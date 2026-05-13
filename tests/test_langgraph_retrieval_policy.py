from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import pytest

import backend.agent.graph as graph_module
from backend.agent.graph import run_pdf_rag_agent, run_pdf_rag_agent_stream


class FakeOpenRouterClient:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def chat(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.responses.pop(0)


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
    monkeypatch.setattr(graph_module, "apply_leak_guard_with_model", lambda **kwargs: _return_async(kwargs["answer"]))
    monkeypatch.setattr(graph_module, "save_chat_retrieval_memory", lambda memory, state: graph_module._CHAT_RETRIEVAL_MEMORY_CACHE.update({state.get("conversation_id") or "test": memory}))


async def _noop_async() -> None:
    return None


async def _return_async(value: str) -> str:
    return value


def test_normalize_backend_structured_output_unwraps_section_text_objects() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": {"text": "I'm checking the exact problem 2.16 now."},
                "nextStep": "{'text': 'Send the page or a photo.'}",
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
        "answer": "I'm checking the exact problem 2.16 now.",
        "nextStep": "Send the page or a photo.",
    }


def test_decision_prompt_searches_source_lookup_before_asking_for_more_detail() -> None:
    heuristic = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="student_requested_problem",
        query="find exact problem page OCR metadata 2.24",
        active_record=None,
        memory_used=False,
    )

    messages = graph_module.build_tutor_decision_messages(
        {
            "answer_policy": {"refuseAnswerOnlyRequests": True},
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "2.24"}],
            "source_usage": {"useClassMaterialsFirst": True},
        },
        heuristic,
    )

    system_prompt = messages[0]["content"]
    assert "Treat the provided heuristic as the default plan" in system_prompt
    assert "bare number, problem/exercise/question locator" in system_prompt
    assert "needs_search true unless active_metadata already contains the exact requested item" in system_prompt
    assert "Do not answer with a request for the page image" in system_prompt
    assert "For find-similar-example requests" in system_prompt
    assert "rather than only the assigned problem number" in system_prompt


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


def test_tutor_decision_can_return_one_search_per_distinct_need() -> None:
    decision = graph_module.parse_tutor_decision_response(
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


def test_decision_json_with_latex_backslashes_is_parsed_not_surfaced() -> None:
    content = (
        '{"can_answer_now":true,"needs_search":false,"retrieval_reason":"","search_query":"",'
        '"searches":[],"help_level":"guiding_question",'
        '"student_response":"Start with part (i): compare $\\operatorname{span}(S)$ with $F[x;2]$.",'
        '"memory_used":true,'
        '"structuredOutput":{"hint":"Use $\\operatorname{span}(S)$, not the raw list.",'
        '"nextStep":"Can you make $1$, $x$, and $x^2$?"},'
        '"sectionOrder":["hint","nextStep"],"metadata":{"problem":"1.7"}}'
    )

    decision = graph_module.parse_tutor_decision_response(
        {"content": content},
        {},
    )

    assert decision["needs_search"] is False
    assert decision["student_response"] == "Start with part (i): compare $\\operatorname{span}(S)$ with $F[x;2]$."
    assert decision["structuredOutput"]["sections"]["hint"] == "Use $\\operatorname{span}(S)$, not the raw list."
    assert not decision["student_response"].startswith("{")


def test_example_request_cannot_be_downgraded_to_no_search_refusal() -> None:
    fallback = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="needed_example_page",
        query="worked example textbook reading notes method OCR metadata ACME VOL 1 show me an example",
        active_record=ocr_page(title="ACME VOL 1"),
        memory_used=False,
    )

    decision = graph_module.parse_tutor_decision_response(
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

    assert decision["needs_search"] is True
    assert decision["can_answer_now"] is False
    assert decision["retrieval_reason"] == "needed_example_page"
    assert decision["student_response"] == "I'm looking for a relevant class example."
    assert decision["searches"] == [
        {
            "query": "worked example textbook reading notes method OCR metadata ACME VOL 1 show me an example",
            "retrieval_reason": "needed_example_page",
            "top_k": 5,
        }
    ]


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

    messages = graph_module.build_tutor_decision_messages(state, heuristic)
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

    messages = graph_module.build_tutor_decision_messages(state, heuristic)
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

    decision = graph_module.parse_tutor_decision_response(
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


def test_repeated_stuck_plan_can_escalate_to_depth_two() -> None:
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
    assert understanding["understandingLevel"] == 2


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

    messages = graph_module.build_tutor_decision_messages(state, heuristic)
    system_prompt = messages[0]["content"]

    assert "not from turn count and not by incrementing one level at a time" in system_prompt
    assert "The level may jump by more than 1 in a single update" in system_prompt
    assert "0 = problem loaded, no student understanding observed yet" in system_prompt
    assert "1 = needs first nudge or little/no useful work shown" in system_prompt
    assert "2 = understands setup but is missing the core idea" in system_prompt
    assert "3 = understands the core idea but needs execution help" in system_prompt
    assert "4 = solution-ready, mostly needs verification or minor cleanup" in system_prompt
    assert "once the student asks for help, shows work, asks for explanation, asks for a next step, or seeks verification on the active problem, use at least level 1" in system_prompt
    assert "State update wording must explain the evidence for the understanding level, not teach the academic concept" in system_prompt
    assert "Do not write definitions such as `image means...`" in system_prompt
    assert "connected image containment to rank" in system_prompt
    assert "asked how the concept applies but has not shown work" in system_prompt
    assert "Allowed jumps include 0->2, 0->3, 0->4, 1->3, and 1->4" in system_prompt
    assert "incorrectly claims im(KL) is contained in im(L), set understandingLevel to 2, not 1" in system_prompt


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
    assert understanding["hintsGiven"] == 3
    assert "image containment" in understanding["lastHintSummary"]


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
    assert understanding["hintsGiven"] == 1


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


def test_decision_prompt_tracks_current_step_and_substep_for_repeated_stuck() -> None:
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
                    "currentSubstep": "Substitute L(e1) and L(e2).",
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

    messages = graph_module.build_tutor_decision_messages(state, heuristic)
    payload = json.loads(messages[-1]["content"])
    system_prompt = messages[0]["content"]

    assert payload["problem_understanding_state"]["currentStep"] == "Compute L(2e1 - 3e2) using linearity."
    assert payload["problem_understanding_state"]["currentStepStatus"] == "in_progress"
    assert "Do not advance currentStep to a later problem step" in system_prompt
    assert "make currentSubstep smaller" in system_prompt
    assert "tiny or unclear answer like `2?`" in system_prompt
    assert "complaints that the previous hint was unhelpful, repetitive, too vague, or did not add more" in system_prompt
    assert "one new concrete distinction, prerequisite idea, or narrower sub-question" in system_prompt
    assert "explain only the expected answer form or type without revealing the value they should get" in system_prompt
    assert "do not move from computing L(2e1 - 3e2) to computing L^2(2e1 - 3e2)" in system_prompt
    assert "2L(e1), -3L(e2), then combining terms" in system_prompt


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
                    "currentSubstep": "Identify the space where im(KL) lives.",
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
                "currentSubstep": "Identify the space where im(KL) lives.",
                "currentStepStatus": "in_progress",
            }
        },
    }

    messages = graph_module.build_multimodal_final_messages(state)
    instruction_text = messages[1]["content"][0]["text"]

    assert "previous hint was unhelpful, repetitive, too vague, or did not add more" in instruction_text
    assert "add one new concrete distinction or prerequisite idea" in instruction_text
    assert "specific missing object, definition, target space, assumption, comparison, representation, or notation choice" in instruction_text


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
        "currentSubstep": "Find 2L(e1).",
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
        "currentSubstep": "Find 2L(e1).",
        "currentStepStatus": "unclear",
        "stateUpdates": {
            "understandingLevel": 1,
            "lastStudentAttemptSummary": "Student gave a tiny unclear answer, `2?`, without a vector expression.",
            "lastHintSummary": "Clarified that the expected answer is a vector expression for 2L(e1).",
        },
    }

    understanding = graph_module.state_after_tutor_plan(state, plan)

    assert understanding["currentStep"] == "Compute L(2e1 - 3e2) using linearity."
    assert understanding["currentSubstep"] == "Find 2L(e1)."
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
                "nextStep": "Send the first transformation from Exercise 2.3.",
            },
            "sectionOrder": ["hint", "nextStep", "answer", "formula"],
            "metadata": {
                "hintLevel": "guided_step",
                "mode": "guided_problem_solving",
                "sourceConfidence": "low",
                "studentActionNeeded": "try_next_step",
            },
        }
    )

    assert structured_output is not None
    assert structured_output["sectionOrder"] == ["answer", "hint", "formula", "nextStep"]


def test_normalize_backend_structured_output_removes_duplicate_hint_next_step() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "You are connecting the prompt to the rule that applies here.",
                "hint": "Focus on the condition in the prompt that tells you which rule applies.",
                "nextStep": "Focus on the condition in the prompt that tells you which rule applies.",
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
        "answer": "You are connecting the prompt to the rule that applies here.",
        "hint": "Focus on the condition in the prompt that tells you which rule applies.",
    }


def test_normalize_backend_structured_output_removes_hint_repeated_by_orientation() -> None:
    structured_output = graph_module.normalize_backend_structured_output(
        {
            "sections": {
                "answer": "You are identifying the condition in the prompt that tells you which rule applies.",
                "hint": "Identify the condition in the prompt that tells you which rule applies.",
                "nextStep": "Write down the one condition you found.",
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
        "answer": "You are identifying the condition in the prompt that tells you which rule applies.",
        "nextStep": "Write down the one condition you found.",
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

    assert structured_output is not None
    assert "problem" not in structured_output["sections"]
    assert structured_output["sections"]["answer"].startswith("You said: 2.20")


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
    decision = graph_module.parse_tutor_decision_response(
        {
            "content": json.dumps(
                {
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "Problem 2.20",
                    "structuredOutput": {
                        "sections": {
                            "answer": "I'm checking the exact textbook/homework problem for 2.20 now.",
                            "nextStep": "I'm checking the exact problem statement for 2.20 now.",
                        },
                        "sectionOrder": ["nextStep", "answer"],
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

    assert decision["structuredOutput"]["sections"] == {
        "answer": "I'm checking the exact textbook/homework problem for 2.20 now."
    }
    assert "Next step:" not in decision["student_response"]


def test_retrieval_decision_suppresses_source_request_while_searching() -> None:
    decision = graph_module.parse_tutor_decision_response(
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
    decision = graph_module.parse_tutor_decision_response(
        {
            "content": json.dumps(
                {
                    "needs_search": True,
                    "retrieval_reason": "student_requested_problem",
                    "search_query": "Problem 2.20",
                    "structuredOutput": {
                        "sections": {
                            "answer": "I'm checking the exact 2.20 problem next.",
                            "nextStep": "Please send the page photo or type the full problem text so I can help step by step.",
                        },
                        "sectionOrder": ["answer", "nextStep"],
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

    assert decision["student_response"] == "I'm checking the exact 2.20 problem next."
    assert decision["structuredOutput"]["sections"] == {"answer": "I'm checking the exact 2.20 problem next."}
    assert "nextStep" not in decision["structuredOutput"]["sections"]


def test_decision_prompt_forbids_source_request_while_searching() -> None:
    heuristic = graph_module.retrieval_decision(
        decision_source="search_required",
        needs_search=True,
        retrieval_reason="student_requested_problem",
        query="find exact problem page OCR metadata 2.20",
        active_record=None,
        memory_used=False,
    )

    messages = graph_module.build_tutor_decision_messages(
        {
            "answer_policy": {"refuseAnswerOnlyRequests": True},
            "chat_retrieval_memory": {},
            "messages": [{"role": "user", "content": "2.20"}],
            "source_usage": {"useClassMaterialsFirst": True},
        },
        heuristic,
    )

    system_prompt = messages[0]["content"]
    assert "do not ask the student to send, upload, type, paste, or share a page image" in system_prompt
    assert "exact source, or problem text in student_response or structuredOutput" in system_prompt
    assert "do not include a nextStep" in system_prompt
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
    assert structured["sections"]["answer"] == "That's the exact Exercise 2.18 on printed page 80"


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


def test_depth_one_structured_output_drops_extra_next_step_card() -> None:
    structured = {
        "sections": {
            "answer": "Start with the object the problem is about.",
            "hint": "Focus on the columns of the rotation matrix.",
            "nextStep": "Compute the dot product of the two transformed generic vectors.",
        },
        "sectionOrder": ["answer", "hint", "nextStep"],
        "metadata": {},
    }

    suppressed = graph_module.suppress_depth_one_over_scaffolding(
        structured,
        {"tutor_plan": {"nextHelpDepth": 1}},
    )

    assert suppressed["sections"] == {
        "answer": "Start with the object the problem is about.",
        "hint": "Focus on the columns of the rotation matrix.",
    }
    assert suppressed["sectionOrder"] == ["answer", "hint"]


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
async def test_empty_final_answer_extracts_unlabeled_numbered_problem_statement() -> None:
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

    assert len(client.calls) == 1
    assert quick_messages == ["I'm checking the class materials for that problem."]
    assert final_content != quick_messages[0]
    assert final_content.startswith("I could not find that exact problem")


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
    assert any(part["type"] == "text" and "OCR text:" in part["text"] for part in final_content)
    assert any(part.get("type") == "file" for part in final_content)
    assert "cmF3LXBkZg==" in json.dumps(final_content)
    assert "ZnVsbC1wZGY=" in json.dumps(final_content)
    assert "pdf_image" not in json.dumps(response["langGraphTrace"])
    assert "pdf_file" not in json.dumps(response["langGraphTrace"])
    assert "file_data_url" not in json.dumps(response["langGraphTrace"])
    assert "cmF3LXBkZg==" not in json.dumps(response["langGraphTrace"])
    assert "ZnVsbC1wZGY=" not in json.dumps(response["langGraphTrace"])


@pytest.mark.asyncio
async def test_garbled_problem_lookup_still_sends_page_asset_to_final_model() -> None:
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
async def test_follow_up_fetches_referenced_exercise_before_helping() -> None:
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
    referenced_page = ocr_page(
        chunk_text="Exercise 2.3. Let T(p(x)) = x^2 p(x).",
        doc_id="material-linear",
        page_start=11,
        page_end=11,
        printed_page_start=79,
        problem_numbers=["2.3"],
        title="Linear Algebra Text",
    )
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
            {"content": "Hint: use both selected exercises."},
        ]
    )

    async def page_asset_builder(pages: list[dict[str, Any]], *, max_total_pages: int) -> list[dict[str, Any]]:
        assert [page["problem_numbers"] for page in pages] == [["2.18"], ["2.3"]]
        return pages

    retriever = FakeRetriever([referenced_page])
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

    assert retriever.calls == [
        {
            "class_id": "class-linear",
            "professor_id": "teacher-1",
            "query": "find exact referenced exercise problem 2.3 Linear Algebra Text",
            "top_k": 2,
        }
    ]
    final_payload = json.dumps(client.calls[1]["messages"][-1]["content"])
    assert "Exercise 2.18" in final_payload
    assert "Exercise 2.3" in final_payload
    assert response["langGraphTrace"]["memoryUsed"] is True
    assert response["langGraphTrace"]["searchQueries"] == ["find exact referenced exercise problem 2.3 Linear Algebra Text"]


@pytest.mark.asyncio
async def test_student_uploaded_pdf_file_is_sent_to_final_model() -> None:
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
            {"content": "I read the uploaded PDF file."},
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

    final_content = client.calls[1]["messages"][-1]["content"]
    assert any(part.get("type") == "file" for part in final_content)
    assert "dXBsb2FkZWQtcGRm" in json.dumps(final_content)
    assert "dXBsb2FkZWQtcGRm" not in json.dumps(response["langGraphTrace"])


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
async def test_retries_tutor_decision_with_double_tokens_after_length_stop() -> None:
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
        max_tokens=900,
        openrouter_client=client,
        professor_id="teacher-1",
        retriever=FakeRetriever([]),
    )

    assert [call["max_tokens"] for call in client.calls] == [900, 1800]
    assert response["content"] == decision["student_response"]


@pytest.mark.asyncio
async def test_streaming_retries_tutor_decision_with_double_tokens_after_length_stop() -> None:
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
            max_tokens=900,
            openrouter_client=client,
            professor_id="teacher-1",
            retriever=FakeRetriever([]),
        )
    ]

    assert [call["max_tokens"] for call in client.calls] == [900, 1800]
    assert events[-1]["payload"]["content"] == decision["student_response"]
