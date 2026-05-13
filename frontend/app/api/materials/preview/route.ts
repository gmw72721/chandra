import { NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  authorizeClassAccess,
  buildTutorKnowledgePreview
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const classId = String(formData.get("classId") ?? "").trim();

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before previewing tutor knowledge." }, { status: 400 });
    }

    await authorizeClassAccess(request, classId, "manageMaterials");
    const preview = await buildTutorKnowledgePreview(formData);

    return NextResponse.json(preview);
  } catch (caughtError) {
    return handleTutorKnowledgeError(caughtError);
  }
}

function handleTutorKnowledgeError(caughtError: unknown) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: "Tutor knowledge preview failed." }, { status: 500 });
}
