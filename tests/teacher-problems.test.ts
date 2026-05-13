import assert from "node:assert/strict";
import test from "node:test";
import { buildTeacherProblemRows, normalizeActiveProblemId } from "../frontend/lib/teacher-problem-aggregation.ts";
import type { ConversationRecord, MessageRecord } from "../frontend/lib/data/conversations.ts";

test("teacher problems excludes unknown problem ids", () => {
  const rows = buildTeacherProblemRows({
    conversations: [conversation({ id: "conversation-1", studentEmail: "ada@example.com", studentName: "Ada" })],
    messages: [
      message({
        conversationId: "conversation-1",
        id: "message-1",
        state: { activeProblemId: "unknown", understandingLevel: 2 }
      }),
      message({
        conversationId: "conversation-1",
        id: "message-2",
        state: { activeProblemId: "  ", understandingLevel: 3 }
      })
    ]
  });

  assert.deepEqual(rows, []);
  assert.equal(normalizeActiveProblemId(" n/a "), "");
});

test("teacher problems groups by activeProblemId and uses latest level per student/problem", () => {
  const rows = buildTeacherProblemRows({
    conversations: [
      conversation({ id: "conversation-1", studentEmail: "ada@example.com", studentName: "Ada" }),
      conversation({ id: "conversation-2", studentEmail: "ben@example.com", studentName: "Ben" }),
      conversation({ id: "conversation-3", studentEmail: "ada@example.com", studentName: "Ada" })
    ],
    messages: [
      studentMessage({ conversationId: "conversation-1", id: "student-1", minutes: 1 }),
      message({
        conversationId: "conversation-1",
        id: "assistant-1",
        minutes: 2,
        state: { activeProblemId: "problem-7", knownConfusions: ["setting up the equation"], understandingLevel: 1 }
      }),
      message({
        conversationId: "conversation-1",
        id: "assistant-2",
        minutes: 3,
        state: { activeProblemId: "problem-7", knownConfusions: ["sign errors"], understandingLevel: 3 }
      }),
      studentMessage({ conversationId: "conversation-2", id: "student-2", minutes: 4 }),
      message({
        conversationId: "conversation-2",
        id: "assistant-3",
        minutes: 5,
        state: { activeProblemId: "problem-7", knownConfusions: ["setting up the equation"], understandingLevel: 1 }
      }),
      message({
        conversationId: "conversation-3",
        id: "assistant-0",
        minutes: 0,
        state: { activeProblemId: "problem-7", knownConfusions: ["old setup issue"], understandingLevel: 0 }
      })
    ]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "problem-7");
  assert.equal(rows[0].studentCount, 2);
  assert.equal(rows[0].conversationCount, 3);
  assert.equal(rows[0].averageUnderstandingLevel, 2);
  assert.deepEqual(rows[0].levelDistribution, { 0: 0, 1: 1, 2: 0, 3: 1, 4: 0 });
  assert.deepEqual(rows[0].commonConfusions.slice(0, 2), ["setting up the equation", "old setup issue"]);
  assert.equal(rows[0].students.find((student) => student.studentName === "Ada")?.latestUnderstandingLevel, 3);
});

test("teacher problems separates activeProblemId groups and counts student questions", () => {
  const rows = buildTeacherProblemRows({
    conversations: [conversation({ id: "conversation-1", studentEmail: "ada@example.com", studentName: "Ada" })],
    messages: [
      message({
        conversationId: "conversation-1",
        id: "assistant-1",
        minutes: 1,
        state: { activeProblemId: "problem-a", understandingLevel: 2 }
      }),
      studentMessage({ conversationId: "conversation-1", id: "student-1", minutes: 2 }),
      message({
        conversationId: "conversation-1",
        id: "assistant-2",
        minutes: 3,
        state: { activeProblemId: "problem-b", understandingLevel: 4 }
      }),
      studentMessage({ conversationId: "conversation-1", id: "student-2", minutes: 4 })
    ]
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(byId.get("problem-a")?.totalStudentMessages, 1);
  assert.equal(byId.get("problem-b")?.totalStudentMessages, 1);
  assert.equal(byId.get("problem-b")?.levelDistribution[4], 1);
});

function conversation(input: Partial<ConversationRecord> & { id: string }): ConversationRecord {
  return {
    assignment: "",
    classId: "class-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    id: input.id,
    lastMessageAt: new Date("2026-01-01T00:10:00.000Z"),
    messageCount: 0,
    metadata: {},
    modelId: "test-model",
    studentEmail: input.studentEmail ?? "student@example.com",
    studentId: input.studentId ?? input.studentEmail ?? "student-id",
    studentName: input.studentName ?? "Student",
    tags: [],
    teacherId: "teacher-1",
    teacherName: "Teacher",
    title: "Test conversation",
    updatedAt: new Date("2026-01-01T00:10:00.000Z")
  };
}

function studentMessage(input: { conversationId: string; id: string; minutes?: number }): MessageRecord {
  return message({ ...input, role: "student" });
}

function message(input: {
  conversationId: string;
  id: string;
  minutes?: number;
  role?: MessageRecord["role"];
  state?: Record<string, unknown>;
}): MessageRecord {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, input.minutes ?? 0, 0));

  return {
    attachments: [],
    classId: "class-1",
    content: input.role === "student" ? "Can you help?" : "Try the next step.",
    conversationId: input.conversationId,
    createdAt,
    debugInfo: undefined,
    id: input.id,
    langGraphTrace: input.state ? { problemUnderstandingState: input.state } : undefined,
    learningStrategyTelemetry: undefined,
    metadata: {},
    modelId: null,
    retrievalConfidence: undefined,
    role: input.role ?? "assistant",
    sources: [],
    structuredOutput: undefined,
    updatedAt: createdAt
  };
}
