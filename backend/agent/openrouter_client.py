from __future__ import annotations

import asyncio
import base64
import json
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
        response_format: dict[str, Any] | None = None,
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

        if response_format:
            payload["response_format"] = response_format

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

    async def stream_chat(
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
        response_format: dict[str, Any] | None = None,
    ):
        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required for LangGraph tutor chat.")

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        if max_tokens:
            payload["max_tokens"] = max_tokens

        if reasoning_effort and model_supports_reasoning_effort(model):
            payload["reasoning"] = {"effort": reasoning_effort}

        if response_format:
            payload["response_format"] = response_format

        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"
            payload["parallel_tool_calls"] = parallel_tool_calls

        content_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        finish_reason: str | None = None
        usage = empty_token_usage()
        raw_chunks: list[dict[str, Any]] = []

        async for chunk in self._stream_chat_completion_chunks(payload):
            raw_chunks.append(chunk)
            if chunk.get("usage") is not None:
                usage = normalize_token_usage(chunk.get("usage"))
                yield {"type": "usage", "usage": usage}

            for choice in chunk.get("choices") or []:
                if not isinstance(choice, dict):
                    continue

                if choice.get("finish_reason") is not None:
                    finish_reason = choice.get("finish_reason")
                    yield {"type": "finish", "finish_reason": finish_reason}

                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                content_delta = delta.get("content")
                if isinstance(content_delta, str) and content_delta:
                    content_parts.append(content_delta)
                    yield {"type": "content_delta", "delta": content_delta}

                for tool_call in accumulate_tool_call_deltas(tool_calls, delta.get("tool_calls")):
                    yield {"type": "tool_call_delta", "tool_call": tool_call}

        yield {
            "type": "done",
            "response": {
                "content": "".join(content_parts),
                "finish_reason": finish_reason,
                "tool_calls": normalized_accumulated_tool_calls(tool_calls),
                "usage": usage,
                "raw": {"chunks": raw_chunks},
            },
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

    async def _stream_chat_completion_chunks(self, payload: dict[str, Any]):
        for attempt in range(self.max_retries + 1):
            try:
                client = self._get_http_client()
                async with client.stream(
                    "POST",
                    self._chat_completions_url,
                    headers=self._headers,
                    json=payload,
                ) as response:
                    status_code = getattr(response, "status_code", 200)
                    if status_code in {429, 500, 502, 503, 504} and attempt < self.max_retries:
                        await response.aread()
                        await asyncio.sleep(openrouter_retry_delay(response, attempt))
                        continue

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

                    async for chunk in parse_openrouter_sse_response(response):
                        yield chunk
                    return
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

        raise RuntimeError("The model provider did not return a streaming response.")

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


async def parse_openrouter_sse_response(response: Any):
    data_lines: list[str] = []

    async for raw_line in response.aiter_lines():
        line = raw_line.strip("\r")
        if not line:
            if data_lines:
                payload = "\n".join(data_lines).strip()
                data_lines = []
                if payload == "[DONE]":
                    return
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk, dict):
                    yield chunk
            continue

        if line.startswith(":"):
            continue

        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())

    if data_lines:
        payload = "\n".join(data_lines).strip()
        if payload and payload != "[DONE]":
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                return
            if isinstance(chunk, dict):
                yield chunk


def accumulate_tool_call_deltas(tool_calls: dict[int, dict[str, Any]], deltas: Any) -> list[dict[str, Any]]:
    if not isinstance(deltas, list):
        return []

    normalized: list[dict[str, Any]] = []
    for fallback_index, delta in enumerate(deltas):
        if not isinstance(delta, dict):
            continue

        index = nonnegative_int(delta.get("index")) if "index" in delta else fallback_index
        existing = tool_calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
        if delta.get("id"):
            existing["id"] = delta.get("id")
        if delta.get("type"):
            existing["type"] = delta.get("type")

        function_delta = delta.get("function") if isinstance(delta.get("function"), dict) else {}
        function = existing.setdefault("function", {"name": "", "arguments": ""})
        if function_delta.get("name"):
            function["name"] = f"{function.get('name') or ''}{function_delta.get('name')}"
        if function_delta.get("arguments"):
            function["arguments"] = f"{function.get('arguments') or ''}{function_delta.get('arguments')}"
        normalized.append(dict(existing))

    return normalized


def normalized_accumulated_tool_calls(tool_calls: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    return [tool_calls[index] for index in sorted(tool_calls)]


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
        return empty_token_usage()

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


def empty_token_usage() -> dict[str, int]:
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "reasoning_tokens": 0}


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
