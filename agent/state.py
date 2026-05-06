from __future__ import annotations

from typing import Any

from typing_extensions import NotRequired, TypedDict


class PdfRagState(TypedDict):
    """State shared by the controlled multimodal PDF RAG graph."""

    messages: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    retrieved_pages: list[dict[str, Any]]
    page_assets: list[dict[str, Any]]
    answer: str
    finish_reason: NotRequired[str]
    tool_call_count: int
    stage_history: NotRequired[list[str]]
    search_queries: NotRequired[list[str]]
    model: NotRequired[str]
    temperature: NotRequired[float]
    max_tokens: NotRequired[int]
    reasoning_effort: NotRequired[str]
    answer_policy: NotRequired[dict[str, Any]]
    source_usage: NotRequired[dict[str, Any]]
    retrieval_confidence: NotRequired[str]
    sources: NotRequired[list[dict[str, Any]]]
    class_id: NotRequired[str]
    professor_id: NotRequired[str]
    professor_name: NotRequired[str]
