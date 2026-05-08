from __future__ import annotations

import re
from typing import Any

from .schemas import (
    MAX_COMPACT_CONTEXT_FIELD_CHARS,
    KnownContext,
    VoiceTutorFullResult,
    VoiceTutorSections,
    VoiceTutorSource,
    compact_string_list,
)

FORBIDDEN_COMPACT_KEYS = {
    "chunk",
    "chunk_text",
    "chunkText",
    "content",
    "fullChat",
    "graphTrace",
    "langGraphTrace",
    "messages",
    "pdfText",
    "raw",
    "reasoning",
    "retrieved_pages",
    "sourceChunks",
    "voiceGraphTrace",
}


def build_compact_context(
    *,
    previous: KnownContext | None = None,
    sections: VoiceTutorSections | None = None,
    sources: list[VoiceTutorSource] | None = None,
    transcript: str = "",
    current_step: str = "",
    next_step: str = "",
    formula: str = "",
    has_reliable_source_context: bool = False,
    last_voice_graph_message_id: str | None = None,
) -> KnownContext:
    """Build the small state object that Realtime may keep across voice turns."""

    previous = previous or KnownContext()
    source_labels = source_labels_from_sources(sources or [])
    problem_summary = compact_text(previous.problemSummary or infer_problem_summary(transcript))
    resolved_formula = compact_text(formula or previous.knownFormula or section_text(sections, "formula"))

    return KnownContext(
        problemSummary=problem_summary or None,
        currentStep=compact_text(current_step or previous.currentStep or section_text(sections, "hint")),
        knownFormula=resolved_formula or None,
        knownSourceLabels=source_labels or compact_string_list(previous.knownSourceLabels),
        lastSectionsShown=sections.shown_names() if sections else previous.lastSectionsShown,
        lastAssistantNextStep=compact_text(next_step or section_text(sections, "nextStep") or previous.lastAssistantNextStep),
        hasReliableSourceContext=bool(has_reliable_source_context or previous.hasReliableSourceContext),
        lastVoiceGraphMessageId=last_voice_graph_message_id or previous.lastVoiceGraphMessageId,
    )


def build_compact_context_from_result(result: VoiceTutorFullResult) -> KnownContext:
    return build_compact_context(
        previous=result.uiResponse.compactContext,
        sections=result.uiResponse.structuredOutput.sections,
        sources=result.uiResponse.sources,
        current_step=result.compactRealtimeResult.currentStep,
        next_step=result.compactRealtimeResult.nextStep,
        has_reliable_source_context=result.uiResponse.retrievalConfidence == "high",
        last_voice_graph_message_id=result.compactRealtimeResult.uiMessageId,
    )


def sanitize_compact_context_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop fields that should never be carried back into Realtime context."""

    sanitized: dict[str, Any] = {}

    for key, value in payload.items():
        if key in FORBIDDEN_COMPACT_KEYS:
            continue

        if isinstance(value, dict):
            sanitized[key] = sanitize_compact_context_payload(value)
        elif isinstance(value, list):
            sanitized[key] = [
                sanitize_compact_context_payload(item) if isinstance(item, dict) else compact_text(str(item), 160)
                for item in value[:8]
            ]
        elif isinstance(value, str):
            sanitized[key] = compact_text(value)
        else:
            sanitized[key] = value

    return sanitized


def section_text(sections: VoiceTutorSections | None, section: str) -> str:
    if sections is None:
        return ""

    value = getattr(sections, section, None)
    return value if isinstance(value, str) else ""


def source_labels_from_sources(sources: list[VoiceTutorSource]) -> list[str]:
    labels = []

    for source in sources:
        label = source.citationLabel or source.title

        if source.pageNumber:
            label = f"{label} p. {source.pageNumber}"

        labels.append(label)

    return compact_string_list(labels)


def infer_problem_summary(transcript: str) -> str:
    text = compact_text(transcript)

    if not text:
        return ""

    if len(text) <= 160:
        return text

    return text[:160].rsplit(" ", 1)[0].strip()


def compact_text(value: str | None, max_chars: int = MAX_COMPACT_CONTEXT_FIELD_CHARS) -> str:
    if not value:
        return ""

    text = re.sub(r"\s+", " ", value).strip()
    text = strip_source_chunk_markers(text)

    if len(text) <= max_chars:
        return text

    return text[:max_chars].rsplit(" ", 1)[0].strip()


def strip_source_chunk_markers(text: str) -> str:
    return re.sub(r"\b(?:chunk_text|chunkText|source chunk|PDF text|full chat history)\b\s*[:=-]?", "", text, flags=re.I)
