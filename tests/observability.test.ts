import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  logEvent,
  pingBetterStackHeartbeat,
  redactLogFields
} from "../frontend/lib/observability.ts";

const repoRoot = process.cwd();

test("Next chat route forwards and logs request IDs without logging message content", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /requestIdFromRequest\(request\)/);
  assert.match(source, /"X-Request-Id": requestId/);
  assert.match(source, /logApiRequest\(\{/);
  assert.match(source, /providerErrorClass/);
  assert.match(source, /logChatAccessDecision/);
  assert.match(source, /student_chat\.\$\{decision\}/);
  assert.match(source, /writeAuditLog/);
  assert.doesNotMatch(source, /messages:\s*preparedRequest\.backendRequest\.messages/);
  assert.doesNotMatch(source, /studentMessageContent/);
});

test("Next health route reports frontend dependencies and backend reachability", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/health/route.ts"), "utf8");

  assert.match(source, /betterStackLogging/);
  assert.match(source, /checkBackend/);
  assert.match(source, /checkEmbeddings/);
  assert.match(source, /checkFirebaseAdmin/);
  assert.match(source, /checkFirebaseWebConfig/);
  assert.match(source, /checkFrontendRuntimeConfig/);
  assert.match(source, /checkOpenRouter/);
  assert.match(source, /AbortSignal\.timeout\(1500\)/);
});

test("Next instrumentation hooks capture server and browser unhandled errors", () => {
  const serverSource = readFileSync(join(repoRoot, "frontend/instrumentation.ts"), "utf8");
  const clientSource = readFileSync(join(repoRoot, "frontend/instrumentation-client.ts"), "utf8");

  assert.match(serverSource, /onRequestError/);
  assert.match(serverSource, /unhandledRejection/);
  assert.match(clientSource, /initBrowserErrorMonitoring/);
});

test("Better Stack log redaction removes sensitive fields", () => {
  const redacted = redactLogFields({
    authorization: "Bearer secret-token",
    nested: {
      prompt: "full provider prompt",
      route: "/api/chat"
    },
    requestId: "req-1",
    studentMessageContent: "private student text"
  });

  assert.equal(redacted.authorization, "[REDACTED]");
  assert.deepEqual(redacted.nested, {
    prompt: "[REDACTED]",
    route: "/api/chat"
  });
  assert.equal(redacted.studentMessageContent, "[REDACTED]");
  assert.equal(redacted.requestId, "req-1");
});

test("Better Stack logging failures do not throw", () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.BETTER_STACK_SOURCE_TOKEN;
  const previousHost = process.env.BETTER_STACK_INGESTING_HOST;
  process.env.BETTER_STACK_SOURCE_TOKEN = "test-token";
  process.env.BETTER_STACK_INGESTING_HOST = "in.logs.betterstack.com";
  globalThis.fetch = (() => {
    throw new Error("network unavailable");
  }) as typeof fetch;

  assert.doesNotThrow(() => {
    logEvent("test.event", "info", {
      requestId: "req-1",
      route: "/api/test"
    });
  });

  globalThis.fetch = previousFetch;
  if (previousToken === undefined) {
    delete process.env.BETTER_STACK_SOURCE_TOKEN;
  } else {
    process.env.BETTER_STACK_SOURCE_TOKEN = previousToken;
  }
  if (previousHost === undefined) {
    delete process.env.BETTER_STACK_INGESTING_HOST;
  } else {
    process.env.BETTER_STACK_INGESTING_HOST = previousHost;
  }
});

test("Better Stack heartbeat failures do not throw scheduled jobs", () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("heartbeat unavailable");
  }) as typeof fetch;

  assert.doesNotThrow(() => {
    pingBetterStackHeartbeat("https://uptime.betterstack.com/api/v1/heartbeat/test", "test.job");
  });

  globalThis.fetch = previousFetch;
});

test("scheduled job routes ping Better Stack heartbeats after success", () => {
  const retentionRoute = readFileSync(
    join(repoRoot, "frontend/app/api/admin/retention/conversations/route.ts"),
    "utf8"
  );
  const learningProfileRoute = readFileSync(
    join(repoRoot, "frontend/app/api/student-learning-profiles/weekly/route.ts"),
    "utf8"
  );

  assert.match(retentionRoute, /BETTER_STACK_RETENTION_HEARTBEAT_URL/);
  assert.match(retentionRoute, /pingBetterStackHeartbeat/);
  assert.match(learningProfileRoute, /BETTER_STACK_LEARNING_PROFILE_HEARTBEAT_URL/);
  assert.match(learningProfileRoute, /pingBetterStackHeartbeat/);
});

test("Langfuse tracing captures tutor workflows without raw payload fields", () => {
  const backendSource = readFileSync(join(repoRoot, "backend/langfuse_observability.py"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");
  const mainSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");
  const nextTracingSource = readFileSync(join(repoRoot, "frontend/lib/langfuse-tracing.ts"), "utf8");

  assert.match(backendSource, /SENSITIVE_KEY_PARTS/);
  assert.match(backendSource, /summarize_messages_for_langfuse/);
  assert.match(backendSource, /flush_langfuse/);
  assert.match(graphSource, /traced_openrouter_chat/);
  assert.match(graphSource, /prompt_key="primary_tutor_turn"/);
  assert.match(mainSource, /fastapi\.langgraph-chat/);
  assert.match(mainSource, /fastapi\.legacy-openrouter-chat/);
  assert.match(nextTracingSource, /LangfuseSpanProcessor/);
  assert.match(nextTracingSource, /exportMode: "immediate"/);
});

test("Langfuse eval runner includes practical score categories", () => {
  const source = readFileSync(join(repoRoot, "scripts/run-langfuse-evals.mjs"), "utf8");
  const dataset = readFileSync(join(repoRoot, "evals/chandra-tutor-core.json"), "utf8");

  assert.match(source, /correctness_task_success/);
  assert.match(source, /groundedness_faithfulness/);
  assert.match(source, /safety_refusal_behavior/);
  assert.match(source, /output_format_validity/);
  assert.match(source, /latency_metadata_present/);
  assert.match(source, /CHANDRA_EVAL_USE_LLM_JUDGE/);
  assert.match(dataset, /answer-shopping-no-work/);
  assert.match(dataset, /grounded-source-answer/);
});
