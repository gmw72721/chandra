import assert from "node:assert/strict";
import test from "node:test";
import {
  __clearTeacherAssistantContextsForTests,
  __setTeacherAssistantClassSnapshotLoaderForTests,
  mintTeacherAssistantContext
} from "../frontend/lib/teacher-assistant/assistant-context.ts";
import { __clearPendingTeacherAssistantActionsForTests } from "../frontend/lib/teacher-assistant/confirmations.ts";
import { handleTeacherAssistantToolCallback } from "../frontend/lib/teacher-assistant/tool-callback.ts";

const previousSecret = process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET;

test.after(() => {
  process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET = previousSecret;
});

test("internal assistant tool callback rejects missing or invalid shared secret", async () => {
  __clearTeacherAssistantContextsForTests();
  process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET = "secret-1";

  const missing = await handleTeacherAssistantToolCallback(buildRequest({ secret: "" }));
  assert.equal(missing.status, 401);

  const invalid = await handleTeacherAssistantToolCallback(buildRequest({ secret: "wrong" }));
  assert.equal(invalid.status, 401);
});

test("internal assistant tool callback rejects expired context and unallowed tools", async () => {
  __clearTeacherAssistantContextsForTests();
  process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET = "secret-1";
  const expired = await mintTeacherAssistantContext({
    actorUid: "teacher-1",
    allowedToolNames: ["navigate_teacher_tab"],
    classId: "class-1",
    now: 1_000,
    sessionId: "session-1",
    ttlMs: 1
  });

  const expiredResult = await handleTeacherAssistantToolCallback(
    buildRequest({
      body: {
        assistantContextId: expired.id,
        toolName: "navigate_teacher_tab"
      },
      now: 2_000,
      secret: "secret-1"
    })
  );
  assert.equal(expiredResult.status, 401);

  const context = await mintTeacherAssistantContext({
    actorUid: "teacher-1",
    allowedToolNames: ["navigate_teacher_tab"],
    classId: "class-1",
    sessionId: "session-1"
  });
  const unallowedResult = await handleTeacherAssistantToolCallback(
    buildRequest({
      body: {
        assistantContextId: context.id,
        toolName: "update_notification_settings"
      },
      secret: "secret-1"
    })
  );
  assert.equal(unallowedResult.status, 403);
});

test("internal assistant tool callback executes allowed navigation through registry", async () => {
  __clearTeacherAssistantContextsForTests();
  process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET = "secret-1";
  __setTeacherAssistantClassSnapshotLoaderForTests(async () => ({
    data: { teacherId: "teacher-1" },
    exists: true,
    id: "class-1"
  }));
  const context = await mintTeacherAssistantContext({
    actorUid: "teacher-1",
    allowedToolNames: ["navigate_teacher_tab"],
    classId: "class-1",
    sessionId: "session-1"
  });

  const result = await handleTeacherAssistantToolCallback(
    buildRequest({
      body: {
        args: { classId: "class-1", tab: "roster" },
        assistantContextId: context.id,
        toolName: "navigate_teacher_tab"
      },
      secret: "secret-1"
    })
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "success");
  assert.equal(result.body.action?.kind, "navigate");
});

test("internal assistant tool callback preserves confirmation for notification settings writes", async () => {
  __clearTeacherAssistantContextsForTests();
  __clearPendingTeacherAssistantActionsForTests();
  process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET = "secret-1";
  __setTeacherAssistantClassSnapshotLoaderForTests(async () => ({
    data: {
      notificationSettings: {
        followUpReminders: true,
        newStudentJoinedClass: true,
        weeklyDigest: true
      },
      teacherId: "teacher-1"
    },
    exists: true,
    id: "class-1"
  }));
  const context = await mintTeacherAssistantContext({
    actorUid: "teacher-1",
    allowedToolNames: ["update_notification_settings"],
    classId: "class-1",
    sessionId: "session-1"
  });

  const result = await handleTeacherAssistantToolCallback(
    buildRequest({
      body: {
        args: { patch: { weeklyDigest: false } },
        assistantContextId: context.id,
        toolName: "update_notification_settings"
      },
      secret: "secret-1"
    })
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmation_required");
  assert.equal(result.body.action?.kind, "confirmation");
});

function buildRequest(input: {
  body?: Record<string, unknown>;
  now?: number;
  secret?: string;
} = {}) {
  return new Request("https://chandra.example/api/internal/teacher-assistant/tools", {
    body: JSON.stringify(
      input.body ?? {
        assistantContextId: "missing",
        toolName: "navigate_teacher_tab"
      }
    ),
    headers: input.secret
      ? {
          "content-type": "application/json",
          "x-chandra-assistant-tool-secret": input.secret
        }
      : {
          "content-type": "application/json"
        },
    method: "POST"
  });
}
