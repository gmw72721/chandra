from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

LANGFUSE_PRODUCTION_LABEL = "production"


def has_langfuse_prompt_config() -> bool:
    return bool(
        os.getenv("LANGFUSE_PUBLIC_KEY")
        and os.getenv("LANGFUSE_SECRET_KEY")
        and os.getenv("LANGFUSE_HOST")
    )


@lru_cache(maxsize=1)
def get_langfuse_client() -> Any | None:
    if not has_langfuse_prompt_config():
        return None

    host = os.getenv("LANGFUSE_HOST")
    if host and not os.getenv("LANGFUSE_BASE_URL"):
        os.environ["LANGFUSE_BASE_URL"] = host

    try:
        from langfuse import get_client

        return get_client()
    except Exception:
        return None


_get_langfuse_client = get_langfuse_client


@dataclass(frozen=True)
class CompiledLangfusePrompt:
    text: str
    prompt: Any | None = None
    used_fallback: bool = True


def compile_langfuse_text_prompt_with_metadata(
    name: str,
    *,
    fallback: str,
    variables: dict[str, str] | None = None,
) -> CompiledLangfusePrompt:
    client = _get_langfuse_client()

    if client is None:
        return CompiledLangfusePrompt(text=fallback)

    try:
        prompt = client.get_prompt(
            name,
            fallback=fallback,
            label=LANGFUSE_PRODUCTION_LABEL,
            type="text",
        )
        compiled = prompt.compile(**(variables or {}))
        if not isinstance(compiled, str):
            return CompiledLangfusePrompt(text=fallback)

        used_fallback = bool(getattr(prompt, "is_fallback", False))
        return CompiledLangfusePrompt(
            text=compiled,
            prompt=None if used_fallback else prompt,
            used_fallback=used_fallback,
        )
    except Exception:
        return CompiledLangfusePrompt(text=fallback)


def compile_langfuse_text_prompt(
    name: str,
    *,
    fallback: str,
    variables: dict[str, str] | None = None,
) -> str:
    return compile_langfuse_text_prompt_with_metadata(
        name,
        fallback=fallback,
        variables=variables,
    ).text


def get_langfuse_prompt_for_trace(name: str) -> Any | None:
    client = _get_langfuse_client()

    if client is None:
        return None

    try:
        return client.get_prompt(name, label=LANGFUSE_PRODUCTION_LABEL, type="text")
    except Exception:
        return None
