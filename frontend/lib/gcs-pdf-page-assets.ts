import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

const localDefaultPdfAssetsBucket = "chandra-f6e13-pdf-page-assets";

let storageClient: Storage | null = null;

export type GcsPdfAssetPointer = {
  bucket: string;
  path: string;
  uri: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export function getGcsPdfAssetsBucketName() {
  const configuredBucket = process.env.GCS_PDF_ASSETS_BUCKET?.trim();

  if (configuredBucket) {
    return configuredBucket;
  }

  if (isProductionRuntime()) {
    throw new Error("GCS_PDF_ASSETS_BUCKET is required in production for canonical PDF page assets.");
  }

  return localDefaultPdfAssetsBucket;
}

export function getGcsPdfAssetsBucket(bucketName = getGcsPdfAssetsBucketName()) {
  if (!storageClient) {
    storageClient = new Storage();
  }

  return storageClient.bucket(bucketName);
}

export function buildGcsUri(bucket: string, path: string) {
  return `gs://${bucket}/${path}`;
}

export function canonicalOriginalPdfPath({
  classId,
  materialId,
  safeFileName
}: {
  classId: string;
  materialId: string;
  safeFileName: string;
}) {
  return `classes/${classId}/materials/${materialId}/original/${safeFileName}`;
}

export function canonicalPdfPageAssetPath({
  classId,
  materialId,
  pageNumber
}: {
  classId: string;
  materialId: string;
  pageNumber: number;
}) {
  return `classes/${classId}/materials/${materialId}/page-assets/page-${pageNumber}.pdf`;
}

export async function saveGcsPdfAsset({
  bucketName = getGcsPdfAssetsBucketName(),
  buffer,
  contentType,
  metadata,
  path
}: {
  bucketName?: string;
  buffer: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
  path: string;
}): Promise<GcsPdfAssetPointer> {
  const sha256 = sha256Hex(buffer);
  const bucket = getGcsPdfAssetsBucket(bucketName);

  await bucket.file(path).save(buffer, {
    contentType,
    metadata: {
      metadata: {
        checksumSha256: sha256,
        ...metadata
      }
    },
    resumable: false
  });

  return {
    bucket: bucketName,
    path,
    uri: buildGcsUri(bucketName, path),
    mimeType: contentType,
    size: buffer.length,
    sha256
  };
}

export async function downloadGcsPdfAssetBuffer({
  bucketName = getGcsPdfAssetsBucketName(),
  path
}: {
  bucketName?: string;
  path: string;
}) {
  const [buffer] = await getGcsPdfAssetsBucket(bucketName).file(path).download();
  return buffer;
}

export async function deleteGcsPdfAssetPrefix({
  bucketName = getGcsPdfAssetsBucketName(),
  prefix
}: {
  bucketName?: string;
  prefix: string;
}) {
  const bucket = getGcsPdfAssetsBucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true }).catch(() => {})));
}

export async function deleteGcsPdfAssetObject({
  bucketName = getGcsPdfAssetsBucketName(),
  path
}: {
  bucketName?: string;
  path: string;
}) {
  await getGcsPdfAssetsBucket(bucketName).file(path).delete({ ignoreNotFound: true });
}

export function isGcsPdfAssetsBucket(bucketName: string | undefined | null) {
  const normalized = bucketName?.trim();
  const configuredBucket = process.env.GCS_PDF_ASSETS_BUCKET?.trim();
  const comparableBucket = configuredBucket || localDefaultPdfAssetsBucket;

  return Boolean(normalized && normalized === comparableBucket);
}

export function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isProductionRuntime() {
  return process.env.CHANDRA_ENV === "production" || process.env.NODE_ENV === "production";
}
