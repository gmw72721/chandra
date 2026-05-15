from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import pytest

import backend.agent.graph as graph_module
import backend.langfuse_prompts as langfuse_prompts
from backend.agent.knowledge import knowledge_items_from_state
from backend.agent.graph import run_pdf_rag_agent, run_pdf_rag_agent_stream


LEGACY_ACTION_SECTION_KEY = "".join(["next", "Step"])


class FakeOpenRouterClient:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def chat(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeStreamingOpenRouterClient(FakeOpenRouterClient):
    async def stream_chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any):
        self.calls.append({"model": model, "messages": messages, **kwargs})
        response = self.responses.pop(0)
        content = str(response.get("content") or "")

        async def stream():
            for index in range(0, len(content), 17):
                yield {"type": "content_delta", "delta": content[index : index + 17]}
            if response.get("finish_reason"):
                yield {"type": "finish", "finish_reason": response.get("finish_reason")}
            if isinstance(response.get("usage"), dict):
                yield {"type": "usage", "usage": response.get("usage")}
            yield {"type": "done", "response": response}

        return stream()


class FakeRetriever:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    async def search(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append(kwargs)
        return self.pages


def ocr_page(**overrides: Any) -> dict[str, Any]:
    page = {
        "chunk_text": "Problem 2.14. Prove rank(KL) <= rank(L).",
        "class_id": "class-linear",
        "doc_id": "material-rank",
        "material_type": "assignment",
        "ocr_confidence": 0.94,
        "ocr_provider": "google-document-ai",
        "ocr_source": "processors/chandra-ocr",
        "page_end": 12,
        "page_start": 12,
        "page_asset_checksum_sha256": "sha256-page-12",
        "page_asset_mime_type": "application/pdf",
        "page_asset_size_bytes": 2048,
        "page_asset_storage_bucket": "bucket",
        "page_asset_storage_path": "classes/class-linear/materials/material-rank/page-assets/page-12.pdf",
        "printed_page_start": 80,
        "professor_id": "teacher-1",
        "problem_numbers": ["2.14"],
        "retrieval_mode": "exact_problem",
        "score": 100.0,
        "source_pdf_path": "gs://bucket/rank.pdf",
        "storage_bucket": "bucket",
        "storage_path": "rank.pdf",
        "title": "Rank Worksheet",
    }
    page.update(overrides)
    return page


@pytest.fixture(autouse=True)
def clear_retrieval_memory_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE.clear()
    monkeypatch.setattr(
        graph_module,
        "read_chat_retrieval_memory",
        lambda state: graph_module.normalize_chat_retrieval_memory(
            graph_module._CHAT_RETRIEVAL_MEMORY_CACHE.get(state.get("conversation_id") or "test", {})
        ),
    )
    monkeypatch.setattr(graph_module, "read_active_problem_context", lambda _state: None)
    monkeypatch.setattr(graph_module, "start_active_problem_context_prefetch", lambda _state: None)
    monkeypatch.setattr(graph_module, "finish_active_problem_context_prefetch", lambda _state: _noop_async())
    monkeypatch.setattr(graph_module, "save_active_problem_context", lambda _context, _state: None)
    monkeypatch.setattr(graph_module, "save_chat_retrieval_memory", lambda memory, state: graph_module._CHAT_RETRIEVAL_MEMORY_CACHE.update({state.get("conversation_id") or "test": memory}))


async def _noop_async() -> None:
    return None


async def _return_async(value: str) -> str:
    return value


def test_normalize_backend_structured_output_unwraps_section_text_objects() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": {"text": "Use the exact wording from the selected page."},
                LEGACY_ACTION_SECTION_KEY: "{'text': 'Send the page or a photo.'}",
            },
            "metadata": {
                "hintLevel": "guided_step",
                "mode": "guided_problem_solving",
                "sourceConfidence": "low",
                "studentActionNeeded": "try_next_step",
            },
        }
    )

    assert structured_output is not None
    assert structured_output["sections"] == {
        "mainChat": "Use the exact wording from the selected page.",
    }


def test_json_problem_context_preserves_internal_tracking_contract() -> None:
    answer = json.dumps(
        {
            "mainText": "Use the statement from the upload.",
            "sections": {},
            "sectionOrder": ["mainText"],
            "metadata": {
                "problemContext": {
                    "relation": "same_problem",
                    "problem": "Problem 4. Find x.",
                    "expected_answer": "x = 2",
                    "source_type": "uploaded_image",
                    "source_document_id": "student-upload.png",
                    "source_page": "1",
                    "confidence": "high",
                }
            },
        }
    )

    context = graph_module.parse_problem_context_from_answer(answer, {}, [])

    assert context["relation"] == "same_problem"
    assert context["problem"] == "Problem 4. Find x."
    assert context["expected_answer"] == "x = 2"
    assert context["source_type"] == "uploaded_image"
    assert context["source_document_id"] == "student-upload.png"
    assert context["source_page"] == 1
    assert context["confidence"] == "high"


def test_json_referenced_sources_preserves_internal_source_tracking_contract() -> None:
    answer = json.dumps(
        {
            "mainText": "That item is on printed page 80.",
            "sections": {"sourceNote": "Rank Worksheet, printed page 80."},
            "sectionOrder": ["mainText", "sourceNote"],
            "metadata": {
                "referencedSources": [
                    {"doc_id": "material-rank", "page": "80", "reason": "matched requested problem"}
                ]
            },
        }
    )

    records = graph_module.referenced_source_records_from_answer(answer)

    assert records == [{"doc_id": "material-rank", "page": 80}]


def test_decision_prompt_searches_source_lookup_before_asking_for_more_detail() -> None:
    heuristic = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="student_requested_problem",
        query="find exact problem page OCR metadata 2.24",
        active_record=None,
        memory_used=False,
    )

    messages = graph_module.build_primary_tutor_messages(
        {
            "answer_policy": {"refuseAnswerOnlyRequests": True},
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "2.24"}],
            "source_usage": {"useClassMaterialsFirst": True},
        },
        heuristic,
    )

    system_prompt = messages[0]["content"]
    assert "Treat heuristic as the default plan" in system_prompt
    assert "bare number, problem/exercise/question/page locator" in system_prompt
    assert "set needs_search true unless active_metadata identifies the exact item" in system_prompt
    assert "do not invent source facts or ask for a page/title/problem text" in system_prompt
    assert "similar-example requests" in system_prompt
    assert "rather than only the assigned problem number" in system_prompt
    assert "Attachment rules" not in system_prompt


def test_primary_payload_excludes_latest_message_from_chat_history() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "messages": [
                {"role": "user", "content": "I need help with problem 2.14."},
                {"role": "assistant", "content": "Let's start with the definition."},
                {"role": "user", "content": "problem 2.18"},
            ],
        },
        {},
    )
    payload = json.loads(messages[-1]["content"])

    assert payload["latest_student_message"] == "problem 2.18"
    assert [item["content"] for item in payload["chat_history"]] == [
        "I need help with problem 2.14.",
        "Let's start with the definition.",
    ]


def test_primary_payload_strips_ocr_text_from_active_metadata() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {
                "active_metadata": ocr_page(
                    chunk_text="Problem 2.14. Prove rank(KL) <= rank(L).",
                    ocr_text="Long OCR body that should not reach the first primary call.",
                    raw_text="Raw extracted text should also be stripped.",
                    problem_numbers=["2.14"],
                )
            },
            "messages": [{"role": "user", "content": "what next?"}],
        },
        {},
    )
    payload = json.loads(messages[-1]["content"])

    assert payload["active_metadata"]["title"] == "Rank Worksheet"
    assert payload["active_metadata"]["problem_numbers"] == ["2.14"]
    serialized = json.dumps(payload["active_metadata"])
    assert "chunk_text" not in serialized
    assert "ocr_text" not in serialized
    assert "raw_text" not in serialized
    assert "Problem 2.14. Prove rank" not in serialized


def test_primary_payload_omits_empty_defaults_and_recent_hint_summaries() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {},
            "debug_options": {},
            "messages": [{"role": "user", "content": "hi"}],
            "source_usage": {},
        },
        {},
    )
    payload = json.loads(messages[-1]["content"])

    assert "active_metadata" not in payload
    assert "active_problem_decision" not in payload
    assert "debug_options" not in payload
    assert "failed_searches" not in payload
    assert "problem_understanding_state" not in payload
    assert "recent_hint_summaries" not in payload
    assert "source_usage" not in payload


def test_primary_prompt_debug_instructions_are_conditional() -> None:
    normal_messages = graph_module.build_primary_tutor_messages(
        {"messages": [{"role": "user", "content": "help me"}]},
        {},
    )
    debug_messages = graph_module.build_primary_tutor_messages(
        {
            "debug_options": {"forceRetrieval": True},
            "messages": [{"role": "user", "content": "help me"}],
        },
        {},
    )

    assert "debug_options.forceRetrieval is true" not in normal_messages[0]["content"]
    assert "debug_options.forceRetrieval is true" in debug_messages[0]["content"]
    assert json.loads(debug_messages[-1]["content"])["debug_options"] == {"forceRetrieval": True}


def test_ambiguous_student_upload_clarification_overrides_search_decision() -> None:
    decision = graph_module.enforce_ambiguous_student_upload_clarification(
        {
            "can_answer_now": False,
            "needs_search": True,
            "query": "find exact problem page OCR metadata here is the problem",
            "retrieval_reason": "student_requested_problem",
            "searches": [
                {
                    "query": "find exact problem page OCR metadata here is the problem",
                    "retrieval_reason": "student_requested_problem",
                    "top_k": 1,
                }
            ],
            "student_response": "I'm checking the class materials for that problem.",
        },
        {
            "chat_retrieval_memory": {},
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "here is the problem\n\n"
                        "Student uploaded homework attachments available for this turn:\n"
                        "1. worksheet.pdf | PDF\n"
                        "Extracted text:\n"
                        "2.14. Prove rank(KL) <= rank(L).\n"
                        "2.15. Find a basis for the image."
                    ),
                }
            ],
            "student_attachment_files": [
                {
                    "fileName": "worksheet.pdf",
                    "fileType": "pdf",
                    "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                    "mimeType": "application/pdf",
                }
            ],
        },
    )

    assert decision["needs_search"] is False
    assert decision["decision_source"] == "student_upload"
    assert decision["searches"] == []
    assert decision["query"] == ""
    assert decision["student_response"] == "Pick the problem you want help with."


def test_ambiguous_student_upload_clarification_keeps_search_when_problem_is_named() -> None:
    original_decision = {
        "can_answer_now": False,
        "needs_search": True,
        "query": "find exact problem page OCR metadata problem 2.14",
        "retrieval_reason": "student_requested_problem",
        "searches": [
            {
                "query": "find exact problem page OCR metadata problem 2.14",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "I'm checking the class materials for that problem.",
    }

    decision = graph_module.enforce_ambiguous_student_upload_clarification(
        original_decision,
        {
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "help me with problem 2.14"}],
            "student_attachment_files": [
                {
                    "fileName": "worksheet.pdf",
                    "fileType": "pdf",
                    "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                    "mimeType": "application/pdf",
                }
            ],
        },
    )

    assert decision is original_decision


def test_terminal_upload_problem_selection_strips_late_search_decision() -> None:
    decision = {
        "can_answer_now": False,
        "needs_search": True,
        "query": "find exact problem page OCR metadata",
        "retrieval_reason": "student_requested_problem",
        "searches": [
            {
                "query": "find exact problem page OCR metadata",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "I can see more than one problem here. Pick the one you want help with.",
        "structuredOutput": {
            "sections": {"answer": "I can see more than one problem here. Pick the one you want help with."},
            "confusionPrompt": "I can see more than one problem here. Pick the one you want help with.",
            "confusionChoices": [
                {"id": "problem-2-14", "label": "2.14", "message": "Help me with problem 2.14 from this upload."},
                {"id": "problem-2-15", "label": "2.15", "message": "Help me with problem 2.15 from this upload."},
            ],
            "metadata": {
                "choiceDisplay": "problem_selection",
                "hintLevel": "none",
                "mode": "clarification",
                "sourceConfidence": "medium",
                "studentActionNeeded": "answer_question",
            },
        },
    }

    fixed = graph_module.enforce_terminal_upload_problem_selection(decision, {"student_attachment_files": []})

    assert fixed["needs_search"] is False
    assert fixed["searches"] == []
    assert fixed["query"] == ""
    assert fixed["structuredOutput"]["metadata"]["choiceDisplay"] == "problem_selection"


def test_langfuse_prompt_helper_falls_back_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_HOST", raising=False)
    langfuse_prompts._get_langfuse_client.cache_clear()

    assert (
        langfuse_prompts.compile_langfuse_text_prompt(
            "chandra/test",
            fallback="local fallback",
            variables={"value": "remote"},
        )
        == "local fallback"
    )


def test_langfuse_prompt_helper_compiles_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakePrompt:
        def compile(self, **variables: str) -> str:
            return f"Hello {variables['student_name']}."

    class FakeClient:
        def get_prompt(self, name: str, **kwargs: Any) -> FakePrompt:
            assert name == "chandra/test"
            assert kwargs["label"] == "production"
            assert kwargs["type"] == "text"
            assert kwargs["fallback"] == "Hello {{student_name}}."
            return FakePrompt()

    monkeypatch.setattr(langfuse_prompts, "_get_langfuse_client", lambda: FakeClient())

    assert (
        langfuse_prompts.compile_langfuse_text_prompt(
            "chandra/test",
            fallback="Hello {{student_name}}.",
            variables={"student_name": "Maya"},
        )
        == "Hello Maya."
    )


def test_search_batch_skips_duplicate_queries_before_execution() -> None:
    state = {"search_queries": ["problem 2.14 rank worksheet"], "tool_call_count": 0}
    tool_calls = [
        {
            "function": {
                "arguments": json.dumps(
                    {
                        "query": "Problem 2.14 rank worksheet",
                        "retrieval_reason": "student_requested_problem",
                    }
                )
            }
        },
        {
            "function": {
                "arguments": json.dumps(
                    {
                        "query": "problem 2.14: rank worksheet!",
                        "retrieval_reason": "student_requested_problem",
                    }
                )
            }
        },
        {
            "function": {
                "arguments": json.dumps(
                    {
                        "query": "rank theorem supporting notes",
                        "retrieval_reason": "needed_supporting_page",
                    }
                )
            }
        },
    ]

    assert graph_module.parse_search_tool_call_batch(state, tool_calls) == [
        ("rank theorem supporting notes", 5, "needed_supporting_page")
    ]


def test_example_search_query_strips_exact_problem_locator_before_execution() -> None:
    tool_calls = [
        {
            "function": {
                "arguments": json.dumps(
                    {
                        "query": "find a similar example for problem 2.14 about rank nullity",
                        "retrieval_reason": "needed_example_page",
                    }
                )
            }
        }
    ]

    [(query, top_k, retrieval_reason)] = graph_module.parse_search_tool_call_batch(
        {"search_queries": [], "tool_call_count": 0},
        tool_calls,
    )

    assert retrieval_reason == "needed_example_page"
    assert top_k == 5
    assert query == "worked example textbook reading notes method about rank nullity"
    assert "problem 2.14" not in query.lower()
    assert graph_module.normalize_query_for_retrieval_reason(query, retrieval_reason) == query


def test_exact_problem_lookup_overrides_misclassified_example_reason() -> None:
    tool_calls = [
        {
            "function": {
                "arguments": json.dumps(
                    {
                        "query": "find problem 3.12",
                        "retrieval_reason": "needed_example_page",
                    }
                )
            }
        }
    ]

    [(query, top_k, retrieval_reason)] = graph_module.parse_search_tool_call_batch(
        {"search_queries": [], "tool_call_count": 0},
        tool_calls,
    )

    assert retrieval_reason == "student_requested_problem"
    assert top_k == 5
    assert query == "find problem 3.12"


def test_example_follow_up_does_not_prepend_active_problem_page() -> None:
    active_page = ocr_page(page_start=98, page_end=98, problem_numbers=["2.14"])
    example_page = ocr_page(
        chunk_text="Example 2.8.17. Use rank-nullity to compare dimensions.",
        page_start=99,
        page_end=99,
        problem_numbers=[],
        retrieval_mode="vector",
    )
    state = {
        "chat_retrieval_memory": {"active_metadata": active_page},
        "retrieval_decision": {
            "memory_used": True,
            "retrieval_reason": "needed_example_page",
            "searches": [{"query": "worked example rank nullity", "retrieval_reason": "needed_example_page"}],
        },
        "retrieved_pages": [example_page],
    }

    pages = graph_module.page_context_records_for_state(state)

    assert pages == [example_page]


def test_example_search_filters_active_problem_page_when_alternatives_exist() -> None:
    active_page = ocr_page(page_start=98, page_end=98, problem_numbers=["2.14"])
    example_page = ocr_page(
        chunk_text="Example 2.8.17. Use rank-nullity to compare dimensions.",
        page_start=99,
        page_end=99,
        problem_numbers=[],
        retrieval_mode="vector",
    )
    state = {"chat_retrieval_memory": {"active_metadata": active_page}}

    pages = graph_module.filter_search_result_for_retrieval_reason(
        [active_page, example_page],
        "needed_example_page",
        state=state,
    )

    assert pages == [example_page]


def test_primary_tutor_turn_can_return_one_search_per_distinct_need() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": False,
                    "needs_search": True,
                    "searches": [
                        {
                            "query": "find exact problem page OCR metadata problem 2.14",
                            "retrieval_reason": "student_requested_problem",
                        },
                        {
                            "query": "textbook reading notes method rank nullity theorem",
                            "retrieval_reason": "needed_supporting_page",
                        },
                        {
                            "query": "find a similar example for problem 2.14 about rank nullity",
                            "retrieval_reason": "needed_example_page",
                        },
                    ],
                    "student_response": "I'm checking the class materials.",
                }
            )
        },
        {},
    )

    assert decision["needs_search"] is True
    assert [search["retrieval_reason"] for search in decision["searches"]] == [
        "student_requested_problem",
        "needed_supporting_page",
        "needed_example_page",
    ]
    assert [search["top_k"] for search in decision["searches"]] == [1, 5, 5]
    assert "problem 2.14" not in decision["searches"][2]["query"].lower()
    assert len(graph_module.retrieval_decision_tool_calls(decision)) == 3


def test_primary_lookup_replaces_locator_echo_with_status_sentence() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": False,
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "problem 2.18",
                    "student_response": "problem 2.18",
                    "structuredOutput": {
                        "sections": {"mainChat": "problem 2.18"},
                        "sectionOrder": ["mainChat"],
                    },
                }
            )
        },
        {},
    )

    assert decision["needs_search"] is True
    assert decision["student_response"] == "I'm checking the class materials for that problem."
    assert decision["structuredOutput"]["sections"] == {
        "mainChat": "I'm checking the class materials for that problem."
    }


def test_primary_lookup_unwraps_json_string_inside_visible_content() -> None:
    inner = {
        "sections": {"mainChat": "I'm checking the class materials for that problem."},
        "sectionOrder": ["mainChat"],
        "metadata": {"problemNumber": "2.18", "problemSummary": "problem lookup"},
    }
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "content": json.dumps(inner),
                    "sections": {"mainChat": json.dumps(inner)},
                    "sectionOrder": ["mainChat"],
                    "metadata": {"problemNumber": "2.18", "problemSummary": "problem lookup"},
                    "can_answer_now": False,
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "problem 2.18",
                    "searches": [
                        {
                            "query": "problem 2.18",
                            "retrieval_reason": "student_requested_problem",
                            "top_k": 1,
                        }
                    ],
                }
            )
        },
        {},
    )

    assert decision["needs_search"] is True
    assert decision["student_response"] == "I'm checking the class materials for that problem."
    assert decision["structuredOutput"] is None
    assert "{" not in decision["student_response"]


def test_decision_json_with_latex_backslashes_is_parsed_not_surfaced() -> None:
    content = json.dumps(
        {
            "can_answer_now": True,
            "needs_search": False,
            "retrieval_reason": "",
            "search_query": "",
            "searches": [],
            "help_level": "guiding_question",
            "student_response": "Start with part (i): compare $\\operatorname{span}(S)$ with $F[x;2].",
            "memory_used": True,
            "structuredOutput": {
                "hint": "Use $\\operatorname{span}(S)$, not the raw list.",
                LEGACY_ACTION_SECTION_KEY: "Can you make $1$, $x$, and $x^2$?",
            },
            "sectionOrder": ["hint", LEGACY_ACTION_SECTION_KEY],
            "metadata": {"problem": "1.7"},
        },
        separators=(",", ":"),
    )

    decision = graph_module.parse_primary_tutor_response(
        {"content": content},
        {},
    )

    assert decision["needs_search"] is False
    assert decision["student_response"] == "Start with part (i): compare $\\operatorname{span}(S)$ with $F[x;2]."
    assert decision["structuredOutput"]["sections"]["hint"] == "Use $\\operatorname{span}(S)$, not the raw list."
    assert not decision["student_response"].startswith("{")


def test_primary_tutor_turn_preserves_two_to_six_valid_confusion_choices() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": True,
                    "needs_search": False,
                    "student_response": "I see a few possible starting points for this rank problem. Pick one and I'll focus there.",
                    "structuredOutput": {
                        "sections": {
                            "answer": "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
                        },
                        "confusionPrompt": "I see a few possible starting points for this rank problem. Pick one and I'll focus there.",
                        "confusionChoices": [
                            {"label": "Notation", "message": "Help me understand the notation."},
                            {"id": "first-step", "label": "First step", "message": "Help me choose the first step."},
                        ],
                    },
                }
            )
        },
        {},
    )

    assert decision["needs_search"] is False
    assert (
        decision["structuredOutput"]["confusionPrompt"]
        == "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
    )
    assert decision["structuredOutput"]["confusionChoices"] == [
        {"id": "choice-1", "label": "Notation", "message": "Help me understand the notation."},
        {"id": "first-step", "label": "First step", "message": "Help me choose the first step."},
    ]


def test_primary_tutor_problem_selection_json_cancels_search() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": False,
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "searches": [
                        {
                            "query": "find exact problem page OCR metadata",
                            "retrieval_reason": "student_requested_problem",
                            "top_k": 1,
                        }
                    ],
                    "student_response": "Pick the problem you want help with.",
                    "structuredOutput": {
                        "sections": {"answer": "Pick the problem you want help with."},
                        "confusionPrompt": "Pick the problem you want help with.",
                        "confusionChoices": [
                            {
                                "id": "problem-2-14",
                                "label": "2.14",
                                "message": "Help me with problem 2.14 from this upload.",
                            },
                            {
                                "id": "problem-2-15",
                                "label": "2.15",
                                "message": "Help me with problem 2.15 from this upload.",
                            },
                        ],
                        "metadata": {
                            "choiceDisplay": "problem_selection",
                            "hintLevel": "none",
                            "mode": "clarification",
                            "sourceConfidence": "medium",
                            "studentActionNeeded": "answer_question",
                        },
                    },
                }
            )
        },
        {
            "decision_source": "search_required",
            "needs_search": True,
            "query": "find exact problem page OCR metadata",
            "retrieval_reason": "student_requested_problem",
            "search_query": "find exact problem page OCR metadata",
            "searches": [
                {
                    "query": "find exact problem page OCR metadata",
                    "retrieval_reason": "student_requested_problem",
                    "top_k": 1,
                }
            ],
            "top_k": 1,
        },
    )

    assert decision["needs_search"] is False
    assert decision["searches"] == []
    assert graph_module.retrieval_decision_tool_calls(decision) == []
    assert decision["structuredOutput"]["metadata"]["choiceDisplay"] == "problem_selection"
    assert [choice["label"] for choice in decision["structuredOutput"]["confusionChoices"]] == ["2.14", "2.15"]


def test_generic_upload_problem_pick_prompt_cancels_search() -> None:
    decision = {
        "can_answer_now": False,
        "decision_source": "search_required",
        "needs_search": True,
        "query": "find exact problem page OCR metadata",
        "retrieval_reason": "student_requested_problem",
        "search_query": "find exact problem page OCR metadata",
        "searches": [
            {
                "query": "find exact problem page OCR metadata",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "Pick the problem you want help with.",
        "top_k": 1,
    }
    state = {
        "messages": [{"role": "user", "content": "Can you help me with this attached homework material?"}],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    }

    fixed = graph_module.enforce_ambiguous_student_upload_clarification(decision, state)

    assert fixed["needs_search"] is False
    assert fixed["searches"] == []
    assert graph_module.retrieval_decision_tool_calls(fixed) == []
    assert fixed["student_response"] == "Pick the problem you want help with."
    assert "confusionChoices" not in fixed["structuredOutput"]


def test_existing_problem_selection_json_choices_are_preserved() -> None:
    structured_output = {
        "sections": {"answer": "This page has several exercises. Which one should we start with?"},
        "confusionPrompt": "This page has several exercises. Which one should we start with?",
        "confusionChoices": [
            {"id": "problem-2-14", "label": "2.14", "message": "Help me with problem 2.14 from this upload."},
            {"id": "problem-2-15", "label": "2.15", "message": "Help me with problem 2.15 from this upload."},
            {"id": "problem-2-16", "label": "2.16", "message": "Help me with problem 2.16 from this upload."},
        ],
        "metadata": {
            "choiceDisplay": "problem_selection",
            "hintLevel": "none",
            "mode": "clarification",
            "sourceConfidence": "medium",
            "studentActionNeeded": "answer_question",
        },
    }
    decision = {
        "can_answer_now": False,
        "decision_source": "search_required",
        "needs_search": True,
        "query": "find exact problem page OCR metadata",
        "retrieval_reason": "student_requested_problem",
        "search_query": "find exact problem page OCR metadata",
        "searches": [
            {
                "query": "find exact problem page OCR metadata",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "This page has several exercises. Which one should we start with?",
        "structuredOutput": graph_module.normalize_backend_structured_output(structured_output),
        "top_k": 1,
    }
    state = {
        "messages": [{"role": "user", "content": "Can you help me with this attached homework material?"}],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "mimeType": "application/pdf",
            }
        ],
    }

    fixed = graph_module.enforce_ambiguous_student_upload_clarification(decision, state)

    assert fixed["needs_search"] is False
    assert graph_module.retrieval_decision_tool_calls(fixed) == []
    assert fixed["structuredOutput"]["confusionPrompt"] == "This page has several exercises. Which one should we start with?"
    assert [choice["label"] for choice in fixed["structuredOutput"]["confusionChoices"]] == ["2.14", "2.15", "2.16"]


def test_selected_upload_problem_number_cancels_search_and_sets_problem_section() -> None:
    decision = {
        "can_answer_now": False,
        "decision_source": "search_required",
        "needs_search": True,
        "query": "find exact task in assignment problem 2.14",
        "retrieval_reason": "student_requested_problem",
        "search_query": "find exact task in assignment problem 2.14",
        "searches": [
            {
                "query": "find exact task in assignment problem 2.14",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "I'm checking the class materials for that problem.",
        "top_k": 1,
    }
    state = {
        "messages": [{"role": "user", "content": "Help me with problem 2.14 from this upload."}],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    }

    fixed = graph_module.enforce_selected_upload_problem_response(decision, state)

    assert fixed["needs_search"] is False
    assert fixed["searches"] == []
    assert graph_module.retrieval_decision_tool_calls(fixed) == []
    assert fixed["decision_source"] == "student_upload"
    assert fixed["structuredOutput"]["sections"]["problem"] == "2.14. Prove rank(KL) <= rank(L)."
    assert fixed["structuredOutput"]["metadata"]["problemNumber"] == "2.14"


def test_selected_upload_problem_without_problem_evidence_keeps_search_decision() -> None:
    decision = {
        "can_answer_now": False,
        "decision_source": "search_required",
        "needs_search": True,
        "query": "find exact task in assignment problem 2.14",
        "retrieval_reason": "student_requested_problem",
        "search_query": "find exact task in assignment problem 2.14",
        "searches": [
            {
                "query": "find exact task in assignment problem 2.14",
                "retrieval_reason": "student_requested_problem",
                "top_k": 1,
            }
        ],
        "student_response": "For 2.14, compare images and use rank-nullity.",
        "top_k": 1,
    }
    state = {
        "messages": [{"role": "user", "content": "Help me with problem 2.14 from this upload."}],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    }

    fixed = graph_module.enforce_selected_upload_problem_response(decision, state)

    assert fixed is decision
    assert fixed["needs_search"] is True


def test_bare_problem_number_after_upload_problem_selection_uses_upload_context() -> None:
    state = {
        "messages": [
            {
                "role": "assistant",
                "content": "Pick the problem you want help with.",
                "structuredOutput": {
                    "sections": {"answer": "Pick the problem you want help with."},
                    "confusionPrompt": "Pick the problem you want help with.",
                    "confusionChoices": [
                        {
                            "id": "problem-2-14",
                            "label": "2.14",
                            "message": "Help me with problem 2.14 from this upload.",
                        },
                        {
                            "id": "problem-2-15",
                            "label": "2.15",
                            "message": "Help me with problem 2.15 from this upload.",
                        },
                    ],
                    "metadata": {
                        "choiceDisplay": "problem_selection",
                        "hintLevel": "none",
                        "mode": "clarification",
                        "sourceConfidence": "medium",
                        "studentActionNeeded": "answer_question",
                    },
                },
            },
            {"role": "user", "content": "2.14"},
        ],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    }

    assert graph_module.selected_upload_problem_numbers(state) == ["2.14"]


def test_forced_initial_search_skips_selected_upload_problem_number() -> None:
    decision = {"needs_search": False, "student_response": "Use the uploaded problem text."}
    state = {
        "messages": [{"role": "user", "content": "Help me with problem 2.14 from this upload."}],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    }

    fixed = graph_module.enforce_initial_source_lookup_search(decision, state)

    assert fixed is decision
    assert graph_module.forced_initial_search_tool_call(state) is not None


def test_primary_tutor_turn_drops_choice_counts_outside_two_to_five() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {"answer": "Pick a direction."},
            "confusionChoices": [
                {"id": "one", "label": "One", "message": "Help me with one."},
            ],
        }
    )

    assert structured_output is not None
    assert "confusionChoices" not in structured_output


def test_decision_prompt_says_choices_are_not_triggered_by_student_confusion_keywords() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "I'm lost"}],
        },
        {},
    )

    system_prompt = messages[0]["content"]
    assert "Uncertainty choices" in system_prompt
    assert "Do not trigger them just because the student says they are lost/confused/stuck" in system_prompt
    assert "prefer a normal nudge or focused question" in system_prompt


def test_decision_prompt_can_force_real_confusion_choices_for_teacher_debug() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {},
            "debug_options": {"forceConfusionChoices": True},
            "messages": [{"role": "user", "content": "help me"}],
        },
        {},
    )

    system_prompt = messages[0]["content"]
    payload = json.loads(messages[1]["content"])

    assert "debug_options.forceConfusionChoices is true" in system_prompt
    assert "hard same-call output requirement" in system_prompt
    assert "Return needs_search false" in system_prompt
    assert "Do not answer the academic question normally" in system_prompt
    assert "structuredOutput.confusionPrompt" in system_prompt
    assert "2 to 6 context-specific structuredOutput.confusionChoices" in system_prompt
    assert "Unless retrieval is required first" not in system_prompt
    assert payload["debug_options"] == {"forceConfusionChoices": True}


def test_decision_prompt_can_force_retrieval_for_teacher_debug() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {},
            "debug_options": {"forceRetrieval": True},
            "messages": [{"role": "user", "content": "explain the rank nullity theorem"}],
        },
        {},
    )

    system_prompt = messages[0]["content"]
    payload = json.loads(messages[1]["content"])

    assert "debug_options.forceRetrieval is true" in system_prompt
    assert "Return needs_search true" in system_prompt
    assert "at least one searches entry with a non-empty query" in system_prompt
    assert payload["debug_options"] == {"forceRetrieval": True}


def test_decision_prompt_can_force_no_retrieval_for_teacher_debug() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "chat_retrieval_memory": {},
            "debug_options": {"forceNoRetrieval": True},
            "messages": [{"role": "user", "content": "what does problem 2.14 say?"}],
        },
        {},
    )

    system_prompt = messages[0]["content"]
    payload = json.loads(messages[1]["content"])

    assert "debug_options.forceNoRetrieval is true" in system_prompt
    assert "Do not retrieve for this turn" in system_prompt
    assert "Return needs_search false" in system_prompt
    assert payload["debug_options"] == {"forceNoRetrieval": True}


def test_debug_force_retrieval_overrides_chat_memory_decision() -> None:
    decision = graph_module.enforce_debug_retrieval_options(
        {
            "can_answer_now": True,
            "decision_source": "chat_memory",
            "memory_used": True,
            "needs_search": False,
            "student_response": "Use rank-nullity here.",
        },
        {
            "chat_retrieval_memory": {},
            "debug_options": {"forceRetrieval": True},
            "messages": [{"role": "user", "content": "explain rank nullity"}],
        },
    )

    assert decision["needs_search"] is True
    assert decision["can_answer_now"] is False
    assert decision["searches"][0]["query"]
    assert decision["retrieval_reason"] in graph_module.ALLOWED_RETRIEVAL_REASONS


def test_debug_force_no_retrieval_overrides_search_decision() -> None:
    decision = graph_module.enforce_debug_retrieval_options(
        {
            "can_answer_now": False,
            "decision_source": "search_required",
            "memory_used": False,
            "needs_search": True,
            "query": "find exact problem page OCR metadata problem 2.14",
            "retrieval_reason": "student_requested_problem",
            "searches": [
                {
                    "query": "find exact problem page OCR metadata problem 2.14",
                    "retrieval_reason": "student_requested_problem",
                    "top_k": 1,
                }
            ],
            "student_response": "I'm checking the class materials for that problem.",
        },
        {
            "debug_options": {"forceNoRetrieval": True},
            "messages": [{"role": "user", "content": "what does problem 2.14 say?"}],
        },
    )

    assert decision["needs_search"] is False
    assert decision["searches"] == []
    assert decision["query"] == ""
    assert "debug mode" in decision["student_response"]


@pytest.mark.asyncio
async def test_ambiguous_student_upload_does_not_search_class_materials() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "searches": [
                            {
                                "query": "find exact problem page OCR metadata here is the problem",
                                "retrieval_reason": "student_requested_problem",
                                "top_k": 1,
                            }
                        ],
                        "student_response": "I'm checking the class materials for that problem.",
                    }
                )
            }
        ]
    )
    retriever = FakeRetriever([ocr_page()])

    response = await run_pdf_rag_agent(
        messages=[
            {
                "role": "user",
                "content": (
                    "here is the problem\n\n"
                    "Student uploaded homework attachments available for this turn:\n"
                    "1. worksheet.pdf | PDF\n"
                    "Extracted text:\n"
                    "2.14. Prove rank(KL) <= rank(L).\n"
                    "2.15. Find a basis for the image."
                ),
            }
        ],
        model="openai/gpt-5.4-mini",
        openrouter_client=client,
        retriever=retriever,
        student_attachment_files=[
            {
                "fileName": "worksheet.pdf",
                "fileType": "pdf",
                "extractedText": "2.14. Prove rank(KL) <= rank(L).\n2.15. Find a basis for the image.",
                "mimeType": "application/pdf",
            }
        ],
    )

    assert retriever.calls == []
    assert response["langGraphTrace"]["toolCallCount"] == 0
    assert response["langGraphTrace"]["searchQueries"] == []
    assert response["langGraphTrace"]["decisionSource"] == "student_upload"
    assert response["content"] == "Pick the problem you want help with."
    assert "confusionChoices" not in response["structuredOutput"]


@pytest.mark.asyncio
async def test_streaming_upload_problem_selection_ends_after_first_model_call() -> None:
    selection_text = (
        "I can help, but this page has several exercises. Which one do you want to work on: "
        "2.14, 2.15, 2.16*, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, or 2.23?"
    )
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "searches": [
                            {
                                "query": "find exact problem page OCR metadata attached homework",
                                "retrieval_reason": "student_requested_problem",
                                "top_k": 1,
                            }
                        ],
                        "student_response": selection_text,
                        "structuredOutput": {
                            "sections": {"answer": "This page has several exercises. Which one do you want to work on?"},
                            "confusionPrompt": "This page has several exercises. Which one do you want to work on?",
                            "confusionChoices": [
                                {
                                    "id": f"problem-2-{number}",
                                    "label": f"2.{number}",
                                    "message": f"Help me with problem 2.{number} from this upload.",
                                }
                                for number in range(14, 24)
                            ],
                            "metadata": {
                                "choiceDisplay": "problem_selection",
                                "hintLevel": "none",
                                "mode": "clarification",
                                "sourceConfidence": "medium",
                                "studentActionNeeded": "answer_question",
                            },
                        },
                    }
                )
            },
            {"content": "This second model call should not happen."},
        ]
    )
    retriever = FakeRetriever([ocr_page()])

    events = []
    async for event in run_pdf_rag_agent_stream(
        messages=[{"role": "user", "content": "Can you help me with this attached homework material?"}],
        model="openai/gpt-5.4-mini",
        openrouter_client=client,
        retriever=retriever,
        student_attachment_files=[
            {
                "fileName": "worksheet.pdf",
                "mimeType": "application/pdf",
            }
        ],
    ):
        events.append(event)

    assert len(client.calls) == 1
    assert retriever.calls == []
    assert not any(event.get("type") == "search_batch" for event in events)
    assert not any(event.get("stage") == "preparing_context_grounded_answer" for event in events)
    final_payload = [event["payload"] for event in events if event.get("type") == "final"][0]
    assert final_payload["langGraphTrace"]["searchQueries"] == []
    assert final_payload["structuredOutput"]["metadata"]["choiceDisplay"] == "problem_selection"
    assert final_payload["structuredOutput"]["sections"]["mainChat"] == (
        "This page has several exercises. Which one do you want to work on?"
    )
    assert [choice["label"] for choice in final_payload["structuredOutput"]["confusionChoices"]] == [
        "2.14",
        "2.15",
        "2.16",
        "2.17",
        "2.18",
        "2.19",
        "2.20",
        "2.21",
        "2.22",
        "2.23",
    ]


@pytest.mark.asyncio
async def test_debug_forced_confusion_choices_become_the_response() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "activeProblemDecision": {
                            "isActualProblem": True,
                            "problemText": "Problem 2.14. Prove rank(KL) <= rank(L).",
                            "problemSource": "student_upload",
                            "relationToPreviousProblem": "new_problem",
                            "confidence": "high",
                            "reason": "The uploaded PDF text contains a complete exercise statement.",
                        },
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can help with Problem 2.14, but I need to know which part you want to start with.",
                        "structuredOutput": {
                            "sections": {
                                "answer": "I can help with Problem 2.14, but I need to know which part you want to start with.",
                                LEGACY_ACTION_SECTION_KEY: "Choose one: the setup from Exercise 2.13, part (i), or part (ii).",
                            },
                            "confusionPrompt": (
                                "I see a few possible starting points for this rank problem. "
                                "Pick one and I'll focus there."
                            ),
                            "confusionChoices": [
                                {
                                    "id": "setup",
                                    "label": "Map setup",
                                    "message": "Help me identify the spaces and maps in this rank problem.",
                                },
                                {
                                    "id": "image",
                                    "label": "Image idea",
                                    "message": "Help me understand which image containment to use.",
                                },
                                {
                                    "id": "work",
                                    "label": "My attempt",
                                    "message": "Help me check the proof step I wrote.",
                                },
                            ],
                            "metadata": {
                                "hintLevel": "small_hint",
                                "mode": "clarification",
                                "sourceConfidence": "low",
                                "studentActionNeeded": "answer_question",
                            },
                        },
                    }
                )
            }
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-debug-choices",
        debug_options={"forceConfusionChoices": True},
        messages=[{"role": "user", "content": "help me"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    assert len(client.calls) == 1
    assert response["content"] == (
        "I can help with Problem 2.14, but I need to know which part you want to start with.\n\n"
        "Choose one: the setup from Exercise 2.13, part (i), or part (ii)."
    )
    assert response["structuredOutput"]["sections"] == {
        "mainChat": response["content"]
    }
    assert response["structuredOutput"]["confusionPrompt"] == (
        "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
    )
    assert [choice["label"] for choice in response["structuredOutput"]["confusionChoices"]] == [
        "Map setup",
        "Image idea",
        "My attempt",
    ]
    assert "Hint:" not in response["content"]
    assert LEGACY_ACTION_SECTION_KEY not in response["structuredOutput"]["sections"]


def test_retrieval_needed_decision_does_not_preserve_confusion_choices() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": False,
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "find exact problem page OCR metadata problem 2.14",
                    "student_response": "Pick a direction.",
                    "structuredOutput": {
                        "sections": {"answer": "Pick a direction."},
                        "confusionPrompt": "Pick one.",
                        "confusionChoices": [
                            {"id": "one", "label": "One", "message": "Help me with one."},
                            {"id": "two", "label": "Two", "message": "Help me with two."},
                            {"id": "three", "label": "Three", "message": "Help me with three."},
                            {"id": "four", "label": "Four", "message": "Help me with four."},
                        ],
                    },
                }
            )
        },
        {},
    )

    assert decision["needs_search"] is True
    assert decision["structuredOutput"] is None
    assert decision["student_response"] == "Pick a direction."


def test_debug_forced_confusion_choices_preserves_same_call_llm_choices() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": False,
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "problem 2.18",
                    "searches": [
                        {
                            "query": "problem 2.18",
                            "retrieval_reason": "student_requested_problem",
                            "top_k": 1,
                        }
                    ],
                    "student_response": "What would help most with problem 2.18?",
                    "structuredOutput": {
                        "sections": {"mainChat": "What would help most with problem 2.18?"},
                        "confusionPrompt": "What would help most with problem 2.18?",
                        "confusionChoices": [
                            {
                                "id": "attempt",
                                "label": "Show your attempt",
                                "description": "I'll check your setup.",
                                "message": "Here is what I tried for problem 2.18: ",
                            },
                            {
                                "id": "setup",
                                "label": "Help with setup",
                                "description": "I'll help build the matrix column by column.",
                                "message": "Help me set up problem 2.18.",
                            },
                        ],
                    },
                }
            )
        },
        {},
        preserve_confusion_choices_on_search=True,
    )

    assert decision["needs_search"] is False
    assert decision["searches"] == []
    assert decision["search_query"] == ""
    assert decision["student_response"] == "What would help most with problem 2.18?"
    assert [choice["label"] for choice in decision["structuredOutput"]["confusionChoices"]] == [
        "Show your attempt",
        "Help with setup",
    ]


def test_uploaded_multi_problem_clarification_does_not_synthesize_focus_choices() -> None:
    answer = "I can see several exercises on the page, so I'm not sure which one you want help with."
    state = {
        "messages": [{"role": "user", "content": "this one"}],
        "retrieval_confidence": "medium",
        "selected_metadata_records": [
            ocr_page(
                chunk_text="2.1. Find the eigenvalues.\n2.2. Solve the system.\n2.3. Compute the determinant.",
                problem_numbers=["2.1", "2.2", "2.3"],
            )
        ],
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "mimeType": "application/pdf",
                "extractedText": "2.1. Find the eigenvalues.\n2.2. Solve the system.\n2.3. Compute the determinant.",
            }
        ],
    }

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert response["content"] == answer
    assert "confusionPrompt" not in response["structuredOutput"]
    assert response["structuredOutput"]["metadata"]["mode"] == "guided_problem_solving"
    assert response["structuredOutput"]["metadata"]["studentActionNeeded"] == "try_next_step"
    assert "choiceDisplay" not in response["structuredOutput"]["metadata"]
    assert "confusionChoices" not in response["structuredOutput"]
    assert "why" not in response["structuredOutput"]["sections"]["mainChat"].lower()


def test_uploaded_multi_problem_clarification_does_not_synthesize_detected_problems() -> None:
    answer = "This page has several exercises. Which one do you want help with?"
    problem_numbers = [f"2.{number}" for number in range(14, 24)]
    extracted_text = "\n".join(f"{number}. Problem statement." for number in problem_numbers)
    state = {
        "messages": [{"role": "user", "content": "help me start"}],
        "retrieval_confidence": "medium",
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "mimeType": "application/pdf",
                "extractedText": extracted_text,
            }
        ],
    }

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert "choiceDisplay" not in response["structuredOutput"]["metadata"]
    assert "confusionChoices" not in response["structuredOutput"]


def test_problem_lookup_final_response_replaces_locator_echo_main_chat() -> None:
    state = {
        "messages": [{"role": "user", "content": "problem 2.18"}],
        "retrieval_confidence": "high",
        "retrieval_decision": {"retrieval_reason": "student_requested_problem"},
        "retrieved_pages": [
            ocr_page(
                chunk_text="2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
                printed_page_start=98,
                problem_numbers=["2.18"],
                title="ACME VOL 1",
            )
        ],
    }
    answer = json.dumps(
        {
            "sections": {
                "mainChat": "problem 2.18",
                "problem": "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
            },
            "sectionOrder": ["mainChat", "problem"],
            "metadata": {
                "hintLevel": "none",
                "mode": "source_lookup",
                "studentActionNeeded": "review_source",
            },
        }
    )

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert response["structuredOutput"]["sections"]["mainChat"] == (
        "I found the matching item in ACME VOL 1 on printed page 98."
    )
    assert response["structuredOutput"]["sections"]["problem"].startswith("2.18. Assuming")
    assert response["structuredOutput"]["sectionOrder"][:2] == ["mainChat", "problem"]
    assert "problem 2.18" not in response["content"].lower()


def test_model_listed_problem_numbers_do_not_become_problem_buttons_without_json() -> None:
    state = {
        "messages": [{"role": "user", "content": "Can you help me with this attached homework material?"}],
        "retrieval_confidence": "medium",
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "mimeType": "application/pdf",
            }
        ],
        "retrieval_decision": {},
    }
    answer = (
        "I can help, but this page has several exercises. Which one do you want to work on: "
        "2.14, 2.15, 2.16*, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, or 2.23?"
    )

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert "choiceDisplay" not in response["structuredOutput"]["metadata"]
    assert "confusionChoices" not in response["structuredOutput"]


def test_numbered_exercise_claim_does_not_fall_back_to_position_buttons() -> None:
    state = {
        "messages": [{"role": "user", "content": "Can you help me with this attached homework material?"}],
        "retrieval_confidence": "medium",
        "student_attachment_files": [
            {
                "fileName": "worksheet.pdf",
                "mimeType": "application/pdf",
            }
        ],
        "retrieval_decision": {},
    }
    answer = "I can see several numbered exercises on the page, so I'm not sure which one you want help with yet."

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert "confusionChoices" not in response["structuredOutput"]


def test_uncited_selected_page_is_not_returned_as_visible_source() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [{"role": "user", "content": "this one"}],
            "page_assets": [ocr_page(title="ACME Vol 1", page_start=12, page_end=12, printed_page_start=None)],
            "retrieval_decision": {},
        },
        "I can see several exercises on the page, so I'm not sure which one you want help with.",
    )

    assert response["sources"] == []


def test_multiple_model_referenced_pages_are_returned_as_visible_sources() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [{"role": "user", "content": "help with these examples"}],
            "page_assets": [
                ocr_page(doc_id="material-acme-12", title="ACME Vol 1", page_start=12, page_end=12),
                ocr_page(doc_id="material-acme-13", title="ACME Vol 1", page_start=13, page_end=13, printed_page_start=81),
            ],
            "retrieval_decision": {},
        },
        (
            "Compare the setup on the two selected pages before choosing the exercise.\n\n"
            "Referenced sources:\n"
            "doc_id: material-acme-12; page: 80; reason: first selected page\n"
            "doc_id: material-acme-13; page: 81; reason: second selected page"
        ),
    )

    assert [source["sourceId"] for source in response["sources"]] == ["material-acme-12", "material-acme-13"]
    assert [source["pageNumber"] for source in response["sources"]] == [80, 81]
    assert "Referenced sources:" not in response["content"]


def test_uploaded_problem_image_without_numbers_does_not_get_fallback_position_choices() -> None:
    answer = "I can see multiple problems in the image, so I'm not sure which one you want help with."
    state = {
        "messages": [{"role": "user", "content": "help with this"}],
        "student_attachment_files": [
            {
                "dataUrl": "data:image/png;base64,abc",
                "fileName": "problems.png",
                "mimeType": "image/png",
                "summary": "An uploaded worksheet image with multiple visible problems.",
            }
        ],
    }

    response = graph_module.pdf_rag_response_from_state(state, answer)

    assert "confusionChoices" not in response["structuredOutput"]
    assert "why" not in response["structuredOutput"]["sections"]["mainChat"].lower()


def test_example_request_model_no_search_decision_is_preserved() -> None:
    fallback = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="needed_example_page",
        query="worked example textbook reading notes method OCR metadata ACME VOL 1 show me an example",
        active_record=ocr_page(title="ACME VOL 1"),
        memory_used=False,
    )

    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": True,
                    "needs_search": False,
                    "help_level": "refusal_with_hint",
                    "student_response": "I can't give a worked example here.",
                }
            )
        },
        fallback,
    )

    assert decision["needs_search"] is False
    assert decision["can_answer_now"] is True
    assert decision["retrieval_reason"] == ""
    assert decision["student_response"] == "I can't give a worked example here."
    assert decision["searches"] == []


def test_decision_prompt_passes_retrieval_memory_and_policy_but_not_pdf_assets() -> None:
    state = {
        "answer_policy": {"requireAttemptBeforeAnswer": True},
        "chat_retrieval_memory": {
            "active_metadata": ocr_page(title="ACME VOL 1", problem_numbers=["1.7"]),
            "failed_searches": [{"query": "missing example"}],
        },
        "messages": [
            {"role": "assistant", "content": "Problem 1.7. Which sets span F[x;2]?"},
            {"role": "user", "content": "what's next"},
        ],
        "page_assets": [{"file_data_url": "data:application/pdf;base64,abc"}],
        "source_usage": {"useClassMaterialsFirst": True},
    }
    heuristic = graph_module.build_retrieval_decision(state)

    messages = graph_module.build_primary_tutor_messages(state, heuristic)
    payload = json.loads(messages[-1]["content"])

    assert payload["active_metadata"]["title"] == "ACME VOL 1"
    assert payload["active_metadata"]["problem_numbers"] == ["1.7"]
    assert payload["failed_searches"] == [{"query": "missing example"}]
    assert payload["answer_policy"]["refuseAnswerOnlyRequests"] is True
    assert payload["answer_policy"]["helpLimitsByUnderstandingLevel"]["0"] == "ask_for_attempt_only"
    assert payload["source_usage"] == {"useClassMaterialsFirst": True}
    assert payload["latest_student_message"] == "what's next"
    assert "file_data_url" not in messages[-1]["content"]


def test_example_followup_marks_active_metadata_memory_used() -> None:
    decision = graph_module.build_retrieval_decision(
        {
            "chat_retrieval_memory": {
                "active_metadata": ocr_page(title="ACME VOL 1", problem_numbers=["1.7"]),
            },
            "messages": [{"role": "user", "content": "show me an example"}],
        }
    )

    assert decision["needs_search"] is True
    assert decision["retrieval_reason"] == "needed_example_page"
    assert decision["memory_used"] is True
    assert decision["active_problem_numbers"] == ["1.7"]


def test_referenced_exercise_support_intent_uses_supporting_retrieval_terms() -> None:
    memory = {
        "active_metadata": ocr_page(
            chunk_text=(
                "Exercise 2.18. Assuming the polynomial bases [1, x, x^2] and "
                "[1, x, x^2, x^3, x^4] for F[x;2] and F[x;4], respectively, "
                "find the matrix representations for each of the linear transformations in Exercise 2.3."
            ),
            problem_numbers=["2.18"],
            title="Linear Algebra Text",
        )
    }
    message = "Let's start with the first transformation from Exercise 2.3. look for class materials"

    assert graph_module.retrieval_reason_for_message(message, memory) == "needed_supporting_page"
    query = graph_module.focused_ocr_search_query(message, memory)
    assert query.startswith("textbook reading notes method OCR metadata Linear Algebra Text")
    assert "find exact problem page" not in query


def test_referenced_exercise_support_intent_does_not_force_exact_initial_search() -> None:
    state = {
        "chat_retrieval_memory": {
            "active_metadata": ocr_page(
                chunk_text=(
                    "Exercise 2.18. Assuming the polynomial bases [1, x, x^2] and "
                    "[1, x, x^2, x^3, x^4] for F[x;2] and F[x;4], respectively, "
                    "find the matrix representations for each of the linear transformations in Exercise 2.3."
                ),
                problem_numbers=["2.18"],
            )
        },
        "messages": [
            {
                "role": "user",
                "content": "Let's start with the first transformation from Exercise 2.3. look for class materials",
            }
        ],
    }

    assert graph_module.should_force_exact_problem_search(state) is False


def test_first_llm_prompt_owns_tutor_plan_and_state_updates() -> None:
    state = {
        "answer_policy": {"refuseAnswerOnlyRequests": True},
        "chat_retrieval_memory": {
            "active_metadata": ocr_page(
                chunk_text=(
                    "Problem 3.9. Prove that a rotation (2.17) in R^2 is an "
                    "orthonormal transformation with respect to the usual inner product."
                ),
                problem_numbers=["3.9"],
            ),
        },
        "messages": [
            {
                "role": "assistant",
                "content": (
                    "Problem 3.9. Prove that a rotation (2.17) in R^2 is an "
                    "orthonormal transformation with respect to the usual inner product."
                ),
            },
            {"role": "user", "content": "help me"},
        ],
    }
    heuristic = graph_module.build_retrieval_decision(state)

    messages = graph_module.build_primary_tutor_messages(state, heuristic)
    payload = json.loads(messages[-1]["content"])
    system_prompt = messages[0]["content"]

    assert "tutorPlan" in system_prompt
    assert "You own tutor state updates in this first step" in system_prompt
    assert "stateUpdates.understandingLevel" in system_prompt
    assert payload["problem_understanding_state"]["activeProblemId"] != ""
    assert payload["latest_student_message"] == "help me"


def test_first_vague_help_plan_depth_one_updates_understanding_state() -> None:
    active = ocr_page(
        chunk_text=(
            "Problem 3.9. Prove that a rotation (2.17) in R^2 is an "
            "orthonormal transformation with respect to the usual inner product."
        ),
        problem_numbers=["3.9"],
    )
    fallback = graph_module.retrieval_decision(
        decision_source="chat_memory",
        needs_search=False,
        retrieval_reason="",
        query="",
        active_record=active,
        memory_used=True,
    )
    problem_id = fallback["tutorPlan"]["activeProblemId"]

    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "can_answer_now": True,
                    "memory_used": True,
                    "needs_search": False,
                    "student_response": (
                        "To prove the rotation is orthonormal, focus on the columns of the rotation matrix. "
                        "What are the two columns of the rotation matrix in (2.17), and what are their lengths?"
                    ),
                    "tutorPlan": {
                        "activeProblemId": problem_id,
                        "studentIntent": "vague_help",
                        "needsRetrieval": False,
                        "currentUnderstandingLevel": 0,
                        "nextHelpDepth": 1,
                        "answerSeekingRisk": "low",
                        "responseStrategy": "Give one light nudge about columns and ask one targeted question.",
                        "shouldAskQuestion": True,
                        "shouldGiveWorkedStep": False,
                        "shouldAvoidFullSolution": True,
                        "stateUpdates": {
                            "understandingLevel": 1,
                            "lastHelpDepth": 1,
                            "hintsGiven": 1,
                            "lastHintSummary": "Focused the student on rotation matrix columns and their lengths.",
                        },
                    },
                }
            )
        },
        fallback,
    )
    state = {
        "chat_retrieval_memory": {"active_metadata": active},
        "conversation_id": "conv-3-9",
        "messages": [{"role": "user", "content": "help me"}],
        "retrieval_decision": decision,
        "tutor_plan": decision["tutorPlan"],
    }

    understanding = graph_module.state_after_tutor_plan(state, decision["tutorPlan"])

    assert decision["tutorPlan"]["nextHelpDepth"] == 1
    assert understanding["understandingLevel"] == 1
    assert understanding["lastHelpDepth"] == 1
    assert understanding["hintsGiven"] == 1
    assert "columns" in understanding["lastHintSummary"]
    assert "directly verify" not in decision["student_response"]
    assert "<Ru" not in decision["student_response"]


def test_repeated_stuck_plan_can_escalate_help_without_increasing_understanding() -> None:
    active = ocr_page(problem_numbers=["3.9"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "chatId": "conv-repeat",
        "activeProblemId": problem_id,
        "understandingLevel": 1,
        "attemptsCount": 0,
        "hintsGiven": 1,
        "lastHelpDepth": 1,
        "conceptsUnderstood": [],
        "knownConfusions": [],
        "repeatedStuckSignals": 0,
        "answerSeekingRisk": "low",
        "lastHintSummary": "Focused on the columns of the rotation matrix.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-repeat",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "I still don't get it"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "vague_help",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 2,
            "lastHelpDepth": 2,
            "hintsGiven": 2,
            "repeatedStuckSignals": 1,
            "lastHintSummary": "Guided the student to test column lengths and their dot product.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["repeatedStuckSignals"] == 1
    assert understanding["hintsGiven"] == 2
    assert understanding["lastHelpDepth"] == 2
    assert understanding["understandingLevel"] == 1


def test_help_limit_clamps_tutor_plan_depth_for_effective_understanding_level() -> None:
    plan = {
        "currentUnderstandingLevel": 1,
        "nextHelpDepth": 4,
        "shouldAskQuestion": False,
        "shouldGiveWorkedStep": True,
        "shouldAvoidFullSolution": False,
        "responseStrategy": "Give a full explanation.",
        "stateUpdates": {
            "understandingLevel": 1,
            "lastHelpDepth": 4,
        },
    }

    clamped = graph_module.clamp_tutor_plan_to_help_limits(
        plan,
        {
            "helpLimitsByUnderstandingLevel": {
                "1": "light_hint",
            }
        },
    )

    assert clamped["nextHelpDepth"] == 1
    assert clamped["stateUpdates"]["lastHelpDepth"] == 1
    assert clamped["shouldAskQuestion"] is True
    assert clamped["shouldGiveWorkedStep"] is False
    assert clamped["shouldAvoidFullSolution"] is True
    assert "light hint" in clamped["responseStrategy"]


def test_help_limit_clamping_uses_protected_understanding_level() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "activeProblemId": problem_id,
        "understandingLevel": 1,
        "hintsGiven": 1,
        "lastHintSummary": "Asked the student to connect rank to image.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "answer_policy": {
            "helpLimitsByUnderstandingLevel": {
                "1": "light_hint",
                "2": "targeted_hint_next_action",
            }
        },
        "conversation_id": "conv-clamp-protected-level",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "I still do not get it."}],
    }
    decision = {
        "tutorPlan": {
            "activeProblemId": problem_id,
            "studentIntent": "vague_help",
            "nextHelpDepth": 2,
            "shouldAskQuestion": False,
            "shouldGiveWorkedStep": False,
            "shouldAvoidFullSolution": False,
            "responseStrategy": "Give a targeted hint.",
            "stateUpdates": {
                "understandingLevel": 2,
                "lastHelpDepth": 2,
                "lastHintSummary": "Gave a more concrete distinction.",
            },
        }
    }

    clamped = graph_module.clamp_decision_to_help_limits(decision, state)

    assert clamped["tutorPlan"]["stateUpdates"]["understandingLevel"] == 1
    assert clamped["tutorPlan"]["nextHelpDepth"] == 1
    assert clamped["tutorPlan"]["shouldAskQuestion"] is True


def test_decision_prompt_uses_evidence_based_understanding_levels() -> None:
    state = {
        "chat_retrieval_memory": {
            "active_metadata": ocr_page(problem_numbers=["2.14"]),
        },
        "messages": [
            {
                "role": "user",
                "content": (
                    "I proved rank(KL) <= rank(K) because im(KL) is inside im(K), "
                    "so I think im(KL) is inside im(L) too."
                ),
            }
        ],
    }
    heuristic = graph_module.build_retrieval_decision(state)

    messages = graph_module.build_primary_tutor_messages(state, heuristic)
    system_prompt = messages[0]["content"]

    assert "Preserve the previous level unless the student's latest message proves a change" in system_prompt
    assert "do not raise it because Chandra gave more help" in system_prompt
    assert "0 for source lookup or a freshly loaded problem before tutoring starts" in system_prompt
    assert "1 = little/no useful work" in system_prompt
    assert "2 = setup understood but core idea missing or work shows the main idea with one conceptual flaw" in system_prompt
    assert "3 = core idea understood but execution help needed" in system_prompt
    assert "4 = solution-ready/minor cleanup" in system_prompt
    assert "incorrectly claims im(KL) is contained in im(L)" not in system_prompt


def test_understanding_level_zero_update_does_not_reset_same_problem_progress() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "activeProblemId": problem_id,
        "understandingLevel": 2,
        "hintsGiven": 2,
        "lastHintSummary": "Connected rank to image containment.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-no-zero-reset",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "I still need help"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "vague_help",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 0,
            "lastHelpDepth": 2,
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 2
    assert understanding["hintsGiven"] == 2
    assert "image containment" in understanding["lastHintSummary"]


def test_understanding_level_decrease_is_ignored_for_same_problem_without_retraction() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "activeProblemId": problem_id,
        "understandingLevel": 3,
        "hintsGiven": 2,
        "lastStudentAttemptSummary": "Student used the right image-containment strategy.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-no-decrease",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "I am still confused by the notation."}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "vague_help",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 1,
            "lastHelpDepth": 2,
            "lastHintSummary": "Narrowed the notation question.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 3
    assert understanding["lastHelpDepth"] == 2


def test_understanding_level_increase_requires_student_work_evidence() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "activeProblemId": problem_id,
        "understandingLevel": 1,
        "hintsGiven": 1,
        "lastHintSummary": "Asked the student to connect rank to image.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-no-unsupported-increase",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "I still do not get it."}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "vague_help",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 2,
            "lastHelpDepth": 2,
            "lastHintSummary": "Gave a more concrete distinction about image containment.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 1
    assert understanding["lastHelpDepth"] == 2


def test_active_problem_help_turn_promotes_model_zero_to_level_one() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-zero-to-one",
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [{"role": "user", "content": "can you explain this?"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "asks_for_explanation",
        "nextHelpDepth": 1,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 0,
            "lastHelpDepth": 1,
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 1
    assert understanding["hintsGiven"] == 0


def test_source_lookup_only_can_initialize_new_problem_at_level_zero() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-source-lookup-zero",
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [{"role": "user", "content": "show me problem 2.14"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "specific_question",
        "needsRetrieval": True,
        "retrievalReason": "student_requested_problem",
        "nextHelpDepth": 1,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 0,
            "lastHelpDepth": 1,
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 0
    assert understanding["hintsGiven"] == 0


def test_source_lookup_only_does_not_reset_same_problem_progress() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "activeProblemId": problem_id,
        "understandingLevel": 3,
        "hintsGiven": 2,
        "lastStudentAttemptSummary": "Student used the right image-containment strategy.",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-source-lookup-preserve",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "show me the problem text again"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "specific_question",
        "needsRetrieval": True,
        "retrievalReason": "student_requested_problem",
        "nextHelpDepth": 1,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 0,
            "lastHelpDepth": 1,
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 3
    assert understanding["hintsGiven"] == 2
    assert "image-containment" in understanding["lastStudentAttemptSummary"]


def test_understanding_level_updates_can_jump_from_zero_based_on_evidence() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-jump-zero",
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [{"role": "user", "content": "Here is my proof attempt..."}],
    }

    level_two = graph_module.state_after_tutor_plan(
        state,
        {
            "activeProblemId": problem_id,
            "studentIntent": "showed_work",
            "nextHelpDepth": 2,
            "answerSeekingRisk": "low",
            "stateUpdates": {
                "understandingLevel": 2,
                "lastStudentAttemptSummary": "Student identified image/rank setup but missed the core inclusion.",
            },
        },
    )
    level_three = graph_module.state_after_tutor_plan(
        state,
        {
            "activeProblemId": problem_id,
            "studentIntent": "showed_work",
            "nextHelpDepth": 2,
            "answerSeekingRisk": "low",
            "stateUpdates": {
                "understandingLevel": 3,
                "lastStudentAttemptSummary": "Student had the right strategy but made execution mistakes.",
            },
        },
    )
    level_four = graph_module.state_after_tutor_plan(
        state,
        {
            "activeProblemId": problem_id,
            "studentIntent": "showed_work",
            "nextHelpDepth": 2,
            "answerSeekingRisk": "low",
            "stateUpdates": {
                "understandingLevel": 4,
                "lastStudentAttemptSummary": "Student was essentially correct with minor cleanup remaining.",
            },
        },
    )

    assert level_two["understandingLevel"] == 2
    assert level_three["understandingLevel"] == 3
    assert level_four["understandingLevel"] == 4


def test_understanding_level_can_jump_from_one_to_four() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-jump-one",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {
                problem_id: {
                    "activeProblemId": problem_id,
                    "understandingLevel": 1,
                    "hintsGiven": 1,
                    "lastHintSummary": "Asked the student to connect rank to image.",
                    "updatedAt": "2026-05-12T00:00:00+00:00",
                }
            },
        },
        "messages": [{"role": "user", "content": "Actually, im(KL) is a subspace of im(K), so rank(KL) <= rank(K)."}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "showed_work",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 4,
            "lastStudentAttemptSummary": "Student corrected the image containment and has only cleanup remaining.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 4
    assert understanding["attemptsCount"] == 1


def test_rank_image_wrong_target_space_is_level_two_not_one() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-rank-regression",
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [
            {
                "role": "user",
                "content": (
                    "Since im(KL) is all outputs K(Lv), those are outputs of K, so rank(KL) <= rank(K). "
                    "For rank(KL) <= rank(L), I think im(KL) is inside im(L)."
                ),
            }
        ],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "showed_work",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "stateUpdates": {
            "understandingLevel": 2,
            "conceptsUnderstood": ["rank/image reasoning", "image containment for rank(KL) <= rank(K)"],
            "knownConfusions": ["target space for im(KL) versus im(L)"],
            "lastStudentAttemptSummary": "Student used image reasoning well but chose the wrong containment for the second inequality.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["understandingLevel"] == 2
    assert "rank/image reasoning" in understanding["conceptsUnderstood"]
    assert "target space for im(KL) versus im(L)" in understanding["knownConfusions"]


def test_decision_prompt_tracks_current_step_for_repeated_stuck() -> None:
    active = ocr_page(
        chunk_text=(
            "Problem 2.17. Let L(e1)=e1+2e2 and L(e2)=2e1-e2. "
            "Compute L(2e1-3e2) and then L^2(2e1-3e2)."
        ),
        problem_numbers=["2.17"],
    )
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-2-17",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {
                problem_id: {
                    "activeProblemId": problem_id,
                    "understandingLevel": 1,
                    "hintsGiven": 2,
                    "repeatedStuckSignals": 1,
                    "currentStep": "Compute L(2e1 - 3e2) using linearity.",
                    "currentStepStatus": "in_progress",
                    "lastHintSummary": "Use linearity, substitute L(e1) and L(e2), then expand.",
                    "updatedAt": "2026-05-12T00:00:00+00:00",
                }
            },
        },
        "messages": [
            {"role": "assistant", "content": "Use linearity, substitute L(e1) and L(e2), then expand."},
            {"role": "user", "content": "give me the next step!"},
        ],
    }
    heuristic = graph_module.build_retrieval_decision(state)

    messages = graph_module.build_primary_tutor_messages(state, heuristic)
    payload = json.loads(messages[-1]["content"])
    system_prompt = messages[0]["content"]

    assert payload["problem_understanding_state"]["currentStep"] == "Compute L(2e1 - 3e2) using linearity."
    assert payload["problem_understanding_state"]["currentStepStatus"] == "in_progress"
    assert "Do not advance currentStep merely because the student asks for the next step" in system_prompt
    assert "currentStep is a guideline" in system_prompt
    assert "tiny unclear answer like `2?`" in system_prompt
    assert "prior hint was unhelpful/repetitive/too vague" in system_prompt
    assert "make the next help narrower, more concrete, or diagnostic inside that step" in system_prompt
    assert "stay on the same currentStep unless completed" in system_prompt


def test_final_prompt_escalates_repeated_unhelpful_hint_without_repeating() -> None:
    active = ocr_page(problem_numbers=["2.14"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-unhelpful-hint",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {
                problem_id: {
                    "activeProblemId": problem_id,
                    "understandingLevel": 1,
                    "hintsGiven": 1,
                    "repeatedStuckSignals": 1,
                    "currentStep": "Compare rank(KL) with rank(L).",
                    "currentStepStatus": "in_progress",
                    "lastHintSummary": "Compare the image of KL to the image of L using rank-nullity.",
                }
            },
        },
        "messages": [
            {"role": "assistant", "content": "Compare the image of KL to the image of L using rank-nullity."},
            {"role": "user", "content": "that hint is too vague"},
        ],
        "retrieval_decision": {
            "tutorPlan": {
                "studentIntent": "vague_help",
                "nextHelpDepth": 2,
                "currentStep": "Compare rank(KL) with rank(L).",
                "currentStepStatus": "in_progress",
            }
        },
    }

    messages = graph_module.build_context_grounded_answer_messages(state)
    instruction_text = messages[0]["content"][1]["text"]

    assert "previous hint was unhelpful, repetitive, too vague, or did not add more" in instruction_text
    assert "add one new concrete distinction or prerequisite idea" in instruction_text
    assert "specific missing object, definition, target space, assumption, comparison, representation, or notation choice" in instruction_text


def test_context_grounded_prompt_makes_lookup_found_and_not_found_mutually_exclusive() -> None:
    state = {
        "answer_policy": {"refuseAnswerOnlyRequests": True},
        "messages": [{"role": "user", "content": "problem 2.20"}],
        "page_assets": [ocr_page(problem_numbers=["2.20"])],
        "retrieval_decision": {
            "needs_search": True,
            "retrieval_reason": "student_requested_problem",
            "tutorPlan": {"studentIntent": "source_lookup"},
        },
        "source_usage": {"useClassMaterialsFirst": True},
    }

    messages = graph_module.build_context_grounded_answer_messages(state)
    instruction_text = messages[0]["content"][1]["text"]

    assert "choose exactly one outcome before writing JSON" in instruction_text
    assert "FOUND outcome" in instruction_text
    assert "NOT_FOUND outcome" in instruction_text
    assert "These outcomes are mutually exclusive" in instruction_text
    assert "do not write any `couldn't find`" in instruction_text
    assert "do not include sections.problem at all" in instruction_text
    assert "fields stream as you generate them" in instruction_text
    assert "emit the top-level sections object before any top-level content/message/mainText" in instruction_text
    assert "put problem as the first key inside sections" in instruction_text
    assert "hint, next-action request, or tutoring guidance" in instruction_text
    assert "Treat sections.problem as extraction-only" in instruction_text
    assert "For pure lookup/location requests, omit `Hint:` entirely" in instruction_text
    assert "optionally include one short relevant contextual/location note" in instruction_text
    assert "Final-section status-text ban" in instruction_text
    assert "checking class materials" in instruction_text
    assert "Problem:` is only the academic task statement" in instruction_text


def test_context_grounded_prompt_receives_primary_response_context() -> None:
    state = {
        "answer_policy": {"refuseAnswerOnlyRequests": True},
        "messages": [{"role": "user", "content": "Find problem 2.20."}],
        "page_assets": [ocr_page(problem_numbers=["2.20"])],
        "primary_student_response": "This looks like the same section we were using.",
        "primary_structured_output": {
            "sections": {"answer": "This looks like the same section we were using."},
            "sectionOrder": ["answer"],
        },
        "retrieval_decision": {
            "needs_search": True,
            "retrieval_reason": "student_requested_problem",
            "search_query": "Problem 2.20",
            "tutorPlan": {"studentIntent": "source_lookup", "nextHelpDepth": 1},
        },
        "source_usage": {"useClassMaterialsFirst": True},
        "tutor_plan": {"studentIntent": "source_lookup", "nextHelpDepth": 1},
    }

    messages = graph_module.build_context_grounded_answer_messages(state)
    instruction_text = messages[0]["content"][1]["text"]
    primary_context = messages[0]["content"][2]["text"]

    assert "Continuation contract" in instruction_text
    assert "already have shown a student-facing response" in instruction_text
    assert "not as a draft to rewrite" in instruction_text
    assert "This looks like the same section we were using." in primary_context
    assert '"nextHelpDepth": 1' in primary_context


def test_context_grounded_continuation_does_not_overwrite_primary_response() -> None:
    state = {
        "primary_student_response": "Start by identifying which space the image lands in.",
    }
    context_response = json.dumps(
        {
            "mainText": "From the worksheet page, this is about comparing image containment.",
            "sections": {"sourceNote": "Rank Worksheet, printed page 80."},
            "sectionOrder": ["mainText", "sourceNote"],
            "metadata": {},
        }
    )

    answer = graph_module.answer_with_context_grounded_continuation(state, context_response)

    assert answer.startswith("Start by identifying which space the image lands in.")
    assert "From the worksheet page" in answer
    assert "Rank Worksheet, printed page 80." in answer


def test_context_grounded_continuation_uses_grounded_answer_when_primary_was_only_status() -> None:
    state = {
        "primary_student_response": "I'm checking the class materials for that problem.",
    }
    context_response = "Problem:\nProblem 2.20. Prove the rank identity."

    assert graph_module.answer_with_context_grounded_continuation(state, context_response) == context_response


def test_problem_lookup_structured_output_allows_context_note_plus_problem() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "This is the exercise that matches the rank problem we were just discussing.",
                "problem": "Problem 2.14. Prove rank(KL) <= rank(L).",
            },
            "sectionOrder": ["answer", "problem"],
            "metadata": {"mode": "source_lookup", "studentActionNeeded": "review_source"},
        }
    )

    assert structured_output is not None
    assert structured_output["sections"]["mainChat"].startswith("This is the exercise")
    assert structured_output["sections"]["problem"] == "Problem 2.14. Prove rank(KL) <= rank(L)."
    assert structured_output["sectionOrder"] == ["mainChat", "problem"]


def test_primary_prompt_streams_problem_before_main_text_when_problem_section_is_present() -> None:
    heuristic = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="student_requested_problem",
        query="problem 2.20",
        active_record=None,
        memory_used=False,
    )
    messages = graph_module.build_primary_tutor_messages(
        {
            "answer_policy": {"refuseAnswerOnlyRequests": True},
            "messages": [{"role": "user", "content": "problem 2.20"}],
            "source_usage": {"useClassMaterialsFirst": True},
        },
        heuristic,
    )
    system_prompt = messages[0]["content"]

    assert "Streaming order matters" in system_prompt
    assert "Emit sections before legacy content/message fields" in system_prompt
    assert "Put problem first when it should render first" in system_prompt
    assert "sections.problem must contain only the exact academic task statement" in system_prompt
    assert "For pure source/problem lookup, omit hint" in system_prompt


def test_unclear_attempt_keeps_current_step_and_counts_repeated_stuck() -> None:
    active = ocr_page(problem_numbers=["2.17"])
    problem_id = graph_module.active_problem_id_from_record(active)
    previous_state = {
        "chatId": "conv-unclear",
        "activeProblemId": problem_id,
        "understandingLevel": 1,
        "attemptsCount": 0,
        "hintsGiven": 2,
        "lastHelpDepth": 2,
        "currentStep": "Compute L(2e1 - 3e2) using linearity.",
        "currentStepStatus": "in_progress",
        "repeatedStuckSignals": 1,
        "lastHintSummary": "Asked the student to compute 2L(e1).",
        "updatedAt": "2026-05-12T00:00:00+00:00",
    }
    state = {
        "conversation_id": "conv-unclear",
        "chat_retrieval_memory": {
            "active_metadata": active,
            "problem_understanding_states": {problem_id: previous_state},
        },
        "messages": [{"role": "user", "content": "2?"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "unclear_attempt",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "currentStep": "Compute L(2e1 - 3e2) using linearity.",
        "currentStepStatus": "unclear",
        "stateUpdates": {
            "understandingLevel": 1,
            "lastStudentAttemptSummary": "Student gave a tiny unclear answer, `2?`, without a vector expression.",
            "lastHintSummary": "Clarified that the expected answer is a vector expression for 2L(e1).",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["currentStep"] == "Compute L(2e1 - 3e2) using linearity."
    assert understanding["currentStepStatus"] == "unclear"
    assert understanding["repeatedStuckSignals"] == 2
    assert "vector expression" in understanding["lastStudentAttemptSummary"]


def test_completed_current_step_can_be_recorded_before_advancing() -> None:
    active = ocr_page(problem_numbers=["2.17"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-complete-step",
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [{"role": "user", "content": "I got -4e1 + 7e2"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "showed_work",
        "nextHelpDepth": 2,
        "answerSeekingRisk": "low",
        "currentStep": "Compute L^2(2e1 - 3e2).",
        "currentStepStatus": "in_progress",
        "stateUpdates": {
            "understandingLevel": 3,
            "currentStep": "Compute L^2(2e1 - 3e2).",
            "currentStepStatus": "in_progress",
            "completedSteps": ["Computed L(2e1 - 3e2)."],
            "lastStudentAttemptSummary": "Student completed the first transformation expression.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["currentStep"] == "Compute L^2(2e1 - 3e2)."
    assert understanding["currentStepStatus"] == "in_progress"
    assert understanding["completedSteps"] == ["Computed L(2e1 - 3e2)."]
    assert understanding["attemptsCount"] == 1


def test_answer_seeking_plan_stays_low_depth_under_restricted_policy() -> None:
    active = ocr_page(problem_numbers=["3.9"])
    problem_id = graph_module.active_problem_id_from_record(active)
    state = {
        "conversation_id": "conv-answer-seeking",
        "answer_policy": {"refuseAnswerOnlyRequests": True},
        "chat_retrieval_memory": {"active_metadata": active},
        "messages": [{"role": "user", "content": "just give me the answer"}],
    }
    plan = {
        "activeProblemId": problem_id,
        "studentIntent": "asks_for_solution",
        "nextHelpDepth": 1,
        "answerSeekingRisk": "high",
        "stateUpdates": {
            "understandingLevel": 1,
            "lastHelpDepth": 1,
            "answerSeekingRisk": "high",
            "lastHintSummary": "Refused answer-only request and asked for current thinking.",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["answerSeekingRisk"] == "high"
    assert understanding["lastHelpDepth"] == 1
    assert graph_module.classify_student_intent("just give me the answer") == "asks_for_solution"


def test_loaded_problem_context_initializes_understanding_level_zero() -> None:
    problem_text = "Problem 3.9. Prove that a rotation in R^2 is orthonormal."
    active_context = {
        "problem_id": graph_module.stable_problem_id(problem_text),
        "problem_text": problem_text,
    }
    state = {
        "conversation_id": "conv-load-problem",
        "chat_retrieval_memory": {},
        "problem_understanding_state": {
            "activeProblemId": "unknown",
            "understandingLevel": 3,
            "hintsGiven": 4,
        },
        "tutor_plan": {
            "studentIntent": "specific_question",
            "needsRetrieval": True,
            "retrievalReason": "student_requested_problem",
            "nextHelpDepth": 1,
        },
    }

    graph_module.sync_problem_understanding_state_to_active_context(state, active_context)

    understanding = state["problem_understanding_state"]
    assert understanding["activeProblemId"] == active_context["problem_id"]
    assert understanding["understandingLevel"] == 0
    assert understanding["hintsGiven"] == 0


def test_visible_structured_problem_keeps_source_lookup_understanding_state() -> None:
    state = {
        "tutor_plan": {
            "studentIntent": "specific_question",
            "needsRetrieval": True,
            "retrievalReason": "student_requested_problem",
        },
    }

    assert not graph_module.should_suppress_problem_understanding_for_response(
        state,
        {},
        visible_problem_text="Problem 2.14. Prove the rank inequalities.",
    )
    assert graph_module.should_suppress_problem_understanding_for_response(state, {})


def test_help_plan_state_survives_active_problem_id_sync() -> None:
    problem_text = "Problem 3.9. Prove that a rotation in R^2 is orthonormal."
    active_context = {
        "problem_id": graph_module.stable_problem_id(problem_text),
        "problem_text": problem_text,
    }
    state = {
        "conversation_id": "conv-help-problem",
        "chat_retrieval_memory": {},
        "problem_understanding_state": {
            "activeProblemId": "requested-problem-3-9",
            "understandingLevel": 1,
            "hintsGiven": 1,
            "lastHintSummary": "Focused the student on the columns.",
        },
        "tutor_plan": {
            "studentIntent": "vague_help",
            "needsRetrieval": True,
            "retrievalReason": "student_requested_problem",
            "nextHelpDepth": 1,
        },
    }

    graph_module.sync_problem_understanding_state_to_active_context(state, active_context)

    understanding = state["problem_understanding_state"]
    assert understanding["activeProblemId"] == active_context["problem_id"]
    assert understanding["understandingLevel"] == 1
    assert understanding["hintsGiven"] == 1
    assert "columns" in understanding["lastHintSummary"]


def test_finalized_understanding_counts_rendered_hint_section_once() -> None:
    problem_text = "Problem 3.9. Prove that a rotation in R^2 is orthonormal."
    problem_id = graph_module.stable_problem_id(problem_text)
    state = {
        "chat_retrieval_memory": {
            "problem_understanding_states": {
                problem_id: {
                    "activeProblemId": problem_id,
                    "understandingLevel": 1,
                    "hintsGiven": 1,
                    "lastHintSummary": "Focus on the columns.",
                }
            }
        },
        "problem_understanding_state": {
            "activeProblemId": problem_id,
            "understandingLevel": 1,
            "hintsGiven": 1,
            "lastHintSummary": "Compare the dot products of the transformed columns.",
        },
        "tutor_plan": {
            "studentIntent": "vague_help",
            "nextHelpDepth": 1,
        },
    }

    graph_module.finalize_understanding_after_rendered_response(
        state,
        {"sections": {"answer": "Use the column condition.", "hint": "Check the dot product of the two columns."}},
        "Use the column condition.\n\nHint: Check the dot product of the two columns.",
    )

    assert state["problem_understanding_state"]["hintsGiven"] == 2


def test_finalized_understanding_does_not_count_default_guided_metadata_as_hint() -> None:
    problem_text = "Problem 3.9. Prove that a rotation in R^2 is orthonormal."
    problem_id = graph_module.stable_problem_id(problem_text)
    state = {
        "chat_retrieval_memory": {
            "problem_understanding_states": {
                problem_id: {
                    "activeProblemId": problem_id,
                    "understandingLevel": 1,
                    "hintsGiven": 1,
                    "lastHintSummary": "Focus on the columns.",
                }
            }
        },
        "problem_understanding_state": {
            "activeProblemId": problem_id,
            "understandingLevel": 1,
            "hintsGiven": 1,
            "lastHintSummary": "Focus on the columns.",
        },
        "tutor_plan": {
            "studentIntent": "source_lookup",
            "nextHelpDepth": 1,
        },
    }

    graph_module.finalize_understanding_after_rendered_response(
        state,
        {"sections": {"answer": "I found the problem statement."}, "metadata": {"hintLevel": "guided_step"}},
        "I found the problem statement.",
    )

    assert state["problem_understanding_state"]["hintsGiven"] == 1


@pytest.mark.asyncio
async def test_parallel_distinct_searches_execute_concurrently() -> None:
    class ConcurrentRetriever:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.active = 0
            self.max_active = 0
            self.all_started = asyncio.Event()

        async def search(self, **kwargs: Any) -> list[dict[str, Any]]:
            self.calls.append(kwargs)
            self.active += 1
            self.max_active = max(self.max_active, self.active)

            if len(self.calls) == 2:
                self.all_started.set()

            await asyncio.wait_for(self.all_started.wait(), timeout=0.5)
            self.active -= 1
            return [ocr_page(title=kwargs["query"])]

    retriever = ConcurrentRetriever()
    parsed_searches = [
        ("find exact problem page OCR metadata problem 2.14", 1, "student_requested_problem"),
        ("worked example textbook reading notes method rank nullity", 5, "needed_example_page"),
    ]

    queries, pages, _diagnostics, reasons = await graph_module.execute_parsed_searches(
        parsed_searches,
        retriever=retriever,
        class_id="class-linear",
        professor_id="teacher-1",
    )

    assert queries == [query for query, _top_k, _reason in parsed_searches]
    assert len(pages) == 2
    assert [reason["retrieval_reason"] for reason in reasons] == [
        "student_requested_problem",
        "needed_example_page",
    ]
    assert retriever.max_active == 2


def test_normalize_backend_structured_output_repairs_unhelpful_section_order() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "Let's work it step by step.",
                "formula": "Matrix columns are transformed basis vectors.",
                "hint": "Apply the transformation to the first basis vector.",
                LEGACY_ACTION_SECTION_KEY: "Send the first transformation from Exercise 2.3.",
            },
            "sectionOrder": ["hint", LEGACY_ACTION_SECTION_KEY, "answer", "formula"],
            "metadata": {
                "hintLevel": "guided_step",
                "mode": "guided_problem_solving",
                "sourceConfidence": "low",
                "studentActionNeeded": "try_next_step",
            },
        }
    )

    assert structured_output is not None
    assert structured_output["sectionOrder"] == ["mainChat", "hint", "formula"]
    assert structured_output["sections"]["mainChat"] == (
        "Let's work it step by step.\n\nSend the first transformation from Exercise 2.3."
    )


def test_normalize_backend_structured_output_folds_duplicate_legacy_action() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "You are connecting the prompt to the rule that applies here.",
                "hint": "Focus on the condition in the prompt that tells you which rule applies.",
                LEGACY_ACTION_SECTION_KEY: "Focus on the condition in the prompt that tells you which rule applies.",
            },
            "metadata": {
                "hintLevel": "small_hint",
                "mode": "guided_problem_solving",
                "sourceConfidence": "low",
                "studentActionNeeded": "try_next_step",
            },
        }
    )

    assert structured_output is not None
    assert structured_output["sections"] == {
        "mainChat": (
            "You are connecting the prompt to the rule that applies here.\n\n"
            "Focus on the condition in the prompt that tells you which rule applies."
        ),
    }


def test_normalize_backend_structured_output_removes_hint_repeated_by_orientation() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "You are identifying the condition in the prompt that tells you which rule applies.",
                "hint": "Identify the condition in the prompt that tells you which rule applies.",
                LEGACY_ACTION_SECTION_KEY: "Write down the one condition you found.",
            },
            "metadata": {
                "hintLevel": "small_hint",
                "mode": "guided_problem_solving",
                "sourceConfidence": "low",
                "studentActionNeeded": "try_next_step",
            },
        }
    )

    assert structured_output is not None
    assert structured_output["sections"] == {
        "mainChat": (
            "You are identifying the condition in the prompt that tells you which rule applies.\n\n"
            "Write down the one condition you found."
        ),
    }


def test_normalize_backend_structured_output_moves_status_out_of_problem_section() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "problem": (
                    "You said: 2.20\n\n"
                    "I'm checking which problem 2.20 refers to so I can help with the right one. "
                    "Please send the page or textbook name if you have it."
                )
            },
            "sectionOrder": ["problem"],
            "metadata": {
                "hintLevel": "guided_step",
                "mode": "clarification",
                "sourceConfidence": "low",
                "studentActionNeeded": "paste_problem",
            },
        }
    )

    assert structured_output is None


def test_normalize_backend_structured_output_keeps_actual_problem_section() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "problem": (
                    "2.20. Let a != 0 be fixed, and let V be the space spanned by "
                    "S = [e^{ax}, xe^{ax}, x^2 e^{ax}]. Find the matrix A representing D on S."
                )
            },
            "sectionOrder": ["problem"],
        }
    )

    assert structured_output is not None
    assert structured_output["sections"]["problem"].startswith("2.20. Let a")


def test_retrieval_decision_drops_status_next_step() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "Problem 2.20",
                    "structuredOutput": {
                        "sections": {
                            "answer": "I'm checking the exact textbook/homework problem for 2.20 now.",
                            LEGACY_ACTION_SECTION_KEY: "I'm checking the exact problem statement for 2.20 now.",
                        },
                        "sectionOrder": [LEGACY_ACTION_SECTION_KEY, "answer"],
                    },
                }
            )
        },
        {
            "query": "Problem 2.20",
            "retrieval_reason": "student_requested_problem",
            "top_k": 1,
        },
    )

    assert decision["structuredOutput"] is None
    assert "Action:" not in decision["student_response"]


def test_retrieval_decision_suppresses_source_request_while_searching() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "Problem 2.18",
                    "student_response": (
                        "I'm checking which exact 2.18 problem this refers to. "
                        "If you can, send the textbook/homework title or a photo of the page."
                    ),
                }
            )
        },
        {
            "query": "Problem 2.18",
            "retrieval_reason": "student_requested_problem",
            "top_k": 1,
        },
    )

    assert decision["student_response"] == "I'm checking the class materials for that problem."


def test_retrieval_decision_removes_page_photo_next_step_while_searching() -> None:
    decision = graph_module.parse_primary_tutor_response(
        {
            "content": json.dumps(
                {
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "Problem 2.20",
                    "structuredOutput": {
                        "sections": {
                            "answer": "I'm checking the exact 2.20 problem next.",
                            LEGACY_ACTION_SECTION_KEY: "Please send the page photo or type the full problem text so I can help step by step.",
                        },
                        "sectionOrder": ["answer", LEGACY_ACTION_SECTION_KEY],
                    },
                }
            )
        },
        {
            "query": "Problem 2.20",
            "retrieval_reason": "student_requested_problem",
            "top_k": 1,
        },
    )

    assert decision["student_response"] == "I'm checking the class materials for that problem."
    assert decision["structuredOutput"] is None


def test_decision_prompt_forbids_source_request_while_searching() -> None:
    heuristic = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="student_requested_problem",
        query="find exact problem page OCR metadata 2.20",
        active_record=None,
        memory_used=False,
    )

    messages = graph_module.build_primary_tutor_messages(
        {
            "answer_policy": {"refuseAnswerOnlyRequests": True},
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "2.20"}],
            "source_usage": {"useClassMaterialsFirst": True},
        },
        heuristic,
    )

    system_prompt = messages[0]["content"]
    assert "do not invent source facts or ask for a page/title/problem text" in system_prompt
    assert "retrieval can check class metadata" in system_prompt
    assert "I'm checking the class materials for that problem." in system_prompt


def test_problem_section_location_note_is_split_out() -> None:
    structured = graph_module.structured_tutor_output_from_answer(
        (
            "Problem:\n"
            "2.18. Assuming the polynomial bases [1,x,x^2] and [1,x,x^2,x^3,x^4] "
            "for F[x;2] and F[x;4], respectively, find the matrix representations "
            "for each of the linear transformations in Exercise 2.3. "
            "That's the exact Exercise 2.18 on printed page 80."
        ),
        {"retrieval_confidence": "high"},
        [],
    )

    assert structured["sections"]["problem"].endswith("Exercise 2.3.")
    assert "printed page 80" not in structured["sections"]["problem"]
    assert structured["sections"]["mainChat"] == "That's the exact Exercise 2.18 on printed page 80"


def test_lost_followup_suppresses_repeated_problem_section() -> None:
    structured = {
        "sections": {
            "problem": "1.7. For each set below, decide which sets span F[x;2].",
            "answer": "You're working on a spanning problem.",
            "hint": "Check whether the set can generate 1, x, and x^2.",
        },
        "sectionOrder": ["problem", "answer", "hint"],
        "metadata": {},
    }

    suppressed = graph_module.suppress_structured_problem_section_for_followup(
        structured,
        {"messages": [{"role": "user", "content": "im lost"}]},
    )

    assert "problem" not in suppressed["sections"]
    assert suppressed["sectionOrder"] == ["answer", "hint"]


def test_help_on_this_followup_suppresses_repeated_problem_section() -> None:
    structured = {
        "sections": {
            "problem": "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
            "mainChat": "This is about representing linear transformations in chosen bases.",
        },
        "sectionOrder": ["problem", "mainChat"],
        "metadata": {},
    }

    suppressed = graph_module.suppress_structured_problem_section_for_followup(
        structured,
        {"messages": [{"role": "user", "content": "I need help on this"}]},
    )

    assert "problem" not in suppressed["sections"]
    assert suppressed["sections"]["mainChat"] == "This is about representing linear transformations in chosen bases."
    assert suppressed["sectionOrder"] == ["mainChat"]


DIRECT_VALIDATION_VERDICT_RE = re.compile(
    r"\b(?:correct|incorrect|right|wrong|yes|no)\b|that's the answer|your first part is right|the mistake is|not quite",
    re.IGNORECASE,
)


def assert_no_direct_validation_verdict(text: str) -> None:
    assert not DIRECT_VALIDATION_VERDICT_RE.search(text)


def test_validation_request_neutralizes_partially_correct_verdict_language() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "I proved rank(KL) <= rank(K), then said im(KL) is inside im(L). Is this right?",
                }
            ],
            "answer": "Yes, the first part is right. Your missing step is to connect KL to the image of L.",
            "retrieval_decision": {},
            "retrieved_pages": [],
            "page_assets": [],
        }
    )

    content = response["content"]
    assert_no_direct_validation_verdict(content)
    assert "uses a relevant idea" in content


def test_validation_request_neutralizes_flaw_without_wrong_label() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "I think im(KL) is contained in im(L), so rank(KL) <= rank(L). Is this right?",
                }
            ],
            "answer": "Not quite. The mistake is comparing im(KL) directly with im(L).",
            "retrieval_decision": {},
            "retrieved_pages": [],
            "page_assets": [],
        }
    )

    content = response["content"]
    assert_no_direct_validation_verdict(content)
    assert "Check this part carefully" in content
    assert "One place to inspect" in content


def test_validation_request_neutralizes_near_correct_structured_output() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "I wrote im(KL)=K(im L), then used dimension. Is this correct?",
                }
            ],
            "answer": "That is correct. Polish the notation around im L.",
            "retrieval_decision": {},
            "retrieved_pages": [],
            "page_assets": [],
            "structured_output_override": {
                "sections": {
                    "answer": "That is correct. Polish the notation around im L.",
                    "checkWork": "Looks right: tighten the notation around im L.",
                },
                "sectionOrder": ["answer", "checkWork"],
                "metadata": {},
            },
        }
    )

    content = response["content"]
    structured_text = json.dumps(response["structuredOutput"]["sections"])
    assert_no_direct_validation_verdict(content)
    assert_no_direct_validation_verdict(structured_text)
    assert "This uses a relevant idea" in content
    assert "A useful direction" in structured_text


def test_check_my_work_search_guidance_lives_in_primary_prompt() -> None:
    messages = graph_module.build_primary_tutor_messages(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "Can you check my work and tell me what I should revisit?",
                    "studentMessageMode": "work",
                }
            ],
        },
        {},
    )

    system_prompt = messages[0]["content"]
    assert "When the student asks Chandra to check/review their work" in system_prompt
    assert "do not search class materials just because the request says `check my work`" in system_prompt


def test_page_match_fallback_never_exposes_top_ranked_locator_text() -> None:
    response = graph_module.pdf_rag_response_from_state(
        {
            "messages": [{"role": "user", "content": "Can you help with this?"}],
            "answer": "",
            "retrieval_decision": {},
            "retrieved_pages": [],
            "page_assets": [ocr_page(title="ACME VOL 1", printed_page_start=620)],
        }
    )

    assert "strongest matching PDF page" not in response["content"]
    assert "top-ranked match" not in response["content"]
    assert "ACME VOL 1 page 620" not in response["content"]
    assert response["sources"] == []


def test_followup_knowledge_reuses_active_problem_source_identity() -> None:
    previous_problem = {
        "chatId": "conv-knowledge",
        "content": "2.18. Assuming the polynomial bases [1,x,x2], find the matrix representations.",
        "createdAt": "2026-05-12T08:21:00.000Z",
        "id": "knowledge-active-problem-original",
        "kind": "problem",
        "page": 98,
        "problemId": "2.18",
        "reason": "Student asked: problem 2.18",
        "sourceId": "acme",
        "sourceName": "ACME VOL 1",
        "updatedAt": "2026-05-12T08:21:00.000Z",
        "usedAs": "active_problem",
    }

    items = knowledge_items_from_state(
        {
            "conversation_id": "conv-knowledge",
            "messages": [{"role": "user", "content": "I need help"}],
            "page_assets": [],
        },
        active_problem_text="2.18. Assuming the polynomial bases [1,x,x2], find the matrix representations.",
        previous_items=[previous_problem],
    )

    active_problems = [item for item in items if item.get("kind") == "problem" and item.get("usedAs") == "active_problem"]
    assert len(active_problems) == 1
    assert active_problems[0]["id"] == "knowledge-active-problem-original"
    assert active_problems[0]["sourceName"] == "ACME VOL 1"
    assert active_problems[0]["sourceId"] == "acme"
    assert active_problems[0]["page"] == 98


@pytest.mark.asyncio
async def test_active_problem_metadata_reuses_context_without_search() -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE["conv-memory"] = {
        "active_metadata": ocr_page(),
        "retrieved_metadata": [ocr_page()],
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": True,
                        "needs_search": False,
                        "student_response": "Hint: focus on the image of L before K acts.",
                    }
                ),
                "usage": {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16},
            },
            {"content": "Hint: focus on the image of L before K acts."},
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-memory",
        messages=[{"role": "user", "content": "I am stuck on why rank(KL) <= rank(L)."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"].startswith("Hint:")
    assert len(client.calls) == 2
    assert retriever.calls == []
    assert response["langGraphTrace"]["decisionSource"] == "chat_memory"
    assert response["langGraphTrace"]["memoryUsed"] is True
    assert response["langGraphTrace"]["selectedMetadataRecords"][0]["ocr_provider"] == "google-document-ai"


@pytest.mark.asyncio
async def test_final_prompt_obeys_first_llm_help_depth_without_state_revision() -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE["conv-final-plan"] = {
        "active_metadata": ocr_page(problem_numbers=["3.9"]),
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": True,
                        "needs_search": False,
                        "student_response": "Hint: focus on the columns.",
                        "tutorPlan": {
                            "activeProblemId": graph_module.active_problem_id_from_record(ocr_page(problem_numbers=["3.9"])),
                            "studentIntent": "vague_help",
                            "needsRetrieval": False,
                            "currentUnderstandingLevel": 0,
                            "nextHelpDepth": 1,
                            "answerSeekingRisk": "low",
                            "responseStrategy": "Give one light hint and one question.",
                            "shouldAskQuestion": True,
                            "shouldGiveWorkedStep": False,
                            "shouldAvoidFullSolution": True,
                            "stateUpdates": {
                                "understandingLevel": 1,
                                "lastHelpDepth": 1,
                                "hintsGiven": 1,
                                "lastHintSummary": "Asked about rotation matrix columns.",
                            },
                        },
                    }
                )
            },
            {
                "content": (
                    "Hint: Focus on the two columns of the rotation matrix. What are their lengths?\n\n"
                    "Problem context:\n"
                    "relation: same_problem\n"
                    "confidence: medium"
                )
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-final-plan",
        messages=[{"role": "user", "content": "help me"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=lambda pages, *, max_total_pages: _return_async([pages[0]]),
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    final_prompt = json.dumps(client.calls[1]["messages"][-1]["content"])
    assert "TutorPlan for internal use only" in final_prompt
    assert "do not revise those fields" in final_prompt
    assert "Tutor state update" not in final_prompt
    assert response["langGraphTrace"]["tutorPlan"]["nextHelpDepth"] == 1
    assert response["langGraphTrace"]["problemUnderstandingState"]["understandingLevel"] == 1
    assert response["langGraphTrace"]["problemUnderstandingState"]["lastHelpDepth"] == 1


@pytest.mark.asyncio
async def test_final_response_uses_clamped_help_limit_depth() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "needed_supporting_page",
                        "search_query": "rank theorem",
                        "student_response": "",
                        "tutorPlan": {
                            "activeProblemId": "rank-problem",
                            "studentIntent": "asks_for_explanation",
                            "needsRetrieval": True,
                            "retrievalReason": "needed_supporting_page",
                            "currentUnderstandingLevel": 1,
                            "nextHelpDepth": 4,
                            "answerSeekingRisk": "low",
                            "responseStrategy": "Give the full route.",
                            "shouldAskQuestion": False,
                            "shouldGiveWorkedStep": True,
                            "shouldAvoidFullSolution": False,
                            "stateUpdates": {
                                "understandingLevel": 1,
                                "lastHelpDepth": 4,
                            },
                        },
                    }
                )
            },
            {"content": "Try one light hint first."},
        ]
    )

    response = await run_pdf_rag_agent(
        answer_policy={
            "helpLimitsByUnderstandingLevel": {
                "1": "light_hint",
            }
        },
        class_id="class-linear",
        conversation_id="conv-help-limit",
        messages=[{"role": "user", "content": "can you explain all of this?"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=lambda pages, *, max_total_pages: _return_async([pages[0]]),
        professor_id="teacher-1",
        retriever=FakeRetriever([ocr_page()]),
    )

    final_prompt = json.dumps(client.calls[1]["messages"][-1]["content"])
    assert '\\"nextHelpDepth\\": 1' in final_prompt or '\\"nextHelpDepth\\":1' in final_prompt
    assert "Understanding level 1 max help" in final_prompt
    assert response["langGraphTrace"]["tutorPlan"]["nextHelpDepth"] == 1
    assert response["langGraphTrace"]["problemUnderstandingState"]["lastHelpDepth"] == 1


@pytest.mark.asyncio
async def test_specific_problem_lookup_uses_two_llm_calls_and_only_exact_problem() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.14",
                        "student_response": "",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.14. Prove rank(KL) <= rank(L)."},
        ]
    )
    retriever = FakeRetriever([ocr_page()])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-problem",
        messages=[{"role": "user", "content": "Find problem 2.14."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert len(client.calls) == 2
    assert retriever.calls == [
        {
            "class_id": "class-linear",
            "professor_id": "teacher-1",
            "query": "Problem 2.14",
            "top_k": 1,
        }
    ]
    assert "Example:" not in response["content"]
    assert response["langGraphTrace"]["retrievalReason"] == "student_requested_problem"
    assert response["langGraphTrace"]["selectedMetadataRecords"][0]["problem_numbers"] == ["2.14"]


@pytest.mark.asyncio
async def test_bare_decimal_problem_reference_is_framed_as_problem_lookup() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "find exact problem page OCR metadata 2.14",
                        "student_response": "",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.14. Prove rank(KL) <= rank(L)."},
        ]
    )
    retriever = FakeRetriever([ocr_page()])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-bare-problem",
        messages=[{"role": "user", "content": "2.14"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert retriever.calls == [
        {
            "class_id": "class-linear",
            "professor_id": "teacher-1",
            "query": "find exact problem page OCR metadata 2.14",
            "top_k": 1,
        }
    ]
    assert response["langGraphTrace"]["retrievalReason"] == "student_requested_problem"


@pytest.mark.asyncio
async def test_bare_decimal_problem_reference_forces_search_before_clarifying() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "Please share the page image or homework title.",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.16. Read the selected page first."},
        ]
    )
    retriever = FakeRetriever([ocr_page(chunk_text="Problem 2.16. Read the selected page first.", problem_numbers=["2.16"])])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-force-bare-problem",
        messages=[{"role": "user", "content": "2.16"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert retriever.calls == [
        {
            "class_id": "class-linear",
            "professor_id": "teacher-1",
            "query": "find exact task in assignment problem PDF worksheet lab prompt practice problems textbook section 2.16",
            "top_k": 1,
        }
    ]
    assert response["content"].startswith("Problem:")
    assert response["langGraphTrace"]["retrievalReason"] == "student_requested_problem"


@pytest.mark.asyncio
async def test_selected_problem_page_prevents_page_image_request_fallback() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.16",
                    }
                )
            },
            {"content": "Please share the page image or the homework/textbook title if you have it."},
        ]
    )
    retriever = FakeRetriever([ocr_page(chunk_text="Problem 2.16. Use the selected page.", problem_numbers=["2.16"])])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-page-fallback",
        messages=[{"role": "user", "content": "2.16"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert "Please share" not in response["content"]
    assert response["content"] == "Problem:\nProblem 2.16. Use the selected page."


@pytest.mark.asyncio
async def test_problem_lookup_without_detected_problem_suppresses_understanding_state() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.20",
                        "student_response": "I'm checking the class materials for that problem.",
                        "tutorPlan": {
                            "activeProblemId": "requested-problem-2-20",
                            "needsRetrieval": True,
                            "retrievalReason": "student_requested_problem",
                            "studentIntent": "specific_question",
                            "stateUpdates": {
                                "understandingLevel": 0,
                                "lastHintSummary": "Requested problem 2/20 after earlier asking for problem 2.24.",
                            },
                        },
                    }
                )
            },
            {"content": "I'm checking the class materials for that problem."},
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-undetected-problem-lookup",
        messages=[{"role": "user", "content": "problem 2/20"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    assert response["content"] == "I'm checking the class materials for that problem."
    assert response["langGraphTrace"]["problemUnderstandingState"] == {}


@pytest.mark.asyncio
async def test_bare_problem_lookup_returns_problem_statement_not_solving_hint() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.20",
                    }
                )
            },
            {
                "content": (
                    "This is Exercise 2.20 on printed page 80.\n\n"
                    "A good way to start is to differentiate each basis function."
                )
            },
        ]
    )
    retriever = FakeRetriever(
        [
            ocr_page(
                chunk_text=(
                    "Exercise 2.20. Let D be the differentiation operator on "
                    "S = {e^{ax}, xe^{ax}, x^2e^{ax}}. Find the matrix of D with respect to this basis.\n\n"
                    "Exercise 2.21. Another problem."
                ),
                problem_numbers=["2.20"],
            )
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-problem-statement-fallback",
        messages=[{"role": "user", "content": "2.20"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"].startswith("Problem:\nExercise 2.20.")
    assert "differentiate each basis function" not in response["content"]
    assert "Exercise 2.21" not in response["content"]


@pytest.mark.asyncio
async def test_empty_context_grounded_answer_extracts_unlabeled_numbered_problem_statement() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.24",
                    }
                )
            },
            {"content": ""},
        ]
    )
    retriever = FakeRetriever(
        [
            ocr_page(
                chunk_text=(
                    "2.23. Compute the null space of A.\n"
                    "2.24. Find a basis for the range of T and determine its rank.\n"
                    "2.25. Show that the listed vectors are independent."
                ),
                problem_numbers=["2.24"],
            )
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-empty-unlabeled-problem",
        messages=[{"role": "user", "content": "2.24"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "Problem:\n2.24. Find a basis for the range of T and determine its rank."
    assert "strongest matching PDF page" not in response["content"]
    assert "2.25" not in response["content"]


@pytest.mark.asyncio
async def test_bare_problem_lookup_preserves_model_extracted_statement() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.24",
                    }
                )
            },
            {"content": "2.24. Find the model-extracted visible problem text."},
        ]
    )
    retriever = FakeRetriever(
        [
            ocr_page(
                chunk_text="2.24. Find the deterministic fallback problem text.",
                problem_numbers=["2.24"],
            )
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-model-extracted-problem",
        messages=[{"role": "user", "content": "2.24"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert response["content"] == "2.24. Find the model-extracted visible problem text."


@pytest.mark.asyncio
async def test_final_prompt_tells_model_to_extract_unlabeled_numbered_items() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.24",
                    }
                )
            },
            {"content": "Problem:\n2.24. Find the model-extracted visible problem text."},
        ]
    )
    retriever = FakeRetriever([ocr_page(chunk_text="2.24. Find the visible problem text.", problem_numbers=["2.24"])])

    await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-model-prompt-unlabeled-problem",
        messages=[{"role": "user", "content": "2.24"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    final_content = client.calls[1]["messages"][-1]["content"]
    assert "Source lookup contract" in json.dumps(final_content)
    assert "never ask the student for a page image, textbook title, homework title, or pasted problem" in json.dumps(final_content)
    assert "Problem extraction procedure" in json.dumps(final_content)
    assert "inspect the attached page asset and OCR metadata yourself" in json.dumps(final_content)
    assert "unlabeled numbered items" in json.dumps(final_content)
    assert "extract the matching numbered block" in json.dumps(final_content)


@pytest.mark.asyncio
async def test_streaming_forced_problem_search_does_not_emit_page_image_request() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "Please share the page image or homework title.",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.16. Read the selected page first."},
        ]
    )
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            conversation_id="conv-stream-force-bare-problem",
            messages=[{"role": "user", "content": "2.16"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever([ocr_page(chunk_text="Problem 2.16. Read the selected page first.", problem_numbers=["2.16"])]),
        )
    ]

    quick_messages = [event.get("message", "") for event in events if event.get("type") == "quick_response"]
    assert quick_messages == ["I'm checking the class materials for that problem."]
    assert "Please share" not in json.dumps(events)
    assert events[-1]["payload"]["content"].startswith("Problem:")


@pytest.mark.asyncio
async def test_streaming_lookup_suppresses_raw_locator_echo_sections() -> None:
    client = FakeStreamingOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "problem 2.18",
                        "student_response": "problem 2.18",
                        "structuredOutput": {
                            "sections": {"mainChat": "problem 2.18"},
                            "sectionOrder": ["mainChat"],
                        },
                    }
                )
            },
            {
                "content": json.dumps(
                    {
                        "sections": {
                            "mainChat": "problem 2.18",
                            "problem": "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
                        },
                        "sectionOrder": ["mainChat", "problem"],
                        "metadata": {
                            "hintLevel": "none",
                            "mode": "source_lookup",
                            "studentActionNeeded": "review_source",
                        },
                    }
                )
            },
        ]
    )
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            conversation_id="conv-stream-lookup-echo",
            messages=[{"role": "user", "content": "problem 2.18"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever(
                [
                    ocr_page(
                        chunk_text="2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
                        printed_page_start=98,
                        problem_numbers=["2.18"],
                        title="ACME VOL 1",
                    )
                ]
            ),
        )
    ]

    quick_messages = [event.get("message", "") for event in events if event.get("type") == "quick_response"]
    raw_section_deltas = [
        event
        for event in events
        if event.get("type") == "section_delta" and "problem 2.18" in str(event.get("delta") or "").lower()
    ]
    final_payload = events[-1]["payload"]

    assert quick_messages == ["I'm checking the class materials for that problem."]
    assert raw_section_deltas == []
    assert final_payload["structuredOutput"]["sections"]["mainChat"] == (
        "I found the matching item in ACME VOL 1 on printed page 98."
    )
    assert final_payload["structuredOutput"]["sections"]["problem"].startswith("2.18. Assuming")


@pytest.mark.asyncio
async def test_streaming_lookup_never_emits_raw_primary_json_as_quick_response() -> None:
    raw_inner = json.dumps(
        {
            "sections": {"mainChat": "I'm checking the class materials for that problem."},
            "sectionOrder": ["mainChat"],
            "metadata": {"problemNumber": "2.18", "problemSummary": "problem lookup"},
        }
    )
    client = FakeStreamingOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "content": raw_inner,
                        "sections": {"mainChat": "I'm checking the class materials for that problem."},
                        "sectionOrder": ["mainChat"],
                        "metadata": {"problemNumber": "2.18", "problemSummary": "problem lookup"},
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "2.18 OCR metadata exact page",
                        "searches": [
                            {
                                "query": "2.18 OCR metadata exact page",
                                "retrieval_reason": "student_requested_problem",
                                "top_k": 1,
                            }
                        ],
                        "student_response": raw_inner,
                    }
                )
            },
            {"content": "Problem:\n2.18. Assuming the polynomial bases, find the matrix representations."},
        ]
    )
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            conversation_id="conv-stream-raw-json-quick-response",
            messages=[{"role": "user", "content": "problem 2.18"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever(
                [
                    ocr_page(
                        chunk_text="2.18. Assuming the polynomial bases, find the matrix representations.",
                        problem_numbers=["2.18"],
                    )
                ]
            ),
        )
    ]

    quick_messages = [event.get("message", "") for event in events if event.get("type") == "quick_response"]
    assert quick_messages == ["I'm checking the class materials for that problem."]
    assert all(not str(message).lstrip().startswith("{") for message in quick_messages)


@pytest.mark.asyncio
async def test_streaming_failed_problem_search_does_not_finalize_quick_status() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.20",
                        "student_response": "I'm checking the class materials for that problem.",
                    }
                )
            },
            {
                "content": json.dumps(
                    {
                        "sections": {
                            "mainChat": "I could not find a matching problem in the class materials I searched."
                        },
                        "sectionOrder": ["mainChat"],
                        "metadata": {
                            "hintLevel": "none",
                            "mode": "source_lookup",
                            "studentActionNeeded": "paste_problem",
                        },
                    }
                )
            },
        ]
    )
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            conversation_id="conv-stream-missing-problem",
            messages=[{"role": "user", "content": "problem 2/20"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever([]),
        )
    ]

    quick_messages = [event.get("message", "") for event in events if event.get("type") == "quick_response"]
    final_content = events[-1]["payload"]["content"]

    assert len(client.calls) == 2
    assert quick_messages == ["I'm checking the class materials for that problem."]
    assert final_content != quick_messages[0]
    assert final_content == "I could not find a matching problem in the class materials I searched."


@pytest.mark.asyncio
async def test_failed_search_memory_skips_repeated_query() -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE["conv-failed"] = {
        "failed_searches": [{"query": "Problem 9.99", "retrieval_reason": "student_requested_problem"}],
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 9.99",
                        "student_response": "",
                    }
                )
            }
        ]
    )
    retriever = FakeRetriever([])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-failed",
        messages=[{"role": "user", "content": "Find problem 9.99 again."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert len(client.calls) == 1
    assert retriever.calls == []
    assert response["langGraphTrace"]["failedSearchesSkipped"] == ["Problem 9.99"]
    assert response["langGraphTrace"]["retrievalReason"] == "previous_search_failed"


@pytest.mark.asyncio
async def test_final_llm_payload_contains_page_asset_and_ocr_metadata() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.14",
                    }
                )
            },
            {"content": "Use the image-of-composition idea."},
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        page = pages[0]
        return [
            {
                **page,
                "file": "/tmp/should-not-be-opened.pdf",
                "file_data_url": "data:application/pdf;base64,cmF3LXBkZg==",
                "full_pdf_data_url": "data:application/pdf;base64,ZnVsbC1wZGY=",
                "full_pdf_file_name": "material-rank.pdf",
                "images": ["/tmp/should-not-be-opened.png"],
                "image_url": {"url": "data:image/png;base64,aW1hZ2U="},
            }
        ]

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "Help with problem 2.14."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=FakeRetriever([ocr_page()]),
    )

    final_content = client.calls[1]["messages"][-1]["content"]
    assert any(part["type"] == "text" and "Selected OCR page/problem metadata:" in part["text"] for part in final_content)
    assert any(part["type"] == "text" and "OCR text omitted because an image or PDF asset" in part["text"] for part in final_content)
    assert any(part.get("type") == "file" for part in final_content)
    assert "cmF3LXBkZg==" in json.dumps(final_content)
    assert "ZnVsbC1wZGY=" in json.dumps(final_content)
    assert "pdf_image" not in json.dumps(response["langGraphTrace"])
    assert "pdf_file" not in json.dumps(response["langGraphTrace"])
    assert "file_data_url" not in json.dumps(response["langGraphTrace"])
    assert "cmF3LXBkZg==" not in json.dumps(response["langGraphTrace"])
    assert "ZnVsbC1wZGY=" not in json.dumps(response["langGraphTrace"])


@pytest.mark.asyncio
async def test_garbled_problem_lookup_still_sends_page_asset_to_context_grounded_model() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "search_query": "Problem 2.16",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.16. Read from the attached page asset."},
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        return [{**pages[0], "file_data_url": "data:application/pdf;base64,ZXhhY3QtcGFnZQ=="}]

    await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "Find problem 2.16."}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=FakeRetriever([ocr_page(chunk_text="Pr0b1em Z.I6 garbled OCR", problem_numbers=["2.16"])]),
    )

    final_content = client.calls[1]["messages"][-1]["content"]
    assert any(part.get("type") == "file" for part in final_content)
    assert "Pr0b1em Z.I6 garbled OCR" in json.dumps(final_content)


@pytest.mark.asyncio
async def test_follow_up_reuses_saved_page_asset_context_without_broad_search() -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE["conv-follow-up"] = {
        "active_metadata": ocr_page(problem_numbers=["2.16"], retrieval_reason="student_requested_problem"),
        "retrieved_metadata": [ocr_page(problem_numbers=["2.16"], retrieval_reason="student_requested_problem")],
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": True,
                        "needs_search": False,
                        "student_response": "I can help with that same problem.",
                    }
                )
            },
            {"content": "Hint: use the same selected page."},
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert pages[0]["doc_id"] == "material-rank"
        return [{**pages[0], "file_data_url": "data:application/pdf;base64,c2FtZS1wYWdl"}]

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-follow-up",
        messages=[{"role": "user", "content": "yes, help with this"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    assert response["langGraphTrace"]["memoryUsed"] is True
    assert response["langGraphTrace"]["searchQueries"] == []
    assert any(part.get("type") == "file" for part in client.calls[1]["messages"][-1]["content"])


@pytest.mark.asyncio
async def test_follow_up_does_not_force_referenced_exercise_search_after_llm_no_search() -> None:
    graph_module._CHAT_RETRIEVAL_MEMORY_CACHE["conv-referenced-exercise"] = {
        "active_metadata": ocr_page(
            chunk_text=(
                "Exercise 2.18. Assuming the polynomial bases [1, x, x^2] and "
                "[1, x, x^2, x^3, x^4] for F[x;2] and F[x;4], respectively, "
                "find the matrix representations for each of the linear transformations in Exercise 2.3."
            ),
            problem_numbers=["2.18"],
            title="Linear Algebra Text",
        ),
        "retrieved_metadata": [
            ocr_page(
                chunk_text=(
                    "Exercise 2.18. Assuming the polynomial bases [1, x, x^2] and "
                    "[1, x, x^2, x^3, x^4] for F[x;2] and F[x;4], respectively, "
                    "find the matrix representations for each of the linear transformations in Exercise 2.3."
                ),
                problem_numbers=["2.18"],
                title="Linear Algebra Text",
            )
        ],
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": True,
                        "needs_search": False,
                        "student_response": "Start by applying each transformation to the basis vectors.",
                    }
                )
            },
            {"content": "Hint: use the selected basis vectors as inputs."},
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert [page["problem_numbers"] for page in pages] == [["2.18"]]
        return pages

    retriever = FakeRetriever([])
    response = await run_pdf_rag_agent(
        class_id="class-linear",
        conversation_id="conv-referenced-exercise",
        messages=[{"role": "user", "content": "help me on this"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        page_asset_builder=page_asset_builder,
        professor_id="teacher-1",
        retriever=retriever,
    )

    assert retriever.calls == []
    final_payload = json.dumps(client.calls[1]["messages"][-1]["content"])
    assert "Exercise 2.18" in final_payload
    assert "Exercise 2.3. Let T" not in final_payload
    assert response["langGraphTrace"]["memoryUsed"] is True
    assert response["langGraphTrace"]["searchQueries"] == []


@pytest.mark.asyncio
async def test_student_uploaded_pdf_file_is_sent_to_primary_tutor_model() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can use the uploaded PDF.",
                    }
                )
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "help me with the attached PDF"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
        student_attachment_files=[
            {
                "dataUrl": "data:application/pdf;base64,dXBsb2FkZWQtcGRm",
                "fileName": "homework.pdf",
                "fileSize": 12,
                "mimeType": "application/pdf",
            }
        ],
    )

    primary_content = client.calls[0]["messages"][-1]["content"]
    assert len(client.calls) == 1
    assert any(part.get("type") == "file" for part in primary_content)
    assert "dXBsb2FkZWQtcGRm" in json.dumps(primary_content)
    assert "dXBsb2FkZWQtcGRm" not in json.dumps(response["langGraphTrace"])


@pytest.mark.asyncio
async def test_student_upload_can_still_search_class_pdf_problem_context() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": False,
                        "memory_used": False,
                        "needs_search": True,
                        "retrieval_reason": "student_requested_problem",
                        "searches": [
                            {
                                "query": "find this uploaded problem in class materials",
                                "retrieval_reason": "student_requested_problem",
                                "top_k": 1,
                            }
                        ],
                        "student_response": "I'm checking the class materials for that problem.",
                    }
                )
            },
            {"content": "Problem:\nProblem 2.14. Prove rank(KL) <= rank(L)."},
        ]
    )
    retriever = FakeRetriever([ocr_page()])

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "here is my problem"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=retriever,
        student_attachment_files=[
            {
                "dataUrl": "data:image/jpeg;base64,aW1hZ2UtYnl0ZXM=",
                "fileName": "problem.jpg",
                "fileSize": 11,
                "fileType": "image",
                "mimeType": "image/jpeg",
            }
        ],
    )

    assert retriever.calls == [
        {
            "class_id": "class-linear",
            "professor_id": "teacher-1",
            "query": "find this uploaded problem in class materials",
            "top_k": 1,
        }
    ]
    assert response["langGraphTrace"]["retrievalDecision"]["decision_source"] == "search_required"
    assert response["langGraphTrace"]["searchQueries"] == ["find this uploaded problem in class materials"]
    assert response["langGraphTrace"]["toolCallCount"] == 1
    assert any(item.get("kind") == "problem" for item in response["langGraphTrace"]["knowledgeItems"])


@pytest.mark.asyncio
async def test_student_uploaded_pdf_extracted_text_without_file_is_sent_to_primary_tutor_model() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can use the uploaded PDF text.",
                    }
                )
            },
        ]
    )

    await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "help me with the attached PDF"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
        student_attachment_files=[
            {
                "extractedText": "Problem 2.14. Prove rank(KL) <= rank(L).",
                "fileName": "large-homework.pdf",
                "fileSize": 12_000_000,
                "fileType": "pdf",
                "mimeType": "application/pdf",
            }
        ],
    )

    primary_content = client.calls[0]["messages"][-1]["content"]
    assert len(client.calls) == 1
    assert any(
        part.get("type") == "text" and "Problem 2.14. Prove rank(KL) <= rank(L)." in part.get("text", "")
        for part in primary_content
    )
    assert not any(part.get("type") == "file" for part in primary_content)


@pytest.mark.asyncio
async def test_student_uploaded_pdf_extracted_problem_is_saved_to_knowledge() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "activeProblemDecision": {
                            "isActualProblem": True,
                            "problemText": "Problem 2.14. Prove rank(KL) <= rank(L).",
                            "problemSource": "student_upload",
                            "relationToPreviousProblem": "new_problem",
                            "confidence": "high",
                            "reason": "The uploaded PDF text contains a complete exercise statement.",
                        },
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can use the uploaded PDF text.",
                    }
                )
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "help me with the attached PDF"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
        student_attachment_files=[
            {
                "extractedText": "Problem 2.14. Prove rank(KL) <= rank(L).",
                "fileName": "large-homework.pdf",
                "fileSize": 12_000_000,
                "fileType": "pdf",
                "mimeType": "application/pdf",
            }
        ],
    )

    knowledge_items = response["langGraphTrace"]["knowledgeItems"]
    assert any(
        item.get("kind") == "problem"
        and item.get("usedAs") == "active_problem"
        and item.get("content") == "Problem 2.14. Prove rank(KL) <= rank(L)."
        for item in knowledge_items
    )
    assert any(item.get("kind") == "student_upload" and item.get("usedAs") == "supporting_context" for item in knowledge_items)


@pytest.mark.asyncio
async def test_student_uploaded_pdf_problem_text_requires_llm_active_problem_decision() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can use the uploaded PDF text.",
                    }
                )
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "help me with the attached PDF"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
        student_attachment_files=[
            {
                "extractedText": "Problem 2.14. Prove rank(KL) <= rank(L).",
                "fileName": "large-homework.pdf",
                "fileSize": 12_000_000,
                "fileType": "pdf",
                "mimeType": "application/pdf",
            }
        ],
    )

    knowledge_items = response["langGraphTrace"]["knowledgeItems"]
    assert not any(item.get("kind") == "problem" and item.get("usedAs") == "active_problem" for item in knowledge_items)
    assert response["langGraphTrace"]["activeProblemDecision"]["isActualProblem"] is False
    assert any(item.get("kind") == "student_upload" and item.get("usedAs") == "supporting_context" for item in knowledge_items)


@pytest.mark.asyncio
async def test_student_uploaded_image_is_sent_to_primary_tutor_model_without_followup_call() -> None:
    client = FakeOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": False,
                        "needs_search": False,
                        "student_response": "I can inspect the uploaded image.",
                    }
                )
            },
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "what is this image"}],
        model="openai/gpt-4.1-mini",
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
        student_attachment_files=[
            {
                "dataUrl": "data:image/jpeg;base64,aW1hZ2UtYnl0ZXM=",
                "fileName": "dog.jpg",
                "fileSize": 11,
                "fileType": "image",
                "mimeType": "image/jpeg",
            }
        ],
    )

    primary_content = client.calls[0]["messages"][-1]["content"]
    assert len(client.calls) == 1
    assert isinstance(primary_content, list)
    assert any(part.get("type") == "text" and "what is this image" in part.get("text", "") for part in primary_content)
    assert any(part.get("type") == "image_url" for part in primary_content)
    assert "aW1hZ2UtYnl0ZXM=" in json.dumps(primary_content)
    assert "If attachments are unrelated to class work, do not describe them" in client.calls[0]["messages"][0]["content"]
    assert "aW1hZ2UtYnl0ZXM=" not in json.dumps(response["langGraphTrace"])


@pytest.mark.asyncio
async def test_streaming_matches_non_streaming_retrieval_decision() -> None:
    decision = {
        "can_answer_now": True,
        "memory_used": False,
        "needs_search": False,
        "student_response": "Try naming what the inequality is comparing.",
    }
    client = FakeOpenRouterClient([{"content": json.dumps(decision)}])
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            messages=[{"role": "user", "content": "Can I get a hint?"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever([]),
        )
    ]

    assert len(client.calls) == 1
    assert events[-1]["type"] == "final"
    assert events[-1]["payload"]["content"] == "Try naming what the inequality is comparing."
    assert events[-1]["payload"]["langGraphTrace"]["decisionSource"] == "student_message"


@pytest.mark.asyncio
async def test_streaming_help_followup_does_not_emit_repeated_problem_section() -> None:
    client = FakeStreamingOpenRouterClient(
        [
            {
                "content": json.dumps(
                    {
                        "can_answer_now": True,
                        "memory_used": True,
                        "needs_search": False,
                        "student_response": "This is about representing a linear map using the chosen bases.",
                        "sections": {
                            "problem": "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
                            "mainChat": "This is about representing a linear map using the chosen bases.",
                        },
                        "sectionOrder": ["problem", "mainChat"],
                        "metadata": {
                            "hintLevel": "small_hint",
                            "mode": "guided_problem_solving",
                            "sourceConfidence": "medium",
                            "studentActionNeeded": "show_attempt",
                        },
                    }
                )
            }
        ]
    )

    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            conversation_id="conv-help-on-this",
            messages=[{"role": "user", "content": "I need help on this"}],
            model="openai/gpt-4.1-mini",
            openrouter_client=client,
            retriever=FakeRetriever([]),
        )
    ]

    streamed_sections = [
        event.get("section")
        for event in events
        if event.get("type") in {"section_start", "section_delta", "section_done"}
    ]
    final_payload = events[-1]["payload"]

    assert "problem" not in streamed_sections
    assert "problem" not in final_payload["structuredOutput"]["sections"]
    assert "2.18. Assuming" not in final_payload["content"]


@pytest.mark.asyncio
async def test_retries_primary_tutor_turn_with_double_tokens_after_length_stop() -> None:
    decision = {
        "can_answer_now": True,
        "memory_used": False,
        "needs_search": False,
        "student_response": "Use the image of the composed map: every output of KL is K(something).",
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": '{"can_answer_now":true,"needs_search":false,"student_response":"Use',
                "finish_reason": "length",
                "usage": {"completion_tokens": 397},
            },
            {"content": json.dumps(decision), "finish_reason": "stop"},
        ]
    )

    response = await run_pdf_rag_agent(
        class_id="class-linear",
        messages=[{"role": "user", "content": "I think im(KL) is inside im(L)."}],
        model="openai/gpt-4.1-mini",
        max_tokens=1800,
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    assert [call["max_tokens"] for call in client.calls] == [1800, 3600]
    assert response["content"] == decision["student_response"]


@pytest.mark.asyncio
async def test_streaming_retries_primary_tutor_turn_with_double_tokens_after_length_stop() -> None:
    decision = {
        "can_answer_now": True,
        "memory_used": False,
        "needs_search": False,
        "student_response": "Use the image of the composed map: every output of KL is K(something).",
    }
    client = FakeOpenRouterClient(
        [
            {
                "content": '{"can_answer_now":true,"needs_search":false,"student_response":"Use',
                "finish_reason": "length",
                "usage": {"completion_tokens": 397},
            },
            {"content": json.dumps(decision), "finish_reason": "stop"},
        ]
    )
    events = [
        event
        async for event in run_pdf_rag_agent_stream(
            class_id="class-linear",
            messages=[{"role": "user", "content": "I think im(KL) is inside im(L)."}],
            model="openai/gpt-4.1-mini",
            max_tokens=1800,
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever([]),
        )
    ]

    assert [call["max_tokens"] for call in client.calls] == [1800, 3600]
    assert events[-1]["payload"]["content"] == decision["student_response"]
