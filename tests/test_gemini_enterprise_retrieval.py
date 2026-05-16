from __future__ import annotations

from typing import Any

import pytest

from backend.agent import tools as tools_module
from backend.agent.graph import (
    MAX_REFERENCE_EXPANSION_DEPTH,
    execute_parsed_searches,
    execute_reference_expansion,
)
from backend.retrieval.gemini_enterprise_search import (
    GeminiEnterpriseSearchClient,
    GeminiEnterpriseSearchConfig,
    build_course_material_filter,
    normalize_gemini_enterprise_result,
)
from backend.retrieval.pdf_page_assets import select_metadata_pages


class FakeRetriever:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    async def search(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append(kwargs)
        return self.pages


class FakePlannerClient:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict[str, Any]] = []

    async def chat(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"content": self.content, "usage": {}}


class FakeGeminiTransport:
    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []

    async def post_search(self, *, url: str, token: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        self.payloads.append(payload)
        return {"results": []}


def page(**overrides: Any) -> dict[str, Any]:
    base = {
        "chunk_text": "Worked example: diagonalize a similar matrix.",
        "class_id": "class-1",
        "doc_id": "material-2",
        "page_start": 7,
        "page_end": 7,
        "professor_id": "teacher-1",
        "retrieval_mode": "vector",
        "score": 12,
        "title": "Linear Algebra Examples",
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_similar_example_routes_to_gemini_enterprise_first() -> None:
    broad = FakeRetriever([page(retrieval_mode="gemini_enterprise")])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="vector")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("show me a similar example for diagonalization", 5, "needed_example_page")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert not postgres.calls
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"
    assert broad.calls[0]["preferred_chunk_types"] == ["example"]


@pytest.mark.asyncio
async def test_exact_problem_lookup_tries_gemini_first_by_default() -> None:
    broad = FakeRetriever([page(chunk_text="Problem 7. Diagonalize the matrix.", retrieval_mode="gemini_enterprise")])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 1, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert not postgres.calls
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"


@pytest.mark.asyncio
async def test_exact_problem_lookup_falls_back_to_postgres_when_gemini_has_no_match() -> None:
    broad = FakeRetriever([page(retrieval_mode="gemini_enterprise")])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 1, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert len(postgres.calls) == 1
    assert postgres.calls[0].get("material_id") is None
    assert postgres.calls[0].get("page_before") is None
    assert pages[0]["retrieval_mode"] == "exact_problem"


@pytest.mark.asyncio
async def test_exact_problem_lookup_uses_exact_gemini_match() -> None:
    broad = FakeRetriever(
        [
            page(
                chunk_text="Problem 7. Diagonalize the matrix.",
                problem_numbers=["7"],
                retrieval_mode="gemini_enterprise",
            )
        ]
    )
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 1, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert not postgres.calls
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"


@pytest.mark.asyncio
async def test_exact_problem_lookup_uses_gemini_when_search_enabled() -> None:
    broad = FakeRetriever([page(chunk_text="Problem 7. Diagonalize the matrix.", retrieval_mode="gemini_enterprise")])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 1, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert not postgres.calls
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"


@pytest.mark.asyncio
async def test_exact_problem_lookup_returns_only_top_gemini_match() -> None:
    broad = FakeRetriever(
        [
            page(chunk_text="Problem 7. Diagonalize the matrix.", retrieval_mode="gemini_enterprise", gemini_rank=1),
            page(chunk_text="Problem 7 is referenced here.", retrieval_mode="gemini_enterprise", gemini_rank=2),
        ]
    )
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 5, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(pages) == 1
    assert pages[0]["gemini_rank"] == 1


@pytest.mark.asyncio
async def test_gemini_score_survives_page_context_expansion(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_search_pdf_pages_via_next(**_kwargs: Any) -> list[dict[str, Any]]:
        return [page(retrieval_mode="vector", score=99)]

    monkeypatch.setattr(tools_module, "search_pdf_pages_via_next", fake_search_pdf_pages_via_next)

    pages = await tools_module.expand_broad_results_with_page_context(
        [
            page(
                doc_id="material-2",
                page_number=7,
                retrieval_mode="gemini_enterprise",
                score=0.0,
            )
        ],
        class_id="class-1",
        professor_id="teacher-1",
        retrieval_reason="student_requested_problem",
    )

    assert pages[0]["retrieval_mode"] == "gemini_enterprise"
    assert pages[0]["score"] == 0.0


@pytest.mark.asyncio
async def test_exact_problem_lookup_falls_back_when_gemini_empty() -> None:
    broad = FakeRetriever([])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="exact_problem")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("problem 7", 1, "student_requested_problem")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert len(postgres.calls) == 1
    assert pages[0]["retrieval_mode"] == "exact_problem"


@pytest.mark.asyncio
async def test_gemini_enterprise_empty_result_falls_back_to_postgres() -> None:
    broad = FakeRetriever([])
    postgres = FakeRetriever([page(doc_id="postgres-material", retrieval_mode="vector")])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("find an example like this", 5, "needed_example_page")],
        state={"chat_retrieval_memory": {}},
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(broad.calls) == 1
    assert len(postgres.calls) == 1
    assert pages[0]["doc_id"] == "postgres-material"


@pytest.mark.asyncio
async def test_search_pdf_pages_helper_uses_gemini_before_next(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_search_course_material_broad(**kwargs: Any) -> list[dict[str, Any]]:
        calls.append(kwargs)
        return [page(doc_id="gemini-material", retrieval_mode="gemini_enterprise")]

    async def fake_search_pdf_pages_via_next(**_kwargs: Any) -> list[dict[str, Any]]:
        raise AssertionError("Postgres fallback should not run when Gemini returns results")

    monkeypatch.setattr(tools_module, "search_course_material_broad", fake_search_course_material_broad)
    monkeypatch.setattr(tools_module, "search_pdf_pages_via_next", fake_search_pdf_pages_via_next)

    pages = await tools_module.search_pdf_pages(
        "find problem 7",
        class_id="class-1",
        professor_id="teacher-1",
        retrieval_reason="student_requested_problem",
    )

    assert calls[0]["intent"] == "student_requested_problem"
    assert pages[0]["doc_id"] == "gemini-material"
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"


@pytest.mark.asyncio
async def test_support_fallback_search_is_constrained_to_prior_active_material_pages() -> None:
    broad = FakeRetriever([])
    postgres = FakeRetriever(
        [
            page(doc_id="active-material", page_start=8, page_end=8),
            page(doc_id="active-material", page_start=12, page_end=12),
            page(doc_id="other-material", page_start=6, page_end=6),
        ]
    )

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("rank nullity theorem", 5, "needed_supporting_page")],
        state={
            "chat_retrieval_memory": {
                "active_metadata": page(doc_id="active-material", page_start=12, page_end=12)
            }
        },
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(postgres.calls) == 1
    assert postgres.calls[0]["material_id"] == "active-material"
    assert postgres.calls[0]["page_before"] == 12
    assert [(result["doc_id"], result["page_start"]) for result in pages] == [("active-material", 8)]


@pytest.mark.asyncio
async def test_active_page_excluded_from_similar_example_broad_results() -> None:
    broad = FakeRetriever(
        [
            page(doc_id="active-material", page_start=3, page_end=3),
            page(doc_id="active-material", page_start=4, page_end=4),
            page(doc_id="different-material", page_start=2, page_end=2),
        ]
    )
    postgres = FakeRetriever([])

    _queries, pages, _diagnostics, _history = await execute_parsed_searches(
        [("another example with eigenvalues", 5, "needed_example_page")],
        state={
            "chat_retrieval_memory": {
                "active_metadata": page(doc_id="active-material", page_start=4, page_end=4)
            }
        },
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert [(result["doc_id"], result["page_start"]) for result in pages] == [("active-material", 3)]
    assert broad.calls[0]["active_material_id"] == "active-material"
    assert broad.calls[0]["active_page_number"] == 4
    assert broad.calls[0]["active_page_before"] == 4

@pytest.mark.asyncio
async def test_reference_expansion_follows_explicit_exercise_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    postgres = FakeRetriever([page(chunk_text="Exercise 2.10. The supporting result.", problem_numbers=["2.10"])])

    queries, pages, _diagnostics, history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    chunk_text="Problem 8. Use Exercise 2.10 to finish the argument.",
                    problem_numbers=["8"],
                )
            ],
            "search_queries": ["problem 8"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == ["exercise 2.10"]
    assert pages[0]["problem_numbers"] == ["2.10"]
    assert history[0]["reference_type"] == "exercise"
    assert expansion_diagnostics[0]["reference_type"] == "exercise"
    assert depth == 1


@pytest.mark.asyncio
async def test_reference_expansion_uses_llm_planner_decision(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    planner = FakePlannerClient(
        '{"followup_searches":[{"query":"exercise 2.10","retrieval_reason":"student_requested_problem",'
        '"top_k":1,"reference_type":"exercise","why":"The retrieved problem says to use Exercise 2.10."}]}'
    )
    postgres = FakeRetriever([page(chunk_text="Exercise 2.10. The supporting result.", problem_numbers=["2.10"])])

    queries, pages, _diagnostics, _history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    chunk_text="Problem 8. Use Exercise 2.10 to finish the argument.",
                    problem_numbers=["8"],
                )
            ],
            "search_queries": ["problem 8"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        planner_client=planner,
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(planner.calls) >= 1
    assert queries == ["exercise 2.10"]
    assert pages[0]["problem_numbers"] == ["2.10"]
    assert expansion_diagnostics[0]["planner_source"] == "llm"
    assert depth == 1


@pytest.mark.asyncio
async def test_reference_expansion_respects_llm_empty_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    planner = FakePlannerClient('{"followup_searches":[]}')
    postgres = FakeRetriever([page(chunk_text="Exercise 2.10. The supporting result.", problem_numbers=["2.10"])])

    queries, pages, diagnostics, history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    chunk_text="Problem 8. Use Exercise 2.10 to finish the argument.",
                    problem_numbers=["8"],
                )
            ],
            "search_queries": ["problem 8"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        planner_client=planner,
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert len(planner.calls) == 1
    assert queries == []
    assert pages == []
    assert diagnostics == []
    assert history == []
    assert expansion_diagnostics == []
    assert depth == 0


@pytest.mark.asyncio
async def test_reference_expansion_skips_same_problem_page_variants(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    planner = FakePlannerClient(
        '{"followup_searches":['
        '{"query":"ACME VOL 1 exercise 2.20 page 101","retrieval_reason":"student_requested_problem",'
        '"top_k":1,"reference_type":"problem","why":"The retrieved source is exercise 2.20."},'
        '{"query":"ACME VOL 1 exercise 2.20 page 100","retrieval_reason":"student_requested_problem",'
        '"top_k":1,"reference_type":"problem","why":"Try the previous page for exercise 2.20."},'
        '{"query":"ACME VOL 1 exercise 2.20","retrieval_reason":"student_requested_problem",'
        '"top_k":1,"reference_type":"problem","why":"Search the same exercise again."}'
        "]}",
    )
    postgres = FakeRetriever([page(chunk_text="Should not be searched")])

    queries, pages, diagnostics, history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    title="ACME VOL 1",
                    chunk_text="Exercise 2.20. Show that this rotation preserves lengths.",
                    page_start=101,
                    page_end=101,
                    printed_page_start=101,
                    printed_page_end=101,
                    problem_numbers=["2.20"],
                )
            ],
            "search_queries": ["problem 2.20"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        planner_client=planner,
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == []
    assert pages == []
    assert diagnostics == []
    assert history == []
    assert not postgres.calls
    assert depth == 0
    assert len(expansion_diagnostics) == 3
    assert {item["target_key"] for item in expansion_diagnostics} == {"problem:2.20"}
    assert all(item["skipped"] is True for item in expansion_diagnostics)


@pytest.mark.asyncio
async def test_reference_expansion_allows_different_referenced_problem(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    planner = FakePlannerClient(
        '{"followup_searches":[{"query":"exercise 2.19","retrieval_reason":"student_requested_problem",'
        '"top_k":1,"reference_type":"previous_exercise","why":"Problem 2.20 says to use the previous exercise."}]}'
    )
    postgres = FakeRetriever([page(chunk_text="Exercise 2.19. Previous result.", problem_numbers=["2.19"])])

    queries, pages, _diagnostics, _history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    title="ACME VOL 1",
                    chunk_text="Exercise 2.20. Use the previous exercise.",
                    problem_numbers=["2.20"],
                )
            ],
            "search_queries": ["problem 2.20"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        planner_client=planner,
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == ["exercise 2.19"]
    assert pages[0]["problem_numbers"] == ["2.19"]
    assert pages[0]["lookup_role"] == "reference_expansion"
    assert pages[0]["reference_query"] == "exercise 2.19"
    assert pages[0]["reference_why"] == "Problem 2.20 says to use the previous exercise."
    assert pages[0]["used_as"] == "supporting_context"
    assert expansion_diagnostics[0]["reference_type"] == "previous_exercise"
    assert depth == 1


@pytest.mark.asyncio
async def test_reference_expansion_allows_similar_problem_search_with_active_number(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    planner = FakePlannerClient(
        '{"followup_searches":[{"query":"similar worked example for rotation matrices like exercise 2.20",'
        '"retrieval_reason":"needed_example_page","top_k":3,"reference_type":"similar_example",'
        '"why":"The student needs a related example, not the same exercise."}]}'
    )
    broad = FakeRetriever([page(chunk_text="Worked example: rotation matrices preserve length.", retrieval_mode="gemini_enterprise")])
    postgres = FakeRetriever([])

    queries, pages, _diagnostics, _history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    title="ACME VOL 1",
                    chunk_text="Exercise 2.20. Show that this rotation preserves lengths.",
                    problem_numbers=["2.20"],
                )
            ],
            "search_queries": ["problem 2.20"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
            "chat_retrieval_memory": {},
        },
        planner_client=planner,
        retriever=postgres,
        broad_retriever=broad,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == ["worked example textbook reading notes method similar rotation matrices like"]
    assert pages[0]["retrieval_mode"] == "gemini_enterprise"
    assert expansion_diagnostics[0]["reference_type"] == "similar_example"
    assert depth == 1


@pytest.mark.asyncio
async def test_reference_expansion_skips_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", raising=False)
    postgres = FakeRetriever([page(chunk_text="Exercise 2.10. The supporting result.", problem_numbers=["2.10"])])

    queries, pages, diagnostics, history, expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [page(chunk_text="Problem 8. Use Exercise 2.10.", problem_numbers=["8"])],
            "search_queries": ["problem 8"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == []
    assert pages == []
    assert diagnostics == []
    assert history == []
    assert expansion_diagnostics == []
    assert depth == 0


@pytest.mark.asyncio
async def test_reference_expansion_dedupes_cycles_and_respects_depth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_ENTERPRISE_REFERENCE_EXPANSION_ENABLED", "true")
    postgres = FakeRetriever(
        [
            page(
                chunk_text="Exercise 2.10. This refers back to Problem 8 and Exercise 2.10.",
                problem_numbers=["2.10"],
            )
        ]
    )

    queries, _pages, _diagnostics, _history, _expansion_diagnostics, depth = await execute_reference_expansion(
        {
            "retrieved_pages": [
                page(
                    chunk_text="Problem 8. Use Exercise 2.10 to finish the argument.",
                    problem_numbers=["8"],
                )
            ],
            "search_queries": ["problem 8"],
            "tool_call_count": 1,
            "reference_expansion_depth": 0,
        },
        retriever=postgres,
        broad_retriever=None,
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert queries == ["exercise 2.10"]
    assert depth <= MAX_REFERENCE_EXPANSION_DEPTH


def test_course_material_filter_includes_scope_visibility_and_exclusion() -> None:
    filter_expression = build_course_material_filter(
        class_id="class-1",
        professor_id="teacher-1",
        active_material_id="material-1",
        active_page_number=3,
        preferred_chunk_types=["example", "formula", "unsafe"],
    )

    assert 'class_id: ANY("class-1")' in filter_expression
    assert 'teacher_id: ANY("teacher-1")' in filter_expression
    assert 'professor_id: ANY("teacher-1")' in filter_expression
    assert 'active_for_students = "true"' in filter_expression
    assert 'teacher_only = "false"' in filter_expression
    assert 'source_table: ANY("pdf_pages")' in filter_expression
    assert 'chunk_type: ANY("example", "formula")' in filter_expression
    assert 'NOT (material_id: ANY("material-1") AND page_number = 3)' in filter_expression


def test_course_material_filter_can_constrain_to_prior_pages_in_active_material() -> None:
    filter_expression = build_course_material_filter(
        class_id="class-1",
        professor_id="teacher-1",
        active_material_id="material-1",
        active_page_number=10,
        active_page_before=10,
        preferred_chunk_types=["example"],
    )

    assert '(material_id: ANY("material-1") AND page_number < 10)' in filter_expression
    assert 'NOT (material_id: ANY("material-1") AND page_number = 10)' not in filter_expression


@pytest.mark.asyncio
async def test_standard_edition_search_payload_uses_chunks_without_enterprise_extractive_features(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("backend.retrieval.gemini_enterprise_search.discovery_engine_access_token", lambda: "token")
    transport = FakeGeminiTransport()
    client = GeminiEnterpriseSearchClient(
        config=GeminiEnterpriseSearchConfig(
            enabled=True,
            project_id="project-1",
            location="global",
            collection_id="default_collection",
            data_store_id="store-1",
            serving_config_id="default_search",
        ),
        transport=transport,
    )

    await client.search(
        query="show me a similar example",
        top_k=5,
        class_id="class-1",
        professor_id="teacher-1",
        intent="needed_example_page",
    )

    content_spec = transport.payloads[0]["contentSearchSpec"]
    assert content_spec["searchResultMode"] == "CHUNKS"
    assert content_spec["snippetSpec"] == {"returnSnippet": True}
    assert "extractiveContentSpec" not in content_spec


def test_gemini_result_normalizes_to_chandra_page_context() -> None:
    normalized = normalize_gemini_enterprise_result(
        {
            "id": "result-1",
            "document": {
                "id": "gemini-doc-1",
                "structData": {
                    "class_id": "class-1",
                    "teacher_id": "teacher-1",
                    "material_id": "material-1",
                    "title": "Lecture Notes",
                    "page_number": 6,
                    "chunk_type": "definition",
                    "problem_numbers": ["2.4"],
                },
                "derivedStructData": {
                    "extractive_answers": [{"pageNumber": "6", "content": "A basis is a linearly independent spanning set."}]
                },
            },
        },
        intent="needed_supporting_page",
    )

    assert normalized["doc_id"] == "material-1"
    assert normalized["title"] == "Lecture Notes"
    assert normalized["page_start"] == 6
    assert normalized["chunk_text"] == "A basis is a linearly independent spanning set."
    assert normalized["retrieval_mode"] == "gemini_enterprise"
    assert normalized["chunk_type"] == "definition"


def test_gemini_chunk_result_normalizes_document_metadata_and_page_span() -> None:
    normalized = normalize_gemini_enterprise_result(
        {
            "id": "result-1",
            "chunk": {
                "name": "projects/p/locations/global/collections/default_collection/dataStores/store/branches/0/documents/gemini-doc-1/chunks/c1",
                "id": "c1",
                "content": "Worked example: solve the formula for x.",
                "documentMetadata": {
                    "title": "Chapter 16 Notes",
                    "structData": {
                        "class_id": "class-1",
                        "teacher_id": "teacher-1",
                        "material_id": "material-1",
                        "title": "Lecture Notes",
                        "chunk_type": "document",
                    },
                },
                "pageSpan": {"pageStart": 12, "pageEnd": 13},
            },
        },
        intent="needed_example_page",
    )

    assert normalized["doc_id"] == "material-1"
    assert normalized["gemini_document_id"] == "gemini-doc-1"
    assert normalized["gemini_chunk_id"] == "c1"
    assert normalized["title"] == "Lecture Notes"
    assert normalized["page_start"] == 12
    assert normalized["page_end"] == 13
    assert normalized["chunk_text"] == "Worked example: solve the formula for x."


def test_gemini_chunk_result_offsets_split_pdf_page_span() -> None:
    normalized = normalize_gemini_enterprise_result(
        {
            "chunk": {
                "name": "projects/p/locations/global/collections/default_collection/dataStores/store/branches/0/documents/gemini-doc-1/chunks/c86",
                "id": "c86",
                "content": "Exercise 14.13. Use the resolvent estimate.",
                "documentMetadata": {
                    "structData": {
                        "class_id": "class-1",
                        "teacher_id": "teacher-1",
                        "material_id": "material-1",
                        "page_number": 355,
                        "page_start": 355,
                        "page_end": 708,
                        "part_number": 2,
                        "source_table": "pdf_materials",
                        "title": "ACME VOL 1 (part 2 of 2)",
                    },
                },
                "pageSpan": {"pageStart": 15, "pageEnd": 16},
            },
        },
        intent="student_requested_problem",
    )

    assert normalized["page_start"] == 369
    assert normalized["page_end"] == 370
    assert normalized["page_number"] == 369


def test_gemini_rank_controls_page_asset_selection_order() -> None:
    selected = select_metadata_pages(
        [
            page(page_start=101, page_end=101, retrieval_mode="gemini_enterprise", score=0.4, gemini_rank=3),
            page(page_start=98, page_end=98, retrieval_mode="gemini_enterprise", score=0.1, gemini_rank=1),
        ]
    )

    assert [item["page_start"] for item in selected] == [98, 101]
