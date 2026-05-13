import { NextResponse } from "next/server";
import { conversationNeedsTeacherReview } from "@/lib/conversation-review-utils";
import { listTeacherClassConversations } from "@/lib/student-conversations-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassAccess(request, classId, "viewConversations");

    const conversations = await listTeacherClassConversations({ classId });
    const openConversations = conversations.filter((conversation) =>
      conversationNeedsTeacherReview({
        feedbackSummary: conversation.feedbackSummary,
        followUpDueAt: conversation.review.followUpDueAt,
        status: conversation.reviewStatus
      })
    );
    const metrics = {
      feedbackOpen: conversations.reduce((sum, conversation) => sum + conversation.feedbackSummary.openCount, 0),
      lowConfidence: openConversations.filter((conversation) => conversation.sourceAudit.lowSourceConfidence).length,
      needsFollowUp: openConversations.filter(
        (conversation) =>
          conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted"
      ).length,
      total: conversations.length,
      unreviewed: openConversations.filter(
        (conversation) => conversation.reviewStatus === "new" || conversation.feedbackSummary.openCount > 0
      ).length
    };

    return NextResponse.json({ conversations, metrics });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class conversations load failed." }, { status: 500 });
  }
}
