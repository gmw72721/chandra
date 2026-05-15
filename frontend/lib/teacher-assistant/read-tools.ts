import { conversationNeedsTeacherReview } from "../conversation-review-utils.ts";
import { listTeacherRosterActivity, listTeacherClassConversations } from "../student-conversations-server.ts";
import { getTeacherClassOverview } from "../teacher-overview-server.ts";
import type { TeacherConversationReviewSummary } from "../types.ts";

export async function getTeacherDashboardSummaryTool({
  classId,
  timezone
}: {
  classId: string;
  timezone?: string;
}) {
  const overview = await getTeacherClassOverview({
    classId,
    timezone
  });

  return {
    classId,
    date: overview.date,
    metrics: overview.metrics,
    nextActions: overview.nextActions.slice(0, 5),
    reviewQueueCount: overview.reviewQueueRows.length,
    summary: overview.summary,
    topReviewItems: overview.reviewQueueRows.slice(0, 5)
  };
}

export async function getReviewQueueTool({ classId }: { classId: string }) {
  const conversations = await listTeacherClassConversations({ classId });
  const reviewQueue = conversations
    .filter((conversation) =>
      conversationNeedsTeacherReview({
        feedbackSummary: conversation.feedbackSummary,
        followUpDueAt: conversation.review.followUpDueAt,
        status: conversation.reviewStatus
      })
    )
    .slice(0, 20)
    .map(conversationToReviewQueueItem);

  return {
    classId,
    count: reviewQueue.length,
    reviewQueue
  };
}

export async function searchStudentsForAssistant({ classId, query }: { classId: string; query: string }) {
  const normalizedQuery = query.trim().toLowerCase();
  const roster = await listTeacherRosterActivity({ classId });

  return roster
    .filter((student) =>
      `${student.displayName} ${student.studentEmail}`.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, 10)
    .map((student) => ({
      displayName: student.displayName,
      email: student.studentEmail,
      studentId: student.studentId
    }));
}

function conversationToReviewQueueItem(conversation: TeacherConversationReviewSummary) {
  return {
    conversationId: conversation.id,
    feedbackOpen: conversation.feedbackSummary.openCount,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    retrievalConfidence: conversation.latestRetrievalConfidence ?? "",
    reviewStatus: conversation.reviewStatus,
    sourceCount: conversation.sourceAudit.sourceCount,
    studentEmail: conversation.studentEmail,
    studentId: conversation.studentId,
    studentName: conversation.studentName,
    title: conversation.title,
    topic: conversation.topic
  };
}
