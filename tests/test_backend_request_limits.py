from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.main import (
    MAX_MESSAGE_CONTENT_CHARS,
    MAX_PROVIDER_MESSAGE_CONTENT_CHARS,
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
        "total_tokens": 150,
    }
