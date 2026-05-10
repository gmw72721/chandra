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
    ai_usage_reservation: NotRequired[dict[str, Any]]
    source_usage: NotRequired[dict[str, Any]]
    student_profile_context: NotRequired[dict[str, Any]]
    active_problem_context: NotRequired[dict[str, Any]]
    active_problem_context_prefetch: NotRequired[Any]
    active_problem_context_prefetch_complete: NotRequired[bool]
    answer_leak_blocked_response: NotRequired[dict[str, Any]]
    answer_leak_rewrite_override: NotRequired[str]
    retrieval_confidence: NotRequired[str]
    retrieval_diagnostics: NotRequired[list[dict[str, Any]]]
    sources: NotRequired[list[dict[str, Any]]]
    token_usage: NotRequired[dict[str, int]]
    token_usage_by_call: NotRequired[list[dict[str, Any]]]
    class_id: NotRequired[str]
    conversation_id: NotRequired[str]
    latest_student_message_id: NotRequired[str]
    professor_id: NotRequired[str]
    professor_name: NotRequired[str]
    student_id: NotRequired[str]
