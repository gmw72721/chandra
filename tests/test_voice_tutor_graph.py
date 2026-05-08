from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.voice_tutor.graph import run_voice_tutor_graph
from backend.voice_tutor.realtime_session import (
    DEFAULT_REALTIME_MODEL,
    DEFAULT_REALTIME_REASONING_EFFORT,
    build_realtime_session_config,
)
from backend.voice_tutor.schemas import VoiceTutorBackendRequest, VoiceTutorToolArgs


class FakeRetriever:
    def __init__(self, pages: list[dict] | None = None) -> None:
        self.pages = pages or [
            {
                "doc_id": "worksheet-4",
                "title": "Worksheet 4",
                "page_start": 2,
                "page_end": 2,
                "section": "Linear equations",
                "score": 0.91,
                "chunk_text": "Use distance = rate times time for this problem.",
                "material_type": "worksheet",
            }
        ]
        self.calls: list[dict] = []

    async def search(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages


def make_request(**overrides) -> VoiceTutorBackendRequest:
    tool_args = {
        "studentTranscript": "Can I get a hint for this problem?",
        "courseId": "class-algebra",
        "voiceIntent": "hint",
        "preferredSections": ["hint", "formula", "example", "nextStep"],
        "retrievalMode": "none",
        "responseBudget": "voice_short",
        "knownContext": {},
    }
    tool_args.update(overrides.pop("toolArgs", {}))
    request = {
        "classId": "class-algebra",
        "professorId": "teacher-1",
        "professorName": "Teacher",
        "assistantMessageId": "voice-message-1-assistant",
        "conversationId": "conversation-1",
        "toolArgs": tool_args,
        "answerPolicy": {},
        "sourceUsage": {},
        "studentLearningProfileContext": {},
    }
    request.update(overrides)
    return VoiceTutorBackendRequest(**request)


def test_realtime_session_defaults_to_gpt_realtime_2_and_low_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_REALTIME_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_REALTIME_REASONING_EFFORT", raising=False)

    session = build_realtime_session_config(course_id="class-algebra")

    assert session["model"] == DEFAULT_REALTIME_MODEL
    assert session["reasoning"]["effort"] == DEFAULT_REALTIME_REASONING_EFFORT
    assert session["tools"][0]["name"] == "ask_voice_tutor"


def test_voice_tool_schema_validates_limits_and_section_names() -> None:
    parsed = VoiceTutorToolArgs(
        studentTranscript="What formula do I use?",
        courseId="class-algebra",
        voiceIntent="show_formula",
        preferredSections=["formula", "formula", "nextStep"],
        retrievalMode="auto",
        responseBudget="voice_short",
        knownContext={"knownFormula": "d = rt"},
    )

    assert parsed.preferredSections == ["formula", "nextStep"]

    with pytest.raises(ValidationError):
        VoiceTutorToolArgs(
            studentTranscript="x" * 4001,
            courseId="class-algebra",
            voiceIntent="hint",
            preferredSections=["hint"],
            retrievalMode="none",
            responseBudget="voice_short",
            knownContext={},
        )

    with pytest.raises(ValidationError):
        VoiceTutorToolArgs(
            studentTranscript="help",
            courseId="class-algebra",
            voiceIntent="hint",
            preferredSections=["fullSourceChunk"],
            retrievalMode="none",
            responseBudget="voice_short",
            knownContext={},
        )


@pytest.mark.asyncio
async def test_hint_returns_hint_and_next_step_without_forcing_formula_or_example() -> None:
    result = await run_voice_tutor_graph(make_request())

    assert result.sectionsShown == ["hint", "nextStep"]
    assert result.uiResponse.structuredOutput.sections.hint
    assert result.uiResponse.structuredOutput.sections.formula is None
    assert result.uiResponse.structuredOutput.sections.example is None
    assert result.skippedSections[0].section == "formula"
    assert "Not needed for this hint turn" in result.skippedSections[0].reason


@pytest.mark.asyncio
async def test_formula_request_does_not_always_include_example() -> None:
    result = await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "studentTranscript": "What formula do I use here?",
                "voiceIntent": "show_formula",
                "preferredSections": ["formula", "example", "nextStep"],
                "knownContext": {"knownFormula": "distance = rate * time"},
            }
        )
    )

    assert "formula" in result.sectionsShown
    assert "nextStep" in result.sectionsShown
    assert "example" not in result.sectionsShown
    assert result.uiResponse.structuredOutput.sections.example is None


@pytest.mark.asyncio
async def test_source_lookup_reuses_reliable_source_context() -> None:
    retriever = FakeRetriever()
    result = await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "studentTranscript": "Where did that come from in the PDF?",
                "voiceIntent": "find_source",
                "preferredSections": ["sourceNote", "sources"],
                "retrievalMode": "reuse_sources",
                "knownContext": {
                    "hasReliableSourceContext": True,
                    "knownSourceLabels": ["Worksheet 4 p. 2"],
                },
            }
        ),
        retriever=retriever,
    )

    assert retriever.calls == []
    assert result.uiResponse.structuredOutput.sections.sourceNote
    assert result.uiResponse.sources[0].reused is True
    assert result.compactRealtimeResult.searched is False
    assert result.compactRealtimeResult.sourceLabels == ["Worksheet 4 p. 2"]


@pytest.mark.asyncio
async def test_explanation_with_known_source_avoids_unnecessary_search() -> None:
    retriever = FakeRetriever()
    result = await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "studentTranscript": "Can you explain that step?",
                "voiceIntent": "explain_step",
                "preferredSections": ["explanation", "nextStep"],
                "retrievalMode": "search_if_uncertain",
                "knownContext": {
                    "currentStep": "Set the two expressions equal.",
                    "hasReliableSourceContext": True,
                    "knownSourceLabels": ["Notes p. 5"],
                },
            }
        ),
        retriever=retriever,
    )

    assert retriever.calls == []
    assert result.sectionsShown == ["explanation", "nextStep"]
    assert result.uiResponse.retrievalConfidence == "high"


@pytest.mark.asyncio
async def test_walkthrough_returns_minimal_useful_support() -> None:
    result = await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "studentTranscript": "Walk me through this step by step.",
                "voiceIntent": "walkthrough",
                "preferredSections": ["answer", "hint", "explanation", "formula", "example", "nextStep"],
                "retrievalMode": "none",
                "knownContext": {"problemSummary": "Solve a linear equation."},
            }
        )
    )

    assert result.sectionsShown == ["hint", "explanation", "nextStep"]
    assert "formula" not in result.sectionsShown
    assert "example" not in result.sectionsShown


@pytest.mark.asyncio
async def test_check_work_returns_check_work_and_next_step() -> None:
    result = await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "studentTranscript": "Can you check my work? I got x = 4.",
                "voiceIntent": "check_work",
                "preferredSections": ["checkWork", "nextStep"],
                "retrievalMode": "none",
            }
        )
    )

    assert result.sectionsShown == ["checkWork", "nextStep"]
    assert result.uiResponse.structuredOutput.metadata.mode == "check_work"


@pytest.mark.asyncio
async def test_retrieval_modes_control_search_behavior() -> None:
    none_retriever = FakeRetriever()
    await run_voice_tutor_graph(
        make_request(toolArgs={"retrievalMode": "none", "voiceIntent": "find_source"}),
        retriever=none_retriever,
    )
    assert none_retriever.calls == []

    search_retriever = FakeRetriever()
    await run_voice_tutor_graph(
        make_request(toolArgs={"retrievalMode": "search_if_uncertain", "voiceIntent": "explain_step"}),
        retriever=search_retriever,
    )
    assert len(search_retriever.calls) == 1

    reuse_retriever = FakeRetriever()
    await run_voice_tutor_graph(
        make_request(
            toolArgs={
                "retrievalMode": "reuse_sources",
                "voiceIntent": "find_source",
                "knownContext": {
                    "hasReliableSourceContext": True,
                    "knownSourceLabels": ["Worksheet 4 p. 2"],
                },
            }
        ),
        retriever=reuse_retriever,
    )
    assert reuse_retriever.calls == []

    force_retriever = FakeRetriever()
    await run_voice_tutor_graph(
        make_request(toolArgs={"retrievalMode": "force_search", "voiceIntent": "find_source"}),
        retriever=force_retriever,
    )
    assert len(force_retriever.calls) == 1


@pytest.mark.asyncio
async def test_compact_realtime_result_is_separate_from_full_ui_result_and_excludes_trace_data() -> None:
    result = await run_voice_tutor_graph(
        make_request(toolArgs={"retrievalMode": "force_search", "voiceIntent": "find_source"}),
        retriever=FakeRetriever(),
    )
    compact = result.compactRealtimeResult.model_dump(exclude_none=True)

    assert "voiceReply" in compact
    assert "voiceGraphTrace" not in compact
    assert "sources" not in compact
    assert "progressEvents" not in compact
    assert "chunk_text" not in str(compact)
    assert result.uiResponse.voiceGraphTrace["searched"] is True
    assert result.uiResponse.sources


@pytest.mark.asyncio
async def test_progress_events_are_produced_during_retrieval() -> None:
    result = await run_voice_tutor_graph(
        make_request(toolArgs={"retrievalMode": "force_search", "voiceIntent": "find_source"}),
        retriever=FakeRetriever(),
    )
    stages = [event.stage for event in result.progressEvents]

    assert "searching_sources" in stages
    assert "opening_sources" in stages
    assert "reading_sources" in stages
    assert stages[-1] == "final"
