import { NextResponse } from "next/server";
import { listTeacherStudentConversations } from "@/lib/student-conversations-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string; studentId: string }> }
) {
  try {
    const { classId, studentId } = await params;
    await authorizeClassAccess(request, classId, "viewConversations");

    const conversations = await listTeacherStudentConversations({
      classId,
      studentEmail: decodeURIComponent(studentId)
    });

    return NextResponse.json({ conversations });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Conversation load failed." }, { status: 500 });
  }
}
