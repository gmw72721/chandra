import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildPdfPageAssetPayloads, PdfPageAssetPayloadTooLargeError } from "@/lib/pdf-page-assets-payload";
import {
  searchStructuredPdfMetadata
} from "@/lib/pdf-ocr-postgres";
import { defaultStructuredPdfEmbeddingDim } from "@/lib/pdf-ingestion-config";
import { VertexEmbeddingError, createVertexEmbeddings } from "@/lib/vertex-embeddings";

export const runtime = "nodejs";

const requestSchema = z.object({
  classId: z.string().min(1).max(200),
  includeAssets: z.boolean().optional(),
  materialId: z.string().min(1).max(200).optional(),
  professorId: z.string().min(1).max(200),
  query: z.string().min(1).max(30000),
  topK: z.number().int().min(1).max(20).optional()
});

const maxRequestedAssetPages = 12;
const defaultMaxTotalBytes = 20 * 1024 * 1024;
const defaultMaxFullPdfTotalBytes = 50 * 1024 * 1024;

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);

  if (authError) {
    return authError;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid internal PDF retrieval request." }, { status: 400 });
  }

  const queryEmbedding = shouldUseStructuredVectorSearch(parsed.data.query)
    ? await createPdfSearchQueryEmbedding(parsed.data.query)
    : undefined;
  let pages = await searchStructuredPdfMetadata({
    classId: parsed.data.classId,
    limit: parsed.data.topK ?? 5,
    materialId: parsed.data.materialId,
    professorId: parsed.data.professorId,
    query: parsed.data.query,
    queryVector: queryEmbedding?.values
  });

  const responsePayload: {
    assets?: Array<Record<string, unknown>>;
    pages: Array<Record<string, unknown>>;
  } = {
    pages: pages.map((page) => ({
      chunk_text: page.chunkText,
      classId: page.classId,
      doc_id: page.docId,
      docId: page.docId,
      materialId: page.materialId,
      material_type: page.materialType,
      materialType: page.materialType,
      pageLevelSearchText: page.pageLevelSearchText,
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
      title: page.title,
      sourceType: page.sourceType,
      sourceId: page.sourceId,
      embeddingLevel: page.embeddingLevel,
      blockId: page.blockId,
      objectId: page.objectId,
      blockType: page.blockType,
      objectType: page.objectType,
      itemKind: page.itemKind,
      itemNumber: page.itemNumber,
      itemLabel: page.itemLabel,
      canonicalItemId: page.canonicalItemId,
      embeddingSource: page.embeddingSource,
      ingestionVersion: page.ingestionVersion,
      embeddingDim: page.embeddingDim
    }))
  };

  if (parsed.data.includeAssets && pages.length) {
    try {
      const assetPages = assetRequestsFromSearchResults(pages);

      if (assetPages.length) {
        responsePayload.assets = await buildPdfPageAssetPayloads({
          classId: parsed.data.classId,
          maxFullPdfTotalBytes:
            readPositiveInteger(process.env.INTERNAL_FULL_PDF_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxFullPdfTotalBytes,
          maxTotalBytes: readPositiveInteger(process.env.INTERNAL_PDF_PAGE_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxTotalBytes,
          pages: assetPages,
          professorId: parsed.data.professorId
        });
      }
    } catch (caughtError) {
      if (!(caughtError instanceof PdfPageAssetPayloadTooLargeError)) {
        throw caughtError;
      }
    }
  }

  return NextResponse.json(responsePayload);
}

function assetRequestsFromSearchResults(pages: Awaited<ReturnType<typeof searchStructuredPdfMetadata>>) {
  const requests: Array<{ materialId: string; pageNumber: number }> = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const materialId = page.materialId || page.docId;

    if (!materialId) {
      continue;
    }

    for (let pageNumber = page.pageStart; pageNumber <= page.pageEnd; pageNumber += 1) {
      if (requests.length >= maxRequestedAssetPages) {
        return requests;
      }

      const key = `${materialId}:${pageNumber}`;

      if (!seen.has(key)) {
        seen.add(key);
        requests.push({ materialId, pageNumber });
      }
    }
  }

  return requests;
}

async function createPdfSearchQueryEmbedding(query: string) {
  try {
    const [embedding] = await createVertexEmbeddings(
      [{
        taskType: "RETRIEVAL_QUERY",
        text: query
      }],
      { dimensions: defaultStructuredPdfEmbeddingDim }
    );

    if (embedding?.values.length && embedding.values.length !== defaultStructuredPdfEmbeddingDim) {
      console.warn(
        `Structured PDF query embedding has ${embedding.values.length} dimensions; expected ${defaultStructuredPdfEmbeddingDim}. Skipping PDF vector search.`
      );
      return undefined;
    }

    return embedding;
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      console.warn("Structured PDF query embedding failed. Returning exact/full-text PDF search results only.", caughtError);
      return undefined;
    }

    throw caughtError;
  }
}

function shouldUseStructuredVectorSearch(query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return !(
    /^(?:problem|exercise|question|number|no\.?|#)?\s*\d{1,3}(?:\s*\.\s*\d{1,3}[a-z]?)?\s*[?.!]?$/.test(normalized)
    || /^(?:page|pg\.?|p\.?|printed\s+page)\s*#?\s*\d{1,4}\s*[?.!]?$/.test(normalized)
  );
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

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
