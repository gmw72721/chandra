import { NextResponse } from "next/server";
import { ConversationPersistenceError, updateTeacherStudentChatAccess } from "@/lib/student-conversations-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string; studentId: string }> }
) {
  try {
    const { classId, studentId } = await params;
    const { uid } = await authorizeClassAccess(request, classId, "manageStudentSupport");
    const data = (await request.json()) as { chatBlocked?: unknown };

    if (typeof data.chatBlocked !== "boolean") {
      return NextResponse.json({ error: "Choose whether student chat is paused." }, { status: 400 });
    }

    return NextResponse.json(
      await updateTeacherStudentChatAccess({
        chatBlocked: data.chatBlocked,
        classId,
        studentEmail: decodeURIComponent(studentId),
        teacherId: uid
      })
    );
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Student chat access save failed." }, { status: 500 });
  }
}
