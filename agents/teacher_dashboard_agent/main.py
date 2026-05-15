import json
import os
from collections.abc import AsyncIterator
from typing import Any

import vertexai
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from vertexai.agent_engines import AdkApp

from agent import root_agent


project = os.getenv("GOOGLE_CLOUD_PROJECT")
location = os.getenv("GOOGLE_CLOUD_LOCATION") or os.getenv("GEMINI_AGENT_LOCATION") or "global"

if project:
    vertexai.init(project=project, location=location)

adk_app = AdkApp(agent=root_agent, enable_tracing=None)
adk_app_is_ready = False

app = FastAPI(title="Chandra Teacher Dashboard Agent")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/")
@app.post("/query")
async def query(request: Request) -> JSONResponse:
    body = await request.json()
    class_method, input_payload = parse_agent_runtime_body(body)
    ensure_adk_app_ready()

    if class_method == "async_create_session":
        output = await adk_app.async_create_session(**input_payload)
        return JSONResponse({"output": to_jsonable(output)})

    if class_method == "async_stream_query":
        events = [to_jsonable(event) async for event in call_stream_query(input_payload)]
        return JSONResponse({"output": events})

    raise HTTPException(status_code=400, detail=f"Unsupported class_method: {class_method}")


@app.post("/streamQuery")
async def stream_query(request: Request) -> StreamingResponse:
    body = await request.json()
    class_method, input_payload = parse_agent_runtime_body(body)
    ensure_adk_app_ready()

    if class_method != "async_stream_query":
        raise HTTPException(status_code=400, detail=f"Unsupported stream class_method: {class_method}")

    async def event_source() -> AsyncIterator[str]:
        async for event in call_stream_query(input_payload):
            yield f"data: {json.dumps({'output': to_jsonable(event)}, separators=(',', ':'))}\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream")


def ensure_adk_app_ready() -> None:
    global adk_app_is_ready
    if not adk_app_is_ready:
        adk_app.set_up()
        adk_app_is_ready = True


async def call_stream_query(input_payload: dict[str, Any]) -> AsyncIterator[Any]:
    payload = dict(input_payload)
    payload.pop("assistant_context_id", None)
    payload.pop("chandra_context", None)

    async for event in adk_app.async_stream_query(**payload):
        yield event


def parse_agent_runtime_body(body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    class_method = body.get("class_method") or body.get("classMethod")
    input_payload = body.get("input") or {}

    if not class_method:
        raise HTTPException(status_code=400, detail="Missing class_method.")
    if not isinstance(input_payload, dict):
        raise HTTPException(status_code=400, detail="input must be an object.")

    return class_method, input_payload


def to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return to_jsonable(value.model_dump(exclude_none=True))
    if hasattr(value, "dict"):
        return to_jsonable(value.dict())
    return str(value)
