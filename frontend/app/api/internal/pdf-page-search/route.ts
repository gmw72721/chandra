import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { retrieveCourseContext } from "@/lib/retrieval";

export const runtime = "nodejs";

const requestSchema = z.object({
  classId: z.string().min(1).max(200),
  professorId: z.string().min(1).max(200),
  query: z.string().min(1).max(30000),
  topK: z.number().int().min(1).max(20).optional()
});

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);

  if (authError) {
    return authError;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid internal PDF retrieval request." }, { status: 400 });
  }

  const retrieval = await retrieveCourseContext(
    {
      classId: parsed.data.classId,
      professorId: parsed.data.professorId
    },
    parsed.data.query,
    parsed.data.topK ?? 5
  );

  return NextResponse.json({
    pages: retrieval.hits.map((hit) => ({
      chunk_text: hit.chunk.chunkText ?? hit.chunk.content,
      doc_id: hit.document.id,
      material_type: hit.chunk.materialType ?? hit.document.materialType ?? hit.document.kind,
      page_end: hit.chunk.pageEnd ?? hit.chunk.pageNumber ?? hit.chunk.pageStart ?? 1,
      page_start: hit.chunk.pageStart ?? hit.chunk.pageNumber ?? 1,
      score: hit.score,
      section: hit.chunk.sectionHeading ?? hit.chunk.section ?? "",
      source_pdf_path: hit.document.filePath ?? hit.document.fileUrl ?? "",
      title: hit.chunk.title ?? hit.document.title
    }))
  });
}

function authorizeInternalRequest(request: Request) {
  const expectedSecret = process.env.BACKEND_SHARED_SECRET?.trim() ?? "";

  if (!expectedSecret) {
    return NextResponse.json({ error: "BACKEND_SHARED_SECRET is required." }, { status: 503 });
  }

  const receivedSecret = request.headers.get("x-chandra-internal-secret") ?? "";
  const expectedBuffer = Buffer.from(expectedSecret);
  const receivedBuffer = Buffer.from(receivedSecret);

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return NextResponse.json({ error: "Invalid internal backend secret." }, { status: 403 });
  }

  return null;
}
