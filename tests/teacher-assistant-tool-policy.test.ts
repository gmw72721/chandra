import assert from "node:assert/strict";
import test from "node:test";
import { selectTeacherAssistantToolPolicy } from "../frontend/lib/teacher-assistant/tool-policy.ts";

const allowedTools = [
  "get_review_queue",
  "get_teacher_dashboard_summary",
  "navigate_teacher_tab",
  "open_student_view",
  "search_conversations",
  "search_students",
  "update_notification_settings",
  "update_tutor_access_settings"
];

test("teacher assistant policy limits navigation-only requests to navigation tools", () => {
  const policy = selectTeacherAssistantToolPolicy("open student view", allowedTools);

  assert.equal(policy.maxToolCalls, 1);
  assert.equal(policy.reason, "navigation_only");
  assert.deepEqual(policy.allowedToolNames, ["navigate_teacher_tab", "open_student_view"]);
});

test("teacher assistant policy exposes focused read/write tools by request type", () => {
  const studentPolicy = selectTeacherAssistantToolPolicy("find student ada@example.com", allowedTools);
  assert.equal(studentPolicy.reason, "student_focused");
  assert.ok(studentPolicy.allowedToolNames.includes("search_students"));

  const settingsPolicy = selectTeacherAssistantToolPolicy("turn off tutor chat", allowedTools);
  assert.equal(settingsPolicy.reason, "settings_focused");
  assert.ok(settingsPolicy.allowedToolNames.includes("update_tutor_access_settings"));
});
