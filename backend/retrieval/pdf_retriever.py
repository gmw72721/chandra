from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import httpx

SECTION_RELATED_TOP_K = 8
_GEMINI_EMBEDDING_CLIENT: httpx.AsyncClient | None = None
NORMALIZE_TEXT_SYMBOLS_RE = re.compile(r"[^a-z0-9#\s.-]")
NORMALIZE_TEXT_WHITESPACE_RE = re.compile(r"\s+")
PROBLEM_NUMBER_PATTERNS = (
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s+(\d{1,3}[a-z]?)\b"),
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3})?[a-z]?)(?!\s+\d)\b"),
    re.compile(r"(?:^|[\s(\[{])#\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"\bq\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"(?:^|[\s(\[{])(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\s*[\).]"),
)
PAGE_NUMBER_PATTERNS = (
    re.compile(r"\b(?:page|pg\.?|p\.?)\s*#?\s*(\d{1,4})\b"),
    re.compile(r"\bprinted\s+page\s+(\d{1,4})\b"),
)
SECTION_MARKER_PATTERNS = (
    ("section", re.compile(r"\b(?:section|sec\.?|sect\.?|§)\s*#?\s*(\d{1,3}(?:\.\d{1,3}){0,3}[a-z]?)\b")),
    ("chapter", re.compile(r"\b(?:chapter|ch\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3}){0,2}[a-z]?)\b")),
)
TEXTBOOK_SECTION_SIGNAL_RE = re.compile(r"\b(?:textbook|reading|readings|chapter|section|sec|sect)\b")
ASSIGNMENT_SIGNAL_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems|quiz|exam)\b")
LOCATOR_WORD_RE = re.compile(r"\b(?:find|where|locate|identify|which|what)\b")
PROBLEM_SIGNAL_RE = re.compile(r"\b(?:problem|question|exercise|homework|worksheet|assignment|practice)\b")
MATH_EXPRESSION_SIGNAL_RE = re.compile(r"(?:[<>=≤≥]|\\(?:int|lim|sum|sqrt|frac)|\b(?:rank|dim|nullity|kernel|image)\s*\()", re.I)
EXACT_PHRASE_RE = re.compile(r"['\"]([^'\"]{20,})['\"]|“([^”]{20,})”")
TEXTBOOK_SOURCE_RE = re.compile(r"\b(?:reading|readings|textbook|chapter|section)\b")
ASSIGNMENT_SOURCE_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems|quiz|exam)\b")
PROBLEM_LOCATOR_SOURCE_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems)\b")
TEXTBOOK_PREFERENCE_SOURCE_RE = re.compile(r"\b(?:textbook|reading|readings|chapter)\b")
DIGITS_1_TO_3_RE = re.compile(r"\d{1,3}")
PROBLEM_SUFFIX_RE = re.compile(r"\d{1,3}[a-z]?")
SECTION_CONTEXT_RE = re.compile(r"\b(?:section|sec|sect|chapter|textbook|reading|readings)\b")
EQUATION_TOKEN_RE = re.compile(r"[a-z]?\d+(?:\.\d+)?|[a-z]\^\d+|[a-z]\d+|[=+\-*/^√∫]|\\(?:int|lim|sum|sqrt|frac)|∞|infinity")


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
        return {
            "doc_id": self.doc_id,
            "title": self.title,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "section": self.section,
            "score": self.score,
            "chunk_text": self.chunk_text,
            "source_pdf_path": self.source_pdf_path,
            "material_type": self.material_type,
        }


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
        self._visible_material_docs_cache: dict[tuple[str, str], list[Any]] = {}

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

        query_features = build_query_features(query_text)
        effective_top_k = section_related_top_k(query_features, top_k)
        exact_results_task = (
            asyncio.create_task(
                self._search_firestore_exact_candidates(
                    class_id=class_id,
                    professor_id=professor_id,
                    query_features=query_features,
                    top_k=effective_top_k,
                )
            )
            if query_features["exact_lookup_intent"]
            else None
        )
        query_vector = await self._embed_query(query_text)
        if not query_vector:
            if exact_results_task:
                return await exact_results_task

            return []

        vector_results = await self._search_firestore(
            class_id=class_id,
            professor_id=professor_id,
            query_features=query_features,
            query_vector=query_vector,
            top_k=effective_top_k,
        )

        if not query_features["exact_lookup_intent"]:
            return vector_results

        exact_results = await exact_results_task if exact_results_task else []

        return merge_page_results(vector_results, exact_results)[:effective_top_k]

    async def _embed_query(self, query: str) -> list[float]:
        if not self.gemini_api_key:
            return []

        result: httpx.Response | None = None
        client = gemini_embedding_http_client()
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
        query_features: dict[str, Any],
        query_vector: list[float],
        top_k: int,
    ) -> list[PdfPageResult]:
        if not class_id or not professor_id:
            return []

        try:
            import firebase_admin
            from firebase_admin import firestore
        except ImportError:
            return []

        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app()

            db = firestore.client()
            material_docs = await self._load_visible_class_material_docs(
                db,
                class_id=class_id,
                professor_id=professor_id,
            )
            material_chunk_pairs = await asyncio.gather(
                *[
                    asyncio.to_thread(material_doc.reference.collection("chunks").get)
                    for material_doc in material_docs
                ]
            )
        except Exception:
            return []

        results: list[PdfPageResult] = []

        for material_doc, chunks_snapshot in zip(material_docs, material_chunk_pairs):
            material = material_doc.to_dict() or {}

            for chunk_doc in chunks_snapshot:
                chunk = chunk_doc.to_dict() or {}
                embedding_values = embedding_values_from_chunk(chunk)

                if not embedding_values:
                    continue

                result = self._result_from_chunk(
                    chunk,
                    material=material,
                    material_ref=material_doc.reference,
                    query_features=query_features,
                    vector_score=cosine_similarity(query_vector, embedding_values),
                )

                if result:
                    results.append(result)

        return sorted(results, key=lambda result: result.score, reverse=True)[:top_k]

    async def _search_firestore_exact_candidates(
        self,
        *,
        class_id: str | None,
        professor_id: str | None,
        query_features: dict[str, Any],
        top_k: int,
    ) -> list[PdfPageResult]:
        if not class_id or not professor_id:
            return []

        try:
            import firebase_admin
            from firebase_admin import firestore
        except ImportError:
            return []

        try:
            if not firebase_admin._apps:
                firebase_admin.initialize_app()

            db = firestore.client()
            material_docs = await self._load_visible_class_material_docs(
                db,
                class_id=class_id,
                professor_id=professor_id,
            )
            material_scan_results = await self._search_class_material_chunks_exact(
                db,
                class_id=class_id,
                professor_id=professor_id,
                query_features=query_features,
                top_k=top_k,
                material_docs=material_docs,
            )
            if material_scan_results:
                return material_scan_results

            pdf_scan_results = await self._search_openable_class_pdfs_exact(
                db,
                class_id=class_id,
                professor_id=professor_id,
                query_features=query_features,
                top_k=top_k,
                material_docs=material_docs,
            )
            if pdf_scan_results:
                return pdf_scan_results

            firestore_query = (
                db.collection_group("chunks")
                .where("professorId", "==", professor_id)
                .where("classId", "==", class_id)
            )
            snapshot = await asyncio.to_thread(firestore_query.get)
        except Exception:
            return []

        chunk_docs = list(snapshot)
        material_cache = await self._load_material_cache(chunk_docs)
        results: list[PdfPageResult] = []

        for chunk_doc in chunk_docs:
            chunk = chunk_doc.to_dict() or {}
            material_ref = chunk_doc.reference.parent.parent
            material = self._get_cached_material(material_ref, material_cache)

            if not is_student_visible_ready_material(material):
                continue

            result = self._result_from_chunk(
                chunk,
                material=material,
                material_ref=material_ref,
                query_features=query_features,
                vector_score=0.0,
            )

            if result and has_exact_lookup_match(query_features, result):
                results.append(result)

        return sorted(results, key=lambda result: result.score, reverse=True)[:top_k]

    async def _search_class_material_chunks_exact(
        self,
        db: Any,
        *,
        class_id: str,
        professor_id: str,
        query_features: dict[str, Any],
        top_k: int,
        material_docs: list[Any] | None = None,
    ) -> list[PdfPageResult]:
        if material_docs is None:
            material_docs = await self._load_visible_class_material_docs(
                db,
                class_id=class_id,
                professor_id=professor_id,
            )
        material_chunk_pairs = await asyncio.gather(
            *[
                asyncio.to_thread(material_doc.reference.collection("chunks").get)
                for material_doc in material_docs
            ]
        )
        results: list[PdfPageResult] = []

        for material_doc, chunks_snapshot in zip(material_docs, material_chunk_pairs):
            material = material_doc.to_dict() or {}

            for chunk_doc in chunks_snapshot:
                chunk = chunk_doc.to_dict() or {}
                result = self._result_from_chunk(
                    chunk,
                    material=material,
                    material_ref=material_doc.reference,
                    query_features=query_features,
                    vector_score=0.0,
                )

                if result and has_exact_lookup_match(query_features, result):
                    results.append(result)

        return sorted(results, key=lambda result: result.score, reverse=True)[:top_k]

    async def _search_openable_class_pdfs_exact(
        self,
        db: Any,
        *,
        class_id: str,
        professor_id: str,
        query_features: dict[str, Any],
        top_k: int,
        material_docs: list[Any] | None = None,
    ) -> list[PdfPageResult]:
        try:
            from backend.retrieval.pdf_page_assets import resolve_pdf_path
        except ImportError:
            return []

        if material_docs is None:
            material_docs = await self._load_visible_class_material_docs(
                db,
                class_id=class_id,
                professor_id=professor_id,
            )

        semaphore = asyncio.Semaphore(4)

        async def scan_material(material_doc: Any) -> list[PdfPageResult]:
            async with semaphore:
                material = material_doc.to_dict() or {}
                source_pdf_path = source_pdf_path_from_material(material)

                if not source_pdf_path:
                    return []

                try:
                    source_pdf = await resolve_pdf_path(source_pdf_path, output_dir=Path("data/rendered"))
                    return await asyncio.to_thread(
                        exact_results_from_pdf_text,
                        source_pdf,
                        material=material,
                        material_ref=material_doc.reference,
                        query_features=query_features,
                        source_pdf_path=source_pdf_path,
                    )
                except Exception:
                    return []

        material_result_groups = await asyncio.gather(*(scan_material(material_doc) for material_doc in material_docs))
        results = [result for group in material_result_groups for result in group]

        return sorted(results, key=lambda result: result.score, reverse=True)[:top_k]

    async def _load_visible_class_material_docs(
        self,
        db: Any,
        *,
        class_id: str,
        professor_id: str,
    ) -> list[Any]:
        cache_key = (class_id, professor_id)
        if cache_key in self._visible_material_docs_cache:
            return self._visible_material_docs_cache[cache_key]

        try:
            materials_snapshot = await asyncio.to_thread(
                db.collection("classes").document(class_id).collection("materials").get
            )
        except Exception:
            return []

        material_docs: list[Any] = []

        for material_doc in list(materials_snapshot):
            material = material_doc.to_dict() or {}
            material_professor_id = str(material.get("professorId") or material.get("teacherId") or "")

            if material_professor_id != professor_id or not is_student_visible_ready_material(material):
                continue

            material_docs.append(material_doc)

        self._visible_material_docs_cache[cache_key] = material_docs
        return material_docs

    def _result_from_chunk(
        self,
        chunk: dict[str, Any],
        *,
        material: dict[str, Any],
        material_ref: Any | None,
        query_features: dict[str, Any],
        vector_score: float,
    ) -> PdfPageResult | None:
        source_pdf_path = source_pdf_path_from_material(material, chunk)
        if not source_pdf_path and material_requires_openable_pdf_source(material):
            return None

        page_start = int(chunk.get("page_start") or chunk.get("pageStart") or chunk.get("pageNumber") or 1)
        page_end = int(chunk.get("page_end") or chunk.get("pageEnd") or page_start)
        normalized_page_start = max(1, min(page_start, page_end))
        normalized_page_end = max(page_start, page_end)
        chunk_text = str(chunk.get("chunk_text") or chunk.get("chunkText") or chunk.get("content") or "")
        title = str(chunk.get("title") or material.get("title") or "Untitled PDF")
        section = str(chunk.get("section") or chunk.get("sectionHeading") or "")
        material_type = str(chunk.get("materialType") or material.get("materialType") or material.get("kind") or "")
        searchable_text = " ".join([title, section, chunk_text])

        return PdfPageResult(
            doc_id=str(
                chunk.get("doc_id")
                or chunk.get("docId")
                or chunk.get("materialId")
                or (material_ref.id if material_ref else "")
            ),
            title=title,
            page_start=normalized_page_start,
            page_end=normalized_page_end,
            section=section,
            score=hybrid_page_score(
                query_features,
                material_type=material_type,
                page_start=normalized_page_start,
                page_end=normalized_page_end,
                searchable_text=searchable_text,
                vector_score=vector_score,
            ),
            chunk_text=chunk_text,
            source_pdf_path=source_pdf_path,
            material_type=material_type,
        )

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
    section_markers = section_markers_from_text(query)
    problem_locator_intent = is_problem_locator_query(query)
    exact_phrases = exact_phrases_from_text(query)
    equation_tokens = equation_tokens_from_text(query)
    textbook_section_intent = is_textbook_section_query(query, section_markers)

    return {
        "equation_tokens": equation_tokens,
        "exact_lookup_intent": bool(
            problem_numbers
            or page_numbers
            or section_markers
            or exact_phrases
            or problem_locator_intent
        ),
        "exact_phrases": exact_phrases,
        "numbered_item_lookup_intent": bool(
            problem_numbers
            or re.search(
                r"\b(?:exercise|exercises|ex\.?|problem|problems|question|questions|number|no\.?|practice|worksheet|assignment)\b",
                query,
                re.I,
            )
        ),
        "page_numbers": page_numbers,
        "problem_locator_intent": problem_locator_intent,
        "problem_numbers": problem_numbers,
        "section_markers": section_markers,
        "textbook_section_intent": textbook_section_intent,
        "terms": terms,
    }


def gemini_embedding_http_client() -> httpx.AsyncClient:
    global _GEMINI_EMBEDDING_CLIENT

    if _GEMINI_EMBEDDING_CLIENT is None or getattr(_GEMINI_EMBEDDING_CLIENT, "is_closed", False):
        try:
            _GEMINI_EMBEDDING_CLIENT = httpx.AsyncClient(
                timeout=45.0,
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )
        except TypeError:
            _GEMINI_EMBEDDING_CLIENT = httpx.AsyncClient(timeout=45.0)

    return _GEMINI_EMBEDDING_CLIENT


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
    section_markers = most_specific_section_markers(query_features.get("section_markers") or [])
    semantic_weight = 3 if query_features["exact_lookup_intent"] else 5
    title_and_text_score = term_overlap_score(normalized_text, query_features["terms"]) * 2
    exact_phrase_score = sum(1 for phrase in query_features["exact_phrases"] if phrase and phrase in normalized_text) * 8
    equation_score = equation_overlap_score(normalized_text, query_features["equation_tokens"]) * 6
    section_score = section_marker_score(normalized_text, section_markers) * 12
    numbered_item_context_score = (
        4
        if query_features.get("numbered_item_lookup_intent")
        and has_numbered_item_context(normalized_text, material_type)
        else 0
    )
    page_score = (
        12
        if any(page_start <= page_number <= page_end for page_number in query_features["page_numbers"])
        else 0
    )
    requested_problem_numbers = exact_search_problem_numbers(query_features)
    has_requested_problem_match = content_has_requested_problem_number(searchable_text, requested_problem_numbers)
    has_section_and_problem_locator = bool(query_features["problem_numbers"] and query_features["section_markers"])
    problem_score = (
        (40 if has_section_and_problem_locator else 14)
        if has_requested_problem_match
        else 0
    )
    problem_miss_penalty = -18 if has_section_and_problem_locator and not has_requested_problem_match else 0
    exact_item_context_score = (
        10
        if has_section_and_problem_locator
        and has_requested_problem_match
        and has_numbered_item_context(normalized_text, material_type)
        else 0
    )

    return (
        vector_score * semantic_weight
        + title_and_text_score
        + exact_phrase_score
        + equation_score
        + section_score
        + numbered_item_context_score
        + exact_item_context_score
        + page_score
        + problem_score
        + problem_miss_penalty
        + material_preference_score(query_features, searchable_text=searchable_text, material_type=material_type)
    )


def embedding_values_from_chunk(chunk: dict[str, Any]) -> list[float]:
    embedding = chunk.get("embedding")

    if embedding is None:
        return []

    if hasattr(embedding, "to_list"):
        embedding = embedding.to_list()
    elif hasattr(embedding, "toArray"):
        embedding = embedding.toArray()
    elif hasattr(embedding, "_values"):
        embedding = getattr(embedding, "_values")

    if isinstance(embedding, dict):
        embedding = embedding.get("values") or embedding.get("value")

    if not isinstance(embedding, (list, tuple)):
        return []

    values: list[float] = []

    for value in embedding:
        try:
            values.append(float(value))
        except (TypeError, ValueError):
            return []

    return values


def cosine_similarity(first: list[float], second: list[float]) -> float:
    if not first or not second:
        return 0.0

    length = min(len(first), len(second))
    dot_product = 0.0
    first_norm = 0.0
    second_norm = 0.0

    for index in range(length):
        first_value = first[index]
        second_value = second[index]
        dot_product += first_value * second_value
        first_norm += first_value * first_value
        second_norm += second_value * second_value

    if first_norm <= 0 or second_norm <= 0:
        return 0.0

    return dot_product / ((first_norm ** 0.5) * (second_norm ** 0.5))


def has_numbered_item_context(normalized_text: str, material_type: str) -> bool:
    normalized_material_type = normalize_text(material_type)

    return bool(
        normalized_material_type in {"assignment", "practice-problems", "practice problems"}
        or re.search(
            r"\b(?:exercise|exercises|ex|problem|problems|question|questions|practice|worksheet|assignment|homework)\b",
            normalized_text,
        )
    )


def has_exact_lookup_match(query_features: dict[str, Any], result: PdfPageResult) -> bool:
    searchable_text = " ".join([result.title, result.section, result.chunk_text])
    normalized_text = normalize_text(searchable_text)
    requested_problem_numbers = exact_search_problem_numbers(query_features)
    has_problem_match = content_has_requested_problem_number(searchable_text, requested_problem_numbers)
    section_score = section_marker_score(
        normalized_text,
        most_specific_section_markers(query_features.get("section_markers") or []),
    )
    has_section_and_problem_locator = bool(query_features["problem_numbers"] and query_features["section_markers"])

    if has_section_and_problem_locator:
        return (
            any(result.page_start <= page_number <= result.page_end for page_number in query_features["page_numbers"])
            or has_problem_match
            or any(phrase and phrase in normalized_text for phrase in query_features["exact_phrases"])
        )

    return (
        any(result.page_start <= page_number <= result.page_end for page_number in query_features["page_numbers"])
        or has_problem_match
        or section_score > 0
        or any(phrase and phrase in normalized_text for phrase in query_features["exact_phrases"])
        or equation_overlap_score(normalized_text, query_features["equation_tokens"]) >= 0.75
    )


def merge_page_results(*groups: list[PdfPageResult]) -> list[PdfPageResult]:
    merged: dict[tuple[str, int, int, str, str], PdfPageResult] = {}

    for result in [item for group in groups for item in group]:
        key = (
            result.doc_id,
            result.page_start,
            result.page_end,
            result.section,
            normalize_text(result.chunk_text[:200]),
        )
        current = merged.get(key)

        if current is None or result.score > current.score:
            merged[key] = result

    return sorted(merged.values(), key=lambda result: result.score, reverse=True)


def section_related_top_k(query_features: dict[str, Any], requested_top_k: int) -> int:
    if query_features.get("textbook_section_intent"):
        return max(requested_top_k, SECTION_RELATED_TOP_K)

    return requested_top_k


def is_problem_locator_query(query: Any) -> bool:
    normalized = normalize_text(query)
    has_locator_word = bool(LOCATOR_WORD_RE.search(normalized))
    has_problem_signal = bool(PROBLEM_SIGNAL_RE.search(normalized))
    has_equation_signal = len(equation_tokens_from_text(normalized)) >= 2 or has_math_expression_signal(query)

    return has_locator_word and (has_problem_signal or has_equation_signal)


def has_math_expression_signal(query: Any) -> bool:
    text = ensure_text(query)
    return bool(MATH_EXPRESSION_SIGNAL_RE.search(text))


def exact_phrases_from_text(query: Any) -> list[str]:
    text = ensure_text(query)
    quoted_phrases = [
        phrase
        for match in EXACT_PHRASE_RE.finditer(text)
        for phrase in match.groups()
        if phrase
    ]

    return [normalize_text(phrase) for phrase in quoted_phrases if normalize_text(phrase)]


def material_preference_score(
    query_features: dict[str, Any],
    *,
    searchable_text: str,
    material_type: str,
) -> float:
    source_text = normalize_text(f"{material_type} {searchable_text}")

    if query_features.get("textbook_section_intent"):
        if TEXTBOOK_SOURCE_RE.search(source_text):
            return 8.0

        if ASSIGNMENT_SOURCE_RE.search(source_text):
            return -6.0

        return 0.0

    if not query_features.get("problem_locator_intent"):
        return 0.0

    if PROBLEM_LOCATOR_SOURCE_RE.search(source_text):
        return 8.0

    if TEXTBOOK_PREFERENCE_SOURCE_RE.search(source_text):
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


def material_requires_openable_pdf_source(material: dict[str, Any]) -> bool:
    source_mode = normalize_text(material.get("sourceMode") or material.get("source_mode") or "")
    content_type = normalize_text(material.get("contentType") or material.get("content_type") or "")
    file_name = normalize_text(material.get("fileName") or material.get("file_name") or "")

    return (
        source_mode in {"file", "file-and-pasted"}
        or content_type == "application/pdf"
        or file_name.endswith(".pdf")
        or int(material.get("pageCount") or material.get("page_count") or 0) > 0
    )


def source_pdf_path_from_material(
    material: dict[str, Any],
    chunk: dict[str, Any] | None = None,
) -> str:
    source = chunk or {}
    return str(
        material.get("source_pdf_path")
        or material.get("filePath")
        or material.get("fileUrl")
        or source.get("source_pdf_path")
        or source.get("sourcePdfPath")
        or source.get("filePath")
        or source.get("fileUrl")
        or ""
    )


def exact_results_from_pdf_text(
    source_pdf: Path,
    *,
    material: dict[str, Any],
    material_ref: Any | None,
    query_features: dict[str, Any],
    source_pdf_path: str,
) -> list[PdfPageResult]:
    results: list[PdfPageResult] = []
    title = str(material.get("title") or "Untitled PDF")
    material_type = str(material.get("materialType") or material.get("kind") or "")
    doc_id = str(material.get("doc_id") or material.get("docId") or (material_ref.id if material_ref else ""))
    page_texts = cached_pdf_page_texts(source_pdf)

    for index, raw_page_text in enumerate(page_texts, start=1):
        page_text = " ".join(raw_page_text.split())
        if not page_text:
            continue

        searchable_text = " ".join([title, page_text])
        result = PdfPageResult(
            doc_id=doc_id,
            title=title,
            page_start=index,
            page_end=index,
            section="",
            score=hybrid_page_score(
                query_features,
                material_type=material_type,
                page_start=index,
                page_end=index,
                searchable_text=searchable_text,
                vector_score=0.0,
            ),
            chunk_text=page_text,
            source_pdf_path=source_pdf_path,
            material_type=material_type,
        )

        if has_exact_lookup_match(query_features, result):
            results.append(result)

    return results


def cached_pdf_page_texts(source_pdf: Path) -> tuple[str, ...]:
    return _cached_pdf_page_texts(str(source_pdf), *file_signature(source_pdf))


def file_signature(path: Path) -> tuple[int, int]:
    try:
        stat = path.stat()
    except OSError:
        return (0, 0)

    return (stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=64)
def _cached_pdf_page_texts(source_pdf_path: str, _mtime_ns: int, _size: int) -> tuple[str, ...]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return ()

    try:
        reader = PdfReader(source_pdf_path)
    except Exception:
        return ()

    page_texts: list[str] = []
    for page in reader.pages:
        try:
            page_texts.append(page.extract_text() or "")
        except Exception:
            page_texts.append("")

    return tuple(page_texts)


def ensure_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value

    return str(value)


def normalize_text(text: Any) -> str:
    text = ensure_text(text)
    return NORMALIZE_TEXT_WHITESPACE_RE.sub(" ", NORMALIZE_TEXT_SYMBOLS_RE.sub(" ", text.lower())).strip()


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
    numbers: set[str] = set()

    for pattern in PROBLEM_NUMBER_PATTERNS:
        for match in pattern.finditer(normalized):
            if len(match.groups()) >= 2 and match.group(2):
                numbers.add(f"{match.group(1)}.{match.group(2)}".upper())
            elif match.group(1):
                numbers.add(match.group(1).upper())

    return numbers


def page_numbers_from_text(text: Any) -> set[int]:
    text = ensure_text(text)
    normalized = text.lower()
    return {
        int(match.group(1))
        for pattern in PAGE_NUMBER_PATTERNS
        for match in pattern.finditer(normalized)
        if int(match.group(1)) > 0
    }


def section_markers_from_text(text: Any) -> tuple[dict[str, str], ...]:
    text = ensure_text(text).lower()
    markers: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for kind, pattern in SECTION_MARKER_PATTERNS:
        for match in pattern.finditer(text):
            number = match.group(1).lower()
            key = (kind, number)

            if key in seen:
                continue

            seen.add(key)
            markers.append({"kind": kind, "number": number})

    return tuple(markers)


def is_textbook_section_query(query: Any, section_markers: tuple[dict[str, str], ...]) -> bool:
    if not section_markers:
        return False

    normalized = normalize_text(query)
    has_textbook_signal = bool(TEXTBOOK_SECTION_SIGNAL_RE.search(normalized))
    has_assignment_signal = bool(ASSIGNMENT_SIGNAL_RE.search(normalized))

    return has_textbook_signal and not has_assignment_signal


def section_marker_score(normalized_text: str, section_markers: tuple[dict[str, str], ...] | list[dict[str, str]]) -> float:
    if not section_markers:
        return 0.0

    score = 0.0

    for marker in section_markers:
        kind = marker.get("kind", "")
        number = marker.get("number", "")

        if not kind or not number:
            continue

        number_pattern = section_number_pattern(number)
        exact_kind_pattern = rf"\b{re.escape(kind)}\s*#?\s*{number_pattern}"

        if re.search(exact_kind_pattern, normalized_text):
            score += 1.0
            continue

        if re.search(number_pattern, normalized_text) and SECTION_CONTEXT_RE.search(normalized_text):
            score += 0.75
            continue

        if re.search(number_pattern, normalized_text):
            score += 0.35

    return min(score, 1.5)


def exact_search_problem_numbers(query_features: dict[str, Any]) -> set[str]:
    base_requested = {str(number).upper() for number in query_features.get("problem_numbers") or []}
    composite_requested: set[str] = set()

    for marker in query_features.get("section_markers") or []:
        section_number = str(marker.get("number") or "")

        if not DIGITS_1_TO_3_RE.fullmatch(section_number):
            continue

        for problem_number in query_features.get("problem_numbers") or []:
            normalized_problem_number = str(problem_number).lower()

            if PROBLEM_SUFFIX_RE.fullmatch(normalized_problem_number):
                composite_requested.add(f"{section_number}.{normalized_problem_number}".upper())

    return composite_requested or base_requested


def content_has_requested_problem_number(text: Any, requested_problem_numbers: set[str]) -> bool:
    source = ensure_text(text)

    for problem_number in requested_problem_numbers:
        if problem_number_contains_dotted_parts(problem_number):
            if re.search(labeled_dotted_problem_number_pattern(problem_number), source, flags=re.IGNORECASE):
                return True

            if re.search(dotted_problem_item_pattern(problem_number), source, flags=re.IGNORECASE):
                return True

            continue

        if problem_number.upper() in problem_numbers_from_text(source):
            return True

    return False


def problem_number_contains_dotted_parts(problem_number: str) -> bool:
    return "." in problem_number


@lru_cache(maxsize=256)
def dotted_problem_number_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    return rf"(?<![\d.]){flexible_number}(?!\s*\.\s*\d)(?=\s*[\).:]|\s|$)"


@lru_cache(maxsize=256)
def labeled_dotted_problem_number_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    return (
        rf"\b(?:problem|problems|exercise|exercises|ex\.?|question|questions|number|no\.?)"
        rf"\s*#?\s*{flexible_number}(?!\s*\.\s*\d)\b"
    )


@lru_cache(maxsize=256)
def dotted_problem_item_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    item_start = (
        r"give|giv|prove|show|let|find|determine|compute|suppose|consider|verify|"
        r"establish|use|assume|recall|for|if|what|which|why|does"
    )
    return rf"(?<![\d.(]){flexible_number}\s*[\).:]\s*(?=(?:{item_start})\b)"


def most_specific_section_markers(
    section_markers: tuple[dict[str, str], ...] | list[dict[str, str]],
) -> tuple[dict[str, str], ...]:
    marker_keys = {
        (str(marker.get("kind") or ""), str(marker.get("number") or ""))
        for marker in section_markers
    }
    filtered: list[dict[str, str]] = []

    for marker in section_markers:
        kind = str(marker.get("kind") or "")
        number = str(marker.get("number") or "")

        if any(
            other_kind == kind and other_number.startswith(f"{number}.")
            for other_kind, other_number in marker_keys
        ):
            continue

        filtered.append(marker)

    return tuple(filtered)


@lru_cache(maxsize=256)
def section_number_pattern(number: str) -> str:
    return rf"(?<![\d.]){re.escape(number)}(?![\d.])"


def equation_tokens_from_text(text: Any) -> set[str]:
    text = ensure_text(text)
    normalized = normalize_text(text)
    alias_haystack = f"{text.lower()} {normalized}"
    tokens = {
        normalize_equation_token(token)
        for token in EQUATION_TOKEN_RE.findall(text)
    }

    for pattern, aliases in MATH_TERM_ALIASES:
        if pattern.search(alias_haystack):
            tokens.update(aliases)

    return {token for token in tokens if token}


MATH_TERM_ALIASES: tuple[tuple[re.Pattern[str], set[str]], ...] = (
    (re.compile(r"(?:\\sqrt\b|\bsqrt\b|\bsquare\s+root\b|√)"), {"sqrt", "square_root"}),
    (re.compile(r"(?:\\int\b|\bint\b|\bintegral\b|∫)"), {"int", "integral"}),
    (re.compile(r"(?:\\lim\b|\blim\b|\blimit\b)"), {"lim", "limit"}),
    (re.compile(r"\b(?:derivative|differentiate|differentiating|differentiation)\b"), {"derivative", "differentiate"}),
)


def normalize_equation_token(token: str) -> str:
    normalized = token.lower().removeprefix("\\")

    if normalized == "√":
        return "sqrt"

    if normalized == "∫":
        return "int"

    if normalized == "∞":
        return "infinity"

    return normalized


def equation_overlap_score(text: str, query_equation_tokens: set[str]) -> float:
    if not query_equation_tokens:
        return 0.0

    content_equation_tokens = equation_tokens_from_text(text)
    return len(query_equation_tokens.intersection(content_equation_tokens)) / len(query_equation_tokens)
