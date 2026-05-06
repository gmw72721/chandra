from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from langgraph.graph import END, START, StateGraph

from agent.openrouter_client import OpenRouterClient, encode_file_as_data_url
from agent.state import PdfRagState
from agent.tools import SEARCH_PDF_PAGES_TOOL, parse_search_pdf_pages_arguments, search_pdf_pages
from retrieval.pdf_page_assets import MAX_TOTAL_PAGES, fetch_or_render_pdf_pages
from retrieval.pdf_retriever import PdfRetriever

MAX_TOOL_CALLS = 8
MAX_PARALLEL_SEARCHES = 3
MAX_RETRIEVED_WINDOWS = 5
DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.4-mini"


def build_pdf_rag_graph(
    *,
    openrouter_client: OpenRouterClient | Any | None = None,
    retriever: PdfRetriever | None = None,
    page_asset_builder: Any | None = None,
):
    """Build the controlled LangGraph runtime for student PDF RAG chat."""

    client = openrouter_client or OpenRouterClient()
    build_assets = page_asset_builder or fetch_or_render_pdf_pages

    async def openrouter_agent(state: PdfRagState) -> dict[str, Any]:
        response = await client.chat(
            model=state.get("model") or DEFAULT_OPENROUTER_MODEL,
            messages=state["messages"],
            tools=[SEARCH_PDF_PAGES_TOOL],
            tool_choice="auto",
            temperature=state.get("temperature", 0.4),
            max_tokens=state.get("max_tokens"),
            reasoning_effort=state.get("reasoning_effort"),
        )
        tool_calls = new_search_tool_calls(
            state,
            [
                tool_call
                for tool_call in response.get("tool_calls", [])
                if (tool_call.get("function") or {}).get("name") == "search_pdf_pages"
            ],
            limit=remaining_search_call_count(state),
        )
        if (
            not tool_calls
            and not state.get("retrieved_pages")
            and state.get("tool_call_count", 0) == 0
            and should_force_exact_problem_search(state)
        ):
            tool_calls = [forced_exact_problem_search_tool_call(state)]

        return {
            "answer": response.get("content") or "",
            "finish_reason": response.get("finish_reason") or "",
            "stage_history": append_stage(state, "openrouter_agent"),
            "tool_calls": tool_calls,
        }

    async def search_pdf_pages_node(state: PdfRagState) -> dict[str, Any]:
        new_search_queries, new_pages = await execute_search_tool_calls(
            state,
            state.get("tool_calls", []),
            retriever=retriever,
            class_id=state.get("class_id"),
            professor_id=state.get("professor_id"),
        )

        retrieved_pages = [*state.get("retrieved_pages", []), *new_pages]
        return {
            "retrieved_pages": deduplicate_retrieved_windows(retrieved_pages),
            "tool_call_count": state.get("tool_call_count", 0) + len(new_search_queries),
            "retrieval_confidence": "high" if retrieved_pages else "low",
            "sources": sources_from_pages(retrieved_pages),
            "stage_history": append_stage(state, "search_pdf_pages"),
            "search_queries": [*state.get("search_queries", []), *new_search_queries],
            "tool_calls": [],
        }

    async def fetch_or_render_pdf_pages_node(state: PdfRagState) -> dict[str, Any]:
        page_assets = await build_assets(state.get("retrieved_pages", []), max_total_pages=MAX_TOTAL_PAGES)
        return {
            "page_assets": page_assets,
            "stage_history": append_stage(state, "fetch_or_render_pdf_pages"),
        }

    async def openrouter_answer_with_pages(state: PdfRagState) -> dict[str, Any]:
        messages = await asyncio.to_thread(build_multimodal_final_messages, state)
        response = await client.chat(
            model=state.get("model") or DEFAULT_OPENROUTER_MODEL,
            messages=messages,
            tools=[SEARCH_PDF_PAGES_TOOL],
            tool_choice="auto",
            temperature=state.get("temperature", 0.4),
            max_tokens=state.get("max_tokens"),
            reasoning_effort=state.get("reasoning_effort"),
        )
        requested_tool_calls = [
            tool_call
            for tool_call in response.get("tool_calls", [])
            if (tool_call.get("function") or {}).get("name") == "search_pdf_pages"
        ]
        tool_calls = new_search_tool_calls(
            state,
            requested_tool_calls,
            limit=remaining_search_call_count(state),
        )
        answer = response.get("content") or ""

        if requested_tool_calls and state.get("tool_call_count", 0) >= MAX_TOOL_CALLS and not answer:
            answer = (
                "I could not find enough support in the selected PDF pages after the maximum number of searches. "
                "Ask your teacher for the exact worksheet, page, or problem text, or paste the relevant part here."
            )

        return {
            "answer": answer,
            "finish_reason": response.get("finish_reason") or "",
            "stage_history": append_stage(state, "openrouter_answer_with_pages"),
            "tool_calls": tool_calls,
        }

    graph = StateGraph(PdfRagState)
    graph.add_node("openrouter_agent", openrouter_agent)
    graph.add_node("search_pdf_pages", search_pdf_pages_node)
    graph.add_node("fetch_or_render_pdf_pages", fetch_or_render_pdf_pages_node)
    graph.add_node("openrouter_answer_with_pages", openrouter_answer_with_pages)
    graph.add_edge(START, "openrouter_agent")
    graph.add_conditional_edges(
        "openrouter_agent",
        route_after_openrouter_agent,
        {
            "search_pdf_pages": "search_pdf_pages",
            END: END,
        },
    )
    graph.add_edge("search_pdf_pages", "fetch_or_render_pdf_pages")
    graph.add_edge("fetch_or_render_pdf_pages", "openrouter_answer_with_pages")
    graph.add_conditional_edges(
        "openrouter_answer_with_pages",
        route_after_openrouter_agent,
        {
            "search_pdf_pages": "search_pdf_pages",
            END: END,
        },
    )
    return graph.compile()


def new_search_tool_calls(
    state: PdfRagState,
    tool_calls: list[dict[str, Any]],
    *,
    limit: int = MAX_PARALLEL_SEARCHES,
) -> list[dict[str, Any]]:
    previous_queries = {normalize_search_query(query) for query in state.get("search_queries", [])}
    filtered_tool_calls: list[dict[str, Any]] = []
    max_calls = max(0, min(limit, MAX_PARALLEL_SEARCHES))

    for tool_call in tool_calls:
        if len(filtered_tool_calls) >= max_calls:
            break

        query = search_query_from_tool_call(tool_call)
        normalized_query = normalize_search_query(query)

        if not normalized_query or normalized_query in previous_queries:
            continue

        previous_queries.add(normalized_query)
        filtered_tool_calls.append(tool_call)

    return filtered_tool_calls


async def execute_search_tool_calls(
    state: PdfRagState,
    tool_calls: list[dict[str, Any]],
    *,
    retriever: PdfRetriever | None,
    class_id: str | None,
    professor_id: str | None,
) -> tuple[list[str], list[dict[str, Any]]]:
    parsed_searches = parse_search_tool_call_batch(state, tool_calls)
    return await execute_parsed_searches(
        parsed_searches,
        retriever=retriever,
        class_id=class_id,
        professor_id=professor_id,
    )


def parse_search_tool_call_batch(
    state: PdfRagState,
    tool_calls: list[dict[str, Any]],
) -> list[tuple[str, int]]:
    remaining_calls = remaining_search_call_count(state)
    return [
        parse_search_pdf_pages_arguments((tool_call.get("function") or {}).get("arguments"))
        for tool_call in tool_calls[:remaining_calls]
    ]


async def execute_parsed_searches(
    parsed_searches: list[tuple[str, int]],
    *,
    retriever: PdfRetriever | None,
    class_id: str | None,
    professor_id: str | None,
) -> tuple[list[str], list[dict[str, Any]]]:

    if not parsed_searches:
        return [], []

    results = await asyncio.gather(
        *[
            search_pdf_pages(
                query,
                min(top_k, MAX_RETRIEVED_WINDOWS),
                retriever=retriever,
                class_id=class_id,
                professor_id=professor_id,
            )
            for query, top_k in parsed_searches
        ]
    )
    pages = [page for search_result in results for page in search_result]
    return [query for query, _top_k in parsed_searches], pages


def remaining_search_call_count(state: PdfRagState) -> int:
    return max(0, min(MAX_PARALLEL_SEARCHES, MAX_TOOL_CALLS - state.get("tool_call_count", 0)))


def search_batch_message(queries: list[str]) -> str:
    if len(queries) == 1:
        return five_word_search_reason("", queries[0])

    return f"Searching {len(queries)} useful angles together."


def search_reason_from_tool_call(tool_call: dict[str, Any]) -> str:
    try:
        raw_arguments = (tool_call.get("function") or {}).get("arguments")
        parsed = raw_arguments if isinstance(raw_arguments, dict) else json.loads(raw_arguments or "{}")
        query = str(parsed.get("query") or "")
        reason = str(parsed.get("student_reason") or parsed.get("reason") or "")
        return five_word_search_reason(reason, query)
    except Exception:
        return five_word_search_reason("", search_query_from_tool_call(tool_call))


def five_word_search_reason(reason: str, query: str) -> str:
    words = re.findall(r"[A-Za-z0-9']+", reason)

    if len(words) == 5:
        return " ".join(words)

    normalized_query = query.lower()
    exact_markers = ["problem", "page", "worksheet", "section", "chapter", "exercise", "quiz", "exam", "number"]
    method_markers = [
        "method",
        "formula",
        "theorem",
        "definition",
        "rule",
        "example",
        "substitution",
        "derivative",
        "integral",
        "solve",
    ]

    if any(marker in normalized_query for marker in exact_markers):
        return "Checking exact problem and page"

    if any(marker in normalized_query for marker in method_markers):
        return "Finding method and example pages"

    return "Searching class PDFs for support"


def search_query_from_tool_call(tool_call: dict[str, Any]) -> str:
    try:
        query, _top_k = parse_search_pdf_pages_arguments((tool_call.get("function") or {}).get("arguments"))
        return query
    except Exception:
        return ""


def normalize_search_query(query: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", query.lower()).split())


def route_after_openrouter_agent(state: PdfRagState) -> str:
    if state.get("tool_calls") and state.get("tool_call_count", 0) < MAX_TOOL_CALLS:
        return "search_pdf_pages"

    return END


def should_force_exact_problem_search(state: PdfRagState) -> bool:
    source_usage = state.get("source_usage")

    if isinstance(source_usage, dict) and source_usage.get("useClassMaterialsFirst") is False:
        return False

    latest_message = latest_student_message_content(state.get("messages", []))
    if not latest_message:
        return False

    return looks_like_concrete_math_problem(latest_message)


def latest_student_message_content(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") not in {"user", "student"}:
            continue

        content = message.get("content")
        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            text_parts = [
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            return " ".join(text_parts).strip()

    return ""


def looks_like_concrete_math_problem(message: str) -> bool:
    normalized = message.lower()
    math_markers = [
        r"\blim\s*\(",
        r"\blim\s*[a-z]\s*(?:->|→|\\to)",
        r"\bint\s*\(",
        r"∫",
        r"\bderivative\b",
        r"\bdifferentiate\b",
        r"\bintegral\b",
        r"\bsolve\b",
        r"\bf\([a-z0-9_+\-\s]+\)",
        r"\b[a-z]\s*=\s*[-+*/^(). 0-9a-z]+",
    ]
    has_math_marker = any(re.search(pattern, normalized) for pattern in math_markers)
    has_operator = bool(re.search(r"(?:->|→|=|\+|-|\*|/|\^|√|\\frac|\\sqrt)", message))
    has_number = bool(re.search(r"\d", message))

    return has_number and (has_math_marker or has_operator)


def forced_exact_problem_search_tool_call(state: PdfRagState) -> dict[str, Any]:
    query = forced_exact_problem_search_query(latest_student_message_content(state.get("messages", [])))
    return {
        "id": "forced_exact_problem_search",
        "type": "function",
        "function": {
            "name": "search_pdf_pages",
            "arguments": json.dumps(
                {
                    "query": query,
                    "student_reason": "Checking exact problem and page",
                }
            ),
        },
    }


def forced_exact_problem_search_query(message: str) -> str:
    compact_message = re.sub(r"\s+", " ", message).strip()
    if len(compact_message) > 260:
        compact_message = compact_message[:260].rsplit(" ", 1)[0].strip()

    return (
        "find exact problem in problem PDF worksheet assignment practice problems textbook section "
        f"{compact_message}"
    ).strip()


def build_multimodal_final_messages(state: PdfRagState) -> list[dict[str, Any]]:
    """Build the multimodal answer/search-again call with only selected page assets."""

    base_messages = list(state["messages"])
    answer_policy = normalize_answer_policy_state(state.get("answer_policy"))
    source_usage = normalize_source_usage_state(state.get("source_usage"))
    selected_context = {
        "retrieved_pages": state.get("retrieved_pages", []),
        "page_assets": [
            {
                "doc_id": asset.get("doc_id"),
                "title": asset.get("title"),
                "page_start": asset.get("page_start"),
                "page_end": asset.get("page_end"),
                "printed_page_start": asset.get("printed_page_start"),
                "printed_page_end": asset.get("printed_page_end"),
                "citation_label": asset.get("citation_label"),
                "score": asset.get("score"),
                "material_type": asset.get("material_type"),
            }
            for asset in state.get("page_assets", [])
        ],
        "searches_used": state.get("tool_call_count", 0),
        "max_searches": MAX_TOOL_CALLS,
        "previous_search_queries": state.get("search_queries", []),
    }
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "Use only the selected PDF pages below. "
                "If they answer the student, give a concise source-backed reply. "
                "If they are insufficient or mismatched, call search_pdf_pages again with a genuinely new, sharper query. "
                "If multiple distinct gaps remain, you may call search_pdf_pages up to 3 times at once for complementary angles. "
                "Each search_pdf_pages call must include student_reason with exactly five words explaining why that query helps. "
                "Never repeat a previous query or minor wording variant. "
                "If the student only asks where a problem is, locate it only; do not ask a follow-up and do not also search for method pages. "
                "If the student only asks to find, identify, or locate a problem, answer with the problem set/assignment location only. "
                f"{final_direct_answer_instruction(answer_policy)} "
                "For solving-help questions, a page that only locates the exercise or lists practice problems is not enough. "
                "Before helping with the next move, make sure selected pages include textbook, reading, notes, or worked-example support for the method. "
                "For solving-help questions only, if selected pages only identify the problem/location, search again for textbook/readings/examples using the method, section, equation pattern, and textbook/example terms. "
                "For conceptual method questions, use selected textbook/readings/examples to teach the recognition pattern in the class wording. "
                f"{final_citation_instruction(source_usage)} "
                f"{final_example_boundary_instruction(answer_policy)} "
                "Give scaffolded help, not a full solution: do not state the next move outright; ask a targeted question or give a small hint that helps the student find it. "
                f"{final_unclear_source_instruction(source_usage)} "
                "When printed_page_start is present, use it as the document page number because it was read from the selected PDF page. "
                "page_start/page_end are only internal render indexes. "
                "For problem-location answers, use this shape: `$integral$ is Problem N in Section X, on printed page P of Title.` "
                "Do not restate an integral the student already supplied more than once; use at most one math block. "
                "Use `$...$` or `$$...$$`; do not use `\\(...\\)`, `\\[...\\]`, or plain bracketed math. "
                "Do not use unrelated pages or outside knowledge.\n\n"
                f"Selected page metadata:\n{json.dumps(selected_context, indent=2)}"
            ),
        }
    ]

    for asset in state.get("page_assets", []):
        for image_path in asset.get("images") or []:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": encode_file_as_data_url(image_path, "image/png")},
                }
            )

        if asset.get("file"):
            content.append(
                {
                    "type": "file",
                    "file": {
                        "filename": f"{asset.get('doc_id') or 'selected-pages'}.pdf",
                        "file_data": encode_file_as_data_url(asset["file"], "application/pdf"),
                    },
                }
            )

    return [
        *base_messages,
        {
            "role": "user",
            "content": content,
        },
    ]


def normalize_answer_policy_state(value: Any) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    return {
        "refuseAnswerOnlyRequests": source.get("refuseAnswerOnlyRequests")
        if isinstance(source.get("refuseAnswerOnlyRequests"), bool)
        else True,
    }


def normalize_source_usage_state(value: Any) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    return {
        "citeSourcePages": source.get("citeSourcePages") if isinstance(source.get("citeSourcePages"), bool) else True,
        "askClarificationIfSourceUnclear": source.get("askClarificationIfSourceUnclear")
        if isinstance(source.get("askClarificationIfSourceUnclear"), bool)
        else True,
    }


def final_direct_answer_instruction(answer_policy: dict[str, bool]) -> str:
    if answer_policy["refuseAnswerOnlyRequests"]:
        return (
            "If the student asks for the answer, final answer, or says to just give the answer, "
            "say you cannot give the final answer and do not continue solving their exact problem in that reply. "
            "For direct-answer requests, offer to walk through a similar textbook/readings/example problem or check their attempted step instead."
        )

    return (
        "If the student asks for the answer, final answer, or says to just give the answer, "
        "avoid answer-only output; explain the reasoning and check understanding instead."
    )


def final_citation_instruction(source_usage: dict[str, bool]) -> str:
    if source_usage["citeSourcePages"]:
        return (
            "When you give solving help or method teaching, use the selected textbook/readings/examples pages directly. "
            "Include one short quote of 20 words or fewer from the selected textbook example when a relevant quote is available, then paraphrase the idea."
        )

    return (
        "When you give solving help, use the selected textbook/readings/examples pages directly. "
        "Mention source titles when helpful, but page citations and quotes are optional."
    )


def final_example_boundary_instruction(answer_policy: dict[str, bool]) -> str:
    if answer_policy["refuseAnswerOnlyRequests"]:
        return "Use textbook examples to teach a similar pattern; do not finish the student's exact problem after refusing a direct answer request."

    return "Use textbook examples to teach patterns, and avoid completing graded work wholesale."


def final_unclear_source_instruction(source_usage: dict[str, bool]) -> str:
    if source_usage["askClarificationIfSourceUnclear"]:
        return "If no sharper query is available, say the answer is not present and ask for the exact worksheet, page, problem, or pasted text."

    return "If no sharper query is available, say what is uncertain and give cautious general help without inventing source details."


def sources_from_pages(pages: list[dict[str, Any]], *, limit: int = MAX_RETRIEVED_WINDOWS) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()

    for page in pages:
        key = (str(page.get("title") or ""), int(page.get("page_start") or 0))
        if key in seen:
            continue

        seen.add(key)
        sources.append(
            {
                "title": page.get("title") or "Untitled PDF",
                "materialType": page.get("material_type") or "pdf",
                "pageNumber": page.get("page_start"),
            }
        )
        if len(sources) >= limit:
            break

    return sources


def sources_from_page_assets(assets: list[dict[str, Any]], *, limit: int = MAX_RETRIEVED_WINDOWS) -> list[dict[str, Any]]:
    ranked_assets = sorted(assets, key=lambda asset: float(asset.get("score") or 0.0), reverse=True)
    sources: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()

    for asset in ranked_assets:
        page_number = int(asset.get("printed_page_start") or asset.get("page_start") or 0)
        key = (str(asset.get("title") or ""), page_number)

        if key in seen:
            continue

        seen.add(key)
        sources.append(
            {
                "title": asset.get("title") or "Untitled PDF",
                "materialType": asset.get("material_type") or "pdf",
                "pageNumber": page_number or None,
            }
        )

        if len(sources) >= limit:
            break

    return sources


def sources_for_answer(state: PdfRagState, answer: str) -> list[dict[str, Any]]:
    assets = state.get("page_assets") or []

    if assets:
        referenced_assets = [asset for asset in assets if answer_references_asset(answer, asset)]

        if referenced_assets:
            return sources_from_page_assets(referenced_assets)

        return sources_from_page_assets(assets, limit=1)

    return sources_from_pages(state.get("retrieved_pages", []), limit=1)


def answer_references_asset(answer: str, asset: dict[str, Any]) -> bool:
    normalized_answer = answer.lower()
    title = str(asset.get("title") or "").lower()
    citation_label = str(asset.get("citation_label") or "").lower()
    page_start = int(asset.get("page_start") or 0)
    page_end = int(asset.get("page_end") or page_start)
    printed_page_start = int(asset.get("printed_page_start") or 0)
    printed_page_end = int(asset.get("printed_page_end") or printed_page_start)

    if citation_label and citation_label in normalized_answer:
        return True

    if page_start <= 0:
        return False

    referenced_page_numbers = set(range(page_start, page_end + 1))

    if printed_page_start > 0:
        referenced_page_numbers.update(range(printed_page_start, printed_page_end + 1))

    for page_number in sorted(referenced_page_numbers):
        page_markers = [
            f"page {page_number}",
            f"p. {page_number}",
            f"p.{page_number}",
        ]

        if any(marker in normalized_answer for marker in page_markers):
            return True

        if title and title in normalized_answer and str(page_number) in normalized_answer:
            return True

    return False


def answer_or_page_fallback(state: PdfRagState) -> str:
    answer = normalize_answer_against_selected_pages(state, (state.get("answer") or "").strip())
    if answer:
        return answer

    top_assets = sorted(state.get("page_assets", []), key=lambda asset: float(asset.get("score") or 0.0), reverse=True)
    sources = sources_from_page_assets(top_assets[:1], limit=1) or sources_from_pages(
        state.get("retrieved_pages", []),
        limit=1,
    )
    if not sources:
        return ""

    source_labels = [
        f"{source.get('title') or 'Untitled PDF'} page {source.get('pageNumber')}"
        for source in sources
        if source.get("pageNumber")
    ]
    if not source_labels:
        return ""

    return (
        "I found the strongest matching PDF page for this question: "
        f"{'; '.join(source_labels)}. Start there; it was the top-ranked match."
    )


def normalize_answer_against_selected_pages(state: PdfRagState, answer: str) -> str:
    if not answer:
        return ""

    answer = collapse_repeated_problem_location_answer(answer)
    return answer.strip()


def top_scored_page_asset(state: PdfRagState) -> dict[str, Any] | None:
    assets = state.get("page_assets") or []

    if not assets:
        return None

    return max(assets, key=lambda asset: float(asset.get("score") or 0.0))


def collapse_repeated_problem_location_answer(answer: str) -> str:
    answer = remove_problem_restatement(answer)
    answer = remove_problem_location_followup(answer)
    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", answer) if paragraph.strip()]
    if len(paragraphs) < 2:
        return answer

    unique_paragraphs: list[str] = []
    seen: set[str] = set()

    for paragraph in paragraphs:
        normalized = normalize_paragraph_for_deduplication(paragraph)

        if normalized in seen:
            continue

        seen.add(normalized)
        unique_paragraphs.append(paragraph)

    return "\n\n".join(unique_paragraphs)


def normalize_paragraph_for_deduplication(paragraph: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", paragraph.lower())


def remove_problem_restatement(answer: str) -> str:
    restatement_patterns = [
        r"\s*The problem is stated as:\s*[\s\S]*?(?=\n\s*(?:You can find|Would you like|Source:|$))",
        r"\s*It asks you to use a trig substitution to evaluate the integral\s*[\s\S]*?(?=\n\s*(?:You can find|Would you like|Source:|$))",
    ]

    restatement_match = next(
        (
            match
            for pattern in restatement_patterns
            if (match := re.search(pattern, answer, flags=re.IGNORECASE))
        ),
        None,
    )

    if not restatement_match:
        return answer

    return f"{answer[:restatement_match.start()].rstrip()}\n\n{answer[restatement_match.end():].lstrip()}".strip()


def remove_problem_location_followup(answer: str) -> str:
    if not re.search(r"\bproblem\s+\d+\b", answer, flags=re.IGNORECASE):
        return answer

    if not re.search(r"\b(?:section|page)\b", answer, flags=re.IGNORECASE):
        return answer

    answer = re.sub(r"\s*You can find it [^.]*\.\s*", " ", answer, flags=re.IGNORECASE).strip()
    return re.sub(r"\s*Would you like help[^?]*\?\s*$", "", answer, flags=re.IGNORECASE).strip()


def deduplicate_retrieved_windows(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep unique retrieved page windows while preserving retrieval order."""

    unique_pages: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int, str]] = set()

    for page in pages:
        key = (
            str(page.get("doc_id") or ""),
            int(page.get("page_start") or 0),
            int(page.get("page_end") or 0),
            str(page.get("source_pdf_path") or ""),
        )

        if key in seen:
            continue

        seen.add(key)
        unique_pages.append(page)

    return unique_pages


def append_stage(state: PdfRagState, stage: str) -> list[str]:
    return [*state.get("stage_history", []), stage]


async def close_owned_openrouter_client(client: Any, owns_client: bool) -> None:
    if not owns_client or not hasattr(client, "aclose"):
        return

    try:
        await client.aclose()
    except Exception:
        return


async def run_pdf_rag_agent(
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning_effort: str | None = None,
    answer_policy: dict[str, Any] | None = None,
    source_usage: dict[str, Any] | None = None,
    class_id: str | None = None,
    professor_id: str | None = None,
    professor_name: str | None = None,
    openrouter_client: OpenRouterClient | Any | None = None,
    retriever: PdfRetriever | None = None,
    page_asset_builder: Any | None = None,
) -> dict[str, Any]:
    """Run the student PDF RAG graph and return Chandra's API response shape."""

    owns_client = openrouter_client is None
    client = openrouter_client or OpenRouterClient()

    try:
        graph = build_pdf_rag_graph(
            openrouter_client=client,
            retriever=retriever,
            page_asset_builder=page_asset_builder,
        )
        final_state = await graph.ainvoke(
            {
                "messages": messages,
                "tool_calls": [],
                "retrieved_pages": [],
                "page_assets": [],
                "answer": "",
                "tool_call_count": 0,
                "stage_history": [],
                "search_queries": [],
                "model": model,
                "temperature": temperature if temperature is not None else 0.4,
                "max_tokens": max_tokens,
                "finish_reason": "",
                "reasoning_effort": reasoning_effort,
                "answer_policy": answer_policy,
                "source_usage": source_usage,
                "class_id": class_id,
                "professor_id": professor_id,
                "professor_name": professor_name,
                "sources": [],
                "retrieval_confidence": "low",
            },
            {"recursion_limit": 40},
        )
        answer = answer_or_page_fallback(final_state)
        sources = sources_for_answer(final_state, answer)

        return {
            "content": answer,
            "langGraphTrace": {
                "searchQueries": final_state.get("search_queries") or [],
                "selectedPages": selected_page_trace(final_state.get("page_assets", [])),
                "stages": final_state.get("stage_history") or [],
                "finishReason": final_state.get("finish_reason") or "",
                "toolCallCount": final_state.get("tool_call_count") or 0,
            },
            "message": answer,
            "sources": sources,
            "retrievalConfidence": final_state.get("retrieval_confidence") or "low",
        }
    finally:
        await close_owned_openrouter_client(client, owns_client)


async def run_pdf_rag_agent_stream(
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning_effort: str | None = None,
    answer_policy: dict[str, Any] | None = None,
    source_usage: dict[str, Any] | None = None,
    class_id: str | None = None,
    professor_id: str | None = None,
    professor_name: str | None = None,
    openrouter_client: OpenRouterClient | Any | None = None,
    retriever: PdfRetriever | None = None,
    page_asset_builder: Any | None = None,
):
    """Run the PDF RAG flow while yielding student-facing progress events."""

    owns_client = openrouter_client is None
    client = openrouter_client or OpenRouterClient()
    build_assets = page_asset_builder or fetch_or_render_pdf_pages
    state: PdfRagState = {
        "messages": messages,
        "tool_calls": [],
        "retrieved_pages": [],
        "page_assets": [],
        "answer": "",
        "tool_call_count": 0,
        "stage_history": [],
        "search_queries": [],
        "model": model,
        "temperature": temperature if temperature is not None else 0.4,
        "max_tokens": max_tokens,
        "finish_reason": "",
        "reasoning_effort": reasoning_effort,
        "answer_policy": answer_policy,
        "source_usage": source_usage,
        "class_id": class_id,
        "professor_id": professor_id,
        "professor_name": professor_name,
        "sources": [],
        "retrieval_confidence": "low",
    }

    try:
        response = await client.chat(
            model=model or DEFAULT_OPENROUTER_MODEL,
            messages=messages,
            tools=[SEARCH_PDF_PAGES_TOOL],
            tool_choice="auto",
            temperature=state.get("temperature", 0.4),
            max_tokens=state.get("max_tokens"),
            reasoning_effort=state.get("reasoning_effort"),
        )
        state["answer"] = response.get("content") or ""
        state["finish_reason"] = response.get("finish_reason") or ""
        state["stage_history"] = append_stage(state, "openrouter_agent")
        state["tool_calls"] = new_search_tool_calls(
            state,
            [
                tool_call
                for tool_call in response.get("tool_calls", [])
                if (tool_call.get("function") or {}).get("name") == "search_pdf_pages"
            ],
            limit=remaining_search_call_count(state),
        )
        if (
            not state["tool_calls"]
            and not state.get("retrieved_pages")
            and state.get("tool_call_count", 0) == 0
            and should_force_exact_problem_search(state)
        ):
            state["tool_calls"] = [forced_exact_problem_search_tool_call(state)]

        if not state["tool_calls"]:
            yield {"payload": pdf_rag_response_from_state(state), "type": "final"}
            return

        while state.get("tool_calls") and state.get("tool_call_count", 0) < MAX_TOOL_CALLS:
            parsed_searches = parse_search_tool_call_batch(state, state.get("tool_calls", []))
            new_search_queries = [query for query, _top_k in parsed_searches]
            search_number_start = state.get("tool_call_count", 0) + 1
            search_numbers = list(range(search_number_start, search_number_start + len(new_search_queries)))
            search_entries = [
                {
                    "description": search_reason_from_tool_call(tool_call),
                    "query": query,
                    "searchNumber": search_number,
                }
                for tool_call, query, search_number in zip(
                    state.get("tool_calls", []),
                    new_search_queries,
                    search_numbers,
                )
            ]

            yield {
                "message": (
                    search_entries[0]["description"] if len(search_entries) == 1 else search_batch_message(new_search_queries)
                ),
                "queries": new_search_queries,
                "searches": search_entries,
                "searchNumbers": search_numbers,
                "stage": "searching_pages",
                "type": "search_batch",
            }
            _queries, new_pages = await execute_parsed_searches(
                parsed_searches,
                retriever=retriever,
                class_id=class_id,
                professor_id=professor_id,
            )

            state["retrieved_pages"] = deduplicate_retrieved_windows([*state.get("retrieved_pages", []), *new_pages])
            state["tool_call_count"] = state.get("tool_call_count", 0) + len(new_search_queries)
            state["retrieval_confidence"] = "high" if state["retrieved_pages"] else "low"
            state["sources"] = sources_from_pages(state["retrieved_pages"])
            state["stage_history"] = append_stage(state, "search_pdf_pages")
            state["search_queries"] = [*state.get("search_queries", []), *new_search_queries]
            state["tool_calls"] = []

            yield {
                "message": "Opening the selected PDF pages.",
                "stage": "opening_pages",
                "type": "step",
            }
            state["page_assets"] = await build_assets(state.get("retrieved_pages", []), max_total_pages=MAX_TOTAL_PAGES)
            state["stage_history"] = append_stage(state, "fetch_or_render_pdf_pages")
            yield {
                "message": "Reading the most relevant pages.",
                "stage": "reading_pages",
                "type": "step",
            }

            response = await client.chat(
                model=model or DEFAULT_OPENROUTER_MODEL,
                messages=await asyncio.to_thread(build_multimodal_final_messages, state),
                tools=[SEARCH_PDF_PAGES_TOOL],
                tool_choice="auto",
                temperature=state.get("temperature", 0.4),
                max_tokens=state.get("max_tokens"),
                reasoning_effort=state.get("reasoning_effort"),
            )
            state["answer"] = response.get("content") or ""
            state["finish_reason"] = response.get("finish_reason") or ""
            state["stage_history"] = append_stage(state, "openrouter_answer_with_pages")
            requested_tool_calls = [
                tool_call
                for tool_call in response.get("tool_calls", [])
                if (tool_call.get("function") or {}).get("name") == "search_pdf_pages"
            ]
            state["tool_calls"] = new_search_tool_calls(
                state,
                requested_tool_calls,
                limit=remaining_search_call_count(state),
            )

            if not state["tool_calls"]:
                yield {"payload": pdf_rag_response_from_state(state), "type": "final"}
                return

        if not state.get("answer"):
            state["answer"] = (
                "I could not find enough support in the selected PDF pages after the maximum number of searches. "
                "Ask your teacher for the exact worksheet, page, or problem text, or paste the relevant part here."
            )

        yield {"payload": pdf_rag_response_from_state(state), "type": "final"}
    finally:
        await close_owned_openrouter_client(client, owns_client)


def pdf_rag_response_from_state(state: PdfRagState) -> dict[str, Any]:
    answer = answer_or_page_fallback(state)
    sources = sources_for_answer(state, answer)

    return {
        "content": answer,
        "langGraphTrace": {
            "searchQueries": state.get("search_queries") or [],
            "selectedPages": selected_page_trace(state.get("page_assets", [])),
            "stages": state.get("stage_history") or [],
            "finishReason": state.get("finish_reason") or "",
            "toolCallCount": state.get("tool_call_count") or 0,
        },
        "message": answer,
        "sources": sources,
        "retrievalConfidence": state.get("retrieval_confidence") or "low",
    }


def selected_page_trace(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected_pages: list[dict[str, Any]] = []

    for asset in assets:
        page_trace = {
            "citationLabel": asset.get("citation_label"),
            "docId": asset.get("doc_id"),
            "pageEnd": asset.get("page_end"),
            "pageStart": asset.get("page_start"),
            "title": asset.get("title"),
        }

        if asset.get("material_type"):
            page_trace["materialType"] = asset.get("material_type")

        if asset.get("printed_page_start") is not None:
            page_trace["printedPageStart"] = asset.get("printed_page_start")

        if asset.get("printed_page_end") is not None:
            page_trace["printedPageEnd"] = asset.get("printed_page_end")

        selected_pages.append(page_trace)

    return selected_pages
