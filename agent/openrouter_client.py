from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
from pathlib import Path
from typing import Any

import httpx


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
        self.http_referer = http_referer or os.getenv("OPENROUTER_HTTP_REFERER") or "http://localhost:3000"
        self.max_retries = max(0, max_retries)
        self.timeout = timeout
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
        response.raise_for_status()
        completion = response.json()
        choice = completion.get("choices", [{}])[0]
        message = choice.get("message") or {}

        return {
            "content": message.get("content") or "",
            "finish_reason": choice.get("finish_reason"),
            "tool_calls": message.get("tool_calls") or [],
            "raw": completion,
        }

    async def _post_chat_completion(self, payload: dict[str, Any]) -> httpx.Response:
        client = self._get_http_client()

        for attempt in range(self.max_retries + 1):
            try:
                return await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                        "HTTP-Referer": self.http_referer,
                        "X-Title": self.app_title,
                    },
                    json=payload,
                )
            except (httpx.TransportError, httpx.TimeoutException) as error:
                if attempt >= self.max_retries:
                    raise RuntimeError(
                        "The model provider connection dropped while Chandra was generating the answer. "
                        "Please try again."
                    ) from error

                await asyncio.sleep(0.35 * (attempt + 1))

        raise RuntimeError("The model provider did not return a response.")

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._client is None or getattr(self._client, "is_closed", False):
            self._client = httpx.AsyncClient(timeout=self.timeout)

        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


def model_supports_reasoning_effort(model: str) -> bool:
    normalized_model = model.lower()

    return (
        normalized_model.startswith("openai/o")
        or "openai/gpt-5" in normalized_model
        or "reasoning" in normalized_model
    )


def encode_file_as_data_url(path: str | Path, fallback_mime_type: str = "application/octet-stream") -> str:
    """Read a local asset and return an OpenRouter-compatible base64 data URL."""

    asset_path = Path(path)
    mime_type = mimetypes.guess_type(asset_path.name)[0] or fallback_mime_type
    encoded = base64.b64encode(asset_path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"
