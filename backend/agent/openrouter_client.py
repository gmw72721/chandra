from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import ssl
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from backend.observability import capture_exception, log_provider_failure


class OpenRouterClient:
    """Small async OpenRouter wrapper that is easy to replace in tests."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        app_title: str | None = None,
        http_referer: str | None = None,
        max_retries: int = 2,
        timeout: float = 60.0,
    ) -> None:
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY", "")
        self.base_url = (base_url or os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
        self.app_title = app_title or os.getenv("OPENROUTER_APP_TITLE") or "Chandra"
        self.http_referer = http_referer or openrouter_http_referer()
        self.max_retries = max(0, max_retries)
        self.timeout = timeout
        self._chat_completions_url = f"{self.base_url}/chat/completions"
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.http_referer,
            "X-Title": self.app_title,
        }
        self._client: httpx.AsyncClient | None = None

    async def chat(
        self,
        *,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        parallel_tool_calls: bool = True,
        temperature: float = 0.4,
        max_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required for LangGraph tutor chat.")

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }

        if max_tokens:
            payload["max_tokens"] = max_tokens

        if reasoning_effort and model_supports_reasoning_effort(model):
            payload["reasoning"] = {"effort": reasoning_effort}

        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"
            payload["parallel_tool_calls"] = parallel_tool_calls

        response = await self._post_chat_completion(payload)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            log_provider_failure(
                provider="openrouter",
                provider_error_class=error.__class__.__name__,
                provider_status=error.response.status_code,
            )
            await capture_exception(
                error,
                event="provider.openrouter_error",
                provider="openrouter",
                providerErrorClass=error.__class__.__name__,
                providerStatus=error.response.status_code,
            )
            raise
        completion = response.json()
        choice = completion.get("choices", [{}])[0]
        message = choice.get("message") or {}

        return {
            "content": message.get("content") or "",
            "finish_reason": choice.get("finish_reason"),
            "tool_calls": message.get("tool_calls") or [],
            "usage": normalize_token_usage(completion.get("usage")),
            "raw": completion,
        }

    async def _post_chat_completion(self, payload: dict[str, Any]) -> httpx.Response:
        for attempt in range(self.max_retries + 1):
            try:
                client = self._get_http_client()
                response = await client.post(
                    self._chat_completions_url,
                    headers=self._headers,
                    json=payload,
                )
                status_code = getattr(response, "status_code", 200)
                if status_code not in {429, 500, 502, 503, 504} or attempt >= self.max_retries:
                    return response

                await asyncio.sleep(openrouter_retry_delay(response, attempt))
            except (httpx.TransportError, httpx.TimeoutException, ssl.SSLError) as error:
                await self.aclose()

                if attempt >= self.max_retries:
                    log_provider_failure(
                        provider="openrouter",
                        provider_error_class=error.__class__.__name__,
                    )
                    await capture_exception(
                        error,
                        event="provider.openrouter_transport_error",
                        provider="openrouter",
                        providerErrorClass=error.__class__.__name__,
                    )
                    raise RuntimeError(
                        "The model provider connection dropped while Chandra was generating the answer. "
                        "Please try again."
                    ) from error

                await asyncio.sleep(0.35 * (attempt + 1))

        raise RuntimeError("The model provider did not return a response.")

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._client is None or getattr(self._client, "is_closed", False):
            self._client = make_async_client(timeout=self.timeout)

        return self._client

    async def aclose(self) -> None:
        if self._client is not None and hasattr(self._client, "aclose"):
            await self._client.aclose()
            self._client = None


def make_async_client(*, timeout: float) -> httpx.AsyncClient:
    try:
        return httpx.AsyncClient(
            timeout=timeout,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        )
    except TypeError:
        return httpx.AsyncClient(timeout=timeout)


def openrouter_http_referer() -> str:
    configured = (os.getenv("OPENROUTER_HTTP_REFERER") or os.getenv("FRONTEND_ORIGIN") or "").strip()

    if configured:
        return configured.rstrip("/")

    if os.getenv("CHANDRA_ENV", "").strip().lower() in {"prod", "production"}:
        raise RuntimeError("OPENROUTER_HTTP_REFERER or FRONTEND_ORIGIN is required in production.")

    return "http://localhost:3000"


def openrouter_retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return min(8.0, max(0.5, float(retry_after)))
        except ValueError:
            pass

    return min(8.0, 0.75 * (2**attempt))


@lru_cache(maxsize=128)
def model_supports_reasoning_effort(model: str) -> bool:
    normalized_model = model.lower()

    return (
        normalized_model.startswith("openai/o")
        or "openai/gpt-5" in normalized_model
        or "reasoning" in normalized_model
    )


def normalize_token_usage(usage: Any) -> dict[str, int]:
    if not isinstance(usage, dict):
        return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "reasoning_tokens": 0}

    input_tokens = nonnegative_int(usage.get("prompt_tokens") or usage.get("input_tokens"))
    output_tokens = nonnegative_int(usage.get("completion_tokens") or usage.get("output_tokens"))
    total_tokens = nonnegative_int(usage.get("total_tokens"))
    reasoning_tokens = normalize_reasoning_tokens(usage)

    if total_tokens <= 0:
        total_tokens = input_tokens + output_tokens + reasoning_tokens

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "reasoning_tokens": reasoning_tokens,
    }


def normalize_reasoning_tokens(usage: dict[str, Any]) -> int:
    for details_key in ("completion_tokens_details", "output_tokens_details"):
        details = usage.get(details_key)
        if isinstance(details, dict):
            reasoning_tokens = nonnegative_int(details.get("reasoning_tokens"))
            if reasoning_tokens:
                return reasoning_tokens

    return nonnegative_int(
        usage.get("reasoning_tokens")
        or usage.get("reasoningTokens")
        or usage.get("reasoning")
    )


def nonnegative_int(value: Any) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return 0

    return max(0, numeric)


def encode_file_as_data_url(path: str | Path, fallback_mime_type: str = "application/octet-stream") -> str:
    """Read a local asset and return an OpenRouter-compatible base64 data URL."""

    asset_path = Path(path)
    stat = asset_path.stat()
    return _encode_file_as_data_url_cached(str(asset_path), stat.st_mtime_ns, stat.st_size, fallback_mime_type)


@lru_cache(maxsize=128)
def _encode_file_as_data_url_cached(
    path: str,
    _mtime_ns: int,
    _size: int,
    fallback_mime_type: str,
) -> str:
    asset_path = Path(path)
    mime_type = mimetypes.guess_type(asset_path.name)[0] or fallback_mime_type
    encoded = base64.b64encode(asset_path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"
