import { after, NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  TutorKnowledgeHttpError,
  authorizeClassTeacher,
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

    const { classSnapshot, email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const classData = classSnapshot.data() ?? {};
    const professorName = String(classData.teacherName ?? classData.professorName ?? "").trim();
    const jobId = String(formData.get("jobId") ?? "").trim();
    const materialId = String(formData.get("materialId") ?? "").trim();

    after(async () => {
      try {
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
      } catch (caughtError) {
        console.error("Tutor knowledge background save failed.", caughtError);
      }
    });

    return NextResponse.json(
      {
        id: materialId,
        jobId,
        processing: true
      },
      { status: 202 }
    );
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
