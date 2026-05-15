from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Literal

from typing_extensions import NotRequired, TypedDict


KnowledgeKind = Literal["problem", "pdf_page", "student_upload"]
KnowledgeUse = Literal[
    "active_problem",
    "problem_source",
    "supporting_context",
    "definition_reference",
    "theorem_reference",
    "example_reference",
    "student_attempt",
]
KnowledgeUiColorToken = Literal["blue", "neutral", "purple", "green", "orange"]


class KnowledgeItem(TypedDict):
    id: str
    chatId: str
    kind: KnowledgeKind
    sourceName: str
    usedAs: KnowledgeUse
    reason: str
    createdAt: str
    updatedAt: str
    assignmentId: NotRequired[str]
    classId: NotRequired[str]
    sourceId: NotRequired[str]
    fileType: NotRequired[str]
    pdfId: NotRequired[str]
    page: NotRequired[int]
    problemId: NotRequired[str]
    content: NotRequired[str]
    ocrText: NotRequired[str]
    summary: NotRequired[str]
    linkedProblemId: NotRequired[str]


class LlmKnowledgeContextPackage(TypedDict):
    latestStudentMessage: str
    teacherPolicy: dict[str, Any]
    activeProblemText: str
    knowledge: list[dict[str, Any]]
    chatMemory: dict[str, Any]
    studentUploads: list[dict[str, Any]]


KNOWLEDGE_UI_COLOR_BY_USED_AS: dict[KnowledgeUse, KnowledgeUiColorToken] = {
    "active_problem": "blue",
    "problem_source": "blue",
    "supporting_context": "neutral",
    "definition_reference": "purple",
    "theorem_reference": "purple",
    "example_reference": "green",
    "student_attempt": "orange",
}

MAX_KNOWLEDGE_TEXT_CHARS = 6000
MAX_ACTIVE_PROBLEM_CHARS = 2000
MAX_STUDENT_UPLOAD_TEXT_CHARS = 3000
MAX_CHAT_MEMORY_ITEM_CHARS = 420
RAW_INTERNAL_KEY_RE = re.compile(r"(?:^|_)(?:storage|bucket|path|uri|url|chunk|firebase|gcs|data_url|dataUrl)", re.I)
WHITESPACE_RUN_RE = re.compile(r"[ \t]+")
BLANK_LINE_RUN_RE = re.compile(r"\n{3,}")
CAMEL_TO_SNAKE_RE = re.compile(r"(?<!^)([A-Z])")
PDF_EXAMPLE_RE = re.compile(r"\bexample|worked\s+example\b")
PDF_THEOREM_RE = re.compile(r"\btheorem|lemma|proposition|corollary\b")
PDF_DEFINITION_RE = re.compile(r"\bdefinition|defined\s+as|terminology\b")
PDF_PROBLEM_RE = re.compile(r"\bexact_problem|student_requested_problem|problem\s+\d")
PROBLEM_NUMBER_RE = re.compile(r"\b(?:problem|exercise|question|ex\.?|q)\s*#?\s*(\d{1,3}(?:\.\d{1,3})?[a-z]?)\b", re.I)
ATTEMPT_MARKER_RE = re.compile(
    r"\b(?:i\s+(?:tried|used|got|think|started|wrote|did)|my\s+work|here(?:'s| is)\s+my|is\s+this\s+(?:right|correct)|check\s+my)\b",
    re.I,
)
OPTIONAL_IDENTITY_KEY_PAIRS = (
    ("classId", "class_id", "classId"),
    ("assignmentId", "assignment_id", "assignmentId"),
    ("sourceId", "source_id", "sourceId"),
    ("pdfId", "pdf_id", "pdfId"),
    ("problemId", "problem_id", "problemId"),
    ("linkedProblemId", "linked_problem_id", "linkedProblemId"),
)


def knowledge_ui_color_token(used_as: str) -> KnowledgeUiColorToken:
    return KNOWLEDGE_UI_COLOR_BY_USED_AS.get(normalize_knowledge_use(used_as), "neutral")


def normalize_knowledge_use(value: Any) -> KnowledgeUse:
    used_as = str(value or "").strip()
    if used_as in KNOWLEDGE_UI_COLOR_BY_USED_AS:
        return used_as  # type: ignore[return-value]
    return "supporting_context"


def normalize_knowledge_kind(value: Any) -> KnowledgeKind:
    kind = str(value or "").strip()
    if kind in {"problem", "pdf_page", "student_upload"}:
        return kind  # type: ignore[return-value]
    return "pdf_page"


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_knowledge_id(*parts: Any) -> str:
    raw = "|".join(str(part or "") for part in parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
    return f"knowledge_{digest}"


def compact_text(value: Any, *, limit: int = MAX_KNOWLEDGE_TEXT_CHARS) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = WHITESPACE_RUN_RE.sub(" ", text)
    normalized = BLANK_LINE_RUN_RE.sub("\n\n", normalized).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit].rsplit(" ", 1)[0].strip()


def latest_student_message(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") in {"user", "student"}:
            return compact_text(message.get("content"), limit=4000)
    return ""


def problem_request_reason(messages: list[dict[str, Any]]) -> str:
    latest = latest_student_message(messages)
    if latest:
        return f"Student asked: {compact_text(latest, limit=160)}"
    return "Student asked for help in this chat."


def first_problem_number_from_text(text: str) -> str | None:
    match = PROBLEM_NUMBER_RE.search(text or "")
    return match.group(1) if match else None


def infer_pdf_page_used_as(page: dict[str, Any], *, reason: str = "") -> KnowledgeUse:
    explicit = normalize_knowledge_use(page.get("used_as") or page.get("usedAs"))
    if explicit != "supporting_context":
        return explicit

    haystack = " ".join(
        str(value or "")
        for value in (
            reason,
            page.get("retrieval_reason"),
            page.get("retrievalReason"),
            page.get("retrieval_mode"),
            page.get("retrievalMode"),
            page.get("material_type"),
            page.get("materialType"),
            page.get("title"),
            page.get("ocr_text"),
            page.get("ocrText"),
            page.get("chunk_text"),
            page.get("chunkText"),
        )
    ).lower()

    if PDF_EXAMPLE_RE.search(haystack):
        return "example_reference"
    if PDF_THEOREM_RE.search(haystack):
        return "theorem_reference"
    if PDF_DEFINITION_RE.search(haystack):
        return "definition_reference"
    if (
        page.get("problem_numbers")
        or page.get("problemNumbers")
        or PDF_PROBLEM_RE.search(haystack)
    ):
        return "problem_source"

    return "supporting_context"


def active_problem_knowledge_item(
    *,
    problem_text: str,
    state: dict[str, Any],
    reason: str | None = None,
    source_name: str | None = None,
    source_id: str | None = None,
    page: int | None = None,
    problem_id: str | None = None,
) -> KnowledgeItem | None:
    content = compact_text(problem_text, limit=MAX_ACTIVE_PROBLEM_CHARS)
    if not content:
        return None

    chat_id = str(state.get("conversation_id") or state.get("chatId") or "").strip()
    now = utc_timestamp()
    normalized_problem_id = problem_id or stable_knowledge_id(chat_id, "active_problem", content)
    item: KnowledgeItem = {
        "id": stable_knowledge_id(chat_id, "problem", normalized_problem_id, content),
        "chatId": chat_id,
        "kind": "problem",
        "sourceName": compact_text(source_name or "Active problem", limit=180),
        "usedAs": "active_problem",
        "reason": reason or problem_request_reason(state.get("messages", [])),
        "problemId": normalized_problem_id,
        "content": content,
        "createdAt": now,
        "updatedAt": now,
    }
    add_optional_identity_fields(item, state)
    if source_id:
        item["sourceId"] = str(source_id)
        item["pdfId"] = str(source_id)
    if page:
        item["page"] = page
    return item


def pdf_page_knowledge_item(page: dict[str, Any], state: dict[str, Any], *, reason: str | None = None) -> KnowledgeItem | None:
    ocr_text = compact_text(page.get("ocr_text") or page.get("ocrText") or page.get("chunk_text") or page.get("chunkText"))
    if not ocr_text:
        return None

    chat_id = str(state.get("conversation_id") or state.get("chatId") or "").strip()
    doc_id = str(page.get("doc_id") or page.get("docId") or page.get("material_id") or page.get("materialId") or "").strip()
    page_number = first_positive_int(
        page.get("printed_page_start"),
        page.get("printedPageStart"),
        page.get("page_start"),
        page.get("pageStart"),
        page.get("pageNumber"),
    )
    used_as = infer_pdf_page_used_as(page, reason=reason or "")
    now = utc_timestamp()
    item: KnowledgeItem = {
        "id": stable_knowledge_id(chat_id, "pdf_page", doc_id, page_number, used_as, ocr_text[:200]),
        "chatId": chat_id,
        "kind": "pdf_page",
        "sourceName": compact_text(page.get("title") or "PDF page", limit=180),
        "usedAs": used_as,
        "reason": reason or knowledge_reason_for_pdf_page(page, state),
        "ocrText": ocr_text,
        "createdAt": now,
        "updatedAt": now,
    }
    add_optional_identity_fields(item, state)
    if doc_id:
        item["sourceId"] = doc_id
        item["pdfId"] = doc_id
    if page_number:
        item["page"] = page_number
    problem_numbers = page.get("problem_numbers") or page.get("problemNumbers") or []
    if isinstance(problem_numbers, list) and problem_numbers:
        item["problemId"] = str(problem_numbers[0])
    return item


def student_upload_source_knowledge_item(
    upload: dict[str, Any],
    state: dict[str, Any],
    *,
    linked_problem_id: str | None = None,
    reason: str | None = None,
) -> KnowledgeItem | None:
    text = compact_text(
        upload.get("ocrText")
        or upload.get("ocr_text")
        or upload.get("extractedText")
        or upload.get("extracted_text"),
        limit=MAX_STUDENT_UPLOAD_TEXT_CHARS,
    )
    summary = compact_text(upload.get("summary") or upload.get("description"), limit=700)
    file_name = compact_text(upload.get("fileName") or upload.get("file_name") or "Student upload", limit=180)
    file_type = str(upload.get("fileType") or upload.get("file_type") or "").strip().lower()
    mime_type = str(upload.get("mimeType") or upload.get("mime_type") or "").strip().lower()
    if not summary and (file_name or file_type or mime_type):
        type_label = "image" if file_type == "image" or mime_type.startswith("image/") else "file"
        summary = f"Student uploaded {type_label}: {file_name or 'homework file'}."
    if not text and not summary:
        return None

    chat_id = str(state.get("conversation_id") or state.get("chatId") or "").strip()
    source_id = str(upload.get("id") or upload.get("attachmentId") or upload.get("attachment_id") or "").strip()
    used_as = infer_student_upload_used_as(upload, state, text=text, summary=summary)
    now = utc_timestamp()
    item: KnowledgeItem = {
        "id": stable_knowledge_id(chat_id, "student_upload", source_id, text[:200], summary),
        "chatId": chat_id,
        "kind": "student_upload",
        "sourceName": file_name or "Student upload",
        "sourceId": source_id or stable_knowledge_id(chat_id, "student_upload_source", text[:120], summary),
        "usedAs": used_as,
        "reason": reason or student_upload_reason(used_as),
        "createdAt": now,
        "updatedAt": now,
    }
    add_optional_identity_fields(item, state)
    if file_type in {"image", "pdf"}:
        item["fileType"] = file_type
    if text:
        item["ocrText"] = text
    if summary:
        item["summary"] = summary
    if linked_problem_id:
        item["linkedProblemId"] = linked_problem_id
    return item


def infer_student_upload_used_as(upload: dict[str, Any], state: dict[str, Any], *, text: str, summary: str) -> KnowledgeUse:
    explicit = normalize_knowledge_use(upload.get("usedAs") or upload.get("used_as"))
    if explicit != "supporting_context":
        return explicit

    latest = latest_student_message(state.get("messages", []))
    haystack = " ".join([latest, text, summary]).lower()
    if ATTEMPT_MARKER_RE.search(haystack) or "student message mode: show my work" in haystack:
        return "student_attempt"
    return "supporting_context"


def student_upload_reason(used_as: KnowledgeUse) -> str:
    if used_as == "student_attempt":
        return "Student uploaded work for the active problem."
    if used_as == "problem_source":
        return "Student uploaded problem or source context for this chat."
    return "Student uploaded supporting context for this chat."


def knowledge_reason_for_pdf_page(page: dict[str, Any], state: dict[str, Any]) -> str:
    retrieval_reason = str(page.get("retrieval_reason") or page.get("retrievalReason") or "").strip()
    latest_reason = problem_request_reason(state.get("messages", []))
    if retrieval_reason == "student_requested_problem":
        return latest_reason
    if retrieval_reason == "needed_example_page":
        return "Chandra used this page as an example reference."
    if retrieval_reason == "needed_supporting_page":
        return "Chandra used this page as supporting source context."
    return latest_reason


def add_optional_identity_fields(item: KnowledgeItem, state: dict[str, Any]) -> None:
    class_id = str(state.get("class_id") or state.get("classId") or "").strip()
    assignment_id = str(state.get("assignment_id") or state.get("assignmentId") or "").strip()
    if class_id:
        item["classId"] = class_id
    if assignment_id:
        item["assignmentId"] = assignment_id


def first_positive_int(*values: Any) -> int | None:
    for value in values:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return None


def merge_knowledge_items(*groups: list[KnowledgeItem]) -> list[KnowledgeItem]:
    merged: list[KnowledgeItem] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            normalized = normalize_knowledge_item(item)
            if not normalized:
                continue
            key = str(normalized.get("id") or "") or knowledge_dedupe_key(normalized)
            if key in seen:
                continue
            seen.add(key)
            merged.append(normalized)
    return merged[:12]


def knowledge_dedupe_key(item: KnowledgeItem) -> str:
    return "|".join(
        str(item.get(key) or "").lower()
        for key in ("chatId", "kind", "sourceId", "pdfId", "page", "problemId", "usedAs", "content", "ocrText", "summary")
    )


def normalize_knowledge_item(value: Any) -> KnowledgeItem | None:
    if not isinstance(value, dict):
        return None

    chat_id = str(value.get("chatId") or value.get("chat_id") or "").strip()
    kind = normalize_knowledge_kind(value.get("kind"))
    used_as = normalize_knowledge_use(value.get("usedAs") or value.get("used_as"))
    source_name = compact_text(value.get("sourceName") or value.get("source_name") or "Source", limit=180)
    now = utc_timestamp()
    item: KnowledgeItem = {
        "id": str(value.get("id") or stable_knowledge_id(chat_id, kind, source_name, used_as)),
        "chatId": chat_id,
        "kind": kind,
        "sourceName": source_name,
        "usedAs": used_as,
        "reason": compact_text(value.get("reason") or "Chandra used this source.", limit=260),
        "createdAt": str(value.get("createdAt") or value.get("created_at") or now),
        "updatedAt": str(value.get("updatedAt") or value.get("updated_at") or now),
    }

    for camel_key, snake_key, target_key in OPTIONAL_IDENTITY_KEY_PAIRS:
        raw = value.get(camel_key) or value.get(snake_key)
        if raw:
            item[target_key] = str(raw)  # type: ignore[literal-required]

    file_type = str(value.get("fileType") or value.get("file_type") or "").strip().lower()
    if file_type in {"image", "pdf"}:
        item["fileType"] = file_type

    page = first_positive_int(value.get("page"))
    if page:
        item["page"] = page

    content = compact_text(value.get("content"), limit=MAX_ACTIVE_PROBLEM_CHARS)
    ocr_text = compact_text(value.get("ocrText") or value.get("ocr_text"))
    summary = compact_text(value.get("summary"), limit=700)
    if content:
        item["content"] = content
    if ocr_text:
        item["ocrText"] = ocr_text
    if summary:
        item["summary"] = summary

    if not item.get("content") and not item.get("ocrText") and not item.get("summary"):
        return None
    return item


def to_snake_case(value: str) -> str:
    return CAMEL_TO_SNAKE_RE.sub(r"_\1", value).lower()


def knowledge_items_from_state(
    state: dict[str, Any],
    *,
    active_problem_text: str = "",
    source_name: str = "",
    previous_items: list[Any] | None = None,
) -> list[KnowledgeItem]:
    items: list[KnowledgeItem] = []
    previous = [item for item in (normalize_knowledge_item(value) for value in previous_items or []) if item]
    page_assets = state.get("used_page_assets") or state.get("page_assets", []) or []
    student_uploads = state.get("student_attachment_files", []) or []
    primary_page = first_page_asset_from_pages(page_assets)
    resolved_active_problem_text = active_problem_text

    if resolved_active_problem_text:
        previous_active = matching_previous_active_problem(
            previous,
            problem_text=resolved_active_problem_text,
            problem_id=first_problem_id(primary_page or {}) or first_problem_number_from_text(resolved_active_problem_text),
        )
        active_source_name = source_name or str((primary_page or {}).get("title") or "")
        if not active_source_name and previous_active:
            active_source_name = str(previous_active.get("sourceName") or "")
        if not active_source_name and active_problem_text and not primary_page:
            active_source_name = "Active problem"
        source_id = str((primary_page or {}).get("doc_id") or "") or str((previous_active or {}).get("sourceId") or "")
        page = first_positive_int(
            (primary_page or {}).get("printed_page_start"),
            (primary_page or {}).get("page_start"),
        ) or first_positive_int((previous_active or {}).get("page"))
        problem_id = (
            first_problem_id(primary_page or {})
            or first_problem_number_from_text(resolved_active_problem_text)
            or str((previous_active or {}).get("problemId") or "")
            or None
        )
        active = active_problem_knowledge_item(
            problem_text=resolved_active_problem_text,
            state=state,
            reason=None,
            source_name=active_source_name or "Active problem",
            source_id=source_id,
            page=page,
            problem_id=problem_id,
        )
        if active:
            if previous_active and not primary_page and not source_name:
                active["id"] = previous_active["id"]
                active["createdAt"] = previous_active.get("createdAt", active["createdAt"])
            items.append(active)

    for page in page_assets:
        if isinstance(page, dict):
            item = pdf_page_knowledge_item(page, state)
            if item:
                items.append(item)

    linked_problem_id = first_problem_id(primary_page or {}) or first_problem_number_from_text(resolved_active_problem_text)
    for upload in student_uploads:
        if isinstance(upload, dict):
            item = student_upload_source_knowledge_item(upload, state, linked_problem_id=linked_problem_id)
            if item:
                items.append(item)

    return merge_knowledge_items(items, previous)


def matching_previous_active_problem(
    previous: list[KnowledgeItem],
    *,
    problem_text: str,
    problem_id: str | None = None,
) -> KnowledgeItem | None:
    normalized_problem_id = str(problem_id or "").strip().lower()
    normalized_text = comparable_problem_text(problem_text)

    for item in previous:
        if item.get("kind") != "problem" or item.get("usedAs") != "active_problem":
            continue

        item_problem_id = str(item.get("problemId") or "").strip().lower()
        if normalized_problem_id and item_problem_id == normalized_problem_id:
            return item

        if normalized_text and comparable_problem_text(item.get("content") or "") == normalized_text:
            return item

    return None


def comparable_problem_text(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()[:500]


def first_page_asset(state: dict[str, Any]) -> dict[str, Any] | None:
    return first_page_asset_from_pages(state.get("page_assets", []) or [])


def first_page_asset_from_pages(pages: list[Any]) -> dict[str, Any] | None:
    for page in pages:
        if isinstance(page, dict):
            return page
    return None


def first_problem_id(page: dict[str, Any]) -> str | None:
    problem_numbers = page.get("problem_numbers") or page.get("problemNumbers") or []
    if isinstance(problem_numbers, list) and problem_numbers:
        return str(problem_numbers[0])
    problem_id = page.get("problem_id") or page.get("problemId")
    return str(problem_id) if problem_id else None


def build_llm_knowledge_context_package(state: dict[str, Any]) -> LlmKnowledgeContextPackage:
    knowledge_items = [
        item for item in (normalize_knowledge_item(value) for value in state.get("knowledge_items", []) or []) if item
    ]
    if not knowledge_items:
        knowledge_items = knowledge_items_from_state(
            state,
            previous_items=(state.get("chat_retrieval_memory") or {}).get("knowledge_items", []),
        )

    safe_items = [llm_safe_knowledge_item(item) for item in knowledge_items]
    active_problem_text = active_problem_text_from_items(knowledge_items) or active_problem_text_from_memory(state)
    package: LlmKnowledgeContextPackage = {
        "latestStudentMessage": latest_student_message(state.get("messages", [])),
        "teacherPolicy": {
            "answerPolicy": sanitized_mapping(state.get("answer_policy") or {}),
            "sourceUsage": sanitized_mapping(state.get("source_usage") or {}),
            "helpLevel": "attempt_first"
            if (state.get("answer_policy") or {}).get("refuseAnswerOnlyRequests") is not False
            else "explain_with_reasoning",
        },
        "activeProblemText": compact_text(active_problem_text, limit=MAX_ACTIVE_PROBLEM_CHARS),
        "knowledge": safe_items,
        "chatMemory": {
            "hintsAlreadyGiven": recent_assistant_hints(state.get("messages", [])),
            "retrievalReasons": recent_retrieval_reasons(state.get("chat_retrieval_memory") or {}),
        },
        "studentUploads": [item for item in safe_items if item.get("kind") == "student_upload"],
    }
    return package


def active_problem_text_from_items(items: list[KnowledgeItem]) -> str:
    for item in items:
        if item.get("usedAs") == "active_problem" and item.get("content"):
            return str(item.get("content") or "")
    return ""


def active_problem_text_from_memory(state: dict[str, Any]) -> str:
    context = state.get("active_problem_context")
    if isinstance(context, dict):
        return compact_text(context.get("problem_text") or context.get("problem") or "", limit=MAX_ACTIVE_PROBLEM_CHARS)

    memory = state.get("chat_retrieval_memory")
    if isinstance(memory, dict) and isinstance(memory.get("active_problem"), dict):
        return compact_text(memory["active_problem"].get("text") or "", limit=MAX_ACTIVE_PROBLEM_CHARS)
    return ""


def recent_assistant_hints(messages: list[dict[str, Any]]) -> list[str]:
    hints: list[str] = []
    for message in reversed(messages):
        if len(hints) >= 3:
            break
        if message.get("role") not in {"assistant", "system"}:
            continue
        content = compact_text(message.get("content"), limit=MAX_CHAT_MEMORY_ITEM_CHARS)
        if content:
            hints.append(content)
    return list(reversed(hints))


def recent_retrieval_reasons(memory: dict[str, Any]) -> list[dict[str, Any]]:
    reasons: list[dict[str, Any]] = []
    for item in (memory.get("reason_history") or [])[-4:]:
        if not isinstance(item, dict):
            continue
        reason = compact_text(item.get("retrieval_reason"), limit=80)
        if reason:
            reasons.append({"retrievalReason": reason, "memoryUsed": bool(item.get("memory_used"))})
    return reasons


def llm_safe_knowledge_item(item: KnowledgeItem) -> dict[str, Any]:
    allowed: dict[str, Any] = {
        "id": item.get("id"),
        "kind": item.get("kind"),
        "sourceName": item.get("sourceName"),
        "sourceId": item.get("sourceId"),
        "pdfId": item.get("pdfId"),
        "page": item.get("page"),
        "problemId": item.get("problemId"),
        "usedAs": item.get("usedAs"),
        "uiColor": knowledge_ui_color_token(str(item.get("usedAs") or "")),
        "reason": item.get("reason"),
        "linkedProblemId": item.get("linkedProblemId"),
        "content": item.get("content"),
        "ocrText": item.get("ocrText"),
        "summary": item.get("summary"),
    }
    return {key: value for key, value in allowed.items() if value not in (None, "", []) and not RAW_INTERNAL_KEY_RE.search(key)}


def sanitized_mapping(value: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, raw in value.items():
        if RAW_INTERNAL_KEY_RE.search(str(key)):
            continue
        if isinstance(raw, (str, int, float, bool)) or raw is None:
            sanitized[str(key)] = raw
    return sanitized


def package_contains_internal_retrieval_junk(package: dict[str, Any]) -> bool:
    serialized = json.dumps(package, default=str)
    return bool(
        re.search(
            r"(?:storagePath|storage_path|fullPdfPath|full_pdf_path|pageAssetStoragePath|chunk_id|chunkId|firebase|gs://|data:application/pdf)",
            serialized,
        )
    )
