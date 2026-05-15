import assert from "node:assert/strict";
import test from "node:test";
import {
  __clearPendingTeacherAssistantActionsForTests
} from "../frontend/lib/teacher-assistant/confirmations.ts";
import { executeTeacherAssistantToolWithActor } from "../frontend/lib/teacher-assistant/tool-registry.ts";

const actor = {
  classData: {
    notificationSettings: {
      followUpReminders: true,
      newStudentJoinedClass: true,
      weeklyDigest: true
    }
  },
  email: "teacher@example.com",
  uid: "teacher-1"
};

test("teacher assistant requires confirmation before notification settings writes", async () => {
  __clearPendingTeacherAssistantActionsForTests();

  const result = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", patch: { weeklyDigest: false } },
    classId: "class-1",
    toolName: "update_notification_settings"
  });

  assert.equal(result.status, "confirmation_required");
  assert.equal(result.action?.kind, "confirmation");
  assert.match(result.summary, /weekly digest off/);
});

test("teacher assistant approval validates actor and writes allowlisted notification settings", async () => {
  __clearPendingTeacherAssistantActionsForTests();
  const prepared = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", patch: { weeklyDigest: false } },
    classId: "class-1",
    toolName: "update_notification_settings"
  });

  assert.equal(prepared.action?.kind, "confirmation");

  let appliedPatch: unknown = null;
  const approved = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", patch: { weeklyDigest: false } },
    classId: "class-1",
    confirmation: {
      decision: "approved",
      pendingActionId: prepared.action.pendingActionId
    },
    dependencies: {
      applyNotificationSettingsUpdate: async ({ patch }) => {
        appliedPatch = patch;
        return {
          after: {
            followUpReminders: true,
            newStudentJoinedClass: true,
            weeklyDigest: false
          },
          before: actor.classData.notificationSettings,
          changed: true,
          patch,
          summary: "Update notification settings: weekly digest off."
        };
      }
    },
    toolName: "update_notification_settings"
  });

  assert.equal(approved.status, "success");
  assert.deepEqual(appliedPatch, { weeklyDigest: false });
});

test("teacher assistant rejects mismatched confirmation actors and arbitrary patch keys", async () => {
  __clearPendingTeacherAssistantActionsForTests();
  await assert.rejects(
    executeTeacherAssistantToolWithActor({
      actor,
      args: { classId: "class-1", patch: { rawWrite: true } },
      classId: "class-1",
      toolName: "update_notification_settings"
    }),
    /Unrecognized key/
  );

  const prepared = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", patch: { weeklyDigest: false } },
    classId: "class-1",
    toolName: "update_notification_settings"
  });

  assert.equal(prepared.action?.kind, "confirmation");

  await assert.rejects(
    executeTeacherAssistantToolWithActor({
      actor: {
        ...actor,
        uid: "teacher-2"
      },
      args: { classId: "class-1", patch: { weeklyDigest: false } },
      classId: "class-1",
      confirmation: {
        decision: "approved",
        pendingActionId: prepared.action.pendingActionId
      },
      dependencies: {
        applyNotificationSettingsUpdate: async () => {
          throw new Error("should not write");
        }
      },
      toolName: "update_notification_settings"
    }),
    /different teacher session/
  );
});
