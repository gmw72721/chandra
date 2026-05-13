import { NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  assertTutorKnowledgeTextWithinLimit,
  authorizeClassAccess,
  validateTutorKnowledgeFile
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const classId = String(formData.get("classId") ?? "").trim();
    const file = formData.get("file");

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before extracting material text." }, { status: 400 });
    }

    await authorizeClassAccess(request, classId, "manageMaterials");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload a material file." }, { status: 400 });
    }

    validateTutorKnowledgeFile(file);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      return NextResponse.json({
        extractionMode: "google-document-ai-on-save",
        fileName: file.name,
        text: ""
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const text = buffer.toString("utf8").trim();
    assertTutorKnowledgeTextWithinLimit(text, "Extracted material text");
    return NextResponse.json({
      fileName: file.name,
      text
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Material extraction failed." }, { status: 500 });
  }
}
