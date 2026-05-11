from __future__ import annotations

import json
import logging
import os
from typing import Any, Protocol

import httpx

from backend.internal_next import internal_next_base_url, reusable_async_client

logger = logging.getLogger(__name__)
_NEXT_SEARCH_CLIENT: httpx.AsyncClient | None = None


class PdfPageSearchResult(list[dict[str, Any]]):
    """List of page results with optional backend retrieval timing metadata."""

    def __init__(self, pages: list[dict[str, Any]], *, timings: dict[str, Any] | None = None) -> None:
        super().__init__(pages)
        self.timings = timings or {}


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
            "Search indexed class PDF page windows for relevant worksheets, assignments, textbook/readings, notes, "
            "examples, page numbers, sections, problem numbers, or prior source-backed context."
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
                        "Ignored. The tool usually returns the top 5 ranked page windows; textbook section/chapter "
                        "queries may return more related windows."
                    ),
                    "default": 5,
                },
                "student_reason": {
                    "type": "string",
                    "description": (
                        "Exactly five words explaining to the student why this search helps. "
                        "Example: Checking exact problem and page"
                    ),
                },
            },
            "required": ["query", "student_reason"],
        },
    },
}


def parse_search_pdf_pages_arguments(raw_arguments: str | dict[str, Any] | None) -> tuple[str, int]:
    """Parse OpenRouter tool-call arguments for the search_pdf_pages tool."""

    if raw_arguments is None:
        raise ValueError("search_pdf_pages requires a query argument.")

    parsed = raw_arguments if isinstance(raw_arguments, dict) else json.loads(raw_arguments or "{}")
    query = str(parsed.get("query") or "").strip()

    if not query:
        raise ValueError("search_pdf_pages requires a non-empty query.")

    return query, 5


async def search_pdf_pages(
    query: str,
    top_k: int = 5,
    *,
    retriever: PdfRetriever | None = None,
    class_id: str | None = None,
    professor_id: str | None = None,
) -> list[dict[str, Any]]:
    """Search indexed PDF page windows and return page metadata, not whole PDFs."""

    timings: dict[str, Any] = {}

    if retriever:
        pages = await retriever.search(query=query, top_k=top_k, class_id=class_id, professor_id=professor_id)
    else:
        pages, timings = await search_pdf_pages_via_next(
            query=query,
            top_k=top_k,
            class_id=class_id,
            professor_id=professor_id,
        )

    return PdfPageSearchResult([normalize_pdf_page_result(page) for page in pages], timings=timings)


async def search_pdf_pages_via_next(
    *,
    query: str,
    top_k: int,
    class_id: str | None,
    professor_id: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not class_id or not professor_id:
        return [], {}

    shared_secret = os.getenv("BACKEND_SHARED_SECRET", "").strip()

    if not shared_secret:
        return [], {}

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
        return [], {}

    pages = payload.get("pages") if isinstance(payload, dict) else []
    timings = payload.get("timings") if isinstance(payload, dict) else {}
    return (pages if isinstance(pages, list) else []), (timings if isinstance(timings, dict) else {})


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

    result = {
        "doc_id": str(source.get("doc_id") or source.get("docId") or source.get("materialId") or ""),
        "title": str(source.get("title") or "Untitled PDF"),
        "page_start": max(1, min(page_start, page_end)),
        "page_end": max(page_start, page_end),
        "section": str(source.get("section") or source.get("sectionHeading") or ""),
        "score": float(source.get("score") or 0.0),
        "chunk_text": str(source.get("chunk_text") or source.get("chunkText") or source.get("content") or ""),
        "source_type": str(source.get("source_type") or source.get("sourceType") or ""),
        "source_pdf_path": str(
            source.get("source_pdf_path")
            or source.get("sourcePdfPath")
            or source.get("fileUrl")
            or source.get("filePath")
            or ""
        ),
        "material_type": str(source.get("material_type") or source.get("materialType") or source.get("kind") or ""),
    }

    page_asset_prefix = str(source.get("page_asset_prefix") or source.get("pageAssetPrefix") or "").strip()
    page_asset_storage_bucket = str(
        source.get("page_asset_storage_bucket")
        or source.get("pageAssetStorageBucket")
        or source.get("storageBucket")
        or ""
    ).strip()

    if page_asset_prefix:
        result["page_asset_prefix"] = page_asset_prefix
        result["pageAssetPrefix"] = page_asset_prefix

    if page_asset_storage_bucket:
        result["page_asset_storage_bucket"] = page_asset_storage_bucket
        result["pageAssetStorageBucket"] = page_asset_storage_bucket

    if result["source_type"]:
        result["sourceType"] = result["source_type"]

    return result
