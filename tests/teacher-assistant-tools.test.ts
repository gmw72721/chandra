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
  assert.equal(permissionForTool("search_students"), "viewRoster");
  assert.equal(permissionForTool("search_conversations"), "viewConversations");
  assert.equal(permissionForTool("get_class_materials"), "viewMaterials");
  assert.equal(permissionForTool("get_class_settings"), "manageClassSettings");
  assert.equal(permissionForTool("update_tutor_access_settings"), "manageClassSettings");
  assert.equal(permissionForTool("update_notification_settings"), "manageClassSettings");
  assert.throws(() => permissionForTool("delete_everything"), /Unsupported teacher assistant tool/);
});

test("teacher assistant read tools return bounded sanitized data", async () => {
  const conversationsResult = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", query: "limits" },
    classId: "class-1",
    dependencies: {
      getClassConversations: async () => [
        {
          classId: "class-1",
          conversationId: "conv-1",
          feedback: [],
          feedbackSummary: { openCount: 0, resolvedCount: 0 },
          id: "conv-1",
          lastMessageAt: "2026-05-15T00:00:00.000Z",
          latestRetrievalConfidence: "high",
          learningSignals: [],
          messageCount: 4,
          modelId: "model-1",
          review: { followUpDueAt: "", privateNote: "", status: "new", updatedAt: "" },
          reviewStatus: "new",
          sourceAudit: { latestRetrievalConfidence: "high", learningSignals: [], sourceCount: 2 },
          studentEmail: "student@example.com",
          studentId: "student-1",
          studentName: "Student One",
          teacherId: "teacher-1",
          title: "Limits question",
          topic: "Limits"
        }
      ]
    },
    toolName: "search_conversations"
  });

  assert.equal(conversationsResult.status, "success");
  assert.equal(conversationsResult.data?.count, 1);

  const materialsResult = await executeTeacherAssistantToolWithActor({
    actor,
    args: { classId: "class-1", query: "worksheet" },
    classId: "class-1",
    dependencies: {
      listClassMaterials: async () => [
        {
          activeForStudents: true,
          characterCount: 1200,
          chunkCount: 4,
          classId: "class-1",
          citationsRequired: true,
          contentType: "application/pdf",
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
          deletedAt: null,
          fileName: "limits.pdf",
          fileSize: 100,
          fileUrl: null,
          id: "mat-1",
          kind: "Worksheet",
          materialType: "Worksheet",
          metadata: {},
          priority: "primary",
          searchMetadataSource: "postgres",
          sourceMode: "file",
          status: "ready",
          storageBucket: null,
          storagePath: null,
          storageUri: null,
          teacherId: "teacher-1",
          teacherOnly: false,
          title: "Limits worksheet",
          updatedAt: new Date("2026-05-15T00:00:00.000Z")
        }
      ]
    },
    toolName: "search_materials"
  });

  assert.equal(materialsResult.status, "success");
  assert.equal(materialsResult.data?.count, 1);
});

test("teacher assistant settings read tools normalize class data", async () => {
  const result = await executeTeacherAssistantToolWithActor({
    actor: {
      ...actor,
      classData: {
        name: "Algebra",
        notificationSettings: { weeklyDigest: false },
        section: "Period 2"
      }
    },
    args: { classId: "class-1" },
    classId: "class-1",
    toolName: "get_class_settings"
  });

  assert.equal(result.status, "success");
  assert.equal(result.data?.name, "Algebra");
  assert.deepEqual((result.data as { notificationSettings: unknown }).notificationSettings, {
    followUpReminders: true,
    newStudentJoinedClass: true,
    weeklyDigest: false
  });
});
