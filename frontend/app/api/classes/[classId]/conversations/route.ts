import { NextResponse } from "next/server";
import { listTeacherClassConversations } from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);

    const conversations = await listTeacherClassConversations({ classId });
    const openConversations = conversations.filter((conversation) =>
      ["new", "needs_follow_up", "misunderstanding_spotted", "ai_answer_needs_review"].includes(conversation.reviewStatus)
    );
    const metrics = {
      lowConfidence: openConversations.filter((conversation) => conversation.sourceAudit.lowSourceConfidence).length,
      needsFollowUp: openConversations.filter(
        (conversation) =>
          conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted"
      ).length,
      total: conversations.length,
      unreviewed: openConversations.filter((conversation) => conversation.reviewStatus === "new").length
    };

    return NextResponse.json({ conversations, metrics });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class conversations load failed." }, { status: 500 });
  }
}
