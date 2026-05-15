import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildPdfPageAssetPayloads, PdfPageAssetPayloadTooLargeError } from "@/lib/pdf-page-assets-payload";

export const runtime = "nodejs";

const maxRequestedPages = 12;
const defaultMaxTotalBytes = 20 * 1024 * 1024;
const defaultMaxFullPdfTotalBytes = 50 * 1024 * 1024;

const pageRequestSchema = z.object({
  materialId: z.string().min(1).max(200).optional(),
  docId: z.string().min(1).max(200).optional(),
  pageStart: z.number().int().min(1).max(100000).optional(),
  pageEnd: z.number().int().min(1).max(100000).optional(),
  page_start: z.number().int().min(1).max(100000).optional(),
  page_end: z.number().int().min(1).max(100000).optional()
});

const requestSchema = z.object({
  classId: z.string().min(1).max(200),
  professorId: z.string().min(1).max(200),
  pages: z.array(pageRequestSchema).min(1).max(maxRequestedPages)
});

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);

  if (authError) {
    return authError;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid internal PDF page asset request." }, { status: 400 });
  }

  const requestedPages = expandRequestedPages(parsed.data.pages);

  if (requestedPages.length > maxRequestedPages) {
    return NextResponse.json({ error: "Too many PDF page assets requested." }, { status: 413 });
  }

  const maxTotalBytes = readPositiveInteger(process.env.INTERNAL_PDF_PAGE_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxTotalBytes;
  const maxFullPdfTotalBytes =
    readPositiveInteger(process.env.INTERNAL_FULL_PDF_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxFullPdfTotalBytes;

  try {
    const assets = await buildPdfPageAssetPayloads({
      classId: parsed.data.classId,
      maxFullPdfTotalBytes,
      maxTotalBytes,
      pages: requestedPages,
      professorId: parsed.data.professorId
    });

    return NextResponse.json({ assets });
  } catch (caughtError) {
    if (caughtError instanceof PdfPageAssetPayloadTooLargeError) {
      return NextResponse.json({ error: caughtError.message }, { status: 413 });
    }

    throw caughtError;
  }
}

function expandRequestedPages(pages: z.infer<typeof pageRequestSchema>[]) {
  const expanded: Array<{ materialId: string; pageNumber: number }> = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const materialId = String(page.materialId ?? page.docId ?? "").trim();
    const pageStart = page.pageStart ?? page.page_start;
    const pageEnd = page.pageEnd ?? page.page_end ?? pageStart;

    if (!materialId || !pageStart || !pageEnd) {
      continue;
    }

    for (let pageNumber = Math.min(pageStart, pageEnd); pageNumber <= Math.max(pageStart, pageEnd); pageNumber += 1) {
      const key = `${materialId}:${pageNumber}`;

      if (!seen.has(key)) {
        seen.add(key);
        expanded.push({ materialId, pageNumber });
      }
    }
  }

  return expanded;
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
