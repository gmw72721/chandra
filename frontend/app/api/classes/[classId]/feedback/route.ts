import { NextResponse } from "next/server";
import {
  listTeacherClassFeedback,
  StudentFeedbackPersistenceError
} from "@/lib/student-feedback-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    const url = new URL(request.url);
    await authorizeClassAccess(request, classId, "reviewConversations");

    const feedback = await listTeacherClassFeedback({
      classId,
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined
    });

    return NextResponse.json({ feedback });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError || caughtError instanceof StudentFeedbackPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class feedback load failed." }, { status: 500 });
  }
}
