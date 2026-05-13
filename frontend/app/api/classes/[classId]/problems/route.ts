import { NextResponse } from "next/server";
import { getTeacherClassProblems } from "@/lib/teacher-problems-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ classId: string }> }) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);

    const problems = await getTeacherClassProblems({ classId });

    return NextResponse.json({ problems });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class problems load failed." }, { status: 500 });
  }
}
