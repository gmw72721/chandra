import assert from "node:assert/strict";
import test from "node:test";
import { executeTeacherAssistantToolWithActor, permissionForTool } from "../frontend/lib/teacher-assistant/tool-registry.ts";

const actor = {
  classData: {},
  email: "teacher@example.com",
  uid: "teacher-1"
};

test("teacher assistant navigation tools return resolved Chandra routes", async () => {
  const result = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", pane: "notifications" },
    classId: "class-1",
    toolName: "navigate_settings_pane"
  });

  assert.equal(result.status, "success");
  assert.equal(result.action?.kind, "navigate");
  assert.equal(result.action?.href, "/teacher/settings?classId=class-1&settingsPane=notifications");
});

test("teacher assistant rejects class id supplied by the model when it differs from authorized class", async () => {
  await assert.rejects(
    executeTeacherAssistantToolWithActor({
      actor,
      args: { classId: "class-2", tab: "overview" },
      classId: "class-1",
      toolName: "navigate_teacher_tab"
    }),
    /classId must match/
  );
});

test("teacher assistant validates student navigation against class roster", async () => {
  const result = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", studentEmail: "Student@Example.com" },
    classId: "class-1",
    dependencies: {
      listStudents: async () => [{ email: "student@example.com", id: "student-1" }]
    },
    toolName: "open_student_profile"
  });

  assert.equal(result.action?.href, "/teacher/classes/class-1/students/student%40example.com");

  await assert.rejects(
    executeTeacherAssistantToolWithActor({
      actor,
      args: { classId: "class-1", studentEmail: "other@example.com" },
      classId: "class-1",
      dependencies: {
        listStudents: async () => [{ email: "student@example.com", id: "student-1" }]
      },
      toolName: "open_student_profile"
    }),
    /Student was not found/
  );
});

test("teacher assistant maps tools to scoped permissions", () => {
  assert.equal(permissionForTool("get_teacher_dashboard_summary"), "viewOverview");
  assert.equal(permissionForTool("get_review_queue"), "viewConversations");
  assert.equal(permissionForTool("update_notification_settings"), "manageClassSettings");
  assert.throws(() => permissionForTool("delete_everything"), /Unsupported teacher assistant tool/);
});
