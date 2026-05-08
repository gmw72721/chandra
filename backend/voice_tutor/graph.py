from __future__ import annotations

import re
from typing import Any

from .compact_context import build_compact_context, compact_text
from .schemas import (
    CompactRealtimeResult,
    KnownContext,
    RetrievalConfidence,
    SkippedSection,
    StructuredSectionName,
    TutorMode,
    VoiceIntent,
    VoiceSectionName,
    VoiceTutorBackendRequest,
    VoiceTutorFullResult,
    VoiceTutorMetadata,
    VoiceTutorProgressEvent,
    VoiceTutorSections,
    VoiceTutorStructuredOutput,
    VoiceTutorUiResponse,
)
from .state import VoiceTutorState
from .tools import PdfRetriever, reused_sources_from_labels, search_voice_sources, source_labels, voice_sources_from_pages

SOURCE_LOOKUP_WORDS = re.compile(r"\b(where|source|page|pdf|come from|find|locate|which worksheet|which reading)\b", re.I)
FORMULA_WORDS = re.compile(r"\b(formula|equation|rule|relationship)\b", re.I)
CHECK_WORK_WORDS = re.compile(r"\b(check|is this right|valid|did i|my answer|my work|i got)\b", re.I)
WALKTHROUGH_WORDS = re.compile(r"\b(walkthrough|walk me through|step by step|show me how)\b", re.I)
EXPLAIN_WORDS = re.compile(r"\b(why|explain|how come|what does|what means|make sense)\b", re.I)
HINT_WORDS = re.compile(r"\b(hint|stuck|start|begin|nudge|first step)\b", re.I)
REPEAT_WORDS = re.compile(r"\b(repeat|say that again|what did you say|again)\b", re.I)
CLARIFY_WORDS = re.compile(r"\b(clarify|what do you mean|confused|huh)\b", re.I)


class VoiceTutorGraph:
    """Voice-first tutor graph for Realtime tool calls."""

    def __init__(self, *, retriever: PdfRetriever | None = None) -> None:
        self.retriever = retriever

    async def run(self, request: VoiceTutorBackendRequest) -> VoiceTutorFullResult:
        state: VoiceTutorState = {
            "request": request,
            "progress_events": [],
            "stage_history": [],
            "classified_intent": "other",
            "can_answer_from_context": False,
            "retrieval_mode": request.toolArgs.retrievalMode,
            "should_search": False,
            "search_queries": [],
            "retrieved_pages": [],
            "sources": [],
            "retrieval_confidence": "low",
        }

        self.classify_spoken_turn(state)
        self.plan_tutoring_move(state)
        await self.maybe_retrieve_sources(state)
        self.choose_ui_sections(state)
        self.generate_voice_and_ui_output(state)
        return self.persist_or_prepare_conversation(state)

    def classify_spoken_turn(self, state: VoiceTutorState) -> None:
        request = state["request"]
        transcript = request.toolArgs.studentTranscript
        intent = request.toolArgs.voiceIntent

        if intent == "other":
            intent = infer_voice_intent(transcript)

        known_context = request.toolArgs.knownContext
        can_answer_from_context = context_supports_intent(intent, known_context)

        state["classified_intent"] = intent
        state["can_answer_from_context"] = can_answer_from_context
        self.add_progress(state, "reading_question", "Reading the voice question.")

    def plan_tutoring_move(self, state: VoiceTutorState) -> None:
        request = state["request"]
        intent = state["classified_intent"]
        known_context = request.toolArgs.knownContext
        retrieval_mode = resolved_retrieval_mode(
            requested_mode=request.toolArgs.retrievalMode,
            intent=intent,
            known_context=known_context,
            transcript=request.toolArgs.studentTranscript,
        )
        should_search = should_search_sources(
            requested_mode=request.toolArgs.retrievalMode,
            resolved_mode=retrieval_mode,
            intent=intent,
            known_context=known_context,
        )
        state["retrieval_mode"] = retrieval_mode
        state["should_search"] = should_search
        self.add_progress(state, "planning_tutor_move", "Planning the next tutoring move.")

    async def maybe_retrieve_sources(self, state: VoiceTutorState) -> None:
        request = state["request"]
        known_context = request.toolArgs.knownContext

        if not state["should_search"]:
            if known_context.hasReliableSourceContext and known_context.knownSourceLabels:
                state["sources"] = reused_sources_from_labels(known_context.knownSourceLabels)
                state["retrieval_confidence"] = "high"
            return

        spoken_progress = state["classified_intent"] == "find_source" or request.toolArgs.retrievalMode == "force_search"
        self.add_progress(
            state,
            "searching_sources",
            "Searching class pages for support.",
            speak=spoken_progress,
        )
        query = build_voice_search_query(request)
        pages = await search_voice_sources(
            query=query,
            class_id=request.classId,
            professor_id=request.professorId,
            retriever=self.retriever,
        )
        state["search_queries"] = [query]
        state["retrieved_pages"] = pages
        self.add_progress(state, "opening_sources", "Opening the most relevant pages.")
        self.add_progress(state, "reading_sources", "Reading the selected page snippets.")
        state["sources"] = voice_sources_from_pages(pages)
        state["retrieval_confidence"] = retrieval_confidence_from_pages(pages)

    def choose_ui_sections(self, state: VoiceTutorState) -> None:
        self.add_progress(state, "writing_support", "Writing concise voice support.")

    def generate_voice_and_ui_output(self, state: VoiceTutorState) -> None:
        request = state["request"]
        intent = state["classified_intent"]
        sections = sections_for_intent(
            intent=intent,
            transcript=request.toolArgs.studentTranscript,
            known_context=request.toolArgs.knownContext,
            sources=state["sources"],
            retrieval_confidence=state["retrieval_confidence"],
        )
        sections_shown = sections.shown_names()
        next_step = sections.nextStep or default_next_step(intent)
        current_step = current_step_for_sections(sections, request.toolArgs.knownContext)
        voice_reply = voice_reply_for_sections(intent, sections, state["sources"])
        compact_context = build_compact_context(
            previous=request.toolArgs.knownContext,
            sections=sections,
            sources=state["sources"],
            transcript=request.toolArgs.studentTranscript,
            current_step=current_step,
            next_step=next_step,
            formula=sections.formula or "",
            has_reliable_source_context=state["retrieval_confidence"] == "high",
            last_voice_graph_message_id=request.assistantMessageId,
        )

        state["sections"] = sections
        state["sections_shown"] = sections_shown
        state["voice_reply"] = voice_reply
        state["current_step"] = current_step
        state["next_step"] = next_step
        state["compact_context"] = compact_context
        state["progress_summary"] = progress_summary(state)
        self.add_progress(state, "final", "Voice tutor response is ready.")

    def persist_or_prepare_conversation(self, state: VoiceTutorState) -> VoiceTutorFullResult:
        request = state["request"]
        sections = state["sections"]
        sections_shown = state["sections_shown"]
        sources = state["sources"]
        retrieval_confidence = state["retrieval_confidence"]
        compact_context = state["compact_context"]
        skipped_sections = skipped_sections_for_preferences(request.toolArgs.preferredSections, sections_shown)
        metadata = metadata_for_intent(state["classified_intent"], retrieval_confidence, sections)
        ui_response = VoiceTutorUiResponse(
            message=state["voice_reply"],
            content=content_for_ui(sections, state["voice_reply"]),
            structuredOutput=VoiceTutorStructuredOutput(
                sections=sections,
                metadata=metadata,
            ),
            sources=sources,
            voiceGraphTrace={
                "intent": state["classified_intent"],
                "retrievalMode": state["retrieval_mode"],
                "searched": bool(state["search_queries"]),
                "searchQueries": state["search_queries"],
                "stages": state["stage_history"],
            },
            retrievalConfidence=retrieval_confidence,
            compactContext=compact_context,
            assistantMessageId=request.assistantMessageId,
            conversationId=request.conversationId or request.toolArgs.conversationId,
        )
        compact_result = CompactRealtimeResult(
            voiceReply=state["voice_reply"],
            currentStep=state["current_step"],
            nextStep=state["next_step"],
            sectionsShown=sections_shown,
            searched=bool(state["search_queries"]),
            sourceLabels=source_labels(sources),
            uiMessageId=request.assistantMessageId,
        )
        return VoiceTutorFullResult(
            uiResponse=ui_response,
            progressEvents=state["progress_events"],
            sectionsShown=sections_shown,
            skippedSections=skipped_sections,
            compactRealtimeResult=compact_result,
        )

    def add_progress(
        self,
        state: VoiceTutorState,
        stage: VoiceTutorProgressEvent.model_fields["stage"].annotation,
        message: str,
        *,
        speak: bool = False,
    ) -> None:
        state["stage_history"].append(stage)
        state["progress_events"].append(VoiceTutorProgressEvent(stage=stage, message=message, speak=speak))


async def run_voice_tutor_graph(
    request: VoiceTutorBackendRequest,
    *,
    retriever: PdfRetriever | None = None,
) -> VoiceTutorFullResult:
    return await VoiceTutorGraph(retriever=retriever).run(request)


def infer_voice_intent(transcript: str) -> VoiceIntent:
    if REPEAT_WORDS.search(transcript):
        return "repeat"

    if SOURCE_LOOKUP_WORDS.search(transcript):
        return "find_source"

    if FORMULA_WORDS.search(transcript):
        return "show_formula"

    if CHECK_WORK_WORDS.search(transcript):
        return "check_work"

    if WALKTHROUGH_WORDS.search(transcript):
        return "walkthrough"

    if EXPLAIN_WORDS.search(transcript):
        return "explain_step"

    if HINT_WORDS.search(transcript):
        return "hint"

    if CLARIFY_WORDS.search(transcript):
        return "clarify"

    return "other"


def context_supports_intent(intent: VoiceIntent, known_context: KnownContext) -> bool:
    if intent in {"repeat", "clarify"}:
        return bool(known_context.currentStep or known_context.lastAssistantNextStep or known_context.problemSummary)

    if intent == "show_formula":
        return bool(known_context.knownFormula)

    if intent == "find_source":
        return bool(known_context.hasReliableSourceContext and known_context.knownSourceLabels)

    return bool(known_context.problemSummary or known_context.currentStep)


def resolved_retrieval_mode(
    *,
    requested_mode: str,
    intent: VoiceIntent,
    known_context: KnownContext,
    transcript: str,
) -> str:
    if requested_mode != "auto":
        return requested_mode

    if intent in {"repeat", "clarify"}:
        return "none"

    if intent == "find_source":
        return "reuse_sources" if known_context.hasReliableSourceContext else "force_search"

    if intent == "show_formula" and known_context.knownFormula:
        return "none"

    if known_context.hasReliableSourceContext and known_context.knownSourceLabels:
        return "reuse_sources"

    if mentions_class_material(transcript):
        return "search_if_uncertain"

    if intent in {"check_work", "walkthrough", "explain_step"} and not known_context.problemSummary:
        return "search_if_uncertain"

    return "none"


def should_search_sources(
    *,
    requested_mode: str,
    resolved_mode: str,
    intent: VoiceIntent,
    known_context: KnownContext,
) -> bool:
    if requested_mode == "none" or resolved_mode == "none":
        return False

    if requested_mode == "reuse_sources" or resolved_mode == "reuse_sources":
        return not bool(known_context.hasReliableSourceContext and known_context.knownSourceLabels) and intent == "find_source"

    if requested_mode == "force_search" or resolved_mode == "force_search":
        return not bool(known_context.hasReliableSourceContext and known_context.knownSourceLabels)

    if requested_mode == "search_if_uncertain" or resolved_mode == "search_if_uncertain":
        has_reliable_source = bool(known_context.hasReliableSourceContext and known_context.knownSourceLabels)
        has_compact_step_context = bool(known_context.problemSummary or known_context.currentStep)
        return not bool(has_reliable_source or has_compact_step_context)

    return False


def mentions_class_material(transcript: str) -> bool:
    return bool(re.search(r"\b(pdf|page|worksheet|homework|assignment|reading|textbook|source|problem\s+\d+|exercise\s+\d+)\b", transcript, re.I))


def build_voice_search_query(request: VoiceTutorBackendRequest) -> str:
    args = request.toolArgs
    context_parts = [
        args.studentTranscript,
        args.knownContext.problemSummary or "",
        args.knownContext.currentStep or "",
        args.knownContext.knownFormula or "",
    ]
    prefix = "find source page for" if args.voiceIntent == "find_source" else "voice tutor support for"
    return compact_text(f"{prefix} {' '.join(context_parts)}", 500)


def retrieval_confidence_from_pages(pages: list[dict[str, Any]]) -> RetrievalConfidence:
    if not pages:
        return "low"

    best_score = max(float(page.get("score") or 0.0) for page in pages)

    if best_score >= 0.78:
        return "high"

    return "medium"


def sections_for_intent(
    *,
    intent: VoiceIntent,
    transcript: str,
    known_context: KnownContext,
    sources: list[Any],
    retrieval_confidence: RetrievalConfidence,
) -> VoiceTutorSections:
    if intent == "hint":
        return VoiceTutorSections(
            hint=hint_text(known_context, transcript),
            nextStep=next_step_question(known_context, "What variable, quantity, or idea should you identify first?"),
        )

    if intent == "show_formula":
        formula = known_context.knownFormula or formula_from_transcript(transcript) or "Use the relationship that matches the quantities in the problem."
        return VoiceTutorSections(
            formula=formula,
            explanation="Match each symbol in the formula to a quantity from the problem before substituting numbers."
            if formula != "Use the relationship that matches the quantities in the problem."
            else None,
            nextStep="Tell me which quantities the problem gives you, and which one it asks for.",
        )

    if intent == "find_source":
        labels = source_labels(sources)
        if labels:
            return VoiceTutorSections(
                sourceNote=f"I found the relevant class material in {', '.join(labels[:2])}.",
                nextStep="Open that source on the screen, then tell me which line you want to unpack.",
            )

        return VoiceTutorSections(
            sourceNote="I could not confirm a matching class source from the compact context.",
            nextStep="Tell me the worksheet, page, section, or problem number so I can narrow it down.",
        )

    if intent == "explain_step":
        return VoiceTutorSections(
            explanation=explanation_text(known_context, transcript, retrieval_confidence),
            nextStep=next_step_question(known_context, "Which part of that step feels least clear?"),
        )

    if intent == "walkthrough":
        return VoiceTutorSections(
            hint=hint_text(known_context, transcript),
            explanation="We will handle one move at a time instead of jumping to the final answer.",
            nextStep=next_step_question(known_context, "Try the first setup step and say what you get."),
        )

    if intent == "check_work":
        return VoiceTutorSections(
            checkWork=check_work_text(transcript, known_context),
            nextStep="Tell me the exact line you want checked, or say the next algebra step you plan to take.",
        )

    if intent == "repeat":
        repeat_text = known_context.lastAssistantNextStep or known_context.currentStep or "We were choosing the next small step."
        return VoiceTutorSections(
            answer=f"Sure. {repeat_text}",
            nextStep=known_context.lastAssistantNextStep or "Try saying the next step in your own words.",
        )

    if intent == "clarify":
        return VoiceTutorSections(
            answer="I mean we should focus on one small choice before doing the full problem.",
            explanation=known_context.currentStep or known_context.problemSummary,
            nextStep=known_context.lastAssistantNextStep or "Tell me which word, symbol, or step is confusing.",
        )

    return VoiceTutorSections(
        answer="I can help with that, but I need one concrete detail from the problem first.",
        nextStep="Say the problem statement, the step you are on, or what you have tried.",
    )


def hint_text(known_context: KnownContext, transcript: str) -> str:
    if known_context.currentStep:
        return f"Stay with this step: {known_context.currentStep}"

    if known_context.problemSummary:
        return f"Start by turning the problem into one clear target: {known_context.problemSummary}"

    if looks_like_setup_question(transcript):
        return "Start by identifying what the problem is asking you to solve for."

    return "Look for the known quantities first, then name the unknown you need."


def explanation_text(known_context: KnownContext, transcript: str, confidence: RetrievalConfidence) -> str:
    if known_context.currentStep:
        return f"That step matters because it connects the current setup to the next calculation: {known_context.currentStep}"

    if known_context.problemSummary:
        return f"The idea is to connect the rule to the goal of the problem: {known_context.problemSummary}"

    if confidence in {"high", "medium"}:
        return "The selected class material supports this step; use it to match the method before calculating."

    return "That step is about choosing the method before doing computation, so focus on what the problem gives and what it asks for."


def check_work_text(transcript: str, known_context: KnownContext) -> str:
    if "=" in transcript or re.search(r"\d", transcript):
        return "I can check the setup, but verify one line at a time: make sure each operation is applied to the whole expression, not just one term."

    if known_context.currentStep:
        return f"Compare your work against this step: {known_context.currentStep}"

    return "I need to see your exact step before I can confirm it. Read or paste the line you want checked."


def formula_from_transcript(transcript: str) -> str:
    patterns = [
        r"(distance\s*=\s*rate\s*(?:times|\*)\s*time)",
        r"(a\^2\s*\+\s*b\^2\s*=\s*c\^2)",
        r"(y\s*=\s*m\s*x\s*\+\s*b)",
        r"(\$[^$]{3,120}\$)",
    ]

    for pattern in patterns:
        match = re.search(pattern, transcript, re.I)
        if match:
            return match.group(1)

    return ""


def next_step_question(known_context: KnownContext, fallback: str) -> str:
    return known_context.lastAssistantNextStep or fallback


def default_next_step(intent: VoiceIntent) -> str:
    defaults = {
        "hint": "Try the next small step.",
        "show_formula": "Match the variables to the problem.",
        "find_source": "Review the source on screen.",
        "explain_step": "Ask about the part that is still unclear.",
        "walkthrough": "Try the first setup step.",
        "check_work": "Show the exact line to check.",
        "clarify": "Tell me what is confusing.",
        "repeat": "Say back the next step.",
        "other": "Share the problem detail.",
    }
    return defaults[intent]


def current_step_for_sections(sections: VoiceTutorSections, known_context: KnownContext) -> str:
    return compact_text(
        known_context.currentStep
        or sections.hint
        or sections.explanation
        or sections.checkWork
        or sections.answer
        or "",
        240,
    )


def voice_reply_for_sections(intent: VoiceIntent, sections: VoiceTutorSections, sources: list[Any]) -> str:
    if intent == "hint" and sections.hint:
        return concise_voice(f"{sections.hint} {sections.nextStep or ''}")

    if intent == "show_formula" and sections.formula:
        return concise_voice(f"Use {strip_markdown(sections.formula)}. {sections.nextStep or ''}")

    if intent == "find_source":
        if sources:
            return "I found the source and I’ll show it on the screen. Tell me which line you want to unpack."

        return "I could not confirm the source yet. Give me the page, worksheet, or problem number."

    if intent == "check_work" and sections.checkWork:
        return concise_voice(f"{sections.checkWork} {sections.nextStep or ''}")

    if sections.explanation:
        return concise_voice(f"{sections.explanation} {sections.nextStep or ''}")

    return concise_voice(f"{sections.answer or 'Let us focus on one small step.'} {sections.nextStep or ''}")


def concise_voice(text: str, max_chars: int = 260) -> str:
    text = strip_markdown(compact_text(text, max_chars + 80))
    sentences = re.split(r"(?<=[.!?])\s+", text)
    concise = " ".join(sentence for sentence in sentences[:2] if sentence).strip()

    if len(concise) <= max_chars:
        return concise

    return concise[:max_chars].rsplit(" ", 1)[0].strip() + "."


def strip_markdown(text: str) -> str:
    return re.sub(r"[*_`#>]+", "", text).replace("$", "").strip()


def metadata_for_intent(intent: VoiceIntent, confidence: RetrievalConfidence, sections: VoiceTutorSections) -> VoiceTutorMetadata:
    return VoiceTutorMetadata(
        hintLevel=hint_level_for_intent(intent, sections),
        sourceConfidence=confidence,
        studentActionNeeded=student_action_for_intent(intent, sections),
        mode=mode_for_intent(intent),
    )


def hint_level_for_intent(intent: VoiceIntent, sections: VoiceTutorSections) -> str:
    if sections.example:
        return "worked_example"

    if intent in {"hint", "walkthrough"}:
        return "small_hint"

    if sections.nextStep:
        return "guided_step"

    return "none"


def student_action_for_intent(intent: VoiceIntent, sections: VoiceTutorSections) -> str:
    if intent == "find_source":
        return "review_source" if sections.sourceNote else "paste_problem"

    if intent == "check_work":
        return "show_attempt"

    if intent in {"clarify", "other"} and not sections.hint:
        return "answer_question"

    if sections.nextStep:
        return "try_next_step"

    return "none"


def mode_for_intent(intent: VoiceIntent) -> TutorMode:
    return {
        "hint": "socratic",
        "show_formula": "guided_problem_solving",
        "find_source": "source_lookup",
        "explain_step": "guided_problem_solving",
        "walkthrough": "guided_problem_solving",
        "check_work": "check_work",
        "clarify": "clarification",
        "repeat": "clarification",
        "other": "clarification",
    }[intent]


def content_for_ui(sections: VoiceTutorSections, fallback: str) -> str:
    parts = [getattr(sections, section) for section in ("answer", "hint", "formula", "explanation", "checkWork", "sourceNote", "nextStep")]
    text = "\n\n".join(part for part in parts if isinstance(part, str) and part.strip())
    return text or fallback


def skipped_sections_for_preferences(preferred: list[VoiceSectionName], shown: list[StructuredSectionName]) -> list[SkippedSection]:
    skipped: list[SkippedSection] = []

    for section in preferred:
        if section == "sources":
            continue

        if section in shown:
            continue

        skipped.append(SkippedSection(section=section, reason=skipped_section_reason(section, shown)))

    return skipped


def skipped_section_reason(section: VoiceSectionName, shown: list[StructuredSectionName]) -> str:
    if "hint" in shown and section in {"formula", "example", "sourceNote"}:
        return f"Not needed for this hint turn."

    if section == "example":
        return "Example was not needed for this concise voice turn."

    if section == "formula":
        return "Formula was not needed for the requested tutoring move."

    if section == "sourceNote":
        return "Source lookup was not needed for this turn."

    return "The voice tutor chose a smaller targeted set for this turn."


def progress_summary(state: VoiceTutorState) -> str:
    if state["search_queries"]:
        return "Searched class materials and wrote targeted support."

    if state["sources"]:
        return "Reused reliable source context and wrote targeted support."

    return "Answered from compact voice context."


def looks_like_setup_question(transcript: str) -> bool:
    return bool(re.search(r"\b(start|begin|first|setup|set up|stuck)\b", transcript, re.I))
