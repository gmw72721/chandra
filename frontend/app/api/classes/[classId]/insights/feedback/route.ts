import { NextResponse } from "next/server";
import { ConversationPersistenceError } from "@/lib/student-conversations-server";
import { saveTeacherInsightFeedback } from "@/lib/teacher-insights-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

type TeacherInsightFeedbackRouteParams = {
  classId: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<TeacherInsightFeedbackRouteParams> }
) {
  try {
    const { classId } = await params;
    const { uid } = await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      itemId?: unknown;
      note?: unknown;
      range?: unknown;
    };
    const snapshot = await saveTeacherInsightFeedback({
      action: body.action,
      classId,
      itemId: body.itemId,
      note: body.note,
      range: body.range,
      teacherId: uid
    });

    return NextResponse.json({ snapshot });
  } catch (caughtError) {
    return insightsFeedbackErrorResponse(caughtError, "Teacher insights feedback save failed.");
  }
}

function insightsFeedbackErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  if (caughtError instanceof ConversationPersistenceError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
