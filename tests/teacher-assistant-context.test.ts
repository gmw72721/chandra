import assert from "node:assert/strict";
import test from "node:test";
import {
  __clearTeacherAssistantContextsForTests,
  __setTeacherAssistantClassSnapshotLoaderForTests,
  mintTeacherAssistantContext,
  resolveTeacherAssistantContext,
  resolveTeacherAssistantContextForTool
} from "../frontend/lib/teacher-assistant/assistant-context.ts";

test("assistant context mints and resolves a short-lived server-side context", () => {
  __clearTeacherAssistantContextsForTests();
  const context = mintTeacherAssistantContext({
    actorEmail: "teacher@example.com",
    actorUid: "teacher-1",
    allowedToolNames: ["navigate_teacher_tab"],
    classId: "class-1",
    now: 1_000,
    sessionId: "session-1",
    ttlMs: 500
  });

  assert.equal(resolveTeacherAssistantContext(context.id, 1_250)?.actorUid, "teacher-1");
  assert.equal(resolveTeacherAssistantContext(context.id, 1_501), null);
});

test("assistant context resolver rejects unallowed tools and rechecks current class access", async () => {
  __clearTeacherAssistantContextsForTests();
  const context = mintTeacherAssistantContext({
    actorUid: "teacher-1",
    allowedToolNames: ["navigate_teacher_tab"],
    classId: "class-1",
    sessionId: "session-1"
  });

  __setTeacherAssistantClassSnapshotLoaderForTests(async () => ({
    data: { teacherId: "teacher-1" },
    exists: true,
    id: "class-1"
  }));

  const resolved = await resolveTeacherAssistantContextForTool({
    assistantContextId: context.id,
    toolName: "navigate_teacher_tab"
  });
  assert.equal(resolved.actor.uid, "teacher-1");

  await assert.rejects(
    resolveTeacherAssistantContextForTool({
      assistantContextId: context.id,
      toolName: "update_notification_settings"
    }),
    /not allowed/
  );

  __setTeacherAssistantClassSnapshotLoaderForTests(async () => ({
    data: { teacherId: "other-teacher" },
    exists: true,
    id: "class-1"
  }));

  await assert.rejects(
    resolveTeacherAssistantContextForTool({
      assistantContextId: context.id,
      toolName: "navigate_teacher_tab"
    }),
    /permission/
  );
});
