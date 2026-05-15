import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTeacherAssistantTabHref,
  normalizeTeacherAssistantAiTutorSection,
  normalizeTeacherAssistantSettingsPane,
  normalizeTeacherAssistantSourceSection,
  normalizeTeacherAssistantTab,
  resolveTeacherAssistantNavigation
} from "../frontend/lib/teacher-assistant/routes.ts";

test("teacher assistant resolves canonical tab routes", () => {
  assert.equal(buildTeacherAssistantTabHref("overview", { classId: "class-1" }), "/teacher/overview?classId=class-1");
  assert.equal(
    resolveTeacherAssistantNavigation({
      classId: "class-1",
      conversationId: "conv-1",
      tab: "conversations"
    }).href,
    "/teacher/conversations?classId=class-1&conversationId=conv-1"
  );
});

test("teacher assistant rejects unsupported route tokens", () => {
  assert.throws(() => normalizeTeacherAssistantTab("billing"), /Unsupported teacher dashboard tab/);
  assert.throws(() => normalizeTeacherAssistantSettingsPane("secrets"), /Unsupported settings pane/);
  assert.throws(() => normalizeTeacherAssistantSourceSection("raw"), /Unsupported source section/);
  assert.throws(() => normalizeTeacherAssistantAiTutorSection("root"), /Unsupported AI tutor section/);
});

test("teacher assistant routes encode student and pane actions", () => {
  assert.equal(
    buildTeacherAssistantTabHref("settings", { classId: "class 1", settingsPane: "notifications" }),
    "/teacher/settings?classId=class+1&settingsPane=notifications"
  );
  assert.equal(
    resolveTeacherAssistantNavigation({
      classId: "class-1",
      studentEmail: "Student@Example.com",
      tab: "conversations"
    }).href,
    "/teacher/conversations?classId=class-1&student=student%40example.com"
  );
});
