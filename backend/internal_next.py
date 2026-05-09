from __future__ import annotations

import os

import httpx


def internal_next_base_url(production_context: str) -> str:
    configured_url = os.getenv("NEXT_INTERNAL_BASE_URL") or os.getenv("FRONTEND_ORIGIN")

    if configured_url:
        return configured_url.rstrip("/")

    if os.getenv("CHANDRA_ENV", "").strip().lower() in {"prod", "production"}:
        raise RuntimeError(f"NEXT_INTERNAL_BASE_URL or FRONTEND_ORIGIN is required for production {production_context}.")

    return "http://127.0.0.1:3000"


def reusable_async_client(client: httpx.AsyncClient | None, *, timeout: float) -> httpx.AsyncClient:
    if client is not None and not getattr(client, "is_closed", False):
        return client

    try:
        return httpx.AsyncClient(
            timeout=timeout,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        )
    except TypeError:
        return httpx.AsyncClient(timeout=timeout)
