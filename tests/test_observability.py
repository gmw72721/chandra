from __future__ import annotations

import pytest

from backend.observability import (
    better_stack_ingest_endpoint,
    better_stack_logging_status,
    redact_log_fields,
    safe_request_id,
)


def test_better_stack_ingest_endpoint_uses_https_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BETTER_STACK_INGESTING_HOST", "in.logs.betterstack.com")

    assert better_stack_ingest_endpoint() == "https://in.logs.betterstack.com"


def test_better_stack_logging_status_reports_missing_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BETTER_STACK_SOURCE_TOKEN", raising=False)
    monkeypatch.delenv("BETTER_STACK_INGESTING_HOST", raising=False)

    status = better_stack_logging_status()

    assert status["status"] == "missing_config"
    assert status["sourceTokenConfigured"] is False
    assert status["ingestingHostConfigured"] is False


def test_redact_log_fields_removes_sensitive_payloads() -> None:
    redacted = redact_log_fields(
        {
            "authorization": "Bearer secret-token",
            "classId": "class-1",
            "messages": [{"content": "private student text"}],
            "providerPrompt": "raw prompt",
        }
    )

    assert redacted["authorization"] == "[REDACTED]"
    assert redacted["classId"] == "class-1"
    assert redacted["messages"] == "[REDACTED]"
    assert redacted["providerPrompt"] == "[REDACTED]"


def test_safe_request_id_rejects_header_injection() -> None:
    assert safe_request_id("abc-123") == "abc-123"
    assert safe_request_id("abc\nx-secret: leaked") == ""
