from __future__ import annotations

from typing import Any

from typing_extensions import NotRequired, TypedDict

from .schemas import (
    KnownContext,
    RetrievalConfidence,
    StructuredSectionName,
    VoiceIntent,
    VoiceTutorBackendRequest,
    VoiceTutorProgressEvent,
    VoiceTutorSections,
    VoiceTutorSource,
)


class VoiceTutorState(TypedDict):
    request: VoiceTutorBackendRequest
    progress_events: list[VoiceTutorProgressEvent]
    stage_history: list[str]
    classified_intent: VoiceIntent
    can_answer_from_context: bool
    retrieval_mode: str
    should_search: bool
    search_queries: list[str]
    retrieved_pages: list[dict[str, Any]]
    sources: list[VoiceTutorSource]
    retrieval_confidence: RetrievalConfidence
    sections: NotRequired[VoiceTutorSections]
    sections_shown: NotRequired[list[StructuredSectionName]]
    compact_context: NotRequired[KnownContext]
    voice_reply: NotRequired[str]
    current_step: NotRequired[str]
    next_step: NotRequired[str]
    progress_summary: NotRequired[str]
