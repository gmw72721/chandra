import { NextResponse } from "next/server";
import { ConversationPersistenceError, updateTeacherStudentSupport } from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string; studentId: string }> }
) {
  try {
    const { classId, studentId } = await params;
    const { uid } = await authorizeClassTeacher(request, classId);
    const data = (await request.json()) as { teacherNotes?: unknown };
    const teacherNotes = String(data.teacherNotes ?? "");

    await updateTeacherStudentSupport({
      classId,
      notes: teacherNotes,
      studentEmail: decodeURIComponent(studentId),
      teacherId: uid
    });

    return NextResponse.json({ teacherNotes: teacherNotes.slice(0, 1000) });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Student support save failed." }, { status: 500 });
  }
}
