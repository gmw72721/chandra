from __future__ import annotations

import contextvars
import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx

_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")
_user_id: contextvars.ContextVar[str] = contextvars.ContextVar("user_id", default="")
_class_id: contextvars.ContextVar[str] = contextvars.ContextVar("class_id", default="")
_logger = logging.getLogger("chandra")
_SENSITIVE_KEY_RE = re.compile(
    r"(authorization|token|secret|password|privatekey|private_key|apikey|api_key|content|messagecontent|messages|prompt|profile|learningprofile|filecontents|uploadedfile|extractedtext)",
    re.I,
)


def configure_logging() -> None:
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO)


def current_request_id() -> str:
    return _request_id.get()


def current_user_id() -> str:
    return _user_id.get()


def current_class_id() -> str:
    return _class_id.get()


def set_request_id(value: str) -> contextvars.Token[str]:
    return _request_id.set(safe_request_id(value) or create_request_id())


def reset_request_id(token: contextvars.Token[str]) -> None:
    _request_id.reset(token)


def set_current_user_id(value: str) -> None:
    if value:
        _user_id.set(value)


def clear_current_user_id() -> None:
    _user_id.set("")


def set_current_class_id(value: str) -> None:
    if value:
        _class_id.set(value)


def clear_current_class_id() -> None:
    _class_id.set("")


def create_request_id() -> str:
    return str(uuid.uuid4())


def safe_request_id(value: str | None) -> str:
    candidate = (value or "").strip()

    if not candidate or len(candidate) > 128:
        return ""

    if not all(character.isalnum() or character in "_.:/-" for character in candidate):
        return ""

    return candidate


def log_event(event: str, level: str = "info", **fields: Any) -> None:
    payload = redact_log_fields({
        "dt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": better_stack_environment(),
        "event": event,
        "level": level,
        "message": event,
        "service": "chandra-backend",
        **{key: value for key, value in fields.items() if value not in (None, "")},
    })
    message = json.dumps(payload, default=str, separators=(",", ":"))

    if level == "error":
        _logger.error(message)
    elif level == "warning":
        _logger.warning(message)
    else:
        _logger.info(message)

    send_better_stack_log(payload)


def log_request(*, route: str, method: str, status: int, latency_ms: float) -> None:
    log_event(
        "api.request",
        route=route,
        method=method,
        status=status,
        latencyMs=round(latency_ms),
        requestId=current_request_id(),
        userId=current_user_id(),
    )


def log_provider_failure(
    *,
    provider: str,
    provider_error_class: str,
    provider_status: int | None = None,
) -> None:
    log_event(
        "provider.failure",
        level="error",
        provider=provider,
        providerErrorClass=provider_error_class,
        providerStatus=provider_status,
        requestId=current_request_id(),
        classId=current_class_id(),
        userId=current_user_id(),
    )


async def capture_exception(error: BaseException, **context: Any) -> None:
    log_event(
        context.pop("event", "error.captured"),
        level="error",
        errorClass=error.__class__.__name__,
        requestId=current_request_id(),
        userId=current_user_id(),
        **context,
    )


def redact_log_fields(fields: dict[str, Any]) -> dict[str, Any]:
    return redact_value(fields)


def better_stack_logging_status() -> dict[str, Any]:
    source_token = os.getenv("BETTER_STACK_SOURCE_TOKEN", "").strip()
    ingesting_host = os.getenv("BETTER_STACK_INGESTING_HOST", "").strip()

    return {
        "environment": better_stack_environment(),
        "ingestingHostConfigured": bool(ingesting_host),
        "sourceTokenConfigured": bool(source_token),
        "status": "ok" if source_token and ingesting_host else "missing_config",
    }


def send_better_stack_log(payload: dict[str, Any]) -> None:
    endpoint = better_stack_ingest_endpoint()
    source_token = os.getenv("BETTER_STACK_SOURCE_TOKEN", "").strip()

    if not endpoint or not source_token:
        return

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(post_better_stack_log(endpoint, source_token, payload))
    except RuntimeError:
        return


async def post_better_stack_log(endpoint: str, source_token: str, payload: dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            await client.post(
                endpoint,
                headers={
                    "Authorization": f"Bearer {source_token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except Exception:
        return


def better_stack_ingest_endpoint() -> str:
    host = os.getenv("BETTER_STACK_INGESTING_HOST", "").strip()

    if not host:
        return ""

    candidate = host if host.startswith("http") else f"https://{host}"
    parsed = urlparse(candidate)

    if not parsed.scheme or not parsed.netloc:
        return ""

    return candidate.rstrip("/")


def better_stack_environment() -> str:
    return "production" if os.getenv("BETTER_STACK_ENV", "").strip().lower() == "production" else "development"


def redact_value(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_value(item) for item in value]

    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if _SENSITIVE_KEY_RE.search(str(key)) else redact_value(nested_value)
            for key, nested_value in value.items()
        }

    return value
