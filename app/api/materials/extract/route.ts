import { NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import {
  TutorKnowledgeHttpError,
  authorizeClassTeacher
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

const maxUploadBytes = 12 * 1024 * 1024;

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

    if (file.size > maxUploadBytes) {
      return NextResponse.json({ error: "Files must be 12 MB or smaller." }, { status: 400 });
    }

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const buffer = Buffer.from(await file.arrayBuffer());

    if (isPdf) {
      const parser = new PDFParse({ data: buffer });

      try {
        const result = await parser.getText();
        return NextResponse.json({
          fileName: file.name,
          text: result.text.trim()
        });
      } finally {
        await parser.destroy();
      }
    }

    return NextResponse.json({
      fileName: file.name,
      text: buffer.toString("utf8").trim()
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Material extraction failed." }, { status: 500 });
  }
}
