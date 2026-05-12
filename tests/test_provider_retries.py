from __future__ import annotations

import ssl
from typing import Any

import httpx
import pytest

from backend.agent.openrouter_client import OpenRouterClient, normalize_token_usage
from backend.agent.graph import maybe_adjust_ai_usage_reservation
from backend.agent.tools import search_pdf_pages
from backend.retrieval.pdf_retriever import build_query_features


class FakeOpenRouterResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "Recovered after retry.",
                        "tool_calls": [],
                    }
                }
            ]
        }


@pytest.mark.asyncio
async def test_openrouter_client_retries_read_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[int] = []

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: object, **_kwargs: object) -> FakeOpenRouterResponse:
            attempts.append(1)
            if len(attempts) == 1:
                raise httpx.ReadError("provider closed connection")

            return FakeOpenRouterResponse()

    monkeypatch.setattr("backend.agent.openrouter_client.httpx.AsyncClient", FakeAsyncClient)
    client = OpenRouterClient(api_key="test-key", max_retries=2)

    response = await client.chat(model="test-model", messages=[{"role": "user", "content": "hi"}])

    assert response["content"] == "Recovered after retry."
    assert response["finish_reason"] == "stop"
    assert len(attempts) == 2


@pytest.mark.asyncio
async def test_openrouter_client_retries_ssl_errors_with_fresh_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[int] = []
    closed_clients = 0

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        async def post(self, *_args: object, **_kwargs: object) -> FakeOpenRouterResponse:
            attempts.append(1)
            if len(attempts) == 1:
                raise ssl.SSLError("sslv3 alert bad record mac")

            return FakeOpenRouterResponse()

        async def aclose(self) -> None:
            nonlocal closed_clients
            closed_clients += 1

    monkeypatch.setattr("backend.agent.openrouter_client.httpx.AsyncClient", FakeAsyncClient)
    client = OpenRouterClient(api_key="test-key", max_retries=2)

    response = await client.chat(model="test-model", messages=[{"role": "user", "content": "hi"}])

    assert response["content"] == "Recovered after retry."
    assert len(attempts) == 2
    assert closed_clients == 1


@pytest.mark.asyncio
async def test_pdf_reservation_adjustment_failure_does_not_abort_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            return None

        async def __aenter__(self) -> "FailingAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: object, **_kwargs: object) -> httpx.Response:
            raise httpx.ConnectError("frontend internal route unreachable")

    monkeypatch.setenv("CHANDRA_ENV", "production")
    monkeypatch.setenv("BACKEND_SHARED_SECRET", "test-secret")
    monkeypatch.setattr("backend.agent.graph.httpx.AsyncClient", FailingAsyncClient)
    monkeypatch.setattr("backend.agent.graph.internal_next_base_url", lambda _context: "https://frontend.example")

    state = {
        "ai_usage_reservation": {
            "estimatedTokens": 100,
            "id": "reservation-1",
            "studentId": "student-1",
        },
        "class_id": "class-1",
        "conversation_id": "conversation-1",
        "max_tokens": 800,
        "messages": [],
        "student_id": "student-1",
        "token_usage": {"total_tokens": 50},
    }

    await maybe_adjust_ai_usage_reservation(state, [{"content": "x" * 4000, "role": "user"}])

    assert state["ai_usage_reservation"]["estimatedTokens"] == 100


@pytest.mark.asyncio
async def test_pdf_reservation_adjustment_429_still_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class LimitResponse:
        status_code = 429
        is_success = False
        text = '{"error":"AI usage limit reached."}'

    class LimitAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            return None

        async def __aenter__(self) -> "LimitAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: object, **_kwargs: object) -> LimitResponse:
            return LimitResponse()

    monkeypatch.setenv("CHANDRA_ENV", "production")
    monkeypatch.setenv("BACKEND_SHARED_SECRET", "test-secret")
    monkeypatch.setattr("backend.agent.graph.httpx.AsyncClient", LimitAsyncClient)
    monkeypatch.setattr("backend.agent.graph.internal_next_base_url", lambda _context: "https://frontend.example")

    state = {
        "ai_usage_reservation": {
            "estimatedTokens": 100,
            "id": "reservation-1",
            "studentId": "student-1",
        },
        "class_id": "class-1",
        "conversation_id": "conversation-1",
        "max_tokens": 800,
        "messages": [],
        "student_id": "student-1",
        "token_usage": {"total_tokens": 50},
    }

    with pytest.raises(RuntimeError, match="AI usage limit reached."):
        await maybe_adjust_ai_usage_reservation(state, [{"content": "x" * 4000, "role": "user"}])


def test_query_feature_builder_handles_non_string_query_objects() -> None:
    class QueryLikeObject:
        def __str__(self) -> str:
            return "trig substitution problem 14 page 104"

    features = build_query_features(QueryLikeObject())

    assert "trig" in features["terms"]
    assert "14" in features["problem_numbers"]
    assert 104 in features["page_numbers"]


def test_openrouter_usage_normalizes_reasoning_token_details() -> None:
    usage = normalize_token_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 125,
            "completion_tokens_details": {
                "reasoning_tokens": 5,
            },
        }
    )

    assert usage == {
        "input_tokens": 100,
        "output_tokens": 20,
        "reasoning_tokens": 5,
        "total_tokens": 125,
    }


def test_problem_numbers_parse_ocr_spaced_dotted_items() -> None:
    features = build_query_features(
        "no 2 14 Given the setup of Exercise 2.13, prove the following inequalities:"
    )

    assert "2.14" in features["problem_numbers"]
    assert "2.13" in features["problem_numbers"]


def test_problem_numbers_parse_bare_dotted_problem_lookup() -> None:
    features = build_query_features("2.20?")

    assert features["problem_numbers"] == {"2.20"}
    assert features["exact_lookup_intent"] is True


def test_concept_method_query_with_equation_but_no_locator_stays_semantic_led() -> None:
    features = build_query_features(
        "Explain rank-nullity / how do I prove inequalities like rank(KL) <= rank(L)?"
    )

    assert features["exact_lookup_intent"] is False
    assert features["problem_numbers"] == set()


@pytest.mark.asyncio
async def test_search_pdf_pages_defaults_to_next_internal_retrieval(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "pages": [
                    {
                        "chunk_text": "Problem 7 asks students to solve a linear equation.",
                        "doc_id": "material-1",
                        "material_type": "assignment",
                        "ocrConfidence": 0.94,
                        "ocrProvider": "google-document-ai",
                        "ocrSource": "projects/demo/locations/us/processors/5d3fa32c2ebe2a90",
                        "page_end": 3,
                        "page_start": 3,
                        "problemNumbers": ["7"],
                        "retrievalMode": "exact_problem",
                        "score": 0.91,
                        "section": "Practice",
                        "source_pdf_path": "gs://bucket/material.pdf",
                        "storageBucket": "bucket",
                        "storagePath": "material.pdf",
                        "title": "Practice Problems",
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            requests.append({"url": url, **kwargs})
            return FakeResponse()

    monkeypatch.setenv("BACKEND_SHARED_SECRET", "test-secret")
    monkeypatch.setenv("NEXT_INTERNAL_BASE_URL", "http://next.local")
    monkeypatch.setattr("backend.agent.tools.httpx.AsyncClient", FakeAsyncClient)

    pages = await search_pdf_pages(
        "find problem 7",
        class_id="class-1",
        professor_id="teacher-1",
    )

    assert pages == [
        {
            "chunk_text": "Problem 7 asks students to solve a linear equation.",
            "class_id": "class-1",
            "doc_id": "material-1",
            "material_type": "assignment",
            "ocr_confidence": 0.94,
            "ocr_provider": "google-document-ai",
            "ocr_source": "projects/demo/locations/us/processors/5d3fa32c2ebe2a90",
            "ocr_text": "Problem 7 asks students to solve a linear equation.",
            "page_end": 3,
            "page_start": 3,
            "page_asset_checksum_sha256": "",
            "page_asset_mime_type": "",
            "page_asset_size_bytes": None,
            "page_asset_storage_bucket": "",
            "page_asset_storage_path": "",
            "printed_page_end": None,
            "printed_page_start": None,
            "professor_id": "teacher-1",
            "problem_numbers": ["7"],
            "retrieval_mode": "exact_problem",
            "retrieval_reason": "student_requested_problem",
            "score": 0.91,
            "section": "Practice",
            "source_pdf_path": "gs://bucket/material.pdf",
            "storage_bucket": "bucket",
            "storage_path": "material.pdf",
            "title": "Practice Problems",
        }
    ]
    assert requests == [
        {
            "headers": {
                "Content-Type": "application/json",
                "X-Chandra-Internal-Secret": "test-secret",
            },
            "json": {
                "classId": "class-1",
                "professorId": "teacher-1",
                "query": "find problem 7",
                "retrievalReason": "student_requested_problem",
                "topK": 5,
            },
            "url": "http://next.local/api/internal/pdf-page-search",
        }
    ]
