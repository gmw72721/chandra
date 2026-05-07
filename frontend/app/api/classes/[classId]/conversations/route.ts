import { NextResponse } from "next/server";
import { listTeacherClassConversations } from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);

    const conversations = await listTeacherClassConversations({ classId });
    const metrics = {
      lowConfidence: conversations.filter((conversation) => conversation.sourceAudit.lowSourceConfidence).length,
      needsFollowUp: conversations.filter((conversation) => conversation.reviewStatus === "needs_follow_up").length,
      total: conversations.length,
      unreviewed: conversations.filter((conversation) => conversation.reviewStatus === "new").length
    };

    return NextResponse.json({ conversations, metrics });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class conversations load failed." }, { status: 500 });
  }
}
