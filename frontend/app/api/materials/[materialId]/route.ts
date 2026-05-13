import { NextRequest, NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  TutorKnowledgeHttpError,
  authorizeClassAccess,
  deleteTutorKnowledge,
  getTutorKnowledgeDetails,
  updateTutorKnowledgeSettings,
  type TutorKnowledgeSourceSettings
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const { materialId } = await params;
    const classId = request.nextUrl.searchParams.get("classId")?.trim() ?? "";

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before viewing tutor knowledge." }, { status: 400 });
    }

    await authorizeClassAccess(request, classId, "viewMaterials");
    const details = await getTutorKnowledgeDetails({ classId, materialId });

    return NextResponse.json(details);
  } catch (caughtError) {
    return handleTutorKnowledgeError(caughtError, "Tutor knowledge detail load failed.");
  }
}

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

    const { email: actorEmail, uid } = await authorizeClassAccess(request, classId, "manageMaterials");
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

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "material.visibility.updated",
      metadata: {
        activeForStudents: body.activeForStudents,
        priority: body.priority,
        requireCitations: body.requireCitations,
        teacherOnly: body.teacherOnly
      },
      route: "/api/materials/[materialId]",
      target: {
        classId,
        materialId
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

    const { email: actorEmail, uid } = await authorizeClassAccess(request, classId, "manageMaterials");
    await deleteTutorKnowledge({ classId, materialId });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "material.deleted",
      route: "/api/materials/[materialId]",
      target: {
        classId,
        materialId
      }
    });

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
