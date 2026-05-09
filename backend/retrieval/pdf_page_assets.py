from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from pypdf import PdfReader, PdfWriter

logger = logging.getLogger(__name__)

MAX_TOTAL_PAGES = 12
_PAGE_ASSET_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_PAGE_ASSET_CACHE_MAX = 256
PRINTED_PAGE_FOOTER_PATTERNS = (
    re.compile(r"[-\u2013\u2014]\s*(\d{1,5})\s*[-\u2013\u2014]"),
    re.compile(r"\b[Pp]age\s+(\d{1,5})\b"),
)
PRINTED_PAGE_LINE_RE = re.compile(r"\d{1,5}")


async def fetch_or_render_pdf_pages(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
    output_dir: str | Path = "data/rendered",
) -> list[dict[str, Any]]:
    """Fetch/render only selected PDF page ranges into multimodal assets."""

    selected_ranges = deduplicate_page_ranges(retrieved_pages, max_total_pages=max_total_pages)
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    source_cache = await resolve_pdf_sources(selected_ranges, output_dir=target_dir)

    return await asyncio.gather(
        *(build_page_asset(item, source_cache[str(item["source_pdf_path"])], target_dir) for item in selected_ranges)
    )


async def fetch_pdf_page_assets_via_next(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
) -> list[dict[str, Any]]:
    """Ask the Next.js server to build selected PDF assets using Node/Firebase."""

    selected_ranges = deduplicate_page_ranges(retrieved_pages, max_total_pages=max_total_pages)

    if not selected_ranges:
        return []

    shared_secret = os.getenv("BACKEND_SHARED_SECRET", "").strip()

    if not shared_secret:
        return [metadata_only_page_asset(page) for page in selected_ranges]

    next_base_url = internal_next_base_url()

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{next_base_url}/api/internal/pdf-page-assets",
                headers={
                    "Content-Type": "application/json",
                    "X-Chandra-Internal-Secret": shared_secret,
                },
                json={
                    "maxTotalPages": max_total_pages,
                    "pages": selected_ranges,
                },
            )
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        logger.warning(
            "Internal PDF asset build failed.",
            extra={
                "error": str(error),
                "next_base_url": next_base_url,
                "selected_page_count": len(selected_ranges),
            },
        )
        return [metadata_only_page_asset(page) for page in selected_ranges]

    assets = payload.get("assets") if isinstance(payload, dict) else []
    return assets if isinstance(assets, list) else [metadata_only_page_asset(page) for page in selected_ranges]


def internal_next_base_url() -> str:
    configured_url = os.getenv("NEXT_INTERNAL_BASE_URL") or os.getenv("FRONTEND_ORIGIN")

    if configured_url:
        return configured_url.rstrip("/")

    if os.getenv("CHANDRA_ENV", "").strip().lower() in {"prod", "production"}:
        raise RuntimeError("NEXT_INTERNAL_BASE_URL or FRONTEND_ORIGIN is required for production PDF assets.")

    return "http://127.0.0.1:3000"


def metadata_only_page_asset(page: dict[str, Any]) -> dict[str, Any]:
    page_start = int(page.get("page_start") or 1)
    page_end = int(page.get("page_end") or page_start)

    return {
        "citation_label": citation_label(str(page.get("title") or "Untitled PDF"), page_start, page_end),
        "doc_id": str(page.get("doc_id") or ""),
        "images": [],
        "material_type": str(page.get("material_type") or ""),
        "page_end": page_end,
        "page_start": page_start,
        "printed_page_end": None,
        "printed_page_start": None,
        "score": float(page.get("score") or 0.0),
        "title": str(page.get("title") or "Untitled PDF"),
    }


async def resolve_pdf_sources(selected_ranges: list[dict[str, Any]], *, output_dir: Path) -> dict[str, Path]:
    source_keys = list(dict.fromkeys(str(item["source_pdf_path"]) for item in selected_ranges))
    source_paths = await asyncio.gather(*(resolve_pdf_path(source_key, output_dir=output_dir) for source_key in source_keys))

    return dict(zip(source_keys, source_paths))


async def build_page_asset(item: dict[str, Any], source_pdf: Path, output_dir: Path) -> dict[str, Any]:
    cache_key = page_asset_cache_key(item, source_pdf, output_dir)
    cached = _PAGE_ASSET_CACHE.get(cache_key)
    if cached is not None:
        return copy_page_asset(cached)

    images, printed_page_range = await asyncio.gather(
        asyncio.to_thread(
            render_page_images,
            source_pdf,
            doc_id=item["doc_id"],
            page_start=item["page_start"],
            page_end=item["page_end"],
            output_dir=output_dir,
        ),
        asyncio.to_thread(
            extract_printed_page_range,
            source_pdf,
            page_start=item["page_start"],
            page_end=item["page_end"],
        ),
    )
    printed_page_start, printed_page_end = printed_page_range
    display_page_start = printed_page_start or item["page_start"]
    display_page_end = printed_page_end or item["page_end"]
    asset: dict[str, Any] = {
        "doc_id": item["doc_id"],
        "title": item["title"],
        "page_start": item["page_start"],
        "page_end": item["page_end"],
        "printed_page_start": printed_page_start,
        "printed_page_end": printed_page_end,
        "score": float(item.get("score") or 0.0),
        "material_type": str(item.get("material_type") or ""),
        "images": images,
        "citation_label": citation_label(item["title"], display_page_start, display_page_end),
    }

    if not images:
        mini_pdf = await asyncio.to_thread(
            safe_extract_mini_pdf,
            source_pdf,
            doc_id=item["doc_id"],
            page_start=item["page_start"],
            page_end=item["page_end"],
            output_dir=output_dir,
        )

        if mini_pdf:
            asset["file"] = mini_pdf

    remember_page_asset(cache_key, asset)
    return asset


def page_asset_cache_key(item: dict[str, Any], source_pdf: Path, output_dir: Path) -> tuple[Any, ...]:
    stat = file_signature(source_pdf)
    return (
        str(source_pdf),
        stat,
        str(output_dir),
        str(item.get("doc_id") or ""),
        str(item.get("title") or ""),
        int(item.get("page_start") or 1),
        int(item.get("page_end") or item.get("page_start") or 1),
        float(item.get("score") or 0.0),
        str(item.get("material_type") or ""),
    )


def copy_page_asset(asset: dict[str, Any]) -> dict[str, Any]:
    copied = dict(asset)
    if isinstance(copied.get("images"), list):
        copied["images"] = list(copied["images"])
    return copied


def remember_page_asset(cache_key: tuple[Any, ...], asset: dict[str, Any]) -> None:
    if len(_PAGE_ASSET_CACHE) >= _PAGE_ASSET_CACHE_MAX:
        _PAGE_ASSET_CACHE.pop(next(iter(_PAGE_ASSET_CACHE)))

    _PAGE_ASSET_CACHE[cache_key] = copy_page_asset(asset)


def file_signature(path: Path) -> tuple[int, int]:
    try:
        stat = path.stat()
    except OSError:
        return (0, 0)

    return (stat.st_mtime_ns, stat.st_size)


def deduplicate_page_ranges(
    retrieved_pages: list[dict[str, Any]],
    *,
    max_total_pages: int = MAX_TOTAL_PAGES,
) -> list[dict[str, Any]]:
    """Merge overlapping ranges per source PDF and cap total selected pages."""

    by_source: dict[tuple[str, str], list[dict[str, Any]]] = {}

    for page in retrieved_pages:
        source_pdf_path = str(page.get("source_pdf_path") or "").strip()
        if not source_pdf_path:
            continue

        page_start = int(page.get("page_start") or 1)
        page_end = int(page.get("page_end") or page_start)
        normalized = {
            **page,
            "doc_id": str(page.get("doc_id") or ""),
            "title": str(page.get("title") or "Untitled PDF"),
            "page_start": max(1, min(page_start, page_end)),
            "page_end": max(page_start, page_end),
            "source_pdf_path": source_pdf_path,
        }
        by_source.setdefault((normalized["doc_id"], source_pdf_path), []).append(normalized)

    merged: list[dict[str, Any]] = []

    for (_doc_id, _source), ranges in by_source.items():
        sorted_ranges = sorted(ranges, key=lambda item: (item["page_start"], item["page_end"]))
        current: dict[str, Any] | None = None

        for item in sorted_ranges:
            if current is None:
                current = dict(item)
                continue

            if item["page_start"] <= current["page_end"] + 1:
                current["page_end"] = max(current["page_end"], item["page_end"])
                current["score"] = max(float(current.get("score") or 0.0), float(item.get("score") or 0.0))
                current["chunk_text"] = "\n\n".join(
                    text for text in [current.get("chunk_text"), item.get("chunk_text")] if text
                )
            else:
                merged.append(current)
                current = dict(item)

        if current is not None:
            merged.append(current)

    capped: list[dict[str, Any]] = []
    pages_used = 0

    for item in sorted(merged, key=lambda page: float(page.get("score") or 0.0), reverse=True):
        remaining = max_total_pages - pages_used
        if remaining <= 0:
            break

        page_count = item["page_end"] - item["page_start"] + 1
        if page_count > remaining:
            item = {**item, "page_end": item["page_start"] + remaining - 1}
            page_count = remaining

        capped.append(item)
        pages_used += page_count

    return capped


async def resolve_pdf_path(source_pdf_path: str, *, output_dir: Path) -> Path:
    """Resolve a local path or download a URL to a local cache file."""

    storage_reference = parse_storage_reference(source_pdf_path)
    if storage_reference:
        bucket_name, object_path = storage_reference
        digest = hashlib.sha256(f"{bucket_name}/{object_path}".encode("utf-8")).hexdigest()[:16]
        target = output_dir / f"source_{digest}.pdf"

        if not target.exists():
            await asyncio.to_thread(download_storage_object, bucket_name, object_path, target)

        return target

    if source_pdf_path.startswith(("http://", "https://")):
        digest = hashlib.sha256(source_pdf_path.encode("utf-8")).hexdigest()[:16]
        target = output_dir / f"source_{digest}.pdf"

        if not target.exists():
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(source_pdf_path)
                response.raise_for_status()
                target.write_bytes(response.content)

        return target

    path = Path(source_pdf_path)
    if not path.is_absolute():
        path = Path.cwd() / path

    if not path.exists():
        bucket_name = os.getenv("FIREBASE_STORAGE_BUCKET") or os.getenv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET")

        if bucket_name:
            digest = hashlib.sha256(f"{bucket_name}/{source_pdf_path}".encode("utf-8")).hexdigest()[:16]
            target = output_dir / f"source_{digest}.pdf"

            if not target.exists():
                await asyncio.to_thread(download_storage_object, bucket_name, source_pdf_path, target)

            return target

        raise FileNotFoundError(f"PDF source not found: {source_pdf_path}")

    return path


def parse_storage_reference(source_pdf_path: str) -> tuple[str, str] | None:
    if source_pdf_path.startswith("gs://"):
        bucket_and_path = source_pdf_path.removeprefix("gs://")
        bucket_name, _, object_path = bucket_and_path.partition("/")
        return (bucket_name, object_path) if bucket_name and object_path else None

    parsed = urlparse(source_pdf_path)

    if parsed.scheme in {"http", "https"} and parsed.netloc == "storage.googleapis.com":
        bucket_name, _, object_path = parsed.path.lstrip("/").partition("/")
        return (bucket_name, unquote(object_path)) if bucket_name and object_path else None

    return None


def download_storage_object(bucket_name: str, object_path: str, target: Path) -> None:
    try:
        import firebase_admin
        from firebase_admin import storage
    except ImportError as error:
        raise RuntimeError("Firebase Admin storage support is not installed.") from error

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"storageBucket": bucket_name})

    bucket = storage.bucket(bucket_name)
    bucket.blob(object_path).download_to_filename(target)


def render_page_images(
    source_pdf: Path,
    *,
    doc_id: str,
    page_start: int,
    page_end: int,
    output_dir: Path,
) -> list[str]:
    """Render pages to PNG when pypdfium2 is available."""

    try:
        import pypdfium2
    except ImportError:
        return []

    safe_doc_id = safe_name(doc_id)
    rendered: list[str] = []
    try:
        pdf = pypdfium2.PdfDocument(str(source_pdf))
    except Exception:
        return []

    try:
        for page_number in range(page_start, page_end + 1):
            output_path = output_dir / f"{safe_doc_id}_p{page_number}.png"

            if not output_path.exists():
                try:
                    page = pdf[page_number - 1]
                    bitmap = page.render(scale=2).to_pil()
                    bitmap.save(output_path)
                except Exception:
                    continue

            rendered.append(str(output_path))
    finally:
        pdf.close()

    return rendered


def safe_extract_mini_pdf(
    source_pdf: Path,
    *,
    doc_id: str,
    page_start: int,
    page_end: int,
    output_dir: Path,
) -> str:
    try:
        return extract_mini_pdf(
            source_pdf,
            doc_id=doc_id,
            page_start=page_start,
            page_end=page_end,
            output_dir=output_dir,
        )
    except Exception:
        return ""


def extract_printed_page_range(source_pdf: Path, *, page_start: int, page_end: int) -> tuple[int | None, int | None]:
    page_texts = cached_pdf_page_texts(source_pdf)
    page_count = len(page_texts)
    printed_pages: list[int] = []

    for page_number in range(page_start, min(page_end, page_count) + 1):
        page_text = page_texts[page_number - 1]
        printed_page = extract_printed_page_number_from_text(page_text)

        if printed_page is None:
            return (None, None)

        printed_pages.append(printed_page)

    if not printed_pages:
        return (None, None)

    return (printed_pages[0], printed_pages[-1])


def cached_pdf_page_texts(source_pdf: Path) -> tuple[str, ...]:
    return _cached_pdf_page_texts(str(source_pdf), *file_signature(source_pdf))


@lru_cache(maxsize=64)
def _cached_pdf_page_texts(source_pdf_path: str, _mtime_ns: int, _size: int) -> tuple[str, ...]:
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


def extract_printed_page_number_from_text(text: str) -> int | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    footer_text = "\n".join(lines[-10:])

    for pattern in PRINTED_PAGE_FOOTER_PATTERNS:
        matches = pattern.findall(footer_text)
        if matches:
            return int(matches[-1])

    for line in reversed(lines[-5:]):
        if PRINTED_PAGE_LINE_RE.fullmatch(line):
            return int(line)

    return None


def extract_mini_pdf(
    source_pdf: Path,
    *,
    doc_id: str,
    page_start: int,
    page_end: int,
    output_dir: Path,
) -> str:
    """Create a mini-PDF containing only the selected pages."""

    output_path = output_dir / f"{safe_name(doc_id)}_p{page_start}-{page_end}.pdf"

    if output_path.exists():
        return str(output_path)

    reader = PdfReader(str(source_pdf))
    writer = PdfWriter()
    page_count = len(reader.pages)

    for page_number in range(page_start, min(page_end, page_count) + 1):
        writer.add_page(reader.pages[page_number - 1])

    with output_path.open("wb") as handle:
        writer.write(handle)

    return str(output_path)


def citation_label(title: str, page_start: int, page_end: int) -> str:
    pages = f"page {page_start}" if page_start == page_end else f"pages {page_start}-{page_end}"
    return f"{title}, {pages}"


def safe_name(value: str) -> str:
    normalized = "".join(character if character.isalnum() or character in ("-", "_") else "_" for character in value)
    return normalized or "pdf"
