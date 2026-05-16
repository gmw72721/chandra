from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Protocol

import httpx

from backend.internal_next import internal_next_base_url, reusable_async_client
from backend.retrieval.pdf_page_assets import merge_page_asset_payloads
from backend.retrieval.gemini_enterprise_search import GeminiEnterpriseSearchClient

logger = logging.getLogger(__name__)
_NEXT_SEARCH_CLIENT: httpx.AsyncClient | None = None
ALLOWED_RETRIEVAL_REASONS = {
    "student_requested_problem",
    "needed_supporting_page",
    "needed_example_page",
    "student_changed_problem",
    "previous_search_failed",
}
EXAMPLE_SEARCH_PREFIX = "worked example textbook reading notes method"
EXAMPLE_EXACT_LOCATOR_PATTERNS = (
    re.compile(
        r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*"
        r"(?:\d{1,3}\s+\d{1,3}[a-z]?|\d{1,3}\s*\.\s*\d{1,3}[a-z]?|\d{1,3}[a-z]?)\b",
        re.I,
    ),
    re.compile(r"(?:^|[\s([{])#\s*\d{1,3}[a-z]?\b", re.I),
    re.compile(r"\bq\s*\d{1,3}[a-z]?\b", re.I),
    re.compile(r"\b(?:page|pg\.?|p\.?|printed\s+page)\s*#?\s*\d{1,4}\b", re.I),
    re.compile(r"(?:^|[\s([{])\d{1,3}\s*\.\s*\d{1,3}[a-z]?\s*[\).]", re.I),
)
EXAMPLE_SEARCH_FILLER_PATTERN = re.compile(
    r"\b(?:find|locate|show|read|quote|pull\s+up|give\s+me|can\s+you|please|"
    r"similar\s+example|similar\s+problem|example\s+problem|worked\s+example|"
    r"another\s+example|nearby\s+example|different\s+example|example|a|an|the|for)\b",
    re.I,
)
EXAMPLE_INTENT_PATTERN = re.compile(
    r"\b(?:similar|worked|another|nearby|different|example|examples)\b",
    re.I,
)


class PdfRetriever(Protocol):
    async def search(
        self,
        *,
        query: str,
        top_k: int = 5,
        class_id: str | None = None,
        professor_id: str | None = None,
        material_id: str | None = None,
        page_before: int | None = None,
    ) -> list[dict[str, Any]]:
        ...


class CourseMaterialBroadRetriever(Protocol):
    async def search(
        self,
        *,
        query: str,
        intent: str,
        top_k: int = 5,
        class_id: str | None = None,
        professor_id: str | None = None,
        active_material_id: str | None = None,
        active_page_number: int | None = None,
        active_page_before: int | None = None,
        preferred_chunk_types: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        ...


SEARCH_PDF_PAGES_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "search_pdf_pages",
        "description": (
            "Search Gemini Agent Search by default for class PDF pages/problems from worksheets, assignments, "
            "textbook/readings, notes, examples, page numbers, sections, problem numbers, or prior source-backed context; "
            "falls back to PostgreSQL OCR metadata when Gemini has no usable result."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Focused PDF search query. Include exact titles, page/section/problem numbers, topic words, "
                        "and distinctive student wording when known."
                    ),
                },
                "top_k": {
                    "type": "integer",
                    "description": (
                        "Maximum OCR metadata records to return. Exact problem lookups should use 1."
                    ),
                    "default": 5,
                },
                "retrieval_reason": {
                    "type": "string",
                    "enum": sorted(ALLOWED_RETRIEVAL_REASONS),
                    "description": (
                        "Internal reason for searching indexed course material. Must be one of the allowed values."
                    ),
                },
            },
            "required": ["query", "retrieval_reason"],
        },
    },
}

SEARCH_COURSE_MATERIAL_BROAD_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "search_course_material_broad",
        "description": (
            "Search Gemini Enterprise Search / Agent Search Standard Edition for broad semantic matches across "
            "course materials: similar worked examples, methods, concepts, definitions, formulas, tables, "
            "captions, sections, and env-gated exact problem/page lookup."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "intent": {
                    "type": "string",
                    "description": "Broad search intent such as similar_example, similar_method, concept, definition, formula, table, caption, or section.",
                },
                "top_k": {"type": "integer", "default": 5},
                "preferred_chunk_types": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["caption", "definition", "example", "formula", "paragraph", "section", "table"],
                    },
                },
            },
            "required": ["query", "intent"],
        },
    },
}


def normalize_retrieval_reason(value: Any, *, query: str = "") -> str:
    reason = str(value or "").strip()
    normalized_query = query.lower()

    if has_exact_locator(query) and not has_example_intent(query):
        return "student_requested_problem"

    if reason in ALLOWED_RETRIEVAL_REASONS:
        return reason

    if any(marker in normalized_query for marker in ("example", "worked example")):
        return "needed_example_page"

    if any(marker in normalized_query for marker in ("textbook", "reading", "notes", "method", "theorem", "formula")):
        return "needed_supporting_page"

    return "student_requested_problem"


def normalize_query_for_retrieval_reason(query: str, retrieval_reason: str) -> str:
    normalized_query = " ".join(str(query or "").split())

    if retrieval_reason != "needed_example_page":
        return normalized_query

    cleaned_query = normalized_query

    for pattern in EXAMPLE_EXACT_LOCATOR_PATTERNS:
        cleaned_query = pattern.sub(" ", cleaned_query)

    cleaned_query = " ".join(cleaned_query.split())

    if cleaned_query.lower().startswith(EXAMPLE_SEARCH_PREFIX):
        return cleaned_query

    cleaned_query = EXAMPLE_SEARCH_FILLER_PATTERN.sub(" ", cleaned_query)
    cleaned_query = " ".join(cleaned_query.split())

    return " ".join([EXAMPLE_SEARCH_PREFIX, cleaned_query]).strip()


def has_exact_locator(query: str) -> bool:
    return any(pattern.search(query or "") for pattern in EXAMPLE_EXACT_LOCATOR_PATTERNS)


def has_example_intent(query: str) -> bool:
    return bool(EXAMPLE_INTENT_PATTERN.search(query or ""))


def parse_search_pdf_pages_arguments(raw_arguments: str | dict[str, Any] | None) -> tuple[str, int, str]:
    """Parse OpenRouter tool-call arguments for the search_pdf_pages tool."""

    if raw_arguments is None:
        raise ValueError("search_pdf_pages requires a query argument.")

    parsed = raw_arguments if isinstance(raw_arguments, dict) else json.loads(raw_arguments or "{}")
    query = str(parsed.get("query") or "").strip()

    if not query:
        raise ValueError("search_pdf_pages requires a non-empty query.")

    top_k = parsed.get("top_k")
    parsed_top_k = int(top_k) if isinstance(top_k, int) and top_k > 0 else 5
    retrieval_reason = normalize_retrieval_reason(parsed.get("retrieval_reason"), query=query)
    query = normalize_query_for_retrieval_reason(query, retrieval_reason)

    return query, min(parsed_top_k, 20), retrieval_reason


async def search_pdf_pages(
    query: str,
    top_k: int = 5,
    *,
    retriever: PdfRetriever | None = None,
    class_id: str | None = None,
    professor_id: str | None = None,
    retrieval_reason: str | None = None,
    material_id: str | None = None,
    page_before: int | None = None,
    try_gemini: bool = True,
) -> list[dict[str, Any]]:
    """Search indexed PDF metadata and return metadata, not whole PDFs."""

    normalized_reason = normalize_retrieval_reason(retrieval_reason, query=query)
    normalized_query = normalize_query_for_retrieval_reason(query, normalized_reason)

    if try_gemini and not retriever:
        gemini_pages = await search_course_material_broad(
            query=normalized_query,
            intent=normalized_reason,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
            active_material_id=material_id,
            active_page_before=page_before,
            preferred_chunk_types=preferred_chunk_types_for_pdf_tool_search(normalized_query, normalized_reason),
        )
        if gemini_pages:
            return [
                {
                    **page,
                    "class_id": str(class_id or page.get("class_id") or ""),
                    "professor_id": str(professor_id or page.get("professor_id") or ""),
                    "retrieval_reason": normalized_reason,
                }
                for page in gemini_pages
            ]

    if retriever:
        scoped_kwargs = {
            **({"material_id": material_id} if material_id else {}),
            **({"page_before": page_before} if page_before else {}),
        }
        pages = await retriever.search(
            query=normalized_query,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
            **scoped_kwargs,
        )
    else:
        pages = await search_pdf_pages_via_next(
            query=normalized_query,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
            retrieval_reason=normalized_reason,
            material_id=material_id,
            page_before=page_before,
        )

    normalized_pages = [normalize_pdf_page_result(page) for page in pages]
    normalized_pages = filter_pages_before_material(
        normalized_pages,
        material_id=material_id,
        page_before=page_before,
    )
    return [
        {
            **page,
            "class_id": str(class_id or page.get("class_id") or ""),
            "professor_id": str(professor_id or page.get("professor_id") or ""),
            "retrieval_reason": normalized_reason,
        }
        for page in normalized_pages
    ]


def preferred_chunk_types_for_pdf_tool_search(query: str, retrieval_reason: str) -> list[str] | None:
    normalized = query.lower()
    chunk_types: list[str] = []

    if retrieval_reason == "needed_example_page" or re.search(r"\bexamples?\b", normalized):
        chunk_types.append("example")
    if re.search(r"\bdefinitions?|define|means?\b", normalized):
        chunk_types.append("definition")
    if re.search(r"\bformula|equation\b", normalized):
        chunk_types.append("formula")
    if re.search(r"\btable\b", normalized):
        chunk_types.append("table")
    if re.search(r"\bcaption|figure|diagram\b", normalized):
        chunk_types.append("caption")
    if re.search(r"\bsection|notes?|concept|method|theorem|rule\b", normalized):
        chunk_types.extend(["paragraph", "section"])

    return sorted(set(chunk_types)) or None


async def search_course_material_broad(
    *,
    query: str,
    intent: str,
    top_k: int = 5,
    class_id: str | None = None,
    professor_id: str | None = None,
    active_material_id: str | None = None,
    active_page_number: int | None = None,
    active_page_before: int | None = None,
    preferred_chunk_types: list[str] | None = None,
    broad_retriever: CourseMaterialBroadRetriever | None = None,
) -> list[dict[str, Any]]:
    """Search broad course-material context with Gemini Enterprise Search.

    This function intentionally returns no results when disabled or misconfigured so callers can safely
    fall back to PostgreSQL OCR retrieval.
    """

    normalized_query = " ".join(str(query or "").split())
    if not normalized_query or not class_id or not professor_id:
        return []

    try:
        if broad_retriever:
            pages = await broad_retriever.search(
                query=normalized_query,
                intent=intent,
                top_k=top_k,
                class_id=class_id,
                professor_id=professor_id,
                active_material_id=active_material_id,
                active_page_number=active_page_number,
                active_page_before=active_page_before,
                preferred_chunk_types=preferred_chunk_types,
            )
        else:
            pages = await GeminiEnterpriseSearchClient().search(
                query=normalized_query,
                intent=intent,
                top_k=top_k,
                class_id=class_id,
                professor_id=professor_id,
                active_material_id=active_material_id,
                active_page_number=active_page_number,
                active_page_before=active_page_before,
                preferred_chunk_types=preferred_chunk_types,
            )
    except Exception as error:
        logger.warning(
            "Broad course-material retrieval failed; falling back to PostgreSQL OCR retrieval.",
            extra={
                "class_id": class_id,
                "error": str(error),
                "intent": intent,
                "professor_id": professor_id,
            },
        )
        return []

    normalized_pages = [
        {
            **normalize_pdf_page_result(page),
            "chunk_type": str(page.get("chunk_type") or page.get("chunkType") or ""),
            "gemini_chunk_id": str(page.get("gemini_chunk_id") or page.get("geminiChunkId") or ""),
            "gemini_document_id": str(page.get("gemini_document_id") or page.get("geminiDocumentId") or ""),
            "gemini_rank": page.get("gemini_rank") or page.get("geminiRank"),
            "layout_json": page.get("layout_json") or page.get("layoutJson"),
            "parent_chunk_id": str(page.get("parent_chunk_id") or page.get("parentChunkId") or ""),
            "previous_chunk_id": str(page.get("previous_chunk_id") or page.get("previousChunkId") or ""),
            "next_chunk_id": str(page.get("next_chunk_id") or page.get("nextChunkId") or ""),
            "retrieval_mode": "gemini_enterprise",
            "retrieval_reason": intent or "needed_example_page",
        }
        for page in pages
        if isinstance(page, dict)
    ]
    normalized_pages = filter_pages_before_material(
        normalized_pages,
        material_id=active_material_id,
        page_before=active_page_before,
    )

    return await expand_broad_results_with_page_context(
        normalized_pages,
        class_id=class_id,
        professor_id=professor_id,
        retrieval_reason=intent or "needed_example_page",
    )


async def expand_broad_results_with_page_context(
    pages: list[dict[str, Any]],
    *,
    class_id: str,
    professor_id: str,
    retrieval_reason: str,
) -> list[dict[str, Any]]:
    expanded_pages: list[dict[str, Any]] = []

    for page in pages:
        material_id = str(page.get("doc_id") or page.get("material_id") or "")
        page_number = int(page.get("page_number") or page.get("page_start") or 0)
        context_pages: list[dict[str, Any]] = []

        if material_id and page_number:
            context_pages = await search_pdf_pages_via_next(
                query=f"page {page_number}",
                top_k=1,
                class_id=class_id,
                professor_id=professor_id,
                retrieval_reason=retrieval_reason,
                material_id=material_id,
            )

        if context_pages:
            context = normalize_pdf_page_result(context_pages[0])
            expanded_pages.append(
                {
                    **context,
                    "chunk_text": page.get("chunk_text") or context.get("chunk_text") or "",
                    "gemini_chunk_id": page.get("gemini_chunk_id") or "",
                    "gemini_document_id": page.get("gemini_document_id") or "",
                    "gemini_rank": page.get("gemini_rank"),
                    "chunk_type": page.get("chunk_type") or "",
                    "layout_json": page.get("layout_json"),
                    "parent_chunk_id": page.get("parent_chunk_id") or "",
                    "previous_chunk_id": page.get("previous_chunk_id") or "",
                    "next_chunk_id": page.get("next_chunk_id") or "",
                    "retrieval_mode": "gemini_enterprise",
                    "retrieval_reason": retrieval_reason,
                    "score": score_from_gemini_page(page),
                }
            )
        else:
            expanded_pages.append(page)

    return expanded_pages


def score_from_gemini_page(page: dict[str, Any]) -> float:
    try:
        return float(page["score"])
    except (KeyError, TypeError, ValueError):
        return 0.0


async def search_pdf_pages_via_next(
    *,
    query: str,
    top_k: int,
    class_id: str | None,
    professor_id: str | None,
    retrieval_reason: str,
    material_id: str | None = None,
    page_before: int | None = None,
) -> list[dict[str, Any]]:
    if not class_id or not professor_id:
        return []

    shared_secret = os.getenv("BACKEND_SHARED_SECRET", "").strip()

    if not shared_secret:
        return []

    next_base_url = internal_next_base_url("PDF retrieval")

    try:
        client = next_search_http_client()
        response = await client.post(
            f"{next_base_url}/api/internal/pdf-page-search",
            headers={
                "Content-Type": "application/json",
                "X-Chandra-Internal-Secret": shared_secret,
            },
            json={
                "classId": class_id,
                "includeAssets": True,
                **({"materialId": material_id} if material_id else {}),
                **({"pageBefore": int(page_before)} if page_before else {}),
                "professorId": professor_id,
                "query": query,
                "retrievalReason": retrieval_reason,
                "topK": top_k,
            },
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        if isinstance(error, (httpx.TransportError, httpx.TimeoutException)):
            await close_next_search_http_client()

        logger.warning(
            "Internal PDF retrieval failed.",
            extra={
                "class_id": class_id,
                "error": str(error),
                "next_base_url": next_base_url,
                "professor_id": professor_id,
            },
        )
        return []

    pages = payload.get("pages") if isinstance(payload, dict) else []
    assets = payload.get("assets") if isinstance(payload, dict) else []
    normalized_pages = [page for page in pages if isinstance(page, dict)] if isinstance(pages, list) else []
    if normalized_pages and isinstance(assets, list) and assets:
        return merge_page_asset_payloads(
            normalized_pages,
            [asset for asset in assets if isinstance(asset, dict)],
        )

    return normalized_pages


def filter_pages_before_material(
    pages: list[dict[str, Any]],
    *,
    material_id: str | None,
    page_before: int | None,
) -> list[dict[str, Any]]:
    normalized_material_id = str(material_id or "").strip()
    try:
        before = int(page_before or 0)
    except (TypeError, ValueError):
        before = 0
    if not normalized_material_id or before <= 1:
        return pages

    filtered: list[dict[str, Any]] = []
    for page in pages:
        page_material_id = str(page.get("doc_id") or page.get("docId") or page.get("material_id") or page.get("materialId") or "")
        try:
            page_start = int(page.get("page_start") or page.get("pageStart") or page.get("page_number") or page.get("pageNumber") or 0)
        except (TypeError, ValueError):
            page_start = 0
        if page_material_id == normalized_material_id and page_start and page_start < before:
            filtered.append(page)
    return filtered


def next_search_http_client() -> httpx.AsyncClient:
    global _NEXT_SEARCH_CLIENT

    _NEXT_SEARCH_CLIENT = reusable_async_client(_NEXT_SEARCH_CLIENT, timeout=45.0)

    return _NEXT_SEARCH_CLIENT


async def close_next_search_http_client() -> None:
    global _NEXT_SEARCH_CLIENT

    if _NEXT_SEARCH_CLIENT is None:
        return

    await _NEXT_SEARCH_CLIENT.aclose()
    _NEXT_SEARCH_CLIENT = None


def normalize_pdf_page_result(page: dict[str, Any] | Any) -> dict[str, Any]:
    """Normalize retriever output into the required tool result shape."""

    source = page if isinstance(page, dict) else page.to_dict()
    page_start = int(source.get("page_start") or source.get("pageStart") or source.get("pageNumber") or 1)
    page_end = int(source.get("page_end") or source.get("pageEnd") or page_start)

    return {
        "class_id": str(source.get("classId") or source.get("class_id") or ""),
        "doc_id": str(source.get("doc_id") or source.get("docId") or source.get("materialId") or ""),
        "title": str(source.get("title") or "Untitled PDF"),
        "page_start": max(1, min(page_start, page_end)),
        "page_end": max(page_start, page_end),
        "page_asset_checksum_sha256": str(source.get("pageAssetChecksumSha256") or source.get("page_asset_checksum_sha256") or ""),
        "page_asset_bucket": str(source.get("pageAssetBucket") or source.get("page_asset_bucket") or source.get("pageAssetStorageBucket") or source.get("page_asset_storage_bucket") or ""),
        "page_asset_path": str(source.get("pageAssetPath") or source.get("page_asset_path") or source.get("pageAssetStoragePath") or source.get("page_asset_storage_path") or ""),
        "page_asset_uri": str(source.get("pageAssetUri") or source.get("page_asset_uri") or ""),
        "page_asset_mime_type": str(source.get("pageAssetMimeType") or source.get("page_asset_mime_type") or ""),
        "page_asset_size_bytes": source.get("pageAssetSizeBytes") if source.get("pageAssetSizeBytes") is not None else source.get("page_asset_size_bytes"),
        "page_asset_storage_bucket": str(source.get("pageAssetStorageBucket") or source.get("page_asset_storage_bucket") or ""),
        "page_asset_storage_path": str(source.get("pageAssetStoragePath") or source.get("page_asset_storage_path") or ""),
        "full_pdf_bucket": str(source.get("fullPdfBucket") or source.get("full_pdf_bucket") or ""),
        "full_pdf_path": str(source.get("fullPdfPath") or source.get("full_pdf_path") or ""),
        "full_pdf_uri": str(source.get("fullPdfUri") or source.get("full_pdf_uri") or ""),
        "full_pdf_mime_type": str(source.get("fullPdfMimeType") or source.get("full_pdf_mime_type") or "application/pdf"),
        "full_pdf_size_bytes": source.get("fullPdfSizeBytes") if source.get("fullPdfSizeBytes") is not None else source.get("full_pdf_size_bytes") if source.get("full_pdf_size_bytes") is not None else source.get("fullPdfSize") if source.get("fullPdfSize") is not None else source.get("full_pdf_size"),
        "full_pdf_sha256": str(source.get("fullPdfSha256") or source.get("full_pdf_sha256") or ""),
        "full_pdf_data_url": source.get("full_pdf_data_url") or source.get("fullPdfDataUrl"),
        "full_pdf_file_name": source.get("full_pdf_file_name") or source.get("fullPdfFileName"),
        "full_pdf_skipped_reason": str(source.get("full_pdf_skipped_reason") or source.get("fullPdfSkippedReason") or ""),
        "printed_page_start": source.get("printed_page_start") or source.get("printedPageStart"),
        "printed_page_end": source.get("printed_page_end") or source.get("printedPageEnd"),
        "professor_id": str(source.get("professorId") or source.get("professor_id") or ""),
        "section": str(source.get("section") or source.get("sectionHeading") or ""),
        "score": float(source.get("score") or 0.0),
        "chunk_text": str(source.get("chunk_text") or source.get("chunkText") or source.get("ocrText") or source.get("content") or ""),
        "ocr_text": str(source.get("ocrText") or source.get("ocr_text") or source.get("chunk_text") or source.get("chunkText") or ""),
        "ocr_confidence": source.get("ocrConfidence") if source.get("ocrConfidence") is not None else source.get("ocr_confidence"),
        "ocr_provider": str(source.get("ocrProvider") or source.get("ocr_provider") or ""),
        "ocr_source": str(source.get("ocrSource") or source.get("ocr_source") or ""),
        "problem_numbers": source.get("problemNumbers") or source.get("problem_numbers") or [],
        "retrieval_mode": str(source.get("retrievalMode") or source.get("retrieval_mode") or ""),
        "source_pdf_path": str(
            source.get("source_pdf_path")
            or source.get("sourcePdfPath")
            or source.get("fileUrl")
            or source.get("filePath")
            or ""
        ),
        "storage_bucket": str(source.get("storageBucket") or source.get("storage_bucket") or ""),
        "storage_path": str(source.get("storagePath") or source.get("storage_path") or ""),
        "material_type": str(source.get("material_type") or source.get("materialType") or source.get("kind") or ""),
        "file_data_url": source.get("file_data_url") or source.get("fileDataUrl"),
        "file_name": source.get("file_name") or source.get("fileName"),
        "image_url": source.get("image_url") or source.get("imageUrl"),
        "images": source.get("images") if isinstance(source.get("images"), list) else [],
    }
