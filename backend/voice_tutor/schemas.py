from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VoiceIntent = Literal[
    "hint",
    "show_formula",
    "find_source",
    "explain_step",
    "walkthrough",
    "check_work",
    "clarify",
    "repeat",
    "other",
]
VoiceSectionName = Literal[
    "answer",
    "hint",
    "explanation",
    "formula",
    "example",
    "checkWork",
    "sourceNote",
    "sources",
    "nextStep",
]
StructuredSectionName = Literal[
    "answer",
    "hint",
    "explanation",
    "formula",
    "example",
    "checkWork",
    "sourceNote",
    "nextStep",
]
RetrievalMode = Literal["auto", "none", "reuse_sources", "search_if_uncertain", "force_search"]
ResponseBudget = Literal["voice_short", "ui_compact", "ui_full"]
ProgressStage = Literal[
    "reading_question",
    "planning_tutor_move",
    "searching_sources",
    "opening_sources",
    "reading_sources",
    "writing_support",
    "final",
]
RetrievalConfidence = Literal["high", "medium", "low"]
HintLevel = Literal["none", "small_hint", "guided_step", "worked_example", "refusal"]
StudentActionNeeded = Literal[
    "none",
    "show_attempt",
    "try_next_step",
    "answer_question",
    "review_source",
    "paste_problem",
    "ask_teacher",
]
TutorMode = Literal[
    "guided_problem_solving",
    "socratic",
    "check_work",
    "reading_helper",
    "exam_review",
    "source_lookup",
    "direct_answer_refusal",
    "clarification",
    "off_topic_redirect",
]

VOICE_STRUCTURED_SECTION_NAMES: tuple[StructuredSectionName, ...] = (
    "answer",
    "hint",
    "explanation",
    "formula",
    "example",
    "checkWork",
    "sourceNote",
    "nextStep",
)
VOICE_TOOL_SECTION_NAMES: tuple[VoiceSectionName, ...] = (*VOICE_STRUCTURED_SECTION_NAMES, "sources")

MAX_STUDENT_TRANSCRIPT_CHARS = 4000
MAX_COMPACT_CONTEXT_FIELD_CHARS = 600
MAX_COMPACT_CONTEXT_LIST_ITEM_CHARS = 120
MAX_COMPACT_CONTEXT_LIST_ITEMS = 8
MAX_PREFERRED_SECTIONS = len(VOICE_TOOL_SECTION_NAMES)
MAX_COURSE_ID_CHARS = 200
MAX_CONVERSATION_ID_CHARS = 200


class VoiceTutorBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KnownContext(VoiceTutorBaseModel):
    problemSummary: Optional[str] = Field(default=None, max_length=MAX_COMPACT_CONTEXT_FIELD_CHARS)
    currentStep: Optional[str] = Field(default=None, max_length=MAX_COMPACT_CONTEXT_FIELD_CHARS)
    knownFormula: Optional[str] = Field(default=None, max_length=MAX_COMPACT_CONTEXT_FIELD_CHARS)
    knownSourceLabels: list[str] = Field(default_factory=list, max_length=MAX_COMPACT_CONTEXT_LIST_ITEMS)
    lastSectionsShown: list[StructuredSectionName] = Field(default_factory=list, max_length=MAX_COMPACT_CONTEXT_LIST_ITEMS)
    lastAssistantNextStep: Optional[str] = Field(default=None, max_length=MAX_COMPACT_CONTEXT_FIELD_CHARS)
    hasReliableSourceContext: Optional[bool] = None
    lastVoiceGraphMessageId: Optional[str] = Field(default=None, max_length=MAX_CONVERSATION_ID_CHARS)

    @field_validator("problemSummary", "currentStep", "knownFormula", "lastAssistantNextStep", "lastVoiceGraphMessageId")
    @classmethod
    def strip_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None

        stripped = " ".join(value.split()).strip()
        return stripped or None

    @field_validator("knownSourceLabels")
    @classmethod
    def strip_source_labels(cls, value: list[str]) -> list[str]:
        return compact_string_list(value)


class VoiceTutorToolArgs(VoiceTutorBaseModel):
    studentTranscript: str = Field(min_length=1, max_length=MAX_STUDENT_TRANSCRIPT_CHARS)
    courseId: str = Field(min_length=1, max_length=MAX_COURSE_ID_CHARS)
    conversationId: Optional[str] = Field(default=None, max_length=MAX_CONVERSATION_ID_CHARS)
    voiceIntent: VoiceIntent = "other"
    preferredSections: list[VoiceSectionName] = Field(default_factory=list, max_length=MAX_PREFERRED_SECTIONS)
    retrievalMode: RetrievalMode = "auto"
    responseBudget: ResponseBudget = "voice_short"
    knownContext: KnownContext = Field(default_factory=KnownContext)

    @field_validator("studentTranscript", "courseId", "conversationId")
    @classmethod
    def strip_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None

        stripped = " ".join(value.split()).strip()
        return stripped

    @field_validator("conversationId")
    @classmethod
    def reject_path_like_conversation_id(cls, value: Optional[str]) -> Optional[str]:
        if value and "/" in value:
            raise ValueError("conversationId must be a document id, not a path.")

        return value

    @field_validator("preferredSections")
    @classmethod
    def deduplicate_preferred_sections(cls, value: list[VoiceSectionName]) -> list[VoiceSectionName]:
        deduplicated: list[VoiceSectionName] = []

        for section in value:
            if section not in deduplicated:
                deduplicated.append(section)

        return deduplicated


class VoiceTutorBackendRequest(VoiceTutorBaseModel):
    classId: str = Field(min_length=1, max_length=MAX_COURSE_ID_CHARS)
    professorId: str = Field(min_length=1, max_length=MAX_COURSE_ID_CHARS)
    professorName: Optional[str] = Field(default=None, max_length=MAX_COMPACT_CONTEXT_LIST_ITEM_CHARS)
    conversationId: Optional[str] = Field(default=None, max_length=MAX_CONVERSATION_ID_CHARS)
    assistantMessageId: Optional[str] = Field(default=None, max_length=MAX_CONVERSATION_ID_CHARS)
    toolArgs: VoiceTutorToolArgs
    answerPolicy: Optional[dict[str, Any]] = None
    sourceUsage: Optional[dict[str, Any]] = None
    studentLearningProfileContext: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def force_authorized_class_into_tool_args(self) -> "VoiceTutorBackendRequest":
        if self.toolArgs.courseId == self.classId:
            return self

        self.toolArgs = self.toolArgs.model_copy(update={"courseId": self.classId})
        return self


class VoiceTutorProgressEvent(VoiceTutorBaseModel):
    stage: ProgressStage
    message: str = Field(min_length=1, max_length=240)
    speak: bool = False


class VoiceTutorSource(VoiceTutorBaseModel):
    title: str = Field(min_length=1, max_length=240)
    materialType: str = Field(default="material", max_length=80)
    citationLabel: Optional[str] = Field(default=None, max_length=240)
    docId: Optional[str] = Field(default=None, max_length=200)
    pageNumber: Optional[int] = Field(default=None, ge=1)
    pageStart: Optional[int] = Field(default=None, ge=1)
    pageEnd: Optional[int] = Field(default=None, ge=1)
    problemNumber: Optional[str] = Field(default=None, max_length=80)
    reused: bool = False


class VoiceTutorSections(VoiceTutorBaseModel):
    answer: Optional[str] = Field(default=None, max_length=1600)
    hint: Optional[str] = Field(default=None, max_length=1600)
    explanation: Optional[str] = Field(default=None, max_length=1800)
    formula: Optional[str] = Field(default=None, max_length=1200)
    example: Optional[str] = Field(default=None, max_length=1600)
    checkWork: Optional[str] = Field(default=None, max_length=1600)
    sourceNote: Optional[str] = Field(default=None, max_length=1200)
    nextStep: Optional[str] = Field(default=None, max_length=800)

    def shown_names(self) -> list[StructuredSectionName]:
        return [
            section
            for section in VOICE_STRUCTURED_SECTION_NAMES
            if isinstance(getattr(self, section), str) and getattr(self, section).strip()
        ]


class VoiceTutorMetadata(VoiceTutorBaseModel):
    hintLevel: HintLevel
    sourceConfidence: RetrievalConfidence
    studentActionNeeded: StudentActionNeeded
    mode: TutorMode


class VoiceTutorStructuredOutput(VoiceTutorBaseModel):
    sections: VoiceTutorSections
    metadata: VoiceTutorMetadata


class VoiceTutorUiResponse(VoiceTutorBaseModel):
    message: str = Field(min_length=1, max_length=1200)
    content: str = Field(min_length=1, max_length=4000)
    structuredOutput: VoiceTutorStructuredOutput
    sources: list[VoiceTutorSource] = Field(default_factory=list, max_length=8)
    voiceGraphTrace: dict[str, Any] = Field(default_factory=dict)
    retrievalConfidence: RetrievalConfidence
    compactContext: KnownContext
    assistantMessageId: Optional[str] = None
    conversationId: Optional[str] = None


class SkippedSection(VoiceTutorBaseModel):
    section: VoiceSectionName
    reason: str = Field(min_length=1, max_length=240)


class CompactRealtimeResult(VoiceTutorBaseModel):
    voiceReply: str = Field(min_length=1, max_length=500)
    currentStep: str = Field(default="", max_length=240)
    nextStep: str = Field(default="", max_length=240)
    sectionsShown: list[StructuredSectionName] = Field(default_factory=list, max_length=8)
    searched: bool
    sourceLabels: list[str] = Field(default_factory=list, max_length=MAX_COMPACT_CONTEXT_LIST_ITEMS)
    uiMessageId: Optional[str] = Field(default=None, max_length=MAX_CONVERSATION_ID_CHARS)

    @field_validator("sourceLabels")
    @classmethod
    def strip_labels(cls, value: list[str]) -> list[str]:
        return compact_string_list(value)


class VoiceTutorFullResult(VoiceTutorBaseModel):
    uiResponse: VoiceTutorUiResponse
    progressEvents: list[VoiceTutorProgressEvent] = Field(default_factory=list)
    sectionsShown: list[StructuredSectionName] = Field(default_factory=list)
    skippedSections: list[SkippedSection] = Field(default_factory=list)
    compactRealtimeResult: CompactRealtimeResult


def compact_string_list(values: list[str]) -> list[str]:
    compacted: list[str] = []

    for raw_value in values[:MAX_COMPACT_CONTEXT_LIST_ITEMS]:
        value = " ".join(str(raw_value).split()).strip()

        if not value:
            continue

        value = value[:MAX_COMPACT_CONTEXT_LIST_ITEM_CHARS].rstrip()
        if value not in compacted:
            compacted.append(value)

    return compacted
