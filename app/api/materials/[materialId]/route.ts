import { NextRequest, NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  authorizeClassTeacher,
  deleteTutorKnowledge,
  updateTutorKnowledgeSettings,
  type TutorKnowledgeSourceSettings
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const { materialId } = await params;
    const body = await request.json() as Partial<TutorKnowledgeSourceSettings> & { classId?: string };
    const classId = String(body.classId ?? "").trim();

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before updating tutor knowledge." }, { status: 400 });
    }

    await authorizeClassTeacher(request, classId);
    const material = await updateTutorKnowledgeSettings({
      classId,
      materialId,
      settings: {
        activeForStudents: body.activeForStudents,
        priority: body.priority,
        requireCitations: body.requireCitations,
        teacherOnly: body.teacherOnly
      }
    });

    return NextResponse.json(material);
  } catch (caughtError) {
    return handleTutorKnowledgeError(caughtError, "Tutor knowledge update failed.");
  }
}

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
    return handleTutorKnowledgeError(caughtError, "Tutor knowledge delete failed.");
  }
}

function handleTutorKnowledgeError(caughtError: unknown, fallback: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallback }, { status: 500 });
}
