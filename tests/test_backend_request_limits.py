from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.main import (
    ChatRequest,
    MAX_MESSAGE_CONTENT_CHARS,
    MAX_PROVIDER_MESSAGE_CONTENT_CHARS,
    enforce_ai_usage_reservation,
    validate_message_payload_size,
)
from backend.agent.openrouter_client import normalize_token_usage


def test_langgraph_provider_messages_accept_larger_server_built_prompts() -> None:
    validate_message_payload_size(
        [{"content": "x" * (MAX_MESSAGE_CONTENT_CHARS + 1)}],
        max_message_content_chars=MAX_PROVIDER_MESSAGE_CONTENT_CHARS,
    )


def test_default_chat_messages_still_reject_oversized_raw_content() -> None:
    with pytest.raises(HTTPException) as raised:
        validate_message_payload_size([{"content": "x" * (MAX_MESSAGE_CONTENT_CHARS + 1)}])

    assert raised.value.status_code == 413
    assert raised.value.detail == "A chat message is too large."


def test_openrouter_usage_is_normalized_for_token_budget_tracking() -> None:
    assert normalize_token_usage(
        {
            "prompt_tokens": 120,
            "completion_tokens": 30,
            "total_tokens": 150,
        }
    ) == {
        "input_tokens": 120,
        "output_tokens": 30,
        "reasoning_tokens": 0,
        "total_tokens": 150,
    }


def test_legacy_chat_request_preserves_ai_usage_reservation() -> None:
    request = ChatRequest(
        aiUsageReservation={"estimatedTokens": 250, "id": "reservation-1", "studentId": "student-1"},
        messages=[
            {
                "id": "message-1",
                "role": "student",
                "content": "Can you help me with problem 2?",
                "createdAt": "2026-05-12T00:00:00.000Z",
            }
        ],
    )

    assert request.aiUsageReservation == {"estimatedTokens": 250, "id": "reservation-1", "studentId": "student-1"}
    enforce_ai_usage_reservation(request.aiUsageReservation, student_id="student-1")


def test_student_chat_requires_valid_ai_usage_reservation() -> None:
    with pytest.raises(HTTPException) as raised:
        enforce_ai_usage_reservation(None, student_id="student-1")

    assert raised.value.status_code == 429
    assert raised.value.detail == "AI usage reservation required."


def test_student_chat_rejects_reservation_for_different_student() -> None:
    with pytest.raises(HTTPException) as raised:
        enforce_ai_usage_reservation(
            {"estimatedTokens": 250, "id": "reservation-1", "studentId": "student-2"},
            student_id="student-1",
        )

    assert raised.value.status_code == 429
    assert raised.value.detail == "AI usage reservation required."
