import { NextRequest, NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  authorizeClassTeacher,
  deleteTutorKnowledge
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const { materialId } = await params;
    const classId = request.nextUrl.searchParams.get("classId")?.trim() ?? "";

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before deleting tutor knowledge." }, { status: 400 });
    }

    await authorizeClassTeacher(request, classId);
    await deleteTutorKnowledge({ classId, materialId });

    return NextResponse.json({ ok: true });
  } catch (caughtError) {
    return handleTutorKnowledgeError(caughtError);
  }
}

function handleTutorKnowledgeError(caughtError: unknown) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: "Tutor knowledge delete failed." }, { status: 500 });
}
