from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

from backend.langfuse_prompts import get_langfuse_client, has_langfuse_prompt_config

MAX_TRACE_TEXT_CHARS = 1200
MAX_TRACE_LIST_ITEMS = 8
SENSITIVE_KEY_PARTS = (
    "authorization",
    "cookie",
    "dataurl",
    "file_data",
    "key",
    "ocrtext",
    "password",
    "private",
    "secret",
    "storagekey",
    "token",
)


def langfuse_tracing_enabled() -> bool:
    disabled_value = os.getenv("LANGFUSE_TRACING_ENABLED", "").strip().lower()
    return has_langfuse_prompt_config() and disabled_value not in {"0", "false", "off", "no"}


def langfuse_environment() -> str | None:
    value = (
        os.getenv("LANGFUSE_ENVIRONMENT")
        or os.getenv("CHANDRA_ENV")
        or os.getenv("VERCEL_ENV")
        or os.getenv("NODE_ENV")
        or ""
    ).strip()
    return value or None


def truncate_text(value: Any, max_chars: int = MAX_TRACE_TEXT_CHARS) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars].rsplit(' ', 1)[0]}..."


def sanitize_for_langfuse(value: Any, *, max_chars: int = MAX_TRACE_TEXT_CHARS) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return truncate_text(value, max_chars=max_chars)

    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            normalized_key = key_text.replace("_", "").replace("-", "").lower()
            if any(part in normalized_key for part in SENSITIVE_KEY_PARTS):
                sanitized[key_text] = "[redacted]"
                continue
            sanitized[key_text] = sanitize_for_langfuse(item, max_chars=max_chars)
        return sanitized

    if isinstance(value, (list, tuple)):
        items = [sanitize_for_langfuse(item, max_chars=max_chars) for item in list(value)[:MAX_TRACE_LIST_ITEMS]]
        if len(value) > MAX_TRACE_LIST_ITEMS:
            items.append(f"... {len(value) - MAX_TRACE_LIST_ITEMS} more")
        return items

    return truncate_text(value, max_chars=max_chars)


def summarize_messages_for_langfuse(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for message in messages[-MAX_TRACE_LIST_ITEMS:]:
        role = str(message.get("role") or "")
        content = message.get("content")
        if isinstance(content, list):
            text_parts = [
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            asset_count = len(content) - len(text_parts)
            summary.append(
                {
                    "role": role,
                    "content": truncate_text(" ".join(text_parts)),
                    "asset_part_count": asset_count,
                }
            )
            continue

        summary.append({"role": role, "content": truncate_text(content)})
    return summary


def tutor_trace_input(
    *,
    messages: list[dict[str, Any]],
    class_id: str | None,
    conversation_id: str | None,
    model: str | None,
    route: str,
    attachment_count: int = 0,
) -> dict[str, Any]:
    latest = ""
    for message in reversed(messages):
        if message.get("role") in {"user", "student"}:
            latest = truncate_text(message.get("content"))
            break

    return {
        "attachment_count": attachment_count,
        "class_id": class_id,
        "conversation_id": conversation_id,
        "latest_student_message": latest,
        "message_count": len(messages),
        "model": model,
        "route": route,
    }


def tutor_trace_output(response: dict[str, Any] | None, *, answer: str | None = None) -> dict[str, Any]:
    source = response or {}
    return sanitize_for_langfuse(
        {
            "answer_preview": answer or source.get("content") or source.get("message") or "",
            "finish_reason": source.get("finishReason") or source.get("finish_reason"),
            "retrieval_confidence": source.get("retrievalConfidence"),
            "stage_count": len(source.get("langGraphTrace", {}).get("stages", []) or []),
            "tool_call_count": source.get("langGraphTrace", {}).get("toolCallCount"),
            "usage": source.get("tokenUsage") or source.get("usage"),
        }
    )


def usage_details_for_langfuse(usage: Any) -> dict[str, int] | None:
    if not isinstance(usage, dict):
        return None

    details = {
        "input": int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
        "output": int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
        "total": int(usage.get("total_tokens") or 0),
    }
    reasoning_tokens = int(usage.get("reasoning_tokens") or 0)
    if reasoning_tokens:
        details["reasoning"] = reasoning_tokens
    return details


def langfuse_tags(*, feature: str, route: str, workflow: str | None = None) -> list[str]:
    tags = [f"feature:{feature}", f"route:{route}"]
    if workflow:
        tags.append(f"workflow:{workflow}")
    environment = langfuse_environment()
    if environment:
        tags.append(f"environment:{environment}")
    return tags


@contextmanager
def langfuse_span(
    name: str,
    *,
    input: Any | None = None,
    metadata: dict[str, Any] | None = None,
    output: Any | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    tags: list[str] | None = None,
) -> Iterator[Any | None]:
    client = get_langfuse_client() if langfuse_tracing_enabled() else None
    if client is None:
        yield None
        return

    attributes = {
        "environment": langfuse_environment(),
        "metadata": sanitize_for_langfuse(metadata or {}),
        "tags": tags or [],
        "user_id": user_id,
        "session_id": session_id,
    }
    attributes = {key: value for key, value in attributes.items() if value not in (None, [], {})}

    try:
        from langfuse import propagate_attributes

        with propagate_attributes(**attributes):
            with client.start_as_current_observation(
                as_type="span",
                name=name,
                input=sanitize_for_langfuse(input),
            ) as span:
                yield span
                if output is not None:
                    update_langfuse_observation(span, output=output)
    except Exception:
        yield None


@contextmanager
def langfuse_generation(
    name: str,
    *,
    model: str,
    input: Any | None = None,
    metadata: dict[str, Any] | None = None,
    prompt: Any | None = None,
) -> Iterator[Any | None]:
    client = get_langfuse_client() if langfuse_tracing_enabled() else None
    if client is None:
        yield None
        return

    kwargs = {
        "as_type": "generation",
        "name": name,
        "model": model,
        "input": sanitize_for_langfuse(input),
        "metadata": sanitize_for_langfuse(metadata or {}),
    }
    if prompt is not None:
        kwargs["prompt"] = prompt

    try:
        with client.start_as_current_observation(**kwargs) as generation:
            yield generation
    except Exception:
        yield None


def update_langfuse_observation(
    observation: Any | None,
    *,
    output: Any | None = None,
    usage: Any | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    if observation is None:
        return

    payload: dict[str, Any] = {}
    if output is not None:
        payload["output"] = sanitize_for_langfuse(output)
    usage_details = usage_details_for_langfuse(usage)
    if usage_details:
        payload["usage_details"] = usage_details
    if metadata:
        payload["metadata"] = sanitize_for_langfuse(metadata)

    try:
        observation.update(**payload)
    except TypeError:
        if "usage_details" in payload:
            payload["usage"] = payload.pop("usage_details")
        try:
            observation.update(**payload)
        except Exception:
            return
    except Exception:
        return


def mark_langfuse_error(observation: Any | None, error: BaseException) -> None:
    update_langfuse_observation(
        observation,
        metadata={
            "error_class": error.__class__.__name__,
            "error_message": truncate_text(error, max_chars=400),
        },
    )
    try:
        observation.update(level="ERROR", status_message=truncate_text(error, max_chars=400))
    except Exception:
        return


def flush_langfuse() -> None:
    client = get_langfuse_client() if langfuse_tracing_enabled() else None
    if client is None:
        return

    try:
        client.flush()
    except Exception:
        return
