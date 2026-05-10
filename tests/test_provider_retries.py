from __future__ import annotations

import sys
import ssl
import types
from typing import Any

import httpx
import pytest

from backend.agent.openrouter_client import OpenRouterClient, normalize_token_usage
from backend.agent.tools import search_pdf_pages
from backend.retrieval.pdf_retriever import GeminiPdfRetriever, build_query_features, exact_results_from_pdf_text


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

    monkeypatch.setattr("backend.retrieval.pdf_retriever.httpx.AsyncClient", FakeAsyncClient)
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
            query_features=build_query_features("problem 7"),
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
        query_features=build_query_features("problem 7"),
        query_vector=[0.1, 0.2],
        top_k=5,
    )

    assert [result.title for result in results] == ["Student Worksheet"]


def test_problem_numbers_parse_ocr_spaced_dotted_items() -> None:
    features = build_query_features(
        "no 2 14 Given the setup of Exercise 2.13, prove the following inequalities:"
    )

    assert "2.14" in features["problem_numbers"]
    assert "2.13" in features["problem_numbers"]


def test_exact_pdf_verifier_reads_page_text_for_numbered_exercise(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    class FakePage:
        def __init__(self, text: str) -> None:
            self.text = text

        def extract_text(self) -> str:
            return self.text

    class FakePdfReader:
        def __init__(self, _path: str) -> None:
            self.pages = [
                FakePage("Rank-nullity theorem context without the requested exercise."),
                FakePage(
                    "80 Chapter 2. Linear Transformations and Matrices. "
                    "2 .14 . Given the setup of Exercise 2.13, prove the following inequalities: "
                    "(i) rank(KL) <= min(rank(L), rank(K))."
                ),
            ]

    monkeypatch.setitem(sys.modules, "pypdf", types.SimpleNamespace(PdfReader=FakePdfReader))

    results = exact_results_from_pdf_text(
        tmp_path / "reader.pdf",
        material={"materialType": "reading", "title": "ACME Textbook"},
        material_ref=types.SimpleNamespace(id="reader-1"),
        query_features=build_query_features("read Exercise 2 14 Given setup of Exercise 2.13"),
        source_pdf_path="reader.pdf",
    )

    assert results
    assert results[0].page_start == 2
    assert "2 .14" in results[0].chunk_text


def test_concept_method_query_without_exact_identifier_does_not_force_pdf_text_match(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    class FakePage:
        def extract_text(self) -> str:
            return "2 .14 . Given the setup of Exercise 2.13, prove a rank inequality."

    class FakePdfReader:
        def __init__(self, _path: str) -> None:
            self.pages = [FakePage()]

    monkeypatch.setitem(sys.modules, "pypdf", types.SimpleNamespace(PdfReader=FakePdfReader))

    query_features = build_query_features("explain rank-nullity and rank product inequalities")
    assert query_features["exact_lookup_intent"] is False

    results = exact_results_from_pdf_text(
        tmp_path / "reader.pdf",
        material={"materialType": "reading", "title": "ACME Textbook"},
        material_ref=types.SimpleNamespace(id="reader-1"),
        query_features=query_features,
        source_pdf_path="reader.pdf",
    )

    assert results == []


def test_concept_method_query_with_equation_but_no_locator_stays_semantic_led() -> None:
    features = build_query_features(
        "Explain rank-nullity / how do I prove inequalities like rank(KL) <= rank(L)?"
    )

    assert features["exact_lookup_intent"] is False
    assert features["problem_numbers"] == set()


@pytest.mark.asyncio
async def test_gemini_retriever_excludes_file_pdf_without_openable_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_fake_firestore_modules(monkeypatch)
    FakeFirestoreClient.next_chunks = [
        fake_chunk_doc(
            material={
                "contentType": "application/pdf",
                "pageCount": 34,
                "sourceMode": "file",
                "status": "ready",
                "studentVisible": True,
                "title": "Broken PDF",
            }
        )
    ]
    retriever = GeminiPdfRetriever(gemini_api_key="test-key")

    results = await retriever._search_firestore(
        class_id="class-1",
        professor_id="teacher-1",
        query_features=build_query_features("exercise 2.14"),
        query_vector=[0.1, 0.2],
        top_k=5,
    )

    assert results == []


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
                        "page_end": 3,
                        "page_start": 3,
                        "score": 0.91,
                        "section": "Practice",
                        "source_pdf_path": "gs://bucket/material.pdf",
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
            "doc_id": "material-1",
            "material_type": "assignment",
            "page_end": 3,
            "page_start": 3,
            "score": 0.91,
            "section": "Practice",
            "source_pdf_path": "gs://bucket/material.pdf",
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
                "topK": 5,
            },
            "url": "http://next.local/api/internal/pdf-page-search",
        }
    ]


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
    normalized_material = {
        "teacherId": "teacher-1",
        **material,
    }

    return FakeChunkDoc(
        chunk={
            "chunk_text": "Problem 7 asks students to solve a linear equation.",
            "classId": "class-1",
            "docId": "material-1",
            "embedding": [0.1, 0.2],
            "materialType": "assignment",
            "page_start": 3,
            "page_end": 3,
            "professorId": "teacher-1",
            "title": normalized_material.get("title", "Material"),
            "vectorDistance": 0.1,
        },
        material=normalized_material,
    )


class FakeFirestoreClient:
    next_chunks: list["FakeChunkDoc"] = []

    def collection(self, _name: str) -> "FakeCollectionReference":
        return FakeCollectionReference(self.next_chunks)


class FakeCollectionReference:
    def __init__(self, chunks: list["FakeChunkDoc"]) -> None:
        self._chunks = chunks

    def document(self, _document_id: str) -> "FakeDocumentReference":
        return FakeDocumentReference(self._chunks)


class FakeDocumentReference:
    def __init__(self, chunks: list["FakeChunkDoc"]) -> None:
        self._chunks = chunks

    def collection(self, _name: str) -> "FakeMaterialsCollectionReference":
        return FakeMaterialsCollectionReference(self._chunks)


class FakeMaterialsCollectionReference:
    def __init__(self, chunks: list["FakeChunkDoc"]) -> None:
        self._chunks = chunks

    def get(self) -> list["FakeMaterialDoc"]:
        materials: dict[str, tuple[dict[str, Any], list[FakeChunkDoc]]] = {}

        for chunk in self._chunks:
            material = chunk.reference.parent.parent._material
            title = str(material.get("title") or "Material")
            materials.setdefault(title, (material, []))[1].append(chunk)

        return [FakeMaterialDoc(material=material, chunks=chunks) for material, chunks in materials.values()]


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

    def collection(self, _name: str) -> "FakeChunkCollectionReference":
        return FakeChunkCollectionReference([])


class FakeMaterialDoc:
    def __init__(self, *, material: dict[str, Any], chunks: list[FakeChunkDoc]) -> None:
        self._material = material
        self.reference = FakeMaterialDocReference(material=material, chunks=chunks)

    def to_dict(self) -> dict[str, Any]:
        return self._material


class FakeMaterialDocReference:
    id = "material-1"
    path = "classes/class-1/materials/material-1"

    def __init__(self, *, material: dict[str, Any], chunks: list[FakeChunkDoc]) -> None:
        self._material = material
        self._chunks = chunks

    def collection(self, _name: str) -> "FakeChunkCollectionReference":
        return FakeChunkCollectionReference(self._chunks)


class FakeChunkCollectionReference:
    def __init__(self, chunks: list[FakeChunkDoc]) -> None:
        self._chunks = chunks

    def get(self) -> list[FakeChunkDoc]:
        return self._chunks


class FakeMaterialSnapshot:
    def __init__(self, material: dict[str, Any]) -> None:
        self._material = material

    def to_dict(self) -> dict[str, Any]:
        return self._material
