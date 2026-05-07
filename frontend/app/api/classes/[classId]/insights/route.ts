import { NextResponse } from "next/server";
import { ConversationPersistenceError } from "@/lib/student-conversations-server";
import {
  getClassTeacherInsights,
  normalizeTeacherInsightRange,
  updateClassTeacherInsights
} from "@/lib/teacher-insights-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

type TeacherInsightsRouteParams = {
  classId: string;
};

export async function GET(request: Request, { params }: { params: Promise<TeacherInsightsRouteParams> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);

    const url = new URL(request.url);
    const snapshot = await getClassTeacherInsights({
      classId,
      range: normalizeTeacherInsightRange(url.searchParams.get("range"))
    });

    return NextResponse.json({ snapshot });
  } catch (caughtError) {
    return insightsErrorResponse(caughtError, "Teacher insights load failed.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<TeacherInsightsRouteParams> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as { force?: unknown; range?: unknown };
    const snapshot = await updateClassTeacherInsights({
      classId,
      force: body.force === true,
      range: normalizeTeacherInsightRange(body.range)
    });

    return NextResponse.json({ snapshot });
  } catch (caughtError) {
    return insightsErrorResponse(caughtError, "Teacher insights generation failed.");
  }
}

function insightsErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  if (caughtError instanceof ConversationPersistenceError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
