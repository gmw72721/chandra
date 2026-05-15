import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { conversationNeedsTeacherReview } from "../frontend/lib/conversation-review-utils.ts";

const repoRoot = process.cwd();

test("scheduled needs-follow-up conversations wait until the due date before entering the queue", () => {
  const now = new Date("2026-05-13T12:00:00.000Z");
  const openFeedback = { openCount: 0 };

  assert.equal(
    conversationNeedsTeacherReview(
      { feedbackSummary: openFeedback, followUpDueAt: "2026-05-14T12:00:00.000Z", status: "needs_follow_up" },
      now
    ),
    false
  );
  assert.equal(
    conversationNeedsTeacherReview(
      { feedbackSummary: openFeedback, followUpDueAt: "2026-05-13T11:59:00.000Z", status: "needs_follow_up" },
      now
    ),
    true
  );
  assert.equal(
    conversationNeedsTeacherReview(
      { feedbackSummary: { openCount: 1 }, followUpDueAt: "2026-05-14T12:00:00.000Z", status: "needs_follow_up" },
      now
    ),
    true
  );
});

test("plain new conversations do not enter review unless they have an explicit review reason", () => {
  const now = new Date("2026-05-13T12:00:00.000Z");
  const feedbackSummary = { openCount: 0 };

  assert.equal(conversationNeedsTeacherReview({ feedbackSummary, status: "new" }, now), false);
  assert.equal(
    conversationNeedsTeacherReview(
      {
        feedbackSummary,
        learningSignals: { answerSeekingReviewCount: 1 },
        status: "new"
      },
      now
    ),
    true
  );
  assert.equal(
    conversationNeedsTeacherReview(
      {
        feedbackSummary,
        learningSignals: { safetyReviewCount: 1 },
        status: "new"
      },
      now
    ),
    true
  );
  assert.equal(
    conversationNeedsTeacherReview(
      {
        feedbackSummary,
        learningSignals: { studentReplyAfterTeacherNote: true },
        status: "reviewed"
      },
      now
    ),
    true
  );
});

test("conversation review persistence stores follow-up due dates in metadata", () => {
  const dataSource = readFileSync(join(repoRoot, "frontend/lib/data/student-records.ts"), "utf8");
  const serverSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const routeSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/conversations/[conversationId]/review/route.ts"),
    "utf8"
  );

  assert.match(dataSource, /followUpDueAt\?: string \| null/);
  assert.match(dataSource, /followUpDueAt: input\.followUpDueAt \?\? null/);
  assert.match(serverSource, /status === "needs_follow_up" \? normalizedFollowUpDueAt : null/);
  assert.match(serverSource, /defaultConversationFollowUpDueAt/);
  assert.match(routeSource, /const followUpDueAt = normalizeFollowUpDueAt\(data\.followUpDueAt\)/);
  assert.match(routeSource, /Follow-up due date is invalid/);
});

test("student feedback review can send a student-visible response separately from private notes", () => {
  const feedbackServerSource = readFileSync(join(repoRoot, "frontend/lib/student-feedback-server.ts"), "utf8");
  const feedbackRouteSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/feedback/[feedbackId]/route.ts"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(feedbackServerSource, /studentVisibleResponse/);
  assert.match(feedbackServerSource, /studentVisibleResponseSentAt/);
  assert.match(feedbackServerSource, /teacherNote: String\(teacherNote \?\? feedback\.teacherNote \?\? ""\)/);
  assert.match(feedbackServerSource, /sendStudentVisibleResponse/);
  assert.match(feedbackRouteSource, /sendStudentVisibleResponse: data\.sendStudentVisibleResponse === true/);
  assert.match(componentSource, /Response to student/);
  assert.match(componentSource, /Send response/);
  assert.match(componentSource, /saveStudentFeedbackReview\(feedback, "resolved", "deny"\)/);
  assert.match(componentSource, /saveStudentFeedbackReview\(feedback, "resolved", "approve"\)/);
});

test("conversation review can send student-visible teacher notes for follow-up chats", () => {
  const serverSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const routeSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/conversations/[conversationId]/review/route.ts"),
    "utf8"
  );
  const componentSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(serverSource, /studentVisibleNote/);
  assert.match(serverSource, /studentReplyAfterTeacherNote/);
  assert.match(serverSource, /appendStudentVisibleTeacherNote/);
  assert.match(routeSource, /sendStudentVisibleNote/);
  assert.match(componentSource, /Message student on this chat/);
  assert.match(componentSource, /Send to student/);
  assert.match(studentSource, /Teacher note/);
  assert.match(studentSource, /conversationId: activeSelectedConversationId/);
});

test("conversation review has separate all conversations and needs review subtabs", () => {
  const componentSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(componentSource, /all: "all"/);
  assert.match(componentSource, /needsReview: "needs-review"/);
  assert.match(componentSource, /label: "All conversations"/);
  assert.match(componentSource, /label: "Needs Review"/);
  assert.match(componentSource, /filter === "all"[\s\S]*return true/);
  assert.match(componentSource, /useState<ConversationFilter>\("needsReview"\)/);
});
