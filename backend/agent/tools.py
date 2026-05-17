from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Protocol

import httpx

from backend.internal_next import internal_next_base_url, reusable_async_client
from backend.retrieval.pdf_page_assets import merge_page_asset_payloads

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
    ) -> list[dict[str, Any]]:
        ...


SEARCH_PDF_PAGES_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "search_pdf_pages",
        "description": (
            "Search PostgreSQL-indexed structured PDF metadata for class PDF pages/problems from worksheets, assignments, "
            "textbook/readings, notes, examples, page numbers, sections, problem numbers, or prior source-backed context."
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
                        "Maximum structured PDF metadata records to return. Exact problem lookups should use several candidates when source disambiguation may be needed."
                    ),
                    "default": 5,
                },
                "retrieval_reason": {
                    "type": "string",
                    "enum": sorted(ALLOWED_RETRIEVAL_REASONS),
                    "description": (
                        "Internal reason for searching indexed structured PDF metadata. Must be one of the allowed values."
                    ),
                },
            },
            "required": ["query", "retrieval_reason"],
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
) -> list[dict[str, Any]]:
    """Search indexed PostgreSQL structured PDF metadata and return metadata, not whole PDFs."""

    normalized_reason = normalize_retrieval_reason(retrieval_reason, query=query)
    normalized_query = normalize_query_for_retrieval_reason(query, normalized_reason)

    if retriever:
        pages = await retriever.search(
            query=normalized_query,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
        )
    else:
        pages = await search_pdf_pages_via_next(
            query=normalized_query,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
            retrieval_reason=normalized_reason,
        )

    normalized_pages = [normalize_pdf_page_result(page) for page in pages]
    return [
        {
            **page,
            "class_id": str(class_id or page.get("class_id") or ""),
            "professor_id": str(professor_id or page.get("professor_id") or ""),
            "retrieval_reason": normalized_reason,
        }
        for page in normalized_pages
    ]


async def search_pdf_pages_via_next(
    *,
    query: str,
    top_k: int,
    class_id: str | None,
    professor_id: str | None,
    retrieval_reason: str,
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
    is_structured_pdf = is_structured_pdf_result(source)

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
        "full_pdf_data_url": None if is_structured_pdf else source.get("full_pdf_data_url") or source.get("fullPdfDataUrl"),
        "full_pdf_file_name": source.get("full_pdf_file_name") or source.get("fullPdfFileName"),
        "full_pdf_skipped_reason": str(source.get("full_pdf_skipped_reason") or source.get("fullPdfSkippedReason") or ""),
        "printed_page_start": source.get("printed_page_start") or source.get("printedPageStart"),
        "printed_page_end": source.get("printed_page_end") or source.get("printedPageEnd"),
        "professor_id": str(source.get("professorId") or source.get("professor_id") or ""),
        "section": str(source.get("section") or source.get("sectionHeading") or ""),
        "score": float(source.get("score") or 0.0),
        "chunk_text": str(source.get("chunk_text") or source.get("chunkText") or source.get("pageLevelSearchText") or source.get("content") or ""),
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
        "file_data_url": None if is_structured_pdf else source.get("file_data_url") or source.get("fileDataUrl"),
        "file_name": source.get("file_name") or source.get("fileName"),
        "image_url": source.get("image_url") or source.get("imageUrl"),
        "images": source.get("images") if isinstance(source.get("images"), list) else [],
        "source_type": str(source.get("sourceType") or source.get("source_type") or ""),
        "source_id": str(source.get("sourceId") or source.get("source_id") or ""),
        "embedding_level": str(source.get("embeddingLevel") or source.get("embedding_level") or ""),
        "block_id": str(source.get("blockId") or source.get("block_id") or ""),
        "object_id": str(source.get("objectId") or source.get("object_id") or ""),
        "block_type": str(source.get("blockType") or source.get("block_type") or ""),
        "object_type": str(source.get("objectType") or source.get("object_type") or ""),
        "item_kind": str(source.get("itemKind") or source.get("item_kind") or ""),
        "item_number": str(source.get("itemNumber") or source.get("item_number") or ""),
        "item_label": str(source.get("itemLabel") or source.get("item_label") or ""),
        "canonical_item_id": str(source.get("canonicalItemId") or source.get("canonical_item_id") or ""),
        "embedding_source": str(source.get("embeddingSource") or source.get("embedding_source") or ""),
        "ingestion_version": str(source.get("ingestionVersion") or source.get("ingestion_version") or ""),
        "embedding_dim": source.get("embeddingDim") if source.get("embeddingDim") is not None else source.get("embedding_dim"),
    }


def is_structured_pdf_result(source: dict[str, Any]) -> bool:
    return (
        str(source.get("ingestionVersion") or source.get("ingestion_version") or "") == "gemini_structured_page_v1"
        or str(source.get("embeddingSource") or source.get("embedding_source") or "") == "structured_page_json"
    )
