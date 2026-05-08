from __future__ import annotations

import os
from typing import Any

import httpx

from .tools import ASK_VOICE_TUTOR_TOOL

DEFAULT_REALTIME_MODEL = "gpt-realtime-2"
DEFAULT_REALTIME_REASONING_EFFORT = "low"
REALTIME_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets"


def configured_realtime_model() -> str:
    return (os.getenv("OPENAI_REALTIME_MODEL") or DEFAULT_REALTIME_MODEL).strip() or DEFAULT_REALTIME_MODEL


def configured_realtime_reasoning_effort() -> str:
    configured = (os.getenv("OPENAI_REALTIME_REASONING_EFFORT") or DEFAULT_REALTIME_REASONING_EFFORT).strip().lower()

    # Voice routing should stay low-latency. Permit medium for future explicit session overrides, never high by default.
    return "medium" if configured == "medium" else DEFAULT_REALTIME_REASONING_EFFORT


def configured_realtime_transcription_model() -> str:
    return (os.getenv("OPENAI_REALTIME_TRANSCRIPTION_MODEL") or "gpt-4o-mini-transcribe").strip()


def build_realtime_session_config(*, course_id: str | None = None, conversation_id: str | None = None) -> dict[str, Any]:
    session: dict[str, Any] = {
        "type": "realtime",
        "model": configured_realtime_model(),
        "output_modalities": ["audio"],
        "instructions": realtime_voice_tutor_instructions(),
        "tools": [ASK_VOICE_TUTOR_TOOL],
        "tool_choice": "auto",
        "max_output_tokens": 700,
        "reasoning": {"effort": configured_realtime_reasoning_effort()},
        "truncation": {
            "type": "retention_ratio",
            "retention_ratio": 0.8,
            "token_limits": {
                "post_instructions": 8000,
            },
        },
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "transcription": {
                    "model": configured_realtime_transcription_model(),
                    "language": "en",
                },
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "auto",
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {
                "voice": os.getenv("OPENAI_REALTIME_VOICE", "marin"),
                "speed": 1.0,
            },
        },
    }
    metadata = {
        key: value
        for key, value in {
            "course_id": course_id,
            "conversation_id": conversation_id,
            "component": "voice_tutor",
        }.items()
        if value
    }

    if metadata:
        session["tracing"] = {
            "workflow_name": "Chandra Voice Tutor",
            "metadata": metadata,
        }

    return session


def realtime_voice_tutor_instructions() -> str:
    return (
        "You are Chandra in Realtime voice mode. Speak as a concise live tutor. "
        "For class-material help, source lookups, formulas, step explanations, walkthroughs, hints, or work checks, call ask_voice_tutor. "
        "Use compact knownContext only; never send full chat history, PDF text, source chunks, hidden prompts, graph traces, or API keys. "
        "After ask_voice_tutor returns, speak only the voiceReply in one or two short sentences unless the student asks for more. "
        "Do not read progress events, source metadata, markdown, tool details, or debug information aloud. "
        "For simple greetings, repeats, or brief clarifications that do not need class context, answer briefly without a tool call. "
        "Default to low reasoning for low-latency routing; use medium only for ambiguous turns that must choose between source reuse and search."
    )


async def create_realtime_client_secret(
    *,
    api_key: str,
    session_config: dict[str, Any] | None = None,
    ttl_seconds: int = 600,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if not api_key.strip():
        raise RuntimeError("OPENAI_API_KEY is required to create a Realtime client secret.")

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=20.0)

    try:
        response = await http_client.post(
            REALTIME_CLIENT_SECRET_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "expires_after": {
                    "anchor": "created_at",
                    "seconds": max(10, min(ttl_seconds, 7200)),
                },
                "session": session_config or build_realtime_session_config(),
            },
        )
        response.raise_for_status()
        return response.json()
    finally:
        if owns_client:
            await http_client.aclose()
