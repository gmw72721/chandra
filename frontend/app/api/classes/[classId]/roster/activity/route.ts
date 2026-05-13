import { NextResponse } from "next/server";
import { listTeacherRosterActivity } from "@/lib/student-conversations-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassAccess(request, classId, "viewRoster");

    const activity = await listTeacherRosterActivity({ classId });

    return NextResponse.json({ activity });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Roster activity load failed." }, { status: 500 });
  }
}
