import type { ConversationReviewStatus, StudentFeedbackSummary } from "./types";

const conversationReviewRequiredStatuses = new Set<ConversationReviewStatus>([
  "ai_answer_needs_review",
  "misunderstanding_spotted",
  "needs_follow_up"
]);

export function conversationFollowUpIsDue(followUpDueAt: unknown, now: Date = new Date()) {
  const dueAt = coerceReviewDate(followUpDueAt);
  return !dueAt || dueAt.getTime() <= now.getTime();
}

export function conversationNeedsTeacherReview(
  row: {
    feedbackSummary: Pick<StudentFeedbackSummary, "openCount">;
    status: ConversationReviewStatus;
    followUpDueAt?: unknown;
    learningSignals?: {
      answerSeekingReviewCount?: number;
      safetyReviewCount?: number;
      studentReplyAfterTeacherNote?: boolean;
    };
  },
  now: Date = new Date()
) {
  if (row.feedbackSummary.openCount > 0) {
    return true;
  }

  if (row.learningSignals?.studentReplyAfterTeacherNote) {
    return true;
  }

  if ((row.learningSignals?.answerSeekingReviewCount ?? 0) > 0 || (row.learningSignals?.safetyReviewCount ?? 0) > 0) {
    return true;
  }

  if (row.status === "needs_follow_up" && !conversationFollowUpIsDue(row.followUpDueAt, now)) {
    return false;
  }

  return conversationReviewRequiredStatuses.has(row.status);
}

function coerceReviewDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}
