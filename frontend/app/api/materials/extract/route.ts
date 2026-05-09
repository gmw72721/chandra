import { NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  assertTutorKnowledgeTextWithinLimit,
  authorizeClassTeacher,
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

    await authorizeClassTeacher(request, classId);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload a material file." }, { status: 400 });
    }

    validateTutorKnowledgeFile(file);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const buffer = Buffer.from(await file.arrayBuffer());

    if (isPdf) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });

      try {
        const result = await parser.getText();
        const text = result.text.trim();
        assertTutorKnowledgeTextWithinLimit(text, "Extracted material text");
        return NextResponse.json({
          fileName: file.name,
          text
        });
      } finally {
        await parser.destroy();
      }
    }

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
