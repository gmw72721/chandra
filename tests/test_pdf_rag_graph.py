from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest

import backend.agent.graph as graph_module
from backend.agent.graph import (
    answer_leak_gate,
    build_multimodal_final_messages,
    diagnose_search_result,
    forced_initial_search_tool_call,
    parse_problem_context_from_answer,
    pdf_rag_response_from_state,
    remove_problem_context_from_student_text,
    run_pdf_rag_agent,
    run_pdf_rag_agent_stream,
    structured_tutor_output_from_answer,
    update_active_problem_context,
)
from backend.agent.tools import normalize_pdf_page_result
from backend.agent.tools import SEARCH_PDF_PAGES_TOOL
from backend.retrieval.pdf_page_assets import (
    deduplicate_page_ranges,
    extract_printed_page_number_from_text,
    fetch_or_render_pdf_pages,
    render_page_images,
)
from backend.retrieval.pdf_retriever import (
    build_query_features,
    equation_overlap_score,
    equation_tokens_from_text,
    exact_search_problem_numbers,
    hybrid_page_score,
    problem_numbers_from_text,
    section_related_top_k,
)


class FakeOpenRouterClient:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def chat(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeRetriever:
    def __init__(self, pages: list[dict[str, Any]] | list[list[dict[str, Any]]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    async def search(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append(kwargs)
        if self.pages and isinstance(self.pages[0], list):
            return self.pages[min(len(self.calls) - 1, len(self.pages) - 1)]  # type: ignore[index,return-value]

        return self.pages  # type: ignore[return-value]


def minimal_state(**overrides: Any) -> dict[str, Any]:
    state = {
        "messages": [{"role": "user", "content": "Help with Solve 2x + 3 = 17."}],
        "tool_calls": [],
        "retrieved_pages": [],
        "page_assets": [],
        "answer": "",
        "tool_call_count": 0,
        "retrieval_confidence": "low",
        "retrieval_diagnostics": [],
        "token_usage": {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0},
        "token_usage_by_call": [],
    }
    state.update(overrides)
    return state


async def wait_until(predicate: Any, *, timeout: float = 1.0) -> None:
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)

    assert predicate()


@pytest.mark.asyncio
async def test_active_problem_context_read_is_prefetched_before_model_work(monkeypatch: pytest.MonkeyPatch) -> None:
    read_started = threading.Event()
    read_finished = threading.Event()

    def slow_context_read(_state: dict[str, Any]) -> dict[str, Any]:
        read_started.set()
        time.sleep(0.12)
        read_finished.set()
        return {
            "problem_id": "problem_prefetched",
            "problem_text": "Solve 2x + 3 = 17.",
            "expected_answer": "x = 7",
        }

    class PrefetchObservingClient(FakeOpenRouterClient):
        async def chat(self, **kwargs: Any) -> dict[str, Any]:
            assert read_started.wait(0.2)
            await asyncio.sleep(0.03)
            return await super().chat(**kwargs)

    monkeypatch.setattr(graph_module, "read_active_problem_context_from_firestore", slow_context_read)
    graph_module._ACTIVE_PROBLEM_CONTEXT_CACHE.pop("conv-prefetch-read", None)
    client = PrefetchObservingClient(
        [
            {"content": "", "tool_calls": []},
            {"content": "Final answer: x = 7.", "tool_calls": []},
        ]
    )

    response = await run_pdf_rag_agent(
        messages=[{"role": "user", "content": "What's the answer?"}],
        model="openai/gpt-5.4-mini",
        class_id="class-prefetch-read",
        conversation_id="conv-prefetch-read",
        student_id="student-prefetch-read",
        openrouter_client=client,
    )

    assert read_finished.is_set()
    assert "x = 7" not in response["content"]
    assert "can't give the full answer" in response["content"]


def test_twenty_realistic_student_turns_parse_into_expected_sections() -> None:
    cases = [
        {
            "student": "idk how to start this chain rule one",
            "answer": (
                "A good first move is to identify the outside function. Hint: Treat x^2+1 as the inside "
                "expression. What would you set u equal to?"
            ),
            "keys": ["answer", "hint", "nextStep"],
        },
        {
            "student": "why did you put y prime after differentiating y^2",
            "answer": (
                "This is an implicit differentiation problem. Why this works: y is a function of x, so "
                "differentiating y^2 gives 2y y'. What term needs the product rule?"
            ),
            "keys": ["answer", "explanation", "nextStep"],
        },
        {
            "student": "what formula do I use for integration by parts",
            "answer": (
                "For integration by parts, pick u as the part that simplifies when differentiated. "
                "Formula: \\int u\\,dv = uv - \\int v\\,du. Which part gets simpler if you differentiate it?"
            ),
            "keys": ["answer", "formula", "nextStep"],
        },
        {
            "student": "can you check this derivative d/dx sin(x^2)=cos(x^2)",
            "answer": (
                "Your derivative setup is close. Check your work: The derivative of sin(x^2) needs the chain "
                "rule, so a factor of 2x is missing. Where should that factor appear?"
            ),
            "keys": ["answer", "checkWork", "nextStep"],
            "mode": "check_work",
        },
        {
            "student": "just give me the final answer",
            "answer": "I can't give you the final answer, but I can walk through a similar example or check your next step.",
            "keys": ["answer"],
            "hintLevel": "refusal",
            "mode": "direct_answer_refusal",
        },
        {
            "student": "where is int sqrt(9-x^2)/x^2 in the pdf",
            "answer": (
                "The problem is in Section 7.3 Trig Substitutions, Problem 14, on printed page 104 of "
                "Paul Dawkins Calculus - Practice Problems."
            ),
            "keys": ["answer"],
            "mode": "source_lookup",
            "sources": True,
        },
        {
            "student": "i'm stuck on this limit fraction",
            "answer": (
                "Because you're asking how to start, focus on the denominator. Hint: Factor first before "
                "canceling anything. What factor do the numerator and denominator share?"
            ),
            "keys": ["answer", "hint", "nextStep"],
        },
        {
            "student": "what does continuous actually mean",
            "answer": (
                "Continuity means the graph has no break at that x-value. Why this works: The function value, "
                "left limit, and right limit all have to agree. Which of those three is failing in your example?"
            ),
            "keys": ["answer", "explanation", "nextStep"],
        },
        {
            "student": "can you show a similar u-sub example",
            "answer": (
                "A similar problem would be $\\int x e^{x^2}\\,dx$. Example: Let $u=x^2$, then $du=2x\\,dx$, "
                "so the integral becomes a constant multiple of $\\int e^u\\,du$. What part of your problem looks like the inside function?"
            ),
            "keys": ["answer", "example", "nextStep"],
            "hintLevel": "worked_example",
        },
        {
            "student": "what do I do next after rewriting it",
            "answer": "Use the power rule on each term first. Next step: rewrite the square root as an exponent.",
            "keys": ["answer", "nextStep"],
        },
        {
            "student": "how do i start this optimization word problem",
            "answer": (
                "The wording points to an optimization setup. Hint: Draw a diagram and name the quantity you "
                "are maximizing or minimizing. What variable could represent the unknown length?"
            ),
            "keys": ["answer", "hint", "nextStep"],
        },
        {
            "student": "i have an exam tomorrow how do i recognize ratio test",
            "answer": (
                "For exam review, recognize this as a ratio-test question: compare |a_{n+1}/a_n|. "
                "What limit would you set up?"
            ),
            "keys": ["answer", "nextStep"],
            "mode": "exam_review",
        },
        {
            "student": "write a text to my friend for me",
            "answer": "I can only help with course material here. Send a calculus question, worksheet problem, or concept you want to work on.",
            "keys": ["answer"],
            "mode": "off_topic_redirect",
        },
        {
            "student": "what formula for tangent lines in polar",
            "answer": (
                "The selected page gives the tangent-with-polar-coordinates section. Formula: For polar curves, "
                "use $\\frac{dy}{dx}=\\frac{(dy/d\\theta)}{(dx/d\\theta)}$. What are x and y in terms of r and theta?"
            ),
            "keys": ["answer", "formula", "nextStep"],
            "sources": True,
        },
        {
            "student": "for part b do I use the same substitution",
            "answer": (
                "For part b, use the same substitution from part a. Hint: Keep the new bounds in u so you do "
                "not switch back too early. What are the bounds after substitution?"
            ),
            "keys": ["answer", "hint", "nextStep"],
            "sources": True,
        },
        {
            "student": "this problem isn't matching the worksheet",
            "answer": "Ask your teacher which worksheet version this is from; the selected pages do not show that exact problem.",
            "keys": ["answer"],
            "studentActionNeeded": "ask_teacher",
            "sources": True,
        },
        {
            "student": "help with #8",
            "answer": "Please paste the exact problem text or upload the page so I can match it to the class material.",
            "keys": ["answer"],
            "mode": "clarification",
            "studentActionNeeded": "paste_problem",
        },
        {
            "student": "is my limit step valid if I cancel the x terms",
            "answer": (
                "Your limit step is not valid yet. Check your work: You canceled a term that is inside a sum "
                "rather than a common factor. What can you factor first?"
            ),
            "keys": ["answer", "checkWork", "nextStep"],
            "mode": "check_work",
        },
        {
            "student": "why can't I use l'hospital on this",
            "answer": (
                "For L'Hospital's Rule, first verify the form is $0/0$ or $\\infty/\\infty$. Why this works: "
                "The theorem applies to indeterminate quotients, not every fraction. What form do you get after direct substitution?"
            ),
            "keys": ["answer", "explanation", "nextStep"],
        },
        {
            "student": "how do I solve this trig equation on the worksheet",
            "answer": (
                "Start by isolating the trig function. Formula: If $\\sin x = a$, use the reference angle and "
                "quadrant information. Hint: Check the interval before listing solutions. What interval is the problem using?"
            ),
            "keys": ["answer", "hint", "formula", "nextStep"],
        },
    ]

    for case in cases:
        sources = [{"title": "Calculus Practice Problems"}] if case.get("sources") else []
        result = structured_tutor_output_from_answer(
            case["answer"],
            {"retrieval_confidence": "high" if sources else "low"},
            sources,
        )

        assert list(result["sections"].keys()) == case["keys"], case["student"]
        assert result["metadata"]["hintLevel"] == case.get("hintLevel", result["metadata"]["hintLevel"])
        assert result["metadata"]["mode"] == case.get("mode", result["metadata"]["mode"])
        assert result["metadata"]["studentActionNeeded"] == case.get(
            "studentActionNeeded",
            result["metadata"]["studentActionNeeded"],
        )
        assert result["metadata"]["sourceConfidence"] == ("high" if sources else "low")
        for forbidden_label in ["Hint:", "Why this works:", "Formula:", "Example:", "Check your work:", "Next step:"]:
            assert forbidden_label not in result["sections"]["answer"], case["student"]


@pytest.mark.asyncio
async def test_direct_answer_path_does_not_call_retrieval_for_conceptual_question() -> None:
    client = FakeOpenRouterClient(
        [
            {"content": "", "tool_calls": [], "usage": {"input_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
            {"content": "Try isolating x first.", "tool_calls": [], "usage": {"input_tokens": 20, "completion_tokens": 5, "total_tokens": 25}},
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "How do I know when to isolate the variable?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "Try isolating x first."
    assert response["structuredOutput"]["sections"]["answer"] == "Try isolating x first."
    assert list(response["structuredOutput"]["sections"].keys()) == ["answer"]
    assert response["structuredOutput"]["metadata"]["sourceConfidence"] == "low"
    assert len(client.calls) == 2
    assert client.calls[0]["model"] == "openai/gpt-5.4-mini"
    assert client.calls[0]["reasoning_effort"] == "low"
    assert client.calls[1]["model"] == "openai/gpt-4.1-mini"
    assert retriever.calls == []
    assert response["tokenUsage"]["actual"] == {
        "input_tokens": 30,
        "output_tokens": 7,
        "reasoning_tokens": 0,
        "total_tokens": 37,
    }
    assert [call["purpose"] for call in response["tokenUsage"]["calls"]] == ["router", "final_answer"]


@pytest.mark.asyncio
async def test_router_is_low_reasoning_and_final_uses_configured_default_model() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
            },
            {
                "content": "A variable is isolated when it is alone on one side.",
                "tool_calls": [],
                "usage": {
                    "prompt_tokens": 23,
                    "completion_tokens": 7,
                    "total_tokens": 35,
                    "reasoning_tokens": 5,
                },
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "What does isolated variable mean?"}],
        model="",
        openrouter_client=client,
        professor_id="teacher-1",
        reasoning_effort="high",
        retriever=FakeRetriever([]),
    )

    assert client.calls[0]["model"] == "openai/gpt-5.4-mini"
    assert client.calls[0]["reasoning_effort"] == "low"
    assert client.calls[1]["model"] == "openai/gpt-5.4-mini"
    assert client.calls[1]["reasoning_effort"] == "high"
    assert response["tokenUsage"]["actual"] == {
        "input_tokens": 34,
        "output_tokens": 10,
        "reasoning_tokens": 5,
        "total_tokens": 49,
    }
    assert response["tokenUsage"]["calls"][0]["reasoningEffort"] == "low"
    assert response["tokenUsage"]["calls"][1]["reasoningEffort"] == "high"
    assert response["langGraphTrace"]["modelCallUsage"] == response["tokenUsage"]["calls"]


def test_search_pdf_pages_tool_schema_stays_short_and_required_fields_remain() -> None:
    function_schema = SEARCH_PDF_PAGES_TOOL["function"]
    parameters = function_schema["parameters"]

    assert parameters["required"] == ["query", "student_reason"]
    assert set(parameters["properties"]) == {"query", "top_k", "student_reason"}
    assert "Exactly five words" in parameters["properties"]["student_reason"]["description"]
    assert len(function_schema["description"]) < 260
    assert "Focused PDF search query" in parameters["properties"]["query"]["description"]


def test_problem_context_block_is_parsed_and_removed_before_structuring() -> None:
    raw_answer = (
        "Hint: isolate the variable first.\n\n"
        "Next step: What operation would undo the +3?\n\n"
        "Problem context:\n"
        "relation: same_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "source_document_id: worksheet-1\n"
        "source_page: 12\n"
        "source_chunk_id: chunk-9\n"
        "confidence: high"
    )

    context = parse_problem_context_from_answer(raw_answer, minimal_state(), [])
    cleaned_answer = remove_problem_context_from_student_text(raw_answer)
    structured = structured_tutor_output_from_answer(cleaned_answer, minimal_state(), [])

    assert context == {
        "relation": "same_problem",
        "problem": "Solve 2x + 3 = 17.",
        "expected_answer": "x = 7",
        "source_type": "pdf",
        "source_document_id": "worksheet-1",
        "source_page": 12,
        "source_chunk_id": "chunk-9",
        "confidence": "high",
    }
    assert "Problem context" not in cleaned_answer
    assert "x = 7" not in cleaned_answer
    assert structured["sections"]["hint"] == "isolate the variable first."
    assert structured["sections"]["nextStep"] == "What operation would undo the +3?"


def test_structured_parser_still_extracts_optional_student_sections() -> None:
    answer = (
        "Start by identifying what is given. "
        "Hint: isolate the variable. "
        "Explanation: inverse operations undo each other. "
        "Formula: ax+b=c. "
        "Example: solve 2y+1=9 the same way. "
        "Check your work: substitute your result. "
        "Next step: What operation would you do first?"
    )

    sections = structured_tutor_output_from_answer(answer, minimal_state(), [])["sections"]

    assert sections["answer"] == "Start by identifying what is given."
    assert sections["hint"] == "isolate the variable."
    assert sections["explanation"] == "inverse operations undo each other."
    assert sections["formula"] == "ax+b=c"
    assert sections["example"] == "solve 2y+1=9 the same way"
    assert sections["checkWork"] == "substitute your result."
    assert sections["nextStep"] == "What operation would you do first?"


def test_same_problem_refreshes_existing_context() -> None:
    existing = {
        "problem_id": "problem_old",
        "problem_text": "Solve 2x + 3 = 17.",
        "last_confirmed_message_id": "old-message",
        "updated_at": "old",
    }
    state = minimal_state(
        active_problem_context=existing,
        latest_student_message_id="student-message-2",
    )
    parsed = {
        "relation": "same_problem",
        "problem": "Solve 2x + 3 = 17.",
        "expected_answer": None,
        "source_type": "pdf",
        "source_document_id": None,
        "source_page": None,
        "source_chunk_id": None,
        "confidence": "high",
    }

    updated = update_active_problem_context(parsed, state) or {}

    assert updated["problem_id"] == "problem_old"
    assert updated["last_confirmed_message_id"] == "student-message-2"


def test_different_problem_medium_confidence_replaces_context() -> None:
    state = minimal_state(
        active_problem_context={
            "problem_id": "problem_old",
            "problem_text": "Old problem",
            "last_confirmed_message_id": "old-message",
        },
        latest_student_message_id="student-message-3",
    )
    parsed = {
        "relation": "different_problem",
        "problem": "Solve y - 4 = 10.",
        "expected_answer": None,
        "source_type": "conversation_extracted",
        "source_document_id": None,
        "source_page": None,
        "source_chunk_id": None,
        "confidence": "medium",
    }

    updated = update_active_problem_context(parsed, state) or {}

    assert updated["problem_id"] != "problem_old"
    assert updated["problem_text"] == "Solve y - 4 = 10."
    assert updated["active_since_message_id"] == "student-message-3"


def test_unknown_low_confidence_does_not_overwrite_good_context() -> None:
    existing = {
        "problem_id": "problem_old",
        "problem_text": "Old problem",
        "last_confirmed_message_id": "old-message",
    }
    state = minimal_state(active_problem_context=existing)
    parsed = {
        "relation": "unknown",
        "problem": "Maybe a new problem",
        "expected_answer": None,
        "source_type": "unknown",
        "source_document_id": None,
        "source_page": None,
        "source_chunk_id": None,
        "confidence": "low",
    }

    updated = update_active_problem_context(parsed, state)

    assert updated == existing


def test_no_context_with_problem_text_saves_context() -> None:
    state = minimal_state(latest_student_message_id="student-message-4")
    parsed = {
        "relation": "unknown",
        "problem": "Find the derivative of x^2.",
        "expected_answer": None,
        "source_type": "conversation_extracted",
        "source_document_id": None,
        "source_page": None,
        "source_chunk_id": None,
        "confidence": "low",
    }

    updated = update_active_problem_context(parsed, state) or {}

    assert updated["problem_text"] == "Find the derivative of x^2."
    assert updated["active_since_message_id"] == "student-message-4"


@pytest.mark.asyncio
async def test_problem_context_persistence_does_not_block_response_path(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    def slow_persist(context: dict[str, Any], _state: dict[str, Any]) -> None:
        time.sleep(0.25)
        calls.append(("persist", str(context.get("problem_text"))))

    def record_context_log(
        _state: dict[str, Any],
        parsed_context: dict[str, Any],
        _old_context: dict[str, Any] | None,
        _new_context: dict[str, Any],
    ) -> None:
        calls.append(("context_log", str(parsed_context.get("relation"))))

    monkeypatch.setattr(graph_module, "save_active_problem_context_to_firestore", slow_persist)
    monkeypatch.setattr(graph_module, "log_problem_context_updated", record_context_log)

    raw_answer = (
        "Hint: isolate the variable first.\n\n"
        "Problem context:\n"
        "relation: different_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "confidence: high"
    )
    state = minimal_state(
        answer=raw_answer,
        conversation_id="conv-bg-nonblocking",
        class_id="class-bg-nonblocking",
        student_id="student-bg-nonblocking",
    )

    start = time.perf_counter()
    response = pdf_rag_response_from_state(state)
    elapsed = time.perf_counter() - start

    assert elapsed < 0.15
    assert response["structuredOutput"]["sections"]["hint"] == "isolate the variable first."
    assert "Problem context" not in response["content"]

    await wait_until(lambda: ("persist", "Solve 2x + 3 = 17.") in calls)
    assert ("context_log", "different_problem") in calls


def test_context_change_schedules_background_persistence_and_log(monkeypatch: pytest.MonkeyPatch) -> None:
    scheduled: list[tuple[str, str]] = []

    def record_schedule(label: str, func: Any, *_args: Any, **_kwargs: Any) -> None:
        scheduled.append((label, getattr(func, "__name__", "")))

    monkeypatch.setattr(graph_module, "schedule_best_effort_side_effect", record_schedule)
    state = minimal_state(
        conversation_id="conv-schedule-context",
        class_id="class-schedule-context",
        student_id="student-schedule-context",
    )
    parsed = {
        "relation": "different_problem",
        "problem": "Solve y - 4 = 10.",
        "expected_answer": None,
        "source_type": "conversation_extracted",
        "source_document_id": None,
        "source_page": None,
        "source_chunk_id": None,
        "confidence": "medium",
    }

    updated = update_active_problem_context(parsed, state) or {}

    assert updated["problem_text"] == "Solve y - 4 = 10."
    assert ("conversation_problem_context_persisted", "save_active_problem_context_to_firestore") in scheduled
    assert ("conversation_problem_context_updated", "log_problem_context_updated") in scheduled


def test_answer_leak_gate_checks_each_structured_section() -> None:
    state = minimal_state(answer_policy={"refuseAnswerOnlyRequests": True})
    structured = {
        "sections": {
            "answer": "Let's work one step at a time.",
            "hint": "Subtract 3 first.",
            "explanation": "The expected result is x = 7.",
            "nextStep": "What do you get after subtracting 3?",
        }
    }

    gate = answer_leak_gate(
        answer="",
        structured_output=structured,
        active_problem_context={"expected_answer": "x = 7"},
        state=state,
        sources=[],
    )

    assert gate["passed"] is False
    assert gate["leaking_sections"] == ["explanation"]
    assert "expected_answer" in gate["leaked_answer_types"]


def test_expected_answer_leak_rewrites_only_leaking_section() -> None:
    raw_answer = (
        "We can work one step at a time.\n\n"
        "Hint: subtract 3 from both sides.\n\n"
        "Explanation: The final answer is x = 7.\n\n"
        "Next step: What do you get after subtracting 3?\n\n"
        "Problem context:\n"
        "relation: different_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "source_page: 12\n"
        "confidence: high"
    )
    response = pdf_rag_response_from_state(minimal_state(answer=raw_answer))

    assert "x = 7" not in response["content"]
    assert "Problem context" not in response["content"]
    assert response["structuredOutput"]["sections"]["answer"] == "We can work one step at a time."
    assert response["structuredOutput"]["sections"]["hint"] == "subtract 3 from both sides."
    assert "relevant class method" in response["structuredOutput"]["sections"]["explanation"]
    assert response["structuredOutput"]["sections"]["nextStep"] == "What do you get after subtracting 3?"


def test_rewrite_that_still_leaks_returns_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    raw_answer = (
        "Final answer: x = 7.\n\n"
        "Problem context:\n"
        "relation: different_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "confidence: high"
    )

    monkeypatch.setattr(graph_module, "safe_replacement_section", lambda *_args: "The answer is x = 7.")
    response = pdf_rag_response_from_state(minimal_state(answer=raw_answer))

    assert response["content"] == graph_module.ANSWER_LEAK_FALLBACK_RESPONSE
    assert "x = 7" not in response["content"]


def test_answer_leak_block_log_is_scheduled_after_block(monkeypatch: pytest.MonkeyPatch) -> None:
    scheduled: list[tuple[str, str, dict[str, Any]]] = []

    def record_schedule(label: str, func: Any, *_args: Any, **kwargs: Any) -> None:
        scheduled.append((label, getattr(func, "__name__", ""), kwargs))

    monkeypatch.setattr(graph_module, "schedule_best_effort_side_effect", record_schedule)
    raw_answer = (
        "Final answer: x = 7.\n\n"
        "Problem context:\n"
        "relation: different_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "confidence: high"
    )

    response = pdf_rag_response_from_state(minimal_state(answer=raw_answer))

    leak_logs = [item for item in scheduled if item[0] == "answer_leak_blocked"]
    assert leak_logs
    assert leak_logs[0][1] == "log_answer_leak_blocked"
    assert leak_logs[0][2]["blocked_response"].startswith("Final answer")
    assert "x = 7" not in response["content"]


def test_frontend_payload_never_includes_problem_context_or_expected_answer() -> None:
    raw_answer = (
        "Hint: isolate the variable first.\n\n"
        "Problem context:\n"
        "relation: different_problem\n"
        "problem: Solve 2x + 3 = 17.\n"
        "expected_answer: x = 7\n"
        "source_type: pdf\n"
        "confidence: high"
    )

    response = pdf_rag_response_from_state(minimal_state(answer=raw_answer))
    serialized = json.dumps(response)

    assert "Problem context" not in serialized
    assert "expected_answer" not in serialized
    assert "x = 7" not in serialized


@pytest.mark.asyncio
async def test_direct_answer_refusal_maps_to_structured_refusal() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [],
            },
            {
                "content": "I can't give you the final answer, but I can check your attempted next step.",
                "tool_calls": [],
            }
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Just give me the answer."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["message"] == "I can't give you the final answer, but I can check your attempted next step."
    assert response["structuredOutput"]["metadata"]["mode"] == "direct_answer_refusal"
    assert response["structuredOutput"]["metadata"]["hintLevel"] == "refusal"


@pytest.mark.asyncio
async def test_next_step_question_label_is_removed() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [],
            },
            {
                "content": "Hint: Set the two curves equal first.\n\nQuestion: what x-values do you get?",
                "tool_calls": [],
            }
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Help me with the bounds."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["structuredOutput"]["sections"]["hint"] == "Set the two curves equal first."
    assert response["structuredOutput"]["sections"]["nextStep"] == "what x-values do you get?"


def test_greeting_question_stays_in_main_answer() -> None:
    result = structured_tutor_output_from_answer(
        "Hi! What calculus problem are you working on?",
        {"retrieval_confidence": "low"},
        [],
    )

    assert result["sections"] == {"answer": "Hi! What calculus problem are you working on?"}


def test_short_tutoring_sentence_after_greeting_can_still_extract_next_step() -> None:
    result = structured_tutor_output_from_answer(
        "Hi, try substitution first. What would you choose for u?",
        {"retrieval_confidence": "low"},
        [],
    )

    assert result["sections"] == {
        "answer": "Hi, try substitution first",
        "nextStep": "What would you choose for u?",
    }


def test_decimal_exercise_number_stays_in_final_next_step_question() -> None:
    result = structured_tutor_output_from_answer(
        "Use the definition from Exercise 2.2. What is Exercise 2.2 asking you to prove?",
        {"retrieval_confidence": "low"},
        [],
    )

    assert result["sections"] == {
        "answer": "Use the definition from Exercise 2.2",
        "nextStep": "What is Exercise 2.2 asking you to prove?",
    }


def test_wrapped_decimal_example_number_does_not_split_next_step() -> None:
    result = structured_tutor_output_from_answer(
        (
            "A good one to practice is Example 2.4.1 on printed pages 48-49 in Section 2.4.1. "
            "It shows how to build a transition matrix. "
            "Would you like to try Example 2.4\n"
            "1 together, starting with how to build the first column of the transition matrix?"
        ),
        {"retrieval_confidence": "low"},
        [],
    )

    assert result["sections"] == {
        "answer": (
            "A good one to practice is Example 2.4.1 on printed pages 48-49 in Section 2.4.1. "
            "It shows how to build a transition matrix"
        ),
        "nextStep": (
            "Would you like to try Example 2.4.1 together, starting with how to build the first column "
            "of the transition matrix?"
        ),
    }


def test_labeled_only_response_does_not_duplicate_main_answer() -> None:
    result = structured_tutor_output_from_answer(
        (
            "Hint: Start by recalling the vector-space operations on $V=(0,\\infty)$ from Exercise 1.1. "
            "Then use Definition 2.1.1 on page 33: check that $T$ preserves the two vector-space operations."
            "\n\nYour next step: What do the addition and scalar multiplication on $(0,\\infty)$ look like?"
        ),
        {"retrieval_confidence": "low"},
        [],
    )

    assert result["sections"] == {
        "answer": "",
        "hint": (
            "Start by recalling the vector-space operations on $V=(0,\\infty)$ from Exercise 1.1. "
            "Then use Definition 2.1.1 on page 33: check that $T$ preserves the two vector-space operations"
        ),
        "nextStep": "What do the addition and scalar multiplication on $(0,\\infty)$ look like?",
    }


@pytest.mark.asyncio
async def test_inline_small_hint_and_bold_section_markers_are_extracted() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [],
            },
            {
                "content": (
                    "Because the density is only positive for t >= 0. Small hint: use 0 as the lower endpoint. "
                    "Formula: **P(T > c)=\\int_c^\\infty f(t) dt**. "
                    "Example: **if g(t)=0.1e^{-t/10}, use \\int_6^\\infty g(t)dt**. "
                    "What integral would you write first?"
                ),
                "tool_calls": [],
            }
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Help me with probability density setup."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    sections = response["structuredOutput"]["sections"]

    assert sections["hint"] == "use 0 as the lower endpoint."
    assert sections["formula"] == "P(T > c)=\\int_c^\\infty f(t) dt"
    assert sections["example"] == "if g(t)=0.1e^{-t/10}, use \\int_6^\\infty g(t)dt"
    assert "Small hint:" not in sections["answer"]
    assert sections["nextStep"] == "What integral would you write first?"


@pytest.mark.asyncio
async def test_pasted_concrete_math_problem_forces_exact_problem_search(tmp_path: Path) -> None:
    image = tmp_path / "limits_p25.png"
    image.write_bytes(b"selected-page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "Use the limit laws to split it up first.",
                "tool_calls": [],
            },
            {"content": "This is listed in the selected practice-problems page. Which limit law applies first?", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "limits_practice",
                "title": "Calculus Practice Problems",
                "page_start": 25,
                "page_end": 25,
                "section": "Limit Properties",
                "score": 0.95,
                "chunk_text": "Given lim x to 8 f(x) = -9 and lim x to 8 h(x) = 4, compute lim x to 8 [2f(x)-12h(x)].",
                "source_pdf_path": "data/pdfs/limits_practice.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-calculus",
        messages=[
            {
                "role": "user",
                "content": "lim(x -> 8) [2f(x) - 12h(x)], given lim f(x) = -9 and lim h(x) = 4. I need help",
            }
        ],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"].startswith("This is listed")
    assert "sections" in response["structuredOutput"]
    assert "metadata" in response["structuredOutput"]
    assert response["structuredOutput"]["metadata"]["sourceConfidence"] == "high"
    assert response["structuredOutput"]["metadata"]["studentActionNeeded"] == "try_next_step"
    assert len(client.calls) == 2
    assert retriever.calls == [
        {
            "query": (
                "find exact task in assignment problem PDF worksheet lab prompt practice problems textbook section "
                "lim(x -> 8) [2f(x) - 12h(x)], given lim f(x) = -9 and lim h(x) = 4. I need help"
            ),
            "top_k": 5,
            "class_id": "class-calculus",
            "professor_id": "teacher-1",
        }
    ]
    assert response["langGraphTrace"]["searchQueries"] == [retriever.calls[0]["query"]]


@pytest.mark.asyncio
async def test_streaming_pasted_concrete_math_problem_forces_exact_problem_search(tmp_path: Path) -> None:
    image = tmp_path / "limits_p25.png"
    image.write_bytes(b"selected-page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "Use the limit laws to split it up first.",
                "tool_calls": [],
            },
            {"content": "This is listed in the selected practice-problems page. Which limit law applies first?", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "limits_practice",
                "title": "Calculus Practice Problems",
                "page_start": 25,
                "page_end": 25,
                "section": "Limit Properties",
                "score": 0.95,
                "chunk_text": "Given lim x to 8 f(x) = -9 and lim x to 8 h(x) = 4, compute lim x to 8 [2f(x)-12h(x)].",
                "source_pdf_path": "data/pdfs/limits_practice.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-calculus",
            messages=[
                {
                    "role": "user",
                    "content": "lim(x -> 8) [2f(x) - 12h(x)], given lim f(x) = -9 and lim h(x) = 4. I need help",
                }
            ],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            page_asset_builder=page_asset_builder,
            professor_id="teacher-1",
            retriever=retriever,
        )
    ]

    assert [event["type"] for event in events] == ["search_batch", "step", "step", "step", "final"]
    assert events[0]["searches"][0]["description"] == "Checking exact task and page"
    assert events[-1]["payload"]["content"].startswith("This is listed")
    assert events[-1]["payload"]["structuredOutput"]["metadata"]["sourceConfidence"] == "high"
    assert len(client.calls) == 2
    assert len(retriever.calls) == 1
    assert retriever.calls[0]["query"].startswith("find exact task in assignment problem PDF")


@pytest.mark.asyncio
async def test_textbook_section_request_forces_generic_section_search(tmp_path: Path) -> None:
    first_image = tmp_path / "section_p104.png"
    second_image = tmp_path / "section_p105.png"
    first_image.write_bytes(b"section page 104")
    second_image.write_bytes(b"section page 105")
    client = FakeOpenRouterClient(
        [
            {
                "content": "Section 7.3 is about trig substitution.",
                "tool_calls": [],
            },
            {
                "content": (
                    "Section 7.3 explains trig substitution across the selected textbook pages. "
                    "Hint: first match the expression to one of the standard trig-sub forms. "
                    "Which square-root pattern do you see?"
                ),
                "tool_calls": [],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "textbook",
                "title": "Uploaded Calculus Textbook",
                "page_start": 104,
                "page_end": 104,
                "section": "Section 7.3 Trig Substitutions",
                "score": 0.98,
                "chunk_text": "Section 7.3 introduces trig substitution forms.",
                "source_pdf_path": "data/rendered/textbook.pdf",
                "material_type": "reading",
            },
            {
                "doc_id": "textbook",
                "title": "Uploaded Calculus Textbook",
                "page_start": 105,
                "page_end": 105,
                "section": "Section 7.3 Trig Substitutions",
                "score": 0.96,
                "chunk_text": "More examples from Section 7.3.",
                "source_pdf_path": "data/rendered/textbook.pdf",
                "material_type": "reading",
            },
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert max_total_pages == 12
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": page["page_start"],
                "printed_page_end": page["page_end"],
                "score": page["score"],
                "material_type": page["material_type"],
                "images": [str(first_image if page["page_start"] == 104 else second_image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-calculus",
        messages=[{"role": "user", "content": "Can you help me with textbook Section 7.3 on trig substitution?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert len(client.calls) == 2
    assert retriever.calls == [
        {
            "query": (
                "find textbook reading section chapter pages "
                "Can you help me with textbook Section 7.3 on trig substitution?"
            ),
            "top_k": 5,
            "class_id": "class-calculus",
            "professor_id": "teacher-1",
        }
    ]
    assert response["content"].startswith("Section 7.3 explains")
    assert response["langGraphTrace"]["searchQueries"] == [retriever.calls[0]["query"]]
    assert [page["pageStart"] for page in response["langGraphTrace"]["selectedPages"]] == [104, 105]
    assert response["sources"][0] == {
        "materialType": "reading",
        "pageNumber": 104,
        "title": "Uploaded Calculus Textbook",
    }


@pytest.mark.asyncio
async def test_retrieval_path_executes_search_pdf_pages(tmp_path: Path) -> None:
    image = tmp_path / "worksheet_p4.png"
    image.write_bytes(b"selected-page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet 4 problem 7", "top_k": 3}),
                        },
                    }
                ],
            },
            {"content": "On the selected page, start by identifying the given equation.", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_1",
                "title": "Worksheet 4",
                "page_start": 4,
                "page_end": 4,
                "section": "Problem 7",
                "score": 0.91,
                "chunk_text": "Problem 7 asks about a linear equation.",
                "source_pdf_path": "data/pdfs/doc_1.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert max_total_pages == 12
        assert [page["page_start"] for page in pages] == [4]
        return [
            {
                "doc_id": "doc_1",
                "title": "Worksheet 4",
                "page_start": 4,
                "page_end": 4,
                "images": [str(image)],
                "citation_label": "Worksheet 4, page 4",
            }
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Help with worksheet 4 problem 7."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"].startswith("On the selected page")
    assert retriever.calls == [
            {
                "query": "worksheet 4 problem 7",
                "top_k": 5,
                "class_id": "class-algebra",
                "professor_id": "teacher-1",
            }
    ]
    assert len(client.calls) == 2
    assert response["langGraphTrace"]["stages"] == [
        "openrouter_agent",
        "search_pdf_pages",
        "fetch_or_render_pdf_pages",
        "openrouter_answer_with_pages",
    ]
    assert response["langGraphTrace"]["searchQueries"] == ["worksheet 4 problem 7"]


@pytest.mark.asyncio
async def test_retrieved_pages_with_diagnostics_do_not_report_high_confidence(tmp_path: Path) -> None:
    image = tmp_path / "wrong_section.png"
    image.write_bytes(b"selected-page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "textbook reading section 7.3 trig substitution", "top_k": 5}),
                        },
                    }
                ],
            },
            {"content": "I found a related page, but it is not the requested section.", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_1",
                "title": "Uploaded Calculus Textbook",
                "page_start": 40,
                "page_end": 40,
                "section": "Section 6.2",
                "score": 0.7,
                "chunk_text": "Section 6.2 covers integration by parts.",
                "source_pdf_path": "data/pdfs/doc_1.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-calculus",
        messages=[{"role": "user", "content": "Help me with textbook Section 7.3 trig substitution."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["retrievalConfidence"] == "medium"
    assert response["structuredOutput"]["metadata"]["sourceConfidence"] == "medium"
    assert response["langGraphTrace"]["retrievalDiagnostics"][0]["issue"] == "wrong section/title"


@pytest.mark.asyncio
async def test_retrieval_path_falls_back_to_ranked_pages_when_model_answer_is_empty(tmp_path: Path) -> None:
    image = tmp_path / "worksheet_p4.png"
    image.write_bytes(b"selected-page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet 4 problem 7", "top_k": 3}),
                        },
                    }
                ],
            },
            {"content": "", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_1",
                "title": "Worksheet 4",
                "page_start": 4,
                "page_end": 4,
                "section": "Problem 7",
                "score": 0.91,
                "chunk_text": "Problem 7 asks about a linear equation.",
                "source_pdf_path": "data/pdfs/doc_1.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Help with worksheet 4 problem 7."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == (
        "I found the strongest matching PDF page for this question: Worksheet 4 page 4. "
        "Start there; it was the top-ranked match."
    )
    assert response["sources"] == [{"materialType": "pdf", "pageNumber": 4, "title": "Worksheet 4"}]


@pytest.mark.asyncio
async def test_agent_can_search_again_until_pages_are_sufficient(tmp_path: Path) -> None:
    first_image = tmp_path / "worksheet_p1.png"
    second_image = tmp_path / "worksheet_p9.png"
    first_image.write_bytes(b"first")
    second_image.write_bytes(b"second")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet optimization table", "top_k": 5}),
                        },
                    }
                ],
            },
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {"query": "worksheet optimization problem 8 sensitivity table page 9", "top_k": 6}
                            ),
                        },
                    }
                ],
            },
            {"content": "The needed value is on the second selected page.", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            [
                {
                    "doc_id": "doc_1",
                    "title": "Optimization Worksheet",
                    "page_start": 1,
                    "page_end": 1,
                    "section": "Overview",
                    "score": 0.7,
                    "chunk_text": "Overview only.",
                    "source_pdf_path": "data/pdfs/doc_1.pdf",
                }
            ],
            [
                {
                    "doc_id": "doc_1",
                    "title": "Optimization Worksheet",
                    "page_start": 9,
                    "page_end": 9,
                    "section": "Problem 8",
                    "score": 0.94,
                    "chunk_text": "Problem 8 sensitivity table.",
                    "source_pdf_path": "data/pdfs/doc_1.pdf",
                }
            ],
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(first_image if page["page_start"] == 1 else second_image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "What does the optimization sensitivity table say?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "The needed value is on the second selected page."
    assert [call["query"] for call in retriever.calls] == [
        "worksheet optimization table",
        "worksheet optimization problem 8 sensitivity table page 9",
    ]
    assert response["langGraphTrace"]["toolCallCount"] == 2
    assert response["langGraphTrace"]["searchQueries"] == [
        "worksheet optimization table",
        "worksheet optimization problem 8 sensitivity table page 9",
    ]


@pytest.mark.asyncio
async def test_search_again_loop_runs_before_answer_leak_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gate_calls = 0
    original_gate = graph_module.answer_leak_gate

    def counting_gate(**kwargs: Any) -> dict[str, Any]:
        nonlocal gate_calls
        gate_calls += 1
        return original_gate(**kwargs)

    monkeypatch.setattr(graph_module, "answer_leak_gate", counting_gate)
    image = tmp_path / "page.png"
    image.write_bytes(b"page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet table", "student_reason": "Checking exact worksheet table"}),
                        },
                    }
                ],
            },
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet table page 9", "student_reason": "Checking corrected table page"}),
                        },
                    }
                ],
            },
            {"content": "Hint: compare the two table columns.", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            [{"doc_id": "doc_1", "title": "Worksheet", "page_start": 1, "page_end": 1, "score": 0.5}],
            [{"doc_id": "doc_1", "title": "Worksheet", "page_start": 9, "page_end": 9, "score": 0.9}],
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "What does the worksheet table say?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "Hint: compare the two table columns."
    assert response["langGraphTrace"]["toolCallCount"] == 2
    assert gate_calls == 1
    assert response["langGraphTrace"]["stages"] == [
        "openrouter_agent",
        "search_pdf_pages",
        "fetch_or_render_pdf_pages",
        "openrouter_answer_with_pages",
        "search_pdf_pages",
        "fetch_or_render_pdf_pages",
        "openrouter_answer_with_pages",
    ]


@pytest.mark.asyncio
async def test_agent_runs_up_to_three_distinct_searches_in_parallel(tmp_path: Path) -> None:
    image = tmp_path / "parallel_page.png"
    image.write_bytes(b"page")

    class ParallelTrackingRetriever:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.in_flight = 0
            self.max_in_flight = 0

        async def search(self, **kwargs: Any) -> list[dict[str, Any]]:
            self.calls.append(kwargs)
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)

            try:
                await asyncio.sleep(0.01)
                page_number = len(self.calls)
                return [
                    {
                        "doc_id": f"doc_{page_number}",
                        "title": "Worksheet 4",
                        "page_start": page_number,
                        "page_end": page_number,
                        "section": "",
                        "score": 0.9,
                        "chunk_text": "Relevant page.",
                        "source_pdf_path": f"data/pdfs/doc_{page_number}.pdf",
                    }
                ]
            finally:
                self.in_flight -= 1

    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_exact",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet 4 problem 7 exact page", "top_k": 5}),
                        },
                    },
                    {
                        "id": "call_method",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "linear equation isolate variable method", "top_k": 5}),
                        },
                    },
                    {
                        "id": "call_duplicate",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "worksheet 4 problem 7 exact page!", "top_k": 5}),
                        },
                    },
                    {
                        "id": "call_example",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "linear equation worked example", "top_k": 5}),
                        },
                    },
                    {
                        "id": "call_extra",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "extra query should wait", "top_k": 5}),
                        },
                    },
                ],
            },
            {"content": "Use the selected pages to isolate the variable.", "tool_calls": []},
        ]
    )
    retriever = ParallelTrackingRetriever()

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Help me with worksheet 4 problem 7."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,  # type: ignore[arg-type]
    )

    assert [call["query"] for call in retriever.calls] == [
        "worksheet 4 problem 7 exact page",
        "linear equation isolate variable method",
        "linear equation worked example",
    ]
    assert retriever.max_in_flight == 3
    assert response["langGraphTrace"]["toolCallCount"] == 3
    assert response["langGraphTrace"]["searchQueries"] == [
        "worksheet 4 problem 7 exact page",
        "linear equation isolate variable method",
        "linear equation worked example",
    ]


@pytest.mark.asyncio
async def test_agent_stops_after_eight_searches(tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"page")
    repeated_tool_responses = [
        {
            "content": "",
            "tool_calls": [
                {
                    "id": f"call_{index}",
                    "type": "function",
                    "function": {
                        "name": "search_pdf_pages",
                        "arguments": json.dumps({"query": f"query {index}", "top_k": 5}),
                    },
                }
            ],
        }
        for index in range(9)
    ]
    client = FakeOpenRouterClient(repeated_tool_responses)
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 1,
                "page_end": 1,
                "section": "",
                "score": 0.5,
                "chunk_text": "Not enough information.",
                "source_pdf_path": "data/pdfs/doc_1.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 1,
                "page_end": 1,
                "images": [str(image)],
                "citation_label": "Worksheet, page 1",
            }
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Find something obscure."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert len(retriever.calls) == 8
    assert response["langGraphTrace"]["toolCallCount"] == 8
    assert "maximum number of searches" in response["content"]


@pytest.mark.asyncio
async def test_final_payload_contains_only_retrieved_page_assets(tmp_path: Path) -> None:
    selected = tmp_path / "doc_1_p2.png"
    selected.write_bytes(b"selected")
    unrelated = tmp_path / "doc_1_p8.png"
    unrelated.write_bytes(b"unrelated")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "diagram on page 2", "top_k": 1}),
                        },
                    }
                ],
            },
            {"content": "The selected page shows the diagram.", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 2,
                "page_end": 2,
                "section": "Diagram",
                "score": 0.99,
                "chunk_text": "Diagram instructions.",
                "source_pdf_path": "data/pdfs/doc_1.pdf",
            }
        ]
    )

    async def page_asset_builder(_pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 2,
                "page_end": 2,
                "images": [str(selected)],
                "citation_label": "Worksheet, page 2",
            }
        ]

    await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "What does the page 2 diagram show?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )
    final_messages = client.calls[1]["messages"]
    final_content = final_messages[-1]["content"]
    final_text = final_content[0]["text"]
    image_urls = [part["image_url"]["url"] for part in final_content if part["type"] == "image_url"]

    assert '"page_start": 2' in final_text
    assert '"page_start": 8' not in final_text
    assert "doc_2" not in final_text
    assert len(image_urls) == 1
    assert "c2VsZWN0ZWQ=" in image_urls[0]
    assert "dW5yZWxhdGVk" not in image_urls[0]


def test_page_rendering_skips_pdfium_page_load_failures(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePdfDocument:
        def __init__(self, _path: str) -> None:
            pass

        def __getitem__(self, _index: int) -> object:
            raise RuntimeError("Failed to load page.")

        def close(self) -> None:
            pass

    monkeypatch.setitem(sys.modules, "pypdfium2", types.SimpleNamespace(PdfDocument=FakePdfDocument))

    images = render_page_images(
        tmp_path / "source.pdf",
        doc_id="doc_1",
        page_start=1,
        page_end=1,
        output_dir=tmp_path,
    )

    assert images == []


def test_page_cap_limits_total_pages() -> None:
    pages = [
        {
            "doc_id": "doc_1",
            "title": "Long PDF",
            "page_start": 1,
            "page_end": 20,
            "score": 0.9,
            "source_pdf_path": "data/pdfs/long.pdf",
        },
        {
            "doc_id": "doc_2",
            "title": "Other PDF",
            "page_start": 1,
            "page_end": 5,
            "score": 0.8,
            "source_pdf_path": "data/pdfs/other.pdf",
        },
    ]

    capped = deduplicate_page_ranges(pages, max_total_pages=12)
    total_pages = sum(page["page_end"] - page["page_start"] + 1 for page in capped)

    assert total_pages == 12
    assert capped == [
        {
            "doc_id": "doc_1",
            "title": "Long PDF",
            "page_start": 1,
            "page_end": 12,
            "score": 0.9,
            "source_pdf_path": "data/pdfs/long.pdf",
        }
    ]


def test_tool_result_shape_includes_required_fields() -> None:
    result = normalize_pdf_page_result(
        {
            "docId": "doc_123",
            "title": "Example Paper",
            "pageStart": 14,
            "pageEnd": 16,
            "sectionHeading": "Methods",
            "score": 0.84,
            "chunkText": "Optional extracted text preview.",
            "filePath": "data/pdfs/doc_123.pdf",
        }
    )

    assert set(result) == {
        "doc_id",
        "title",
        "page_start",
        "page_end",
        "section",
        "score",
        "chunk_text",
        "source_pdf_path",
        "material_type",
    }


def test_hybrid_page_score_boosts_exact_page_and_problem_matches() -> None:
    query_features = build_query_features("Find page 129 problem 17 integral from 1 to 6")
    exact_score = hybrid_page_score(
        query_features,
        page_start=129,
        page_end=129,
        searchable_text="Practice Problems page. Problem 17. Integral from 1 to 6.",
        vector_score=0.65,
    )
    semantic_neighbor_score = hybrid_page_score(
        query_features,
        page_start=33,
        page_end=33,
        searchable_text="Related notes about definite integrals and accumulation functions.",
        vector_score=0.99,
    )

    assert exact_score > semantic_neighbor_score


def test_hybrid_page_score_prefers_numbered_item_over_adjacent_page_only_match() -> None:
    query_features = build_query_features("page 41 problem 2.2")
    requested_page_without_item_score = hybrid_page_score(
        query_features,
        page_start=41,
        page_end=41,
        searchable_text="The chapter discussion continues with determinant examples and applications.",
        vector_score=0.65,
    )
    numbered_item_page_score = hybrid_page_score(
        query_features,
        page_start=42,
        page_end=42,
        searchable_text="Problems. 2.2. Recall the vector space V = (0, oo) given in Problem 1.1.",
        vector_score=0.65,
    )

    assert {"2.2", "2.3", "4"}.issubset(problem_numbers_from_text("Problem 2.2, Exercise 2.3, and question 4."))
    assert numbered_item_page_score > requested_page_without_item_score


def test_problem_locator_query_prefers_problem_pdf_over_textbook() -> None:
    query_features = build_query_features("Can you find the trig substitution problem with 1/sqrt(9x^2 - 36x + 37)?")
    problem_pdf_score = hybrid_page_score(
        query_features,
        material_type="practice-problems",
        page_start=129,
        page_end=129,
        searchable_text="Calc 1 Homework practice problems Section 7.3 Problem 14 integral 1/sqrt(9x^2 - 36x + 37).",
        vector_score=0.72,
    )
    textbook_score = hybrid_page_score(
        query_features,
        material_type="reading",
        page_start=596,
        page_end=597,
        searchable_text="Calc 1 Textbook trig substitution examples completing the square for quadratics.",
        vector_score=0.98,
    )

    assert query_features["problem_locator_intent"] is True
    assert problem_pdf_score > textbook_score


def test_textbook_section_query_prefers_reading_pages_generically() -> None:
    query_features = build_query_features("Can you help me understand Section 7.3 in the textbook?")
    textbook_score = hybrid_page_score(
        query_features,
        material_type="reading",
        page_start=104,
        page_end=104,
        searchable_text="Any Calculus Textbook Section 7.3 Trig Substitutions worked examples and definitions.",
        vector_score=0.7,
    )
    worksheet_score = hybrid_page_score(
        query_features,
        material_type="assignment",
        page_start=7,
        page_end=7,
        searchable_text="Worksheet problem 7.3 asks students to practice trig substitution.",
        vector_score=0.99,
    )

    assert query_features["textbook_section_intent"] is True
    assert section_related_top_k(query_features, 5) == 8
    assert textbook_score > worksheet_score


def test_section_problem_locator_prefers_composite_exercise_item() -> None:
    query_features = build_query_features("problem 3 in section 5 so section 5.3")
    wrong_section_score = hybrid_page_score(
        query_features,
        material_type="reading",
        page_start=199,
        page_end=199,
        searchable_text=(
            "5.1. Metric Spaces and Continuous Functions. "
            "The discrete metric is d(x,y)=1 if x!=y. (5.3) Thus no two distinct points are close."
        ),
        vector_score=0.99,
    )
    exact_exercise_score = hybrid_page_score(
        query_features,
        material_type="reading",
        page_start=252,
        page_end=252,
        searchable_text=(
            "Exercises. 5.3. Give an example of a set X and a function d : X x X -> R "
            "that is symmetric and satisfies the triangle inequality."
        ),
        vector_score=0.65,
    )

    assert exact_search_problem_numbers(query_features) == {"5.3"}
    assert exact_exercise_score > wrong_section_score


def test_section_problem_diagnostic_accepts_composite_exercise_match() -> None:
    diagnostic = diagnose_search_result(
        "problem 3 in section 5 so section 5.3",
        [
            {
                "chunk_text": (
                    "Exercises. 5.3. Give an example of a set X and a function d : X x X -> R "
                    "that is symmetric and satisfies the triangle inequality."
                ),
                "doc_id": "acme",
                "material_type": "reading",
                "page_end": 252,
                "page_start": 252,
                "section": "",
                "source_pdf_path": "data/rendered/source_53d1cee85592d906.pdf",
                "title": "ACME Textbook",
            }
        ],
        "problem 3 in section 5 so section 5.3",
    )

    assert diagnostic is None


def test_numbered_section_problem_forces_exact_search_not_section_reading() -> None:
    tool_call = forced_initial_search_tool_call(
        {"messages": [{"role": "user", "content": "problem 3 in section 5 so section 5.3"}]}
    )

    assert tool_call is not None
    assert tool_call["id"] == "forced_exact_problem_search"


def test_equation_tokens_expand_math_notation_equivalents() -> None:
    query_tokens = equation_tokens_from_text(r"\lim \sqrt{x} + \int derivative")
    ocr_tokens = equation_tokens_from_text("limit square root of x plus integral differentiate")

    assert {"lim", "limit", "sqrt", "square_root", "int", "integral", "derivative", "differentiate"}.issubset(
        query_tokens.union(ocr_tokens)
    )
    assert {"sqrt", "square_root"}.issubset(equation_tokens_from_text("square root"))
    assert equation_overlap_score(
        "limit square root integral differentiate",
        equation_tokens_from_text(r"\lim \sqrt{x} \int derivative"),
    ) > 0.75


def test_search_result_diagnostics_name_missing_retrieval_piece() -> None:
    problem_only = diagnose_search_result(
        "worksheet 4 problem 7 isolate variable method",
        [
            {
                "title": "Worksheet 4",
                "material_type": "worksheet",
                "chunk_text": "Problem 7. Solve x + 2 = 8.",
            }
        ],
        "Help me solve worksheet 4 problem 7.",
    )
    textbook_only = diagnose_search_result(
        "find problem 7 exact page",
        [
            {
                "title": "Algebra Textbook",
                "material_type": "reading",
                "chunk_text": "Worked example for isolating a variable.",
            }
        ],
    )
    wrong_section = diagnose_search_result(
        "section 7.3 trig substitution problem 14",
        [
            {
                "title": "Calculus Reader",
                "material_type": "reading",
                "section": "Section 6.2 Integration by Parts",
                "chunk_text": "Worked example for integration by parts.",
            }
        ],
    )

    assert problem_only and problem_only["issue"] == "found problem page only, missing method"
    assert "textbook reading notes worked example method" in problem_only["suggested_next_query"]
    assert textbook_only and textbook_only["issue"] == "found textbook method, missing exact problem"
    assert "find exact problem homework worksheet assignment practice problems" in textbook_only["suggested_next_query"]
    assert wrong_section and wrong_section["issue"] == "wrong section/title"
    assert "section 7.3" in wrong_section["suggested_next_query"]


@pytest.mark.asyncio
async def test_sources_include_pages_across_multiple_searches(tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"page")
    pages = [
        {
            "doc_id": f"doc_{page}",
            "title": "Worksheet",
            "page_start": page,
            "page_end": page,
            "section": "",
            "score": 1 - page / 100,
            "chunk_text": "",
            "source_pdf_path": f"data/pdfs/doc_{page}.pdf",
        }
        for page in range(1, 8)
    ]
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "many similar pages", "top_k": 5}),
                        },
                    }
                ],
            },
            {"content": "", "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(pages)

    async def page_asset_builder(selected_pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in selected_pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "Find the matching page."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert [source["pageNumber"] for source in response["sources"]] == [1]


@pytest.mark.asyncio
async def test_pdf_source_is_resolved_once_for_multiple_ranges_from_same_pdf(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_pdf = tmp_path / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n")
    calls: list[str] = []

    async def fake_resolve_pdf_path(source_pdf_path: str, *, output_dir: Path) -> Path:
        calls.append(source_pdf_path)
        return source_pdf

    def fake_render_page_images(
        source_pdf: Path,
        *,
        doc_id: str,
        page_start: int,
        page_end: int,
        output_dir: Path,
    ) -> list[str]:
        image = output_dir / f"{doc_id}_{page_start}_{page_end}.png"
        image.write_bytes(b"image")
        return [str(image)]

    monkeypatch.setattr("backend.retrieval.pdf_page_assets.resolve_pdf_path", fake_resolve_pdf_path)
    monkeypatch.setattr("backend.retrieval.pdf_page_assets.render_page_images", fake_render_page_images)

    assets = await fetch_or_render_pdf_pages(
        [
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 1,
                "page_end": 1,
                "score": 0.99,
                "source_pdf_path": "gs://bucket/worksheet.pdf",
            },
            {
                "doc_id": "doc_1",
                "title": "Worksheet",
                "page_start": 4,
                "page_end": 4,
                "score": 0.98,
                "source_pdf_path": "gs://bucket/worksheet.pdf",
            },
        ],
        output_dir=tmp_path,
    )

    assert calls == ["gs://bucket/worksheet.pdf"]
    assert [(asset["page_start"], asset["page_end"]) for asset in assets] == [(1, 1), (4, 4)]


@pytest.mark.asyncio
async def test_invalid_pdf_source_falls_back_to_metadata_only_assets(tmp_path: Path) -> None:
    source_pdf = tmp_path / "invalid.pdf"
    source_pdf.write_bytes(b"not a real pdf")

    assets = await fetch_or_render_pdf_pages(
        [
            {
                "doc_id": "bad_pdf",
                "title": "Uploaded Worksheet",
                "page_start": 3,
                "page_end": 3,
                "score": 0.92,
                "source_pdf_path": str(source_pdf),
            }
        ],
        output_dir=tmp_path,
    )

    assert assets == [
        {
            "citation_label": "Uploaded Worksheet, page 3",
            "doc_id": "bad_pdf",
            "images": [],
            "material_type": "",
            "page_end": 3,
            "page_start": 3,
            "printed_page_end": None,
            "printed_page_start": None,
            "score": 0.92,
            "title": "Uploaded Worksheet",
        }
    ]


def test_final_answer_instruction_is_strict(tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"page")
    messages = build_multimodal_final_messages(
        {
            "messages": [{"role": "user", "content": "What is on the page?"}],
            "tool_calls": [],
            "retrieved_pages": [],
            "page_assets": [
                {
                    "doc_id": "doc_1",
                    "title": "Worksheet",
                    "page_start": 1,
                    "page_end": 1,
                    "images": [str(image)],
                    "citation_label": "Worksheet, page 1",
                }
            ],
            "answer": "",
            "tool_call_count": 1,
            "retrieval_diagnostics": [
                {
                    "issue": "found problem page only, missing method",
                    "query": "worksheet problem 7",
                    "reason": "Selected pages only locate the problem.",
                    "suggested_next_query": "textbook reading notes worked example method problem 7",
                }
            ],
        }
    )

    instruction = messages[-1]["content"][0]["text"]

    assert "Use only the selected PDF pages" in instruction
    assert "If no sharper query is available" in instruction
    assert "Use retrieval_diagnostics to repair weak searches" in instruction
    assert "found problem page only, missing method" in instruction
    assert "sqrt/square root" not in instruction
    assert "If the student explicitly asks where, which page, find, identify, or locate a task, question, exercise, or problem" in instruction
    assert "answer with the assignment/source location only" in instruction
    assert "If the student asks for the answer, final answer" in instruction
    assert "do not continue completing their exact task" in instruction
    assert "treat that as source lookup, not solving help" in instruction
    assert "only supplies a specific problem/exercise/page/title reference without asking for solving help" in instruction
    assert "Source-backed help does not override the attempt-first rule" in instruction
    assert "first ask what they have tried or where they are stuck" in instruction
    assert "do not provide task-specific starting points" in instruction
    assert "how a source, example, prior exercise, hint, rubric, rule, method, or instructor note gives, supports, covers, applies to, or connects" in instruction
    assert "part, half, subquestion, requirement, or step of their exact assigned task" in instruction
    assert "Ask one targeted question or explain a prerequisite concept without applying it to the exact task" in instruction
    assert "Do not state what this gives them, what it proves, which part it completes, what to write next" in instruction
    assert "explain like I am 5' is not a student attempt" in instruction
    assert "do not reveal a full solution, final answer, final artifact" in instruction
    assert "a page that only locates the task or lists practice items is not enough" in instruction
    assert "For conceptual method questions" in instruction
    assert "quote the relevant passage exactly" in instruction
    assert "quote the full visible problem statement exactly" in instruction
    assert "bare references like `problem 3.4`" in instruction
    assert "generic copyright grounds" in instruction
    assert "solving help or method teaching" in instruction
    assert "verify it before affirming it" in instruction
    assert "do not state the next move outright" in instruction
    assert "`That item is Problem/Question N in Section X, on printed page P of Title.`" in instruction


def test_extract_printed_page_number_from_pdf_footer_text() -> None:
    text = "\n".join(
        [
            "Chapter 7 : Integration Techniques Section 7.3 : Trig Substitutions",
            "16.",
            "some final exercise text",
            "© November 2025 Paul Dawkins Calculus - Practice Problems - 104 -",
        ]
    )

    assert extract_printed_page_number_from_text(text) == 104


@pytest.mark.asyncio
async def test_problem_location_response_keeps_printed_page_and_top_source(tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"page")
    bad_answer = (
        "The trig substitution problem involving the integral\n\n"
        "$$\\int \\frac{1}{\\sqrt{9x^2 - 36x + 37}}\\,dx$$\n\n"
        'is problem 14 in Section 7.3 Trig Substitutions on page 104 of the "Calc 1 Homework" PDF. '
        "The problem is stated as:\n\n"
        "$$\\int \\frac{1}{\\sqrt{9x^2 - 36x + 37}}\\,dx$$\n\n"
        "You can find it under the list of problems for trig substitution in Section 7.3 on page 104.\n\n"
        "Would you like help starting this problem?"
    )
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {"query": "trig substitution 1 over sqrt(9x^2 - 36x + 37)", "top_k": 5}
                            ),
                        },
                    }
                ],
            },
            {"content": bad_answer, "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "doc_low",
                "title": "Calc 1 Homework",
                "page_start": 33,
                "page_end": 33,
                "section": "Trig Equations",
                "score": 0.4,
                "chunk_text": "A different trig problem.",
                "source_pdf_path": "data/pdfs/calc1.pdf",
            },
            {
                "doc_id": "doc_high",
                "title": "Calc 1 Homework",
                "page_start": 129,
                "page_end": 129,
                "section": "Section 7.3 Trig Substitutions",
                "score": 0.99,
                "chunk_text": "Problem 14 is integral 1/sqrt(9x^2 - 36x + 37) dx.",
                "source_pdf_path": "data/pdfs/calc1.pdf",
            },
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": 104 if page["page_start"] == 129 else None,
                "printed_page_end": 104 if page["page_start"] == 129 else None,
                "score": page["score"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {104 if page['page_start'] == 129 else page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-calculus",
        messages=[{"role": "user", "content": "What problem is this trig substitution integral and where is it?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert "page 104" in response["message"]
    assert "The problem is stated as" not in response["message"]
    assert "Would you like help" not in response["message"]
    assert response["sources"] == [{"materialType": "pdf", "pageNumber": 104, "title": "Calc 1 Homework"}]


@pytest.mark.asyncio
async def test_exercise_location_response_strips_decimal_followup_question(tmp_path: Path) -> None:
    image = tmp_path / "reader_p78.png"
    image.write_bytes(b"page 78")
    bad_answer = (
        "Exercise 2.2 is on printed page 78 of Linear Algebra Reader, in Chapter 2: "
        "Linear Transformations and Matrices. It appears in the exercises list right after 2.1.\n\n"
        "Would you like help understanding what Exercise 2.2 is asking?"
    )
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": "find Exercise 2.2 Linear Algebra Reader", "top_k": 5}),
                        },
                    }
                ],
            },
            {"content": bad_answer, "tool_calls": []},
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "linear_algebra_reader",
                "title": "Linear Algebra Reader",
                "page_start": 78,
                "page_end": 78,
                "section": "Chapter 2: Linear Transformations and Matrices",
                "score": 0.98,
                "chunk_text": "Exercises 2.1 2.2 Linear Transformations and Matrices",
                "source_pdf_path": "data/pdfs/linear_algebra_reader.pdf",
            },
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": 78,
                "printed_page_end": 78,
                "score": page["score"],
                "images": [str(image)],
                "citation_label": "Linear Algebra Reader, page 78",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-linear-algebra",
        messages=[{"role": "user", "content": "Where is Exercise 2.2 in Linear Algebra Reader?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["message"] == (
        "Exercise 2.2 is on printed page 78 of Linear Algebra Reader, in Chapter 2: "
        "Linear Transformations and Matrices. It appears in the exercises list right after 2.1."
    )
    assert "Would you like help" not in response["message"]
    assert list(response["structuredOutput"]["sections"].keys()) == ["answer"]
    assert response["sources"] == [{"materialType": "pdf", "pageNumber": 78, "title": "Linear Algebra Reader"}]


@pytest.mark.asyncio
async def test_streaming_agent_finds_exact_trig_substitution_problem(tmp_path: Path) -> None:
    image = tmp_path / "practice_p129.png"
    image.write_bytes(b"page 129")
    question = "Can you find the trig substitution problem with 1 over sqrt(9x^2 - 36x + 37)?"
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_trig_sub",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": question,
                                    "student_reason": "Checking exact trig problem page",
                                    "top_k": 5,
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "content": (
                    "Yes. It is in Paul Dawkins Calculus - Practice Problems, Section 7.3 "
                    "Trig Substitutions, problem 14 on page 129."
                ),
                "tool_calls": [
                    {
                        "id": "duplicate_call",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps({"query": question, "top_k": 5}),
                        },
                    }
                ],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "XV1vZYSwLVmsNLB0SwHm",
                "title": "Paul Dawkins Calculus - Practice Problems",
                "page_start": 129,
                "page_end": 129,
                "section": "Section 7.3 Trig Substitutions",
                "score": 0.99,
                "chunk_text": "Problem 14 is integral 1/sqrt(9x^2 - 36x + 37) dx.",
                "source_pdf_path": "data/rendered/source_e4daa33576481e9a.pdf",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert max_total_pages == 12
        assert [(page["page_start"], page["page_end"]) for page in pages] == [(129, 129)]
        return [
            {
                "doc_id": "XV1vZYSwLVmsNLB0SwHm",
                "title": "Paul Dawkins Calculus - Practice Problems",
                "page_start": 129,
                "page_end": 129,
                "images": [str(image)],
                "citation_label": "Paul Dawkins Calculus - Practice Problems, page 129",
            }
        ]

    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-calculus",
            messages=[{"role": "user", "content": question}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            page_asset_builder=page_asset_builder,
            professor_id="teacher-1",
            retriever=retriever,
        )
    ]
    final_payload = events[-1]["payload"]

    assert [event["type"] for event in events] == ["search_batch", "step", "step", "step", "final"]
    assert events[0]["searches"] == [
        {
            "description": "Checking exact trig problem page",
            "query": question,
            "searchNumber": 1,
        }
    ]
    assert retriever.calls == [
        {
            "query": question,
            "top_k": 5,
            "class_id": "class-calculus",
            "professor_id": "teacher-1",
        }
    ]
    assert final_payload["langGraphTrace"]["searchQueries"] == [question]
    assert final_payload["langGraphTrace"]["selectedPages"] == [
        {
            "citationLabel": "Paul Dawkins Calculus - Practice Problems, page 129",
            "docId": "XV1vZYSwLVmsNLB0SwHm",
            "pageEnd": 129,
            "pageStart": 129,
            "title": "Paul Dawkins Calculus - Practice Problems",
        }
    ]
    assert "problem 14" in final_payload["message"]
    assert final_payload["sources"] == [
        {
            "materialType": "pdf",
            "pageNumber": 129,
            "title": "Paul Dawkins Calculus - Practice Problems",
        }
    ]


@pytest.mark.asyncio
async def test_trig_solving_help_gathers_problem_and_textbook_support(tmp_path: Path) -> None:
    practice_image = tmp_path / "practice_p129.png"
    textbook_image = tmp_path / "textbook_p615.png"
    practice_image.write_bytes(b"practice page")
    textbook_image.write_bytes(b"textbook page")
    question = "Help me start the trig substitution problem with 1 over sqrt(9x^2 - 36x + 37)."
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_problem",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "trig substitution problem 1 over sqrt(9x^2 - 36x + 37)",
                                    "student_reason": "Checking exact trig problem page",
                                    "top_k": 5,
                                }
                            ),
                        },
                    },
                    {
                        "id": "call_textbook",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "textbook trig substitution completing square reciprocal quadratic example",
                                    "student_reason": "Finding textbook method example page",
                                    "top_k": 5,
                                }
                            ),
                        },
                    },
                ],
            },
            {
                "content": (
                    "Use Section 7.6, Example 2 on printed page 615 for the method. "
                    "It shows completing the square before choosing the trig substitution. "
                    "Look at the quadratic first: what square plus constant can you rewrite it as?"
                ),
                "tool_calls": [],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            [
                {
                    "doc_id": "practice",
                    "title": "Paul Dawkins Calculus - Practice Problems",
                    "page_start": 129,
                    "page_end": 129,
                    "section": "Section 7.3 Trig Substitutions",
                    "score": 0.99,
                    "chunk_text": "Problem 14 is integral 1/sqrt(9x^2 - 36x + 37) dx.",
                    "source_pdf_path": "data/rendered/practice.pdf",
                    "material_type": "practice-problems",
                }
            ],
            [
                {
                    "doc_id": "textbook",
                    "title": "Calculus Textbook",
                    "page_start": 615,
                    "page_end": 615,
                    "section": "Section 7.6 Trig Substitution",
                    "score": 0.98,
                    "chunk_text": "Example 2 completes the square for a reciprocal quadratic before substituting.",
                    "source_pdf_path": "data/rendered/textbook.pdf",
                    "material_type": "reading",
                }
            ],
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": page["page_start"],
                "printed_page_end": page["page_end"],
                "score": page["score"],
                "material_type": page.get("material_type"),
                "images": [str(practice_image if page["doc_id"] == "practice" else textbook_image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-calculus",
            messages=[{"role": "user", "content": question}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            page_asset_builder=page_asset_builder,
            professor_id="teacher-1",
            retriever=retriever,
        )
    ]
    final_payload = events[-1]["payload"]

    assert [event["type"] for event in events] == ["search_batch", "step", "step", "step", "final"]
    assert [search["description"] for search in events[0]["searches"]] == [
        "Checking exact trig problem page",
        "Finding textbook method example page",
    ]
    assert [call["query"] for call in retriever.calls] == [
        "trig substitution problem 1 over sqrt(9x^2 - 36x + 37)",
        "textbook trig substitution completing square reciprocal quadratic example",
    ]
    assert final_payload["langGraphTrace"]["searchQueries"] == [
        "trig substitution problem 1 over sqrt(9x^2 - 36x + 37)",
        "textbook trig substitution completing square reciprocal quadratic example",
    ]
    assert {page["title"] for page in final_payload["langGraphTrace"]["selectedPages"]} == {
        "Calculus Textbook",
        "Paul Dawkins Calculus - Practice Problems",
    }
    assert "printed page 615" in final_payload["message"] or "page 615" in final_payload["message"]
    assert "what square plus constant" in final_payload["message"]
    assert final_payload["sources"][0] == {
        "materialType": "reading",
        "pageNumber": 615,
        "title": "Calculus Textbook",
    }


@pytest.mark.asyncio
async def test_exact_exercise_solving_help_searches_problem_then_context(tmp_path: Path) -> None:
    exercise_image = tmp_path / "acme_p98.png"
    context_image = tmp_path / "acme_p97.png"
    exercise_image.write_bytes(b"exercise page")
    context_image.write_bytes(b"context page")
    question = "Help me prove Exercise 2.14: Given the setup of Exercise 2.13, prove the rank inequalities."
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_exact_exercise",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "find Exercise 2.14 Given setup Exercise 2.13 rank inequalities",
                                    "student_reason": "Checking exact exercise page",
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_context",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "rank nullity theorem composition linear maps proof context",
                                    "student_reason": "Finding relevant proof context pages",
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "content": (
                    "Use Exercise 2.14 on page 98 together with the rank-nullity context on page 97. "
                    "Hint: compare the range of KL with the ranges of K and L first."
                ),
                "tool_calls": [],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            [
                {
                    "doc_id": "acme",
                    "title": "ACME Textbook",
                    "page_start": 98,
                    "page_end": 98,
                    "section": "Exercises",
                    "score": 0.99,
                    "chunk_text": (
                        "2.14. Given the setup of Exercise 2.13, prove the following inequalities: "
                        "rank(KL) <= min(rank(L), rank(K))."
                    ),
                    "source_pdf_path": "data/rendered/source_53d1cee85592d906.pdf",
                    "material_type": "reading",
                }
            ],
            [
                {
                    "doc_id": "acme",
                    "title": "ACME Textbook",
                    "page_start": 97,
                    "page_end": 97,
                    "section": "Linear Transformations and Matrices",
                    "score": 0.94,
                    "chunk_text": "Rank-nullity theorem and setup for Exercise 2.13.",
                    "source_pdf_path": "data/rendered/source_53d1cee85592d906.pdf",
                    "material_type": "reading",
                }
            ],
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": page["page_start"],
                "printed_page_end": page["page_end"],
                "score": page["score"],
                "material_type": page["material_type"],
                "images": [str(exercise_image if page["page_start"] == 98 else context_image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-acme",
        messages=[{"role": "user", "content": question}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert [call["query"] for call in retriever.calls] == [
        "find Exercise 2.14 Given setup Exercise 2.13 rank inequalities",
        "rank nullity theorem composition linear maps proof context",
    ]
    assert response["langGraphTrace"]["stages"] == [
        "openrouter_agent",
        "search_pdf_pages",
        "fetch_or_render_pdf_pages",
        "openrouter_answer_with_pages",
        "search_pdf_pages",
        "fetch_or_render_pdf_pages",
        "openrouter_answer_with_pages",
    ]
    assert [page["pageStart"] for page in response["langGraphTrace"]["selectedPages"]] == [98, 97]
    assert "rank-nullity context" in response["message"]


@pytest.mark.asyncio
async def test_passage_lookup_verifies_exact_exercise_page_before_quote(tmp_path: Path) -> None:
    image = tmp_path / "acme_p98.png"
    image.write_bytes(b"exercise page")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_quote",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "read quote Exercise 2.14 Given setup Exercise 2.13",
                                    "student_reason": "Checking exact exercise page",
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "content": (
                    "Exercise 2.14 says to prove two rank inequalities from the setup of Exercise 2.13 "
                    "on page 98 of ACME Textbook."
                ),
                "tool_calls": [],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "acme",
                "title": "ACME Textbook",
                "page_start": 98,
                "page_end": 98,
                "section": "Exercises",
                "score": 0.99,
                "chunk_text": (
                    "2.14. Given the setup of Exercise 2.13, prove the following inequalities: "
                    "(i) rank(KL) <= min(rank(L), rank(K))."
                ),
                "source_pdf_path": "data/rendered/source_53d1cee85592d906.pdf",
                "material_type": "reading",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": page["page_start"],
                "printed_page_end": page["page_end"],
                "score": page["score"],
                "material_type": page["material_type"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, page {page['page_start']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-acme",
        messages=[{"role": "user", "content": "Read Exercise 2.14 from the PDF."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert [call["query"] for call in retriever.calls] == ["read quote Exercise 2.14 Given setup Exercise 2.13"]
    assert response["langGraphTrace"]["selectedPages"][0]["pageStart"] == 98
    assert "page 98" in response["message"]
    assert response["structuredOutput"]["metadata"]["mode"] in {"source_lookup", "explain"}


@pytest.mark.asyncio
async def test_concept_method_query_can_use_semantic_context_without_exact_exercise(tmp_path: Path) -> None:
    image = tmp_path / "rank_nullity.png"
    image.write_bytes(b"context")
    client = FakeOpenRouterClient(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_concept",
                        "type": "function",
                        "function": {
                            "name": "search_pdf_pages",
                            "arguments": json.dumps(
                                {
                                    "query": "rank nullity theorem rank composition linear maps inequalities",
                                    "student_reason": "Finding method and context pages",
                                }
                            ),
                        },
                    }
                ],
            },
            {
                "content": (
                    "Use rank-nullity and range containment. Hint: compare range(KL) with range(K), "
                    "then compare null spaces for the lower bound."
                ),
                "tool_calls": [],
            },
        ]
    )
    retriever = FakeRetriever(
        [
            {
                "doc_id": "acme",
                "title": "ACME Textbook",
                "page_start": 91,
                "page_end": 92,
                "section": "Rank-Nullity",
                "score": 0.96,
                "chunk_text": "Rank-nullity theorem and range/null-space arguments for linear maps.",
                "source_pdf_path": "data/rendered/source_53d1cee85592d906.pdf",
                "material_type": "reading",
            }
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": page["doc_id"],
                "title": page["title"],
                "page_start": page["page_start"],
                "page_end": page["page_end"],
                "printed_page_start": page["page_start"],
                "printed_page_end": page["page_end"],
                "score": page["score"],
                "material_type": page["material_type"],
                "images": [str(image)],
                "citation_label": f"{page['title']}, pages {page['page_start']}-{page['page_end']}",
            }
            for page in pages
        ]

    response = await run_pdf_rag_agent(
        class_id="class-acme",
        messages=[
            {
                "role": "user",
                "content": "How do I prove inequalities like rank(KL) <= rank(L) using rank-nullity?",
            }
        ],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert [call["query"] for call in retriever.calls] == [
        "rank nullity theorem rank composition linear maps inequalities"
    ]
    assert response["langGraphTrace"]["selectedPages"][0]["pageStart"] == 91
    assert "rank-nullity" in response["message"]
