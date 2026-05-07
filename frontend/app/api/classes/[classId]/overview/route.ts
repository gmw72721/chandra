import { NextResponse } from "next/server";
import { ConversationPersistenceError } from "@/lib/student-conversations-server";
import { assertOverviewDate, getTeacherClassOverview } from "@/lib/teacher-overview-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);

    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    const timezone = url.searchParams.get("timezone");
    assertOverviewDate(date);

    const overview = await getTeacherClassOverview({ classId, date, timezone });

    return NextResponse.json({ overview });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class overview load failed." }, { status: 500 });
  }
}
