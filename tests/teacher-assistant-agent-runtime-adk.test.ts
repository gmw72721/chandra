import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentRuntimeUrl,
  buildCreateSessionBody,
  buildStreamQueryBody,
  getAgentRuntimeConfig
} from "../frontend/lib/teacher-assistant/providers/agent-runtime-adk.ts";
import type { AssistantTurnInput } from "../frontend/lib/teacher-assistant/types.ts";

test("Agent Runtime provider builds regional REST URLs and ADK method bodies", () => {
  const config = {
    location: "us-central1",
    resource: "projects/project-1/locations/us-central1/reasoningEngines/123"
  };
  const input: AssistantTurnInput = {
    actorUid: "teacher-1",
    assistantContextId: "ctx-1",
    chatHistory: [
      { content: "Open sources", role: "user" },
      { content: "I opened the Sources tab.", role: "assistant" }
    ],
    classId: "class-1",
    message: "Open roster",
    sanitizedContext: {
      allowedToolNames: ["navigate_teacher_tab"],
      classId: "class-1",
      expiresAt: 1_000,
      sessionId: "session-1"
    },
    sessionId: "session-1"
  };

  assert.equal(
    buildAgentRuntimeUrl(config, "streamQuery"),
    "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/reasoningEngines/123:streamQuery?alt=sse"
  );
  assert.deepEqual(buildCreateSessionBody("teacher-1"), {
    class_method: "async_create_session",
    input: {
      user_id: "teacher-1"
    }
  });

  const body = buildStreamQueryBody(input, "remote-session-1");
  assert.equal(body.class_method, "async_stream_query");
  assert.equal(body.input.session_id, "remote-session-1");
  assert.match(body.input.message, /assistant_context_id: ctx-1/);
  assert.match(body.input.message, /allowed_tool_names: navigate_teacher_tab/);
  assert.match(body.input.message, /Recent chat history:/);
  assert.match(body.input.message, /Teacher: Open sources/);
  assert.match(body.input.message, /Assistant: I opened the Sources tab\./);
  assert.equal("assistant_context_id" in body.input, false);
  assert.equal("chandra_context" in body.input, false);
});

test("Agent Runtime config fails clearly when resource is missing or malformed", () => {
  const previousResource = process.env.GEMINI_AGENT_RUNTIME_RESOURCE;
  const previousLocation = process.env.GEMINI_AGENT_LOCATION;

  delete process.env.GEMINI_AGENT_RUNTIME_RESOURCE;
  delete process.env.GEMINI_AGENT_LOCATION;
  assert.throws(() => getAgentRuntimeConfig(), /GEMINI_AGENT_RUNTIME_RESOURCE/);

  process.env.GEMINI_AGENT_RUNTIME_RESOURCE = "bad-resource";
  assert.throws(() => getAgentRuntimeConfig(), /must look like/);

  process.env.GEMINI_AGENT_RUNTIME_RESOURCE = "projects/project-1/locations/global/reasoningEngines/123";
  assert.equal(getAgentRuntimeConfig().location, "global");

  restoreEnv("GEMINI_AGENT_RUNTIME_RESOURCE", previousResource);
  restoreEnv("GEMINI_AGENT_LOCATION", previousLocation);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
