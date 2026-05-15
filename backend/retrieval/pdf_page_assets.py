from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import httpx

from backend.internal_next import internal_next_base_url, reusable_async_client

MAX_TOTAL_PAGES = 12
logger = logging.getLogger(__name__)
_NEXT_ASSET_CLIENT: httpx.AsyncClient | None = None


async def fetch_or_render_pdf_pages(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
    output_dir: str | Path = "data/rendered",
) -> list[dict[str, Any]]:
    """Fetch canonical selected page assets through the internal Next.js route."""

    _ = output_dir
    return await fetch_pdf_page_assets_via_next(retrieved_pages, max_total_pages=max_total_pages)


async def fetch_pdf_page_assets_via_next(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
) -> list[dict[str, Any]]:
    """Fetch page asset data for selected PDF OCR records.

    The request sends only class/professor/material/page selectors. Storage
    paths are resolved by Next.js from PostgreSQL metadata, not trusted from the
    backend payload.
    """

    selected_pages = select_metadata_pages(retrieved_pages, max_total_pages=max_total_pages)
    metadata_pages = [metadata_only_page_asset(page) for page in selected_pages]

    if not metadata_pages:
        return []

    if any(has_prefetched_asset_payload(page) for page in metadata_pages):
        return metadata_pages

    class_id = first_nonempty(metadata_pages, "class_id", "classId")
    professor_id = first_nonempty(metadata_pages, "professor_id", "professorId")
    shared_secret = os.getenv("BACKEND_SHARED_SECRET", "").strip()

    if not class_id or not professor_id or not shared_secret:
        return metadata_pages

    try:
        client = next_asset_http_client()
        response = await client.post(
            f"{internal_next_base_url('PDF page assets')}/api/internal/pdf-page-assets",
            headers={
                "Content-Type": "application/json",
                "X-Chandra-Internal-Secret": shared_secret,
            },
            json={
                "classId": class_id,
                "professorId": professor_id,
                "pages": [
                    {
                        "materialId": page.get("doc_id") or page.get("materialId"),
                        "pageStart": page.get("page_start"),
                        "pageEnd": page.get("page_end"),
                    }
                    for page in metadata_pages
                ],
            },
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        if isinstance(error, (httpx.TransportError, httpx.TimeoutException)):
            await close_next_asset_http_client()

        logger.warning("Internal PDF page asset fetch failed.", extra={"error": str(error)})
        return metadata_pages

    asset_payloads = payload.get("assets") if isinstance(payload, dict) else []
    assets = [asset for asset in asset_payloads if isinstance(asset, dict)] if isinstance(asset_payloads, list) else []
    return merge_page_asset_payloads(metadata_pages, assets)


def next_asset_http_client() -> httpx.AsyncClient:
    global _NEXT_ASSET_CLIENT

    _NEXT_ASSET_CLIENT = reusable_async_client(_NEXT_ASSET_CLIENT, timeout=45.0)
    return _NEXT_ASSET_CLIENT


async def close_next_asset_http_client() -> None:
    global _NEXT_ASSET_CLIENT

    if _NEXT_ASSET_CLIENT is None:
        return

    await _NEXT_ASSET_CLIENT.aclose()
    _NEXT_ASSET_CLIENT = None


def metadata_only_page_asset(page: dict[str, Any]) -> dict[str, Any]:
    page_start = int(page.get("page_start") or page.get("pageStart") or page.get("pageNumber") or 1)
    page_end = int(page.get("page_end") or page.get("pageEnd") or page_start)
    page_start = max(1, min(page_start, page_end))
    page_end = max(page_start, page_end)

    printed_page_start = page.get("printed_page_start")
    if printed_page_start is None:
        printed_page_start = page.get("printedPageStart")

    printed_page_end = page.get("printed_page_end")
    if printed_page_end is None:
        printed_page_end = page.get("printedPageEnd")

    display_page_start = int(printed_page_start or page_start)
    display_page_end = int(printed_page_end or (display_page_start if printed_page_start else page_end))
    ocr_text = str(page.get("ocr_text") or page.get("ocrText") or page.get("chunk_text") or page.get("chunkText") or "")
    chunk_text = str(page.get("chunk_text") or page.get("chunkText") or ocr_text)
    title = str(page.get("title") or "Untitled PDF")

    return {
        "chunk_text": chunk_text,
        "class_id": str(page.get("class_id") or page.get("classId") or ""),
        "citation_label": citation_label(title, display_page_start, display_page_end),
        "doc_id": str(page.get("doc_id") or page.get("docId") or page.get("materialId") or ""),
        "images": [],
        "material_type": str(page.get("material_type") or page.get("materialType") or ""),
        "ocr_confidence": page.get("ocr_confidence") if page.get("ocr_confidence") is not None else page.get("ocrConfidence"),
        "ocr_provider": str(page.get("ocr_provider") or page.get("ocrProvider") or ""),
        "ocr_source": str(page.get("ocr_source") or page.get("ocrSource") or ""),
        "ocr_text": ocr_text,
        "page_end": page_end,
        "page_start": page_start,
        "full_pdf_bucket": str(page.get("full_pdf_bucket") or page.get("fullPdfBucket") or ""),
        "full_pdf_path": str(page.get("full_pdf_path") or page.get("fullPdfPath") or ""),
        "full_pdf_uri": str(page.get("full_pdf_uri") or page.get("fullPdfUri") or ""),
        "full_pdf_mime_type": str(page.get("full_pdf_mime_type") or page.get("fullPdfMimeType") or "application/pdf"),
        "full_pdf_size_bytes": page.get("full_pdf_size") if page.get("full_pdf_size") is not None else page.get("fullPdfSize") if page.get("fullPdfSize") is not None else page.get("full_pdf_size_bytes") if page.get("full_pdf_size_bytes") is not None else page.get("fullPdfSizeBytes"),
        "full_pdf_sha256": str(page.get("full_pdf_sha256") or page.get("fullPdfSha256") or ""),
        "full_pdf_data_url": page.get("full_pdf_data_url") or page.get("fullPdfDataUrl"),
        "full_pdf_file_name": page.get("full_pdf_file_name") or page.get("fullPdfFileName"),
        "full_pdf_skipped_reason": str(page.get("full_pdf_skipped_reason") or page.get("fullPdfSkippedReason") or ""),
        "page_asset_bucket": str(page.get("page_asset_bucket") or page.get("pageAssetBucket") or page.get("page_asset_storage_bucket") or page.get("pageAssetStorageBucket") or ""),
        "page_asset_path": str(page.get("page_asset_path") or page.get("pageAssetPath") or page.get("page_asset_storage_path") or page.get("pageAssetStoragePath") or ""),
        "page_asset_uri": str(page.get("page_asset_uri") or page.get("pageAssetUri") or ""),
        "page_asset_checksum_sha256": str(page.get("page_asset_sha256") or page.get("pageAssetSha256") or page.get("page_asset_checksum_sha256") or page.get("pageAssetChecksumSha256") or ""),
        "page_asset_mime_type": str(page.get("page_asset_mime_type") or page.get("pageAssetMimeType") or ""),
        "page_asset_size_bytes": page.get("page_asset_size") if page.get("page_asset_size") is not None else page.get("pageAssetSize") if page.get("pageAssetSize") is not None else page.get("page_asset_size_bytes") if page.get("page_asset_size_bytes") is not None else page.get("pageAssetSizeBytes"),
        "page_asset_storage_bucket": str(page.get("page_asset_storage_bucket") or page.get("pageAssetStorageBucket") or page.get("page_asset_bucket") or page.get("pageAssetBucket") or ""),
        "page_asset_storage_path": str(page.get("page_asset_storage_path") or page.get("pageAssetStoragePath") or page.get("page_asset_path") or page.get("pageAssetPath") or ""),
        "file_data_url": page.get("file_data_url") or page.get("fileDataUrl"),
        "file_name": page.get("file_name") or page.get("fileName"),
        "image_url": page.get("image_url") or page.get("imageUrl"),
        "images": page.get("images") if isinstance(page.get("images"), list) else [],
        "printed_page_end": printed_page_end,
        "printed_page_start": printed_page_start,
        "professor_id": str(page.get("professor_id") or page.get("professorId") or ""),
        "problem_numbers": page.get("problem_numbers") or page.get("problemNumbers") or [],
        "retrieval_mode": str(page.get("retrieval_mode") or page.get("retrievalMode") or ""),
        "score": float(page.get("score") or 0.0),
        "source_pdf_path": str(page.get("source_pdf_path") or page.get("sourcePdfPath") or ""),
        "storage_bucket": str(page.get("storage_bucket") or page.get("storageBucket") or ""),
        "storage_path": str(page.get("storage_path") or page.get("storagePath") or ""),
        "title": title,
    }


def has_prefetched_asset_payload(page: dict[str, Any]) -> bool:
    image_url = page.get("image_url") or page.get("imageUrl")
    return bool(
        page.get("file_data_url")
        or page.get("fileDataUrl")
        or page.get("full_pdf_data_url")
        or page.get("fullPdfDataUrl")
        or (isinstance(image_url, dict) and image_url.get("url"))
        or page.get("images")
    )


def merge_page_asset_payload(page: dict[str, Any], asset: dict[str, Any] | None) -> dict[str, Any]:
    if not asset:
        return page

    mime_type = str(asset.get("mimeType") or asset.get("pageAssetMimeType") or page.get("page_asset_mime_type") or "")
    data_url = str(asset.get("dataUrl") or "")
    merged = {
        **page,
        "full_pdf_bucket": str(asset.get("fullPdfBucket") or page.get("full_pdf_bucket") or ""),
        "full_pdf_path": str(asset.get("fullPdfPath") or page.get("full_pdf_path") or ""),
        "full_pdf_uri": str(asset.get("fullPdfUri") or page.get("full_pdf_uri") or ""),
        "full_pdf_mime_type": str(asset.get("fullPdfMimeType") or page.get("full_pdf_mime_type") or "application/pdf"),
        "full_pdf_size_bytes": asset.get("fullPdfSize") if asset.get("fullPdfSize") is not None else asset.get("fullPdfSizeBytes") if asset.get("fullPdfSizeBytes") is not None else page.get("full_pdf_size_bytes"),
        "full_pdf_sha256": str(asset.get("fullPdfSha256") or page.get("full_pdf_sha256") or ""),
        "full_pdf_skipped_reason": str(asset.get("fullPdfSkippedReason") or page.get("full_pdf_skipped_reason") or ""),
        "page_asset_bucket": str(asset.get("pageAssetBucket") or page.get("page_asset_bucket") or page.get("page_asset_storage_bucket") or ""),
        "page_asset_path": str(asset.get("pageAssetPath") or page.get("page_asset_path") or page.get("page_asset_storage_path") or ""),
        "page_asset_uri": str(asset.get("pageAssetUri") or page.get("page_asset_uri") or ""),
        "page_asset_checksum_sha256": str(asset.get("pageAssetSha256") or asset.get("pageAssetChecksumSha256") or page.get("page_asset_checksum_sha256") or ""),
        "page_asset_mime_type": mime_type,
        "page_asset_size_bytes": asset.get("pageAssetSize") if asset.get("pageAssetSize") is not None else asset.get("pageAssetSizeBytes") if asset.get("pageAssetSizeBytes") is not None else page.get("page_asset_size_bytes"),
        "page_asset_storage_bucket": str(asset.get("pageAssetStorageBucket") or asset.get("pageAssetBucket") or page.get("page_asset_storage_bucket") or page.get("page_asset_bucket") or ""),
        "page_asset_storage_path": str(asset.get("pageAssetStoragePath") or asset.get("pageAssetPath") or page.get("page_asset_storage_path") or page.get("page_asset_path") or ""),
    }

    if data_url:
        if mime_type.startswith("image/"):
            merged["image_url"] = {"url": data_url}
            merged["images"] = [data_url]
        else:
            merged["file_data_url"] = data_url
            merged["file_name"] = f"{page.get('doc_id') or 'pdf'}-page-{page.get('page_start')}.pdf"

    full_pdf_data_url = str(asset.get("fullPdfDataUrl") or "")
    if full_pdf_data_url:
        merged["full_pdf_data_url"] = full_pdf_data_url
        merged["full_pdf_file_name"] = str(asset.get("fullPdfFileName") or f"{page.get('doc_id') or 'source'}.pdf")

    return merged


def merge_page_asset_payloads(metadata_pages: list[dict[str, Any]], assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not assets:
        return metadata_pages

    merged_pages: list[dict[str, Any]] = []
    used_asset_keys: set[tuple[str, int]] = set()

    for page in metadata_pages:
        doc_id = str(page.get("doc_id") or "")
        page_start = int(page.get("page_start") or 1)
        page_end = int(page.get("page_end") or page_start)
        matching_assets = [
            asset
            for asset in assets
            if str(asset.get("docId") or asset.get("materialId") or "") == doc_id
            and page_start <= int(asset.get("pageNumber") or asset.get("pageStart") or page_start) <= page_end
        ]

        if not matching_assets:
            merged_pages.append(page)
            continue

        for asset in matching_assets:
            page_number = int(asset.get("pageNumber") or asset.get("pageStart") or page_start)
            used_asset_keys.add(page_asset_key(asset))
            merged_pages.append(
                merge_page_asset_payload(
                    {
                        **page,
                        "page_start": page_number,
                        "page_end": page_number,
                    },
                    asset,
                )
            )

    for asset in assets:
        if page_asset_key(asset) in used_asset_keys:
            continue
        merged_pages.append(merge_page_asset_payload(metadata_only_page_asset(asset), asset))

    return merged_pages


def page_asset_key(page: dict[str, Any]) -> tuple[str, int]:
    return (
        str(page.get("doc_id") or page.get("docId") or page.get("materialId") or ""),
        int(page.get("page_start") or page.get("pageStart") or page.get("pageNumber") or 1),
    )


def first_nonempty(pages: list[dict[str, Any]], *keys: str) -> str:
    for page in pages:
        for key in keys:
            value = str(page.get(key) or "").strip()
            if value:
                return value
    return ""


def select_metadata_pages(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
) -> list[dict[str, Any]]:
    """Select narrow OCR metadata records without merging or opening PDFs."""

    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int, str, str]] = set()
    pages_used = 0

    for page in sorted(retrieved_pages, key=lambda item: float(item.get("score") or 0.0), reverse=True):
        page_start = int(page.get("page_start") or page.get("pageStart") or page.get("pageNumber") or 1)
        page_end = int(page.get("page_end") or page.get("pageEnd") or page_start)
        normalized_page_start = max(1, min(page_start, page_end))
        normalized_page_end = max(normalized_page_start, page_end)
        page_count = normalized_page_end - normalized_page_start + 1

        if pages_used + page_count > max_total_pages:
            continue

        key = (
            str(page.get("doc_id") or page.get("docId") or page.get("materialId") or ""),
            normalized_page_start,
            normalized_page_end,
            str(page.get("retrieval_mode") or page.get("retrievalMode") or ""),
            str(page.get("chunk_text") or page.get("chunkText") or page.get("ocr_text") or page.get("ocrText") or "")[:160],
        )

        if key in seen:
            continue

        seen.add(key)
        selected.append(
            {
                **page,
                "doc_id": key[0],
                "page_start": normalized_page_start,
                "page_end": normalized_page_end,
                "title": str(page.get("title") or "Untitled PDF"),
            }
        )
        pages_used += page_count

    return selected


def citation_label(title: str, page_start: int, page_end: int) -> str:
    pages = f"page {page_start}" if page_start == page_end else f"pages {page_start}-{page_end}"
    return f"{title}, {pages}"
