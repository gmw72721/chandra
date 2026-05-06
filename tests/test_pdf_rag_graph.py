from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agent.graph import build_multimodal_final_messages, run_pdf_rag_agent, run_pdf_rag_agent_stream
from agent.tools import normalize_pdf_page_result
from retrieval.pdf_page_assets import (
    deduplicate_page_ranges,
    extract_printed_page_number_from_text,
    fetch_or_render_pdf_pages,
)
from retrieval.pdf_retriever import build_query_features, hybrid_page_score


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


@pytest.mark.asyncio
async def test_direct_answer_path_does_not_call_retrieval() -> None:
    client = FakeOpenRouterClient([{"content": "Try isolating x first.", "tool_calls": []}])
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-algebra",
        messages=[{"role": "user", "content": "How do I solve x + 2 = 5?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "Try isolating x first."
    assert len(client.calls) == 1
    assert retriever.calls == []


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

    monkeypatch.setattr("retrieval.pdf_page_assets.resolve_pdf_path", fake_resolve_pdf_path)
    monkeypatch.setattr("retrieval.pdf_page_assets.render_page_images", fake_render_page_images)

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
        }
    )

    instruction = messages[-1]["content"][0]["text"]

    assert "Use only the selected PDF pages" in instruction
    assert "If no sharper query is available" in instruction
    assert "If the student only asks where a problem is" in instruction
    assert "locate it only; do not ask a follow-up" in instruction
    assert "If the student asks for the answer, final answer" in instruction
    assert "do not continue solving their exact problem" in instruction
    assert "a page that only locates the exercise or lists practice problems is not enough" in instruction
    assert "Include one short quote of 20 words or fewer" in instruction
    assert "do not state the next move outright" in instruction
    assert "`$integral$ is Problem N in Section X, on printed page P of Title.`" in instruction


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

    assert [event["type"] for event in events] == ["search_batch", "step", "step", "final"]
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

    assert [event["type"] for event in events] == ["search_batch", "step", "step", "final"]
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
