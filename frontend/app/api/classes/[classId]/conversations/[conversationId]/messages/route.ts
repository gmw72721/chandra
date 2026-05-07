import { NextResponse } from "next/server";
import { listTeacherConversationMessages } from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string; conversationId: string }> }
) {
  try {
    const { classId, conversationId } = await params;
    await authorizeClassTeacher(request, classId);

    const messages = await listTeacherConversationMessages({
      classId,
      conversationId
    });

    return NextResponse.json({ messages });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Conversation messages failed." }, { status: 500 });
  }
}
