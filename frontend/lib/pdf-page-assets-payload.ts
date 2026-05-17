import { downloadGcsPdfAssetBuffer } from "./gcs-pdf-page-assets";
import { getPdfPageAssetRecords } from "./pdf-ocr-postgres";

const defaultConcurrency = 4;

export class PdfPageAssetPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfPageAssetPayloadTooLargeError";
  }
}

export type PdfPageAssetRequest = {
  materialId: string;
  pageNumber: number;
};

export async function buildPdfPageAssetPayloads({
  classId,
  concurrency = defaultConcurrency,
  maxFullPdfTotalBytes,
  maxTotalBytes,
  pages,
  professorId
}: {
  classId: string;
  concurrency?: number;
  maxFullPdfTotalBytes: number;
  maxTotalBytes: number;
  pages: PdfPageAssetRequest[];
  professorId: string;
}) {
  const records = await getPdfPageAssetRecords({
    classId,
    professorId,
    pages
  });
  const pageDownloadJobs = records.map((record, index) => {
    const storageBucket = String(record.page_asset_bucket ?? record.page_asset_storage_bucket ?? "");
    const storagePath = String(record.page_asset_path ?? record.page_asset_storage_path ?? "");
    const declaredSize = Number(record.page_asset_size ?? record.page_asset_size_bytes ?? 0);

    return {
      declaredSize,
      index,
      record,
      storageBucket,
      storagePath
    };
  });
  const declaredPageBytes = pageDownloadJobs.reduce((total, job) => total + Math.max(0, job.declaredSize), 0);

  if (declaredPageBytes > maxTotalBytes) {
    throw new PdfPageAssetPayloadTooLargeError("PDF page asset payload is too large.");
  }

  const downloadedPages = await mapWithConcurrency(pageDownloadJobs, concurrency, async (job) => {
    if (!job.storageBucket || !job.storagePath) {
      return null;
    }

    return await downloadGcsPdfAssetBuffer({
      bucketName: job.storageBucket,
      path: job.storagePath
    });
  });
  const actualPageBytes = downloadedPages.reduce((total, buffer) => total + (buffer?.length ?? 0), 0);

  if (actualPageBytes > maxTotalBytes) {
    throw new PdfPageAssetPayloadTooLargeError("PDF page asset payload is too large.");
  }
  void maxFullPdfTotalBytes;

  return records.map((record, index) => {
    const storageBucket = String(record.page_asset_bucket ?? record.page_asset_storage_bucket ?? "");
    const storagePath = String(record.page_asset_path ?? record.page_asset_storage_path ?? "");
    const mimeType = String(record.page_asset_mime_type ?? "application/pdf") || "application/pdf";
    const declaredSize = Number(record.page_asset_size ?? record.page_asset_size_bytes ?? 0);
    const fullPdfBucket = String(record.full_pdf_bucket ?? "");
    const fullPdfPath = String(record.full_pdf_path ?? "");
    const fullPdfMimeType = String(record.full_pdf_mime_type ?? "application/pdf") || "application/pdf";
    const materialId = String(record.material_id ?? "");
    const pageAssetBuffer = downloadedPages[index];

    return {
      classId: record.class_id,
      docId: materialId,
      materialId,
      materialType: record.material_type,
      mimeType,
      fullPdfBucket,
      fullPdfPath,
      fullPdfUri: record.full_pdf_uri,
      fullPdfMimeType,
      fullPdfSize: record.full_pdf_size,
      fullPdfSizeBytes: record.full_pdf_size,
      fullPdfSha256: record.full_pdf_sha256,
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
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );

  return results;
}
