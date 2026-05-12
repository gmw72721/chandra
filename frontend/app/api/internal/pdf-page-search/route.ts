import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { searchPdfOcrMetadata, searchPdfOcrMetadataVectorOnly } from "@/lib/pdf-ocr-postgres";
import { VertexEmbeddingError, createVertexEmbedding } from "@/lib/vertex-embeddings";

export const runtime = "nodejs";

const requestSchema = z.object({
  classId: z.string().min(1).max(200),
  materialId: z.string().min(1).max(200).optional(),
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

  let pages = await searchPdfOcrMetadata({
    classId: parsed.data.classId,
    limit: parsed.data.topK ?? 5,
    materialId: parsed.data.materialId,
    professorId: parsed.data.professorId,
    query: parsed.data.query
  });

  if (!pages.length) {
    const queryEmbedding = await createPdfSearchQueryEmbedding(parsed.data.query);

    if (queryEmbedding?.values.length) {
      pages = await searchPdfOcrMetadataVectorOnly({
        classId: parsed.data.classId,
        limit: parsed.data.topK ?? 5,
        materialId: parsed.data.materialId,
        professorId: parsed.data.professorId,
        query: parsed.data.query,
        queryVector: queryEmbedding.values
      });
    }
  }

  return NextResponse.json({
    pages: pages.map((page) => ({
      chunk_text: page.chunkText,
      classId: page.classId,
      doc_id: page.docId,
      docId: page.docId,
      materialId: page.materialId,
      material_type: page.materialType,
      materialType: page.materialType,
      ocrConfidence: page.ocrConfidence,
      ocrProvider: page.ocrProvider,
      ocrSource: page.ocrSource,
      ocrText: page.ocrText,
      page_end: page.pageEnd,
      page_start: page.pageStart,
      fullPdfBucket: page.fullPdfBucket,
      fullPdfPath: page.fullPdfPath,
      fullPdfUri: page.fullPdfUri,
      pageAssetBucket: page.pageAssetBucket,
      pageAssetPath: page.pageAssetPath,
      pageAssetUri: page.pageAssetUri,
      pageAssetChecksumSha256: page.pageAssetChecksumSha256,
      pageAssetMimeType: page.pageAssetMimeType,
      pageAssetSizeBytes: page.pageAssetSizeBytes,
      pageAssetSha256: page.pageAssetSha256,
      pageAssetSize: page.pageAssetSize,
      pageAssetStorageBucket: page.pageAssetStorageBucket,
      pageAssetStoragePath: page.pageAssetStoragePath,
      pageEnd: page.pageEnd,
      pageStart: page.pageStart,
      printed_page_end: page.printedPageEnd,
      printed_page_start: page.printedPageStart,
      professorId: parsed.data.professorId,
      problemNumbers: page.problemNumbers,
      retrievalMode: page.retrievalMode,
      score: page.score,
      source_pdf_path: page.sourcePdfPath,
      storageBucket: page.storageBucket,
      storagePath: page.storagePath,
      title: page.title
    }))
  });
}

async function createPdfSearchQueryEmbedding(query: string) {
  try {
    return await createVertexEmbedding({
      taskType: "RETRIEVAL_QUERY",
      text: query
    });
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      console.warn("PDF OCR query embedding failed. Falling back to exact/full-text PostgreSQL OCR search.", caughtError);
      return undefined;
    }

    throw caughtError;
  }
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
