from __future__ import annotations

import re
from typing import Any, Protocol

from backend.agent.tools import search_pdf_pages

from .compact_context import compact_text
from .schemas import VoiceTutorSource, compact_string_list

ASK_VOICE_TUTOR_TOOL: dict[str, Any] = {
    "type": "function",
    "name": "ask_voice_tutor",
    "description": (
        "Ask Chandra's voice tutor graph for one concise spoken coaching reply and targeted UI support. "
        "Use this when the student needs class-material tutoring, source lookup, a hint, formula, step explanation, walkthrough, or work check. "
        "Do not send full chat history, PDF text, source chunks, or internal traces."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "studentTranscript": {
                "type": "string",
                "description": "The current student utterance transcript. Keep it to the current turn, not the whole conversation.",
                "maxLength": 4000,
            },
            "courseId": {
                "type": "string",
                "description": "The active class/course id provided by the app.",
                "maxLength": 200,
            },
            "conversationId": {
                "type": "string",
                "description": "Optional saved conversation id if the app has one.",
                "maxLength": 200,
            },
            "voiceIntent": {
                "type": "string",
                "enum": [
                    "hint",
                    "show_formula",
                    "find_source",
                    "explain_step",
                    "walkthrough",
                    "check_work",
                    "clarify",
                    "repeat",
                    "other",
                ],
            },
            "preferredSections": {
                "type": "array",
                "description": "Preferred UI sections. The backend decides final sections and may skip unnecessary ones.",
                "items": {
                    "type": "string",
                    "enum": [
                        "answer",
                        "hint",
                        "explanation",
                        "formula",
                        "example",
                        "checkWork",
                        "sourceNote",
                        "sources",
                        "nextStep",
                    ],
                },
                "maxItems": 9,
            },
            "retrievalMode": {
                "type": "string",
                "enum": ["auto", "none", "reuse_sources", "search_if_uncertain", "force_search"],
            },
            "responseBudget": {
                "type": "string",
                "enum": ["voice_short", "ui_compact", "ui_full"],
            },
            "knownContext": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "problemSummary": {"type": "string", "maxLength": 600},
                    "currentStep": {"type": "string", "maxLength": 600},
                    "knownFormula": {"type": "string", "maxLength": 600},
                    "knownSourceLabels": {
                        "type": "array",
                        "items": {"type": "string", "maxLength": 120},
                        "maxItems": 8,
                    },
                    "lastSectionsShown": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "answer",
                                "hint",
                                "explanation",
                                "formula",
                                "example",
                                "checkWork",
                                "sourceNote",
                                "nextStep",
                            ],
                        },
                        "maxItems": 8,
                    },
                    "lastAssistantNextStep": {"type": "string", "maxLength": 600},
                    "hasReliableSourceContext": {"type": "boolean"},
                    "lastVoiceGraphMessageId": {"type": "string", "maxLength": 200},
                },
            },
        },
        "required": [
            "studentTranscript",
            "courseId",
            "voiceIntent",
            "preferredSections",
            "retrievalMode",
            "responseBudget",
            "knownContext",
        ],
        "additionalProperties": False,
    },
}


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


async def search_voice_sources(
    *,
    query: str,
    class_id: str,
    professor_id: str,
    retriever: PdfRetriever | None = None,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    if not query.strip():
        return []

    return await search_pdf_pages(
        compact_text(query, 500),
        top_k=top_k,
        retriever=retriever,
        class_id=class_id,
        professor_id=professor_id,
    )


def voice_sources_from_pages(pages: list[dict[str, Any]], *, limit: int = 5) -> list[VoiceTutorSource]:
    sources: list[VoiceTutorSource] = []
    seen: set[tuple[str, int | None, str]] = set()

    for page in pages:
        title = str(page.get("title") or "Class material").strip() or "Class material"
        page_start = int_or_none(page.get("printed_page_start") or page.get("printedPageStart") or page.get("page_start") or page.get("pageStart"))
        page_end = int_or_none(page.get("printed_page_end") or page.get("printedPageEnd") or page.get("page_end") or page.get("pageEnd"))
        doc_id = str(page.get("doc_id") or page.get("docId") or "").strip()
        key = (doc_id or title, page_start, title)

        if key in seen:
            continue

        seen.add(key)
        section = str(page.get("section") or "").strip()
        citation_label = citation_label_for_source(title, page_start, page_end, section)
        sources.append(
            VoiceTutorSource(
                title=title,
                materialType=str(page.get("material_type") or page.get("materialType") or "material").strip() or "material",
                citationLabel=citation_label,
                docId=doc_id or None,
                pageNumber=page_start,
                pageStart=page_start,
                pageEnd=page_end or page_start,
                problemNumber=problem_number_from_page(page),
            )
        )

        if len(sources) >= limit:
            break

    return sources


def reused_sources_from_labels(labels: list[str]) -> list[VoiceTutorSource]:
    return [
        VoiceTutorSource(
            title=label,
            materialType="known_context",
            citationLabel=label,
            reused=True,
        )
        for label in compact_string_list(labels)
    ]


def source_labels(sources: list[VoiceTutorSource]) -> list[str]:
    return compact_string_list([source.citationLabel or source.title for source in sources])


def citation_label_for_source(title: str, page_start: int | None, page_end: int | None, section: str) -> str:
    label = title

    if section:
        label = f"{label}, {section}"

    if page_start and page_end and page_end != page_start:
        label = f"{label} pp. {page_start}-{page_end}"
    elif page_start:
        label = f"{label} p. {page_start}"

    return compact_text(label, 240)


def problem_number_from_page(page: dict[str, Any]) -> str | None:
    values = page.get("problemNumbers") or page.get("problem_numbers") or []

    if isinstance(values, list) and values:
        return compact_text(str(values[0]), 80)

    text = " ".join(str(page.get(field) or "") for field in ("section", "chunk_text", "chunkText", "content"))
    match = re.search(r"\b(?:problem|exercise|question)\s+([A-Za-z]?\d+(?:\.\d+)*)", text, re.I)
    return match.group(1) if match else None


def int_or_none(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None

    return number if number > 0 else None
