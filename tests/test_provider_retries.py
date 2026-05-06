from __future__ import annotations

from typing import Any

import httpx
import pytest

from agent.openrouter_client import OpenRouterClient
from retrieval.pdf_retriever import GeminiPdfRetriever, build_query_features


class FakeOpenRouterResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return {
            "choices": [
                {
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

    monkeypatch.setattr("agent.openrouter_client.httpx.AsyncClient", FakeAsyncClient)
    client = OpenRouterClient(api_key="test-key", max_retries=2)

    response = await client.chat(model="test-model", messages=[{"role": "user", "content": "hi"}])

    assert response["content"] == "Recovered after retry."
    assert len(attempts) == 2


@pytest.mark.asyncio
async def test_gemini_retriever_returns_no_hits_after_embedding_read_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[int] = []

    class FakeAsyncClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: object, **_kwargs: object) -> httpx.Response:
            attempts.append(1)
            raise httpx.ReadError("embedding provider closed connection")

    monkeypatch.setattr("retrieval.pdf_retriever.httpx.AsyncClient", FakeAsyncClient)
    retriever = GeminiPdfRetriever(gemini_api_key="test-key")

    result = await retriever.search(query="trig substitution", class_id="class-1", professor_id="teacher-1")

    assert result == []
    assert len(attempts) == 3


def test_query_feature_builder_handles_non_string_query_objects() -> None:
    class QueryLikeObject:
        def __str__(self) -> str:
            return "trig substitution problem 14 page 104"

    features = build_query_features(QueryLikeObject())

    assert "trig" in features["terms"]
    assert "14" in features["problem_numbers"]
    assert 104 in features["page_numbers"]
