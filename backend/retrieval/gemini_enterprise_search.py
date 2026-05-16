from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

DISCOVERY_ENGINE_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
DEFAULT_COLLECTION_ID = "default_collection"
DEFAULT_SERVING_CONFIG_ID = "default_search"
SEARCH_API_VERSION = "v1beta"
SEARCHABLE_CHUNK_TYPES = {
    "caption",
    "definition",
    "example",
    "formula",
    "paragraph",
    "section",
    "table",
}


class GeminiEnterpriseTransport(Protocol):
    async def post_search(self, *, url: str, token: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        ...


@dataclass(frozen=True)
class GeminiEnterpriseSearchConfig:
    enabled: bool
    project_id: str
    location: str
    collection_id: str
    data_store_id: str
    serving_config_id: str

    @property
    def is_configured(self) -> bool:
        return bool(
            self.enabled
            and self.project_id
            and self.location
            and self.collection_id
            and self.data_store_id
            and self.serving_config_id
        )

    @property
    def api_endpoint(self) -> str:
        return (
            "https://discoveryengine.googleapis.com"
            if self.location == "global"
            else f"https://{self.location}-discoveryengine.googleapis.com"
        )

    @property
    def serving_config_path(self) -> str:
        return (
            f"projects/{self.project_id}/locations/{self.location}/collections/{self.collection_id}"
            f"/dataStores/{self.data_store_id}/servingConfigs/{self.serving_config_id}"
        )

    @property
    def search_url(self) -> str:
        return f"{self.api_endpoint}/{SEARCH_API_VERSION}/{self.serving_config_path}:search"


class HttpxGeminiEnterpriseTransport:
    async def post_search(self, *, url: str, token: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, dict) else {}


class GeminiEnterpriseSearchClient:
    def __init__(
        self,
        *,
        config: GeminiEnterpriseSearchConfig | None = None,
        transport: GeminiEnterpriseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.config = config or gemini_enterprise_search_config_from_env()
        self.transport = transport or HttpxGeminiEnterpriseTransport()
        self.timeout = timeout

    async def search(
        self,
        *,
        query: str,
        top_k: int,
        class_id: str,
        professor_id: str,
        intent: str,
        active_material_id: str | None = None,
        active_page_number: int | None = None,
        active_page_before: int | None = None,
        preferred_chunk_types: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        if not self.config.is_configured:
            return []

        filter_expression = build_course_material_filter(
            class_id=class_id,
            professor_id=professor_id,
            active_material_id=active_material_id,
            active_page_number=active_page_number,
            active_page_before=active_page_before,
            preferred_chunk_types=preferred_chunk_types,
        )
        payload = {
            "servingConfig": self.config.serving_config_path,
            "query": query,
            "pageSize": max(1, min(int(top_k or 5), 20)),
            "filter": filter_expression,
            "contentSearchSpec": {
                "searchResultMode": "CHUNKS",
                "chunkSpec": {
                    "numPreviousChunks": 1,
                    "numNextChunks": 1,
                },
                "snippetSpec": {"returnSnippet": True},
            },
        }

        try:
            token = await asyncio.to_thread(discovery_engine_access_token)
            response = await self.transport.post_search(
                url=self.config.search_url,
                token=token,
                payload=payload,
                timeout=self.timeout,
            )
        except Exception as error:
            logger.warning(
                "Gemini Enterprise Search failed; falling back to PostgreSQL OCR retrieval.",
                extra={
                    "class_id": class_id,
                    "data_store_id": self.config.data_store_id,
                    "error": str(error),
                    "intent": intent,
                    "professor_id": professor_id,
                },
            )
            return []

        return [
            normalize_gemini_enterprise_result(result, intent=intent, rank=rank)
            for rank, result in enumerate(response.get("results", []), start=1)
            if isinstance(result, dict)
        ]


def gemini_enterprise_search_config_from_env() -> GeminiEnterpriseSearchConfig:
    enabled_value = str(os.getenv("GEMINI_ENTERPRISE_SEARCH_ENABLED") or "").strip().lower()
    return GeminiEnterpriseSearchConfig(
        enabled=enabled_value not in {"0", "false", "no", "off"},
        project_id=(os.getenv("GEMINI_ENTERPRISE_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip(),
        location=(os.getenv("GEMINI_ENTERPRISE_LOCATION") or os.getenv("GOOGLE_CLOUD_LOCATION") or "global").strip(),
        collection_id=(os.getenv("GEMINI_ENTERPRISE_COLLECTION_ID") or DEFAULT_COLLECTION_ID).strip(),
        data_store_id=(os.getenv("GEMINI_ENTERPRISE_DATA_STORE_ID") or "").strip(),
        serving_config_id=(os.getenv("GEMINI_ENTERPRISE_SERVING_CONFIG_ID") or DEFAULT_SERVING_CONFIG_ID).strip(),
    )


def discovery_engine_access_token() -> str:
    try:
        import google.auth
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError as error:
        raise RuntimeError("google-auth is required for Gemini Enterprise Search.") from error

    credentials_json = (
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
        or os.getenv("GEMINI_ENTERPRISE_SERVICE_ACCOUNT_JSON")
        or os.getenv("FIREBASE_SERVICE_ACCOUNT_KEY")
    )
    if credentials_json:
        credentials = service_account.Credentials.from_service_account_info(
            json.loads(credentials_json),
            scopes=[DISCOVERY_ENGINE_SCOPE],
        )
    else:
        credentials, _project_id = google.auth.default(scopes=[DISCOVERY_ENGINE_SCOPE])

    credentials.refresh(Request())
    token = str(getattr(credentials, "token", "") or "")
    if not token:
        raise RuntimeError("Google Application Default Credentials did not return an access token.")
    return token


def build_course_material_filter(
    *,
    class_id: str,
    professor_id: str,
    active_material_id: str | None = None,
    active_page_number: int | None = None,
    active_page_before: int | None = None,
    preferred_chunk_types: list[str] | None = None,
) -> str:
    filters = [
        text_any_filter("class_id", class_id),
        f"({text_any_filter('teacher_id', professor_id)} OR {text_any_filter('professor_id', professor_id)})",
        'active_for_students = "true"',
        'teacher_only = "false"',
        text_any_filter("source_table", "pdf_pages"),
    ]
    filters = [part for part in filters if part]

    chunk_types = [
        chunk_type
        for chunk_type in (preferred_chunk_types or [])
        if chunk_type in SEARCHABLE_CHUNK_TYPES
    ]
    if chunk_types:
        filters.append(
            "chunk_type: ANY("
            + ", ".join(json.dumps(chunk_type, ensure_ascii=True) for chunk_type in sorted(set(chunk_types)))
            + ")"
        )

    if active_material_id and active_page_before:
        filters.append(
            "("
            f"{text_any_filter('material_id', active_material_id)} "
            f"AND page_number < {int(active_page_before)}"
            ")"
        )
    elif active_material_id and active_page_number:
        filters.append(
            "NOT ("
            f"{text_any_filter('material_id', active_material_id)} "
            f"AND page_number = {int(active_page_number)}"
            ")"
        )

    return " AND ".join(filters)


def text_any_filter(field: str, value: str | None) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    return f"{field}: ANY({json.dumps(normalized, ensure_ascii=True)})"


def normalize_gemini_enterprise_result(result: dict[str, Any], *, intent: str, rank: int | None = None) -> dict[str, Any]:
    document = result.get("document") if isinstance(result.get("document"), dict) else {}
    chunk = result.get("chunk") if isinstance(result.get("chunk"), dict) else {}
    chunk_document_metadata = (
        chunk.get("documentMetadata") if isinstance(chunk.get("documentMetadata"), dict) else {}
    )
    struct_data = document.get("structData") if isinstance(document.get("structData"), dict) else {}
    document_metadata_struct_data = (
        chunk_document_metadata.get("structData")
        if isinstance(chunk_document_metadata.get("structData"), dict)
        else {}
    )
    chunk_struct_data = chunk.get("structData") if isinstance(chunk.get("structData"), dict) else {}
    struct_data = {**struct_data, **document_metadata_struct_data, **chunk_struct_data}
    derived = document.get("derivedStructData") if isinstance(document.get("derivedStructData"), dict) else {}
    chunk_derived = chunk.get("derivedStructData") if isinstance(chunk.get("derivedStructData"), dict) else {}
    if chunk_derived:
        derived = {**derived, **chunk_derived}
    page_span = chunk.get("pageSpan") if isinstance(chunk.get("pageSpan"), dict) else {}
    snippets = derived.get("snippets") if isinstance(derived.get("snippets"), list) else []
    extractive_answers = (
        derived.get("extractive_answers")
        if isinstance(derived.get("extractive_answers"), list)
        else derived.get("extractiveAnswers")
        if isinstance(derived.get("extractiveAnswers"), list)
        else []
    )
    extractive_segments = (
        derived.get("extractive_segments")
        if isinstance(derived.get("extractive_segments"), list)
        else derived.get("extractiveSegments")
        if isinstance(derived.get("extractiveSegments"), list)
        else []
    )
    first_answer = next((answer for answer in extractive_answers if isinstance(answer, dict)), {})
    first_segment = next((segment for segment in extractive_segments if isinstance(segment, dict)), {})
    first_snippet = next((snippet for snippet in snippets if isinstance(snippet, dict)), {})
    content = (
        first_answer.get("content")
        or first_segment.get("content")
        or first_snippet.get("snippet")
        or first_snippet.get("htmlSnippet")
        or chunk.get("content")
        or chunk.get("text")
        or struct_data.get("content")
        or struct_data.get("text")
        or ""
    )
    page_start, page_end = normalize_result_page_range(
        struct_data=struct_data,
        page_span=page_span,
        first_answer=first_answer,
        first_segment=first_segment,
    )
    material_id = str(
        struct_data.get("material_id")
        or struct_data.get("materialId")
        or struct_data.get("doc_id")
        or document.get("id")
        or chunk.get("documentId")
        or chunk_document_metadata.get("document")
        or document_id_from_chunk_name(chunk.get("name"))
        or result.get("id")
        or ""
    )
    title = str(
        struct_data.get("title")
        or chunk_document_metadata.get("title")
        or derived.get("title")
        or document.get("id")
        or "Class material"
    )

    model_scores = result.get("modelScores") if isinstance(result.get("modelScores"), dict) else {}
    relevance_score = model_scores.get("relevance_score") if isinstance(model_scores.get("relevance_score"), dict) else {}
    score_values = relevance_score.get("values") if isinstance(relevance_score.get("values"), list) else []

    return {
        "class_id": str(struct_data.get("class_id") or struct_data.get("classId") or ""),
        "chunk_text": strip_html(str(content or "")),
        "chunk_type": str(struct_data.get("chunk_type") or struct_data.get("chunkType") or ""),
        "doc_id": material_id,
        "gemini_chunk_id": str(
            struct_data.get("gemini_chunk_id")
            or chunk.get("id")
            or chunk.get("name")
            or result.get("id")
            or document.get("id")
            or ""
        ),
        "gemini_document_id": str(document.get("id") or document_id_from_chunk_name(chunk.get("name")) or result.get("id") or ""),
        "gemini_rank": rank,
        "layout_json": struct_data.get("layout_json") or struct_data.get("layoutJson"),
        "material_id": material_id,
        "material_type": str(struct_data.get("material_type") or struct_data.get("materialType") or ""),
        "next_chunk_id": str(struct_data.get("next_chunk_id") or struct_data.get("nextChunkId") or ""),
        "ocr_text": strip_html(str(content or "")),
        "page_end": page_end,
        "page_number": page_start,
        "page_start": page_start,
        "parent_chunk_id": str(struct_data.get("parent_chunk_id") or struct_data.get("parentChunkId") or ""),
        "previous_chunk_id": str(struct_data.get("previous_chunk_id") or struct_data.get("previousChunkId") or ""),
        "problem_numbers": normalize_problem_numbers(struct_data.get("problem_numbers") or struct_data.get("problemNumbers")),
        "professor_id": str(struct_data.get("professor_id") or struct_data.get("teacher_id") or ""),
        "retrieval_mode": "gemini_enterprise",
        "retrieval_reason": broad_retrieval_reason(intent),
        "score": read_float(score_values[0] if score_values else result.get("score"), 0.0),
        "section": str(struct_data.get("section") or struct_data.get("section_title") or struct_data.get("sectionTitle") or ""),
        "source_title": title,
        "title": title,
    }


def broad_retrieval_reason(intent: str) -> str:
    normalized = str(intent or "").strip()
    return normalized or "needed_example_page"


def normalize_problem_numbers(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def normalize_result_page_range(
    *,
    struct_data: dict[str, Any],
    page_span: dict[str, Any],
    first_answer: dict[str, Any],
    first_segment: dict[str, Any],
) -> tuple[int, int]:
    document_page_start = read_positive_int(
        struct_data.get("page_start")
        or struct_data.get("pageStart")
        or struct_data.get("page_number")
        or struct_data.get("pageNumber")
    )
    span_start = read_positive_int(page_span.get("pageStart") or page_span.get("page_start"))
    span_end = read_positive_int(page_span.get("pageEnd") or page_span.get("page_end"))

    if span_start:
        offset = (document_page_start or 1) - 1
        page_start = max(1, offset + span_start)
        page_end = max(page_start, offset + (span_end or span_start))
        return page_start, page_end

    page_start = (
        read_positive_int(first_answer.get("pageNumber") or first_answer.get("page_number"))
        or read_positive_int(first_segment.get("pageNumber") or first_segment.get("page_number"))
        or document_page_start
        or 1
    )
    page_end = (
        read_positive_int(struct_data.get("page_end") or struct_data.get("pageEnd"))
        if not first_answer and not first_segment
        else None
    )

    return page_start, max(page_start, page_end or page_start)


def read_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def read_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def read_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def strip_html(value: str) -> str:
    return re.sub(r"<[^>]+>", "", value).strip()


def document_id_from_chunk_name(value: Any) -> str:
    match = re.search(r"/documents/([^/]+)/chunks/", str(value or ""))
    return match.group(1) if match else ""


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
