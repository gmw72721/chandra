from __future__ import annotations

import sys
import types
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

    monkeypatch.setattr("agent.openrouter_client.httpx.AsyncClient", FakeAsyncClient)
    client = OpenRouterClient(api_key="test-key", max_retries=2)

    response = await client.chat(model="test-model", messages=[{"role": "user", "content": "hi"}])

    assert response["content"] == "Recovered after retry."
    assert response["finish_reason"] == "stop"
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


@pytest.mark.asyncio
async def test_gemini_retriever_excludes_teacher_only_and_hidden_materials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_fake_firestore_modules(monkeypatch)
    hidden_materials = [
        {"status": "ready", "teacherOnly": True, "title": "Teacher Solutions"},
        {"status": "ready", "visibility": "hidden", "title": "Hidden Notes"},
        {"status": "ready", "activeForStudents": False, "title": "Inactive Reading"},
        {"status": "ready", "private": True, "title": "Private Source"},
    ]

    for material in hidden_materials:
        FakeFirestoreClient.next_chunks = [fake_chunk_doc(material=material)]
        retriever = GeminiPdfRetriever(gemini_api_key="test-key")

        results = await retriever._search_firestore(
            class_id="class-1",
            professor_id="teacher-1",
            query="problem 7",
            query_vector=[0.1, 0.2],
            top_k=5,
        )

        assert results == []


@pytest.mark.asyncio
async def test_gemini_retriever_keeps_student_visible_ready_material(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_fake_firestore_modules(monkeypatch)
    FakeFirestoreClient.next_chunks = [
        fake_chunk_doc(
            material={
                "status": "ready",
                "studentVisible": True,
                "title": "Student Worksheet",
            }
        )
    ]
    retriever = GeminiPdfRetriever(gemini_api_key="test-key")

    results = await retriever._search_firestore(
        class_id="class-1",
        professor_id="teacher-1",
        query="problem 7",
        query_vector=[0.1, 0.2],
        top_k=5,
    )

    assert [result.title for result in results] == ["Student Worksheet"]


def install_fake_firestore_modules(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_firestore_module = types.SimpleNamespace(client=lambda: FakeFirestoreClient())
    fake_firebase_admin = types.SimpleNamespace(
        _apps=["test-app"],
        firestore=fake_firestore_module,
        initialize_app=lambda: None,
    )
    fake_distance_module = types.SimpleNamespace(DistanceMeasure=types.SimpleNamespace(COSINE="COSINE"))

    monkeypatch.setitem(sys.modules, "firebase_admin", fake_firebase_admin)
    monkeypatch.setitem(sys.modules, "firebase_admin.firestore", fake_firestore_module)
    monkeypatch.setitem(sys.modules, "google", types.SimpleNamespace())
    monkeypatch.setitem(sys.modules, "google.cloud", types.SimpleNamespace())
    monkeypatch.setitem(sys.modules, "google.cloud.firestore_v1", types.SimpleNamespace())
    monkeypatch.setitem(sys.modules, "google.cloud.firestore_v1.base_vector_query", fake_distance_module)


def fake_chunk_doc(*, material: dict[str, Any]) -> "FakeChunkDoc":
    return FakeChunkDoc(
        chunk={
            "chunk_text": "Problem 7 asks students to solve a linear equation.",
            "classId": "class-1",
            "docId": "material-1",
            "materialType": "assignment",
            "page_start": 3,
            "page_end": 3,
            "professorId": "teacher-1",
            "title": material.get("title", "Material"),
            "vectorDistance": 0.1,
        },
        material=material,
    )


class FakeFirestoreClient:
    next_chunks: list["FakeChunkDoc"] = []

    def collection_group(self, _name: str) -> "FakeFirestoreClient":
        return self

    def where(self, *_args: object) -> "FakeFirestoreClient":
        return self

    def find_nearest(self, **_kwargs: object) -> "FakeFirestoreClient":
        return self

    def get(self) -> list["FakeChunkDoc"]:
        return self.next_chunks


class FakeChunkDoc:
    def __init__(self, *, chunk: dict[str, Any], material: dict[str, Any]) -> None:
        self._chunk = chunk
        self.reference = FakeChunkReference(material)

    def to_dict(self) -> dict[str, Any]:
        return self._chunk


class FakeChunkReference:
    def __init__(self, material: dict[str, Any]) -> None:
        self.parent = types.SimpleNamespace(parent=FakeMaterialReference(material))


class FakeMaterialReference:
    id = "material-1"
    path = "classes/class-1/materials/material-1"

    def __init__(self, material: dict[str, Any]) -> None:
        self._material = material

    def get(self) -> "FakeMaterialSnapshot":
        return FakeMaterialSnapshot(self._material)


class FakeMaterialSnapshot:
    def __init__(self, material: dict[str, Any]) -> None:
        self._material = material

    def to_dict(self) -> dict[str, Any]:
        return self._material
