import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { downloadGcsPdfAssetBuffer } from "@/lib/gcs-pdf-page-assets";
import { getPdfPageAssetRecords } from "@/lib/pdf-ocr-postgres";

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

  const records = await getPdfPageAssetRecords({
    classId: parsed.data.classId,
    professorId: parsed.data.professorId,
    pages: requestedPages
  });
  const maxTotalBytes = readPositiveInteger(process.env.INTERNAL_PDF_PAGE_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxTotalBytes;
  const maxFullPdfTotalBytes =
    readPositiveInteger(process.env.INTERNAL_FULL_PDF_ASSET_MAX_TOTAL_BYTES) ?? defaultMaxFullPdfTotalBytes;
  let totalBytes = 0;
  let fullPdfTotalBytes = 0;
  const attachedFullPdfMaterials = new Set<string>();
  const skippedFullPdfMaterials = new Set<string>();
  const assets: Array<Record<string, unknown>> = [];

  for (const record of records) {
    const storageBucket = String(record.page_asset_bucket ?? record.page_asset_storage_bucket ?? "");
    const storagePath = String(record.page_asset_path ?? record.page_asset_storage_path ?? "");
    const mimeType = String(record.page_asset_mime_type ?? "application/pdf") || "application/pdf";
    const declaredSize = Number(record.page_asset_size ?? record.page_asset_size_bytes ?? 0);
    const fullPdfBucket = String(record.full_pdf_bucket ?? "");
    const fullPdfPath = String(record.full_pdf_path ?? "");
    const fullPdfMimeType = String(record.full_pdf_mime_type ?? "application/pdf") || "application/pdf";
    const fullPdfDeclaredSize = Number(record.full_pdf_size ?? 0);
    const materialId = String(record.material_id ?? "");

    let pageAssetBuffer: Buffer | null = null;

    if (storageBucket && storagePath) {
      if (declaredSize > 0 && totalBytes + declaredSize > maxTotalBytes) {
        return NextResponse.json({ error: "PDF page asset payload is too large." }, { status: 413 });
      }

      pageAssetBuffer = await downloadGcsPdfAssetBuffer({ bucketName: storageBucket, path: storagePath });
      totalBytes += pageAssetBuffer.length;

      if (totalBytes > maxTotalBytes) {
        return NextResponse.json({ error: "PDF page asset payload is too large." }, { status: 413 });
      }
    }

    let fullPdfBuffer: Buffer | null = null;
    let fullPdfSkippedReason = "";

    if (
      materialId &&
      fullPdfBucket &&
      fullPdfPath &&
      !attachedFullPdfMaterials.has(materialId) &&
      !skippedFullPdfMaterials.has(materialId)
    ) {
      if (fullPdfDeclaredSize > 0 && fullPdfTotalBytes + fullPdfDeclaredSize > maxFullPdfTotalBytes) {
        fullPdfSkippedReason = "full PDF payload would exceed configured byte limit";
        skippedFullPdfMaterials.add(materialId);
      } else {
        fullPdfBuffer = await downloadGcsPdfAssetBuffer({ bucketName: fullPdfBucket, path: fullPdfPath });

        if (fullPdfTotalBytes + fullPdfBuffer.length > maxFullPdfTotalBytes) {
          fullPdfSkippedReason = "full PDF payload would exceed configured byte limit";
          fullPdfBuffer = null;
          skippedFullPdfMaterials.add(materialId);
        } else {
          fullPdfTotalBytes += fullPdfBuffer.length;
          attachedFullPdfMaterials.add(materialId);
        }
      }
    }

    assets.push({
      classId: record.class_id,
      docId: materialId,
      materialId,
      materialType: record.material_type,
      mimeType,
      ocrConfidence: record.ocr_confidence,
      ocrProvider: record.ocr_provider,
      ocrSource: record.ocr_source,
      ocrText: record.ocr_text,
      fullPdfBucket,
      fullPdfPath,
      fullPdfUri: record.full_pdf_uri,
      fullPdfMimeType,
      fullPdfSize: fullPdfBuffer?.length ?? record.full_pdf_size,
      fullPdfSizeBytes: fullPdfBuffer?.length ?? record.full_pdf_size,
      fullPdfSha256: record.full_pdf_sha256,
      ...(fullPdfBuffer
        ? {
            fullPdfDataUrl: `data:${fullPdfMimeType};base64,${fullPdfBuffer.toString("base64")}`,
            fullPdfFileName: `${materialId || "source"}.pdf`
          }
        : fullPdfSkippedReason
          ? { fullPdfSkippedReason }
          : {}),
      pageAssetBucket: storageBucket,
      pageAssetPath: storagePath,
      pageAssetUri: record.page_asset_uri,
      pageAssetChecksumSha256: record.page_asset_sha256 ?? record.page_asset_checksum_sha256,
      pageAssetMimeType: mimeType,
      pageAssetSha256: record.page_asset_sha256 ?? record.page_asset_checksum_sha256,
      pageAssetSize: pageAssetBuffer?.length ?? declaredSize,
      pageAssetSizeBytes: pageAssetBuffer?.length ?? declaredSize,
      pageAssetStorageBucket: storageBucket,
      pageAssetStoragePath: storagePath,
      pageEnd: record.page_end,
      pageNumber: record.page_number,
      pageStart: record.page_start,
      title: record.title,
      ...(pageAssetBuffer ? { dataUrl: `data:${mimeType};base64,${pageAssetBuffer.toString("base64")}` } : {})
    });
  }

  return NextResponse.json({ assets });
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
