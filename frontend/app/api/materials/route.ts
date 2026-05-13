import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  TutorKnowledgeHttpError,
  authorizeClassAccess,
  saveTutorKnowledge
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const classId = String(formData.get("classId") ?? "").trim();

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before saving tutor knowledge." }, { status: 400 });
    }

    const { classSnapshot, email: actorEmail, uid } = await authorizeClassAccess(request, classId, "manageMaterials");
    const classData = classSnapshot.data() ?? {};
    const professorName = String(classData.teacherName ?? classData.professorName ?? "").trim();
    const jobId = String(formData.get("jobId") ?? "").trim();
    const material = await saveTutorKnowledge({ classId, formData, jobId, professorName, teacherId: uid });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "material.uploaded",
      metadata: {
        jobId,
        title: String(formData.get("title") ?? "").trim()
      },
      route: "/api/materials",
      target: {
        classId,
        materialId: material.id
      }
    });

    return NextResponse.json(material);
  } catch (caughtError) {
    return handleTutorKnowledgeError(caughtError);
  }
}

function handleTutorKnowledgeError(caughtError: unknown) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  console.error("Tutor knowledge save failed.", caughtError);

  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      {
        error: caughtError instanceof Error ? caughtError.message : "Tutor knowledge save failed."
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ error: "Tutor knowledge save failed." }, { status: 500 });
}
