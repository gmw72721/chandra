from __future__ import annotations

import asyncio
import os
import re
from dataclasses import asdict, dataclass
from typing import Any, Protocol

import httpx


@dataclass(frozen=True)
class PdfPageResult:
    """Metadata for a retrieved PDF page window."""

    doc_id: str
    title: str
    page_start: int
    page_end: int
    section: str
    score: float
    chunk_text: str
    source_pdf_path: str
    material_type: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PdfRetriever(Protocol):
    """Mockable retrieval interface for indexed PDF page windows."""

    async def search(
        self,
        *,
        query: str,
        top_k: int = 5,
        class_id: str | None = None,
        professor_id: str | None = None,
    ) -> list[PdfPageResult]:
        ...


class GeminiPdfRetriever:
    """Gemini Embedding 2.0 + Firestore Vector Search retrieval adapter.

    The adapter intentionally returns only page-window metadata. It does not
    fetch, render, or send full PDFs to the chat model.
    """

    def __init__(
        self,
        *,
        gemini_api_key: str | None = None,
        embedding_model: str | None = None,
        dimensions: int | None = None,
    ) -> None:
        self.gemini_api_key = gemini_api_key or os.getenv("GEMINI_API_KEY", "")
        self.embedding_model = embedding_model or os.getenv("VERTEX_EMBEDDING_MODEL") or "gemini-embedding-2"
        self.dimensions = dimensions or int(os.getenv("VERTEX_EMBEDDING_DIMENSIONS") or "768")

    async def search(
        self,
        *,
        query: str,
        top_k: int = 5,
        class_id: str | None = None,
        professor_id: str | None = None,
    ) -> list[PdfPageResult]:
        query_text = ensure_text(query)

        if not query_text.strip():
            return []

        query_vector = await self._embed_query(query_text)
        if not query_vector:
            return []

        return await self._search_firestore(
            class_id=class_id,
            professor_id=professor_id,
            query=query_text,
            query_vector=query_vector,
            top_k=top_k,
        )

    async def _embed_query(self, query: str) -> list[float]:
        if not self.gemini_api_key:
            return []

        result: httpx.Response | None = None
        async with httpx.AsyncClient(timeout=45.0) as client:
            for attempt in range(3):
                try:
                    result = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{self.embedding_model}:embedContent",
                        headers={
                            "Content-Type": "application/json",
                            "x-goog-api-key": self.gemini_api_key,
                        },
                        json={
                            "content": {"parts": [{"text": query[:30000]}]},
                            "outputDimensionality": self.dimensions,
                            "taskType": "RETRIEVAL_QUERY",
                        },
                    )
                    break
                except (httpx.TransportError, httpx.TimeoutException):
                    if attempt == 2:
                        return []

                    await asyncio.sleep(0.35 * (attempt + 1))

        if result is None:
            return []

        result.raise_for_status()
        payload = result.json()

        values = payload.get("embedding", {}).get("values") or []
        return [float(value) for value in values]

    async def _search_firestore(
        self,
        *,
        class_id: str | None,
        professor_id: str | None,
        query: str,
        query_vector: list[float],
        top_k: int,
    ) -> list[PdfPageResult]:
        if not class_id or not professor_id:
            return []

        try:
            import firebase_admin
            from firebase_admin import firestore
            from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        except ImportError:
            return []

        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app()

            db = firestore.client()
            firestore_query = (
                db.collection_group("chunks")
                .where("professorId", "==", professor_id)
                .where("classId", "==", class_id)
                .find_nearest(
                    vector_field="embedding",
                    query_vector=query_vector,
                    distance_measure=DistanceMeasure.COSINE,
                    limit=min(max(top_k * 10, 50), 100),
                    distance_result_field="vectorDistance",
                )
            )
            snapshot = await asyncio.to_thread(firestore_query.get)
        except Exception:
            return []

        chunk_docs = list(snapshot)
        results: list[PdfPageResult] = []
        material_cache = await self._load_material_cache(chunk_docs)
        query_features = build_query_features(query)

        for chunk_doc in chunk_docs:
            chunk = chunk_doc.to_dict() or {}
            material_ref = chunk_doc.reference.parent.parent
            material = self._get_cached_material(material_ref, material_cache)

            if not is_student_visible_ready_material(material):
                continue

            source_pdf_path = str(
                material.get("source_pdf_path")
                or material.get("filePath")
                or material.get("fileUrl")
                or chunk.get("source_pdf_path")
                or ""
            )
            page_start = int(chunk.get("page_start") or chunk.get("pageStart") or chunk.get("pageNumber") or 1)
            page_end = int(chunk.get("page_end") or chunk.get("pageEnd") or page_start)
            vector_score = 1.0 - float(chunk.get("vectorDistance") or 0.0)
            chunk_text = str(chunk.get("chunk_text") or chunk.get("chunkText") or chunk.get("content") or "")
            title = str(chunk.get("title") or material.get("title") or "Untitled PDF")
            section = str(chunk.get("section") or chunk.get("sectionHeading") or "")
            material_type = str(chunk.get("materialType") or material.get("materialType") or material.get("kind") or "")
            searchable_text = " ".join([title, section, chunk_text])

            results.append(
                PdfPageResult(
                    doc_id=str(
                        chunk.get("doc_id")
                        or chunk.get("docId")
                        or chunk.get("materialId")
                        or (material_ref.id if material_ref else "")
                    ),
                    title=title,
                    page_start=max(1, min(page_start, page_end)),
                    page_end=max(page_start, page_end),
                    section=section,
                    score=hybrid_page_score(
                        query_features,
                        material_type=material_type,
                        page_start=max(1, min(page_start, page_end)),
                        page_end=max(page_start, page_end),
                        searchable_text=searchable_text,
                        vector_score=vector_score,
                    ),
                    chunk_text=chunk_text,
                    source_pdf_path=source_pdf_path,
                    material_type=material_type,
                )
            )

        return sorted(results, key=lambda result: result.score, reverse=True)[:top_k]

    async def _load_material_cache(self, chunk_docs: list[Any]) -> dict[str, dict[str, Any]]:
        material_refs: dict[str, Any] = {}

        for chunk_doc in chunk_docs:
            material_ref = chunk_doc.reference.parent.parent
            cache_key = self._material_cache_key(material_ref)

            if cache_key:
                material_refs.setdefault(cache_key, material_ref)

        snapshots = await asyncio.gather(
            *(asyncio.to_thread(material_ref.get) for material_ref in material_refs.values())
        )

        return {
            cache_key: (snapshot.to_dict() if snapshot else {}) or {}
            for cache_key, snapshot in zip(material_refs.keys(), snapshots)
        }

    def _get_cached_material(
        self,
        material_ref: Any | None,
        material_cache: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        cache_key = self._material_cache_key(material_ref)
        return material_cache.get(cache_key, {}) if cache_key else {}

    def _material_cache_key(self, material_ref: Any | None) -> str:
        return str(getattr(material_ref, "path", material_ref)) if material_ref is not None else ""


def build_query_features(query: Any) -> dict[str, Any]:
    query = ensure_text(query)
    terms = tokenize(query)
    problem_numbers = problem_numbers_from_text(query)
    page_numbers = page_numbers_from_text(query)
    exact_phrases = [normalize_text(query)] if len(query.strip()) >= 48 else []
    equation_tokens = equation_tokens_from_text(query)

    return {
        "equation_tokens": equation_tokens,
        "exact_lookup_intent": bool(problem_numbers or page_numbers or exact_phrases or len(equation_tokens) >= 2),
        "exact_phrases": exact_phrases,
        "page_numbers": page_numbers,
        "problem_locator_intent": is_problem_locator_query(query),
        "problem_numbers": problem_numbers,
        "terms": terms,
    }


def hybrid_page_score(
    query_features: dict[str, Any],
    *,
    material_type: str = "",
    page_start: int,
    page_end: int,
    searchable_text: str,
    vector_score: float,
) -> float:
    normalized_text = normalize_text(searchable_text)
    semantic_weight = 3 if query_features["exact_lookup_intent"] else 5
    title_and_text_score = term_overlap_score(normalized_text, query_features["terms"]) * 2
    exact_phrase_score = sum(1 for phrase in query_features["exact_phrases"] if phrase and phrase in normalized_text) * 8
    equation_score = equation_overlap_score(normalized_text, query_features["equation_tokens"]) * 6
    page_score = (
        12
        if any(page_start <= page_number <= page_end for page_number in query_features["page_numbers"])
        else 0
    )
    content_problem_numbers = problem_numbers_from_text(searchable_text)
    problem_score = (
        10
        if set(query_features["problem_numbers"]).intersection(content_problem_numbers)
        else 0
    )

    return (
        vector_score * semantic_weight
        + title_and_text_score
        + exact_phrase_score
        + equation_score
        + page_score
        + problem_score
        + material_preference_score(query_features, searchable_text=searchable_text, material_type=material_type)
    )


def is_problem_locator_query(query: Any) -> bool:
    normalized = normalize_text(query)
    has_locator_word = bool(
        re.search(r"\b(?:find|where|locate|identify|which|what)\b", normalized)
    )
    has_problem_signal = bool(
        re.search(r"\b(?:problem|question|exercise|homework|worksheet|assignment|practice)\b", normalized)
    )
    has_equation_signal = len(equation_tokens_from_text(normalized)) >= 2

    return has_locator_word and (has_problem_signal or has_equation_signal)


def material_preference_score(
    query_features: dict[str, Any],
    *,
    searchable_text: str,
    material_type: str,
) -> float:
    if not query_features.get("problem_locator_intent"):
        return 0.0

    source_text = normalize_text(f"{material_type} {searchable_text}")

    if re.search(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems)\b", source_text):
        return 8.0

    if re.search(r"\b(?:textbook|reading|readings|chapter)\b", source_text):
        return -4.0

    return 0.0


def is_student_visible_ready_material(material: dict[str, Any]) -> bool:
    return (
        material.get("status") == "ready"
        and material.get("activeForStudents") is not False
        and material.get("studentVisible") is not False
        and material.get("teacherOnly") is not True
        and material.get("visibility") not in {"teacher-only", "hidden"}
        and material.get("private") is not True
    )


def ensure_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value

    return str(value)


def normalize_text(text: Any) -> str:
    text = ensure_text(text)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9#\s.-]", " ", text.lower())).strip()


def tokenize(text: Any) -> list[str]:
    stopwords = {
        "about",
        "from",
        "help",
        "need",
        "problem",
        "question",
        "show",
        "that",
        "this",
        "what",
        "with",
        "work",
    }
    return [term for term in normalize_text(text).split() if len(term) > 2 and term not in stopwords]


def term_overlap_score(text: str, terms: list[str]) -> float:
    if not terms:
        return 0.0

    return sum(1 for term in terms if term in text) / len(terms)


def problem_numbers_from_text(text: Any) -> set[str]:
    text = ensure_text(text)
    normalized = text.lower()
    patterns = [
        r"\b(?:problem|question|number|no\.?)\s*#?\s*(\d{1,3}[a-z]?)\b",
        r"(?:^|[\s(\[{])#\s*(\d{1,3}[a-z]?)\b",
        r"\bq\s*(\d{1,3}[a-z]?)\b",
    ]
    return {match.group(1).upper() for pattern in patterns for match in re.finditer(pattern, normalized)}


def page_numbers_from_text(text: Any) -> set[int]:
    text = ensure_text(text)
    normalized = text.lower()
    patterns = [
        r"\b(?:page|pg\.?|p\.?)\s*#?\s*(\d{1,4})\b",
        r"\bprinted\s+page\s+(\d{1,4})\b",
    ]
    return {
        int(match.group(1))
        for pattern in patterns
        for match in re.finditer(pattern, normalized)
        if int(match.group(1)) > 0
    }


def equation_tokens_from_text(text: Any) -> set[str]:
    text = ensure_text(text)
    return {
        token.lower()
        for token in re.findall(r"[a-z]?\d+(?:\.\d+)?|[a-z]\^\d+|[a-z]\d+|[=+\-*/^]|\\(?:int|sum|sqrt|frac)|∞|infinity", text)
    }


def equation_overlap_score(text: str, query_equation_tokens: set[str]) -> float:
    if not query_equation_tokens:
        return 0.0

    content_equation_tokens = equation_tokens_from_text(text)
    return len(query_equation_tokens.intersection(content_equation_tokens)) / len(query_equation_tokens)
