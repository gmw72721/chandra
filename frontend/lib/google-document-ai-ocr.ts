import { GoogleAuth, type JWTInput } from "google-auth-library";
import { PDFDocument } from "pdf-lib";
import {
  downloadGcsPdfAssetBuffer
} from "./gcs-pdf-page-assets.ts";
import { problemNumbersFromText } from "./retrieval-ranking.ts";
import type { PdfDetectedProblemMetadata, PdfMaterialMetadata, PdfOcrPageMetadata } from "./types.ts";

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultDocumentAiProcessorId = "5d3fa32c2ebe2a90";
const defaultDocumentAiProcessorName = "chandra-ocr";
const defaultDocumentAiOnlineConcurrency = 2;
const defaultDocumentAiRequestTimeoutMs = 30000;
const defaultDocumentAiInputShardPageCount = 10;

export type DocumentAiOcrPage = {
  confidence: number | null;
  pageNumber: number;
  text: string;
};

export type DocumentAiOcrResult = {
  inputShardCount: number;
  inputShardPageCount: number;
  outputPrefix: string;
  pages: DocumentAiOcrPage[];
  provider: "google-document-ai";
  source: string;
};

type DocumentAiProgress = {
  completedShards?: number;
  elapsedMs?: number;
  pageEnd?: number;
  pageStart?: number;
  phase: "started" | "processing" | "completed";
  totalShards?: number;
};

type DocumentAiOcrConfig = {
  endpoint: string;
  location: string;
  processorId: string;
  processorName: string;
  projectId: string;
  quotaProjectId: string;
};

type DocumentAiDocument = {
  uri?: string;
  text?: string;
  pages?: DocumentAiPage[];
};

type DocumentAiInputShard = {
  buffer: Buffer;
  pageEnd: number;
  pageStart: number;
};

type DocumentAiPage = {
  blocks?: DocumentAiLayoutContainer[];
  layout?: DocumentAiLayout;
  lines?: DocumentAiLayoutContainer[];
  pageNumber?: number;
  paragraphs?: DocumentAiLayoutContainer[];
  tokens?: DocumentAiLayoutContainer[];
};

type DocumentAiLayoutContainer = {
  layout?: DocumentAiLayout;
};

type DocumentAiLayout = {
  confidence?: number;
  textAnchor?: {
    textSegments?: Array<{
      endIndex?: string | number;
      startIndex?: string | number;
    }>;
  };
};

export async function runGoogleDocumentAiPdfOcr({
  classId,
  materialId,
  mimeType,
  onProgress,
  storageBucket,
  storagePath
}: {
  classId: string;
  materialId: string;
  mimeType: string;
  onProgress?: (progress: DocumentAiProgress) => Promise<void> | void;
  storageBucket: string;
  storagePath: string;
}): Promise<DocumentAiOcrResult> {
  const config = getDocumentAiOcrConfig();
  const authHeaders = await getGoogleAuthHeaders(config.quotaProjectId);
  const runId = Date.now();
  const processorResource = `projects/${config.projectId}/locations/${config.location}/processors/${config.processorId}`;
  const processUrl = `https://${config.endpoint}/v1/${processorResource}:process`;
  const inputShardPageCount = getDocumentAiInputShardPageCount();
  const inputShards = await buildDocumentAiInputShards({
    inputShardPageCount,
    storageBucket,
    storagePath
  });
  const startedAt = Date.now();
  let completedShards = 0;

  await onProgress?.({
    completedShards,
    elapsedMs: 0,
    phase: "started",
    totalShards: inputShards.length
  });

  const documents = await mapWithConcurrency(
    inputShards,
    getDocumentAiOnlineConcurrency(),
    async (shard) => {
      const document = await postDocumentAiProcess({
        authHeaders,
        mimeType,
        processUrl,
        processorName: config.processorName,
        shard
      });
      completedShards += 1;
      await onProgress?.({
        completedShards,
        elapsedMs: Date.now() - startedAt,
        pageEnd: shard.pageEnd,
        pageStart: shard.pageStart,
        phase: "processing",
        totalShards: inputShards.length
      });

      return { document, shard };
    }
  );
  await onProgress?.({
    completedShards,
    elapsedMs: Date.now() - startedAt,
    phase: "completed",
    totalShards: inputShards.length
  });

  const pages = documents
    .flatMap(({ document, shard }) => parseDocumentAiPages(document, shard.pageStart - 1))
    .sort((first, second) => first.pageNumber - second.pageNumber);

  return {
    inputShardCount: inputShards.length,
    inputShardPageCount,
    outputPrefix: `document-ai-process/${runId}`,
    pages,
    provider: "google-document-ai",
    source: processorResource
  };
}

export function buildPdfOcrMetadataRecords({
  contentType,
  fileName,
  fileSize,
  fullPdfBucket,
  fullPdfMimeType,
  fullPdfPath,
  fullPdfSha256,
  fullPdfSize,
  fullPdfUri,
  materialId,
  classId,
  materialType,
  ocr,
  sourceKind,
  storageBucket,
  storagePath,
  title,
  teacherId
}: {
  contentType: string;
  fileName: string;
  fileSize: number;
  fullPdfBucket?: string;
  fullPdfMimeType?: string;
  fullPdfPath?: string;
  fullPdfSha256?: string;
  fullPdfSize?: number;
  fullPdfUri?: string;
  materialId: string;
  classId: string;
  materialType: string;
  ocr: Pick<DocumentAiOcrResult, "pages" | "provider" | "source">;
  sourceKind: PdfMaterialMetadata["sourceKind"];
  storageBucket: string;
  storagePath: string;
  title: string;
  teacherId: string;
}) {
  const pages: PdfOcrPageMetadata[] = ocr.pages.map((page) => ({
    materialId,
    classId,
    courseId: classId,
    professorId: teacherId,
    teacherId,
    title,
    materialType,
    pageNumber: page.pageNumber,
    pageStart: page.pageNumber,
    pageEnd: page.pageNumber,
    ocrText: page.text,
    ocrProvider: ocr.provider,
    ocrSource: ocr.source,
    ocrConfidence: page.confidence,
    storageBucket,
    storagePath,
    fullPdfBucket: fullPdfBucket ?? storageBucket,
    fullPdfPath: fullPdfPath ?? storagePath,
    fullPdfUri: fullPdfUri ?? `gs://${fullPdfBucket ?? storageBucket}/${fullPdfPath ?? storagePath}`,
    fullPdfMimeType: fullPdfMimeType ?? contentType,
    fullPdfSize: fullPdfSize ?? fileSize,
    fullPdfSha256: fullPdfSha256 ?? null
  }));
  const characterCount = pages.reduce((sum, page) => sum + page.ocrText.length, 0);
  const confidenceValues = pages
    .map((page) => page.ocrConfidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const ocrConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : null;
  const material: PdfMaterialMetadata = {
    materialId,
    classId,
    courseId: classId,
    professorId: teacherId,
    teacherId,
    title,
    materialType,
    contentType,
    fileName,
    fileSize,
    storageBucket,
    storagePath,
    storageUri: `gs://${storageBucket}/${storagePath}`,
    fullPdfBucket: fullPdfBucket ?? storageBucket,
    fullPdfPath: fullPdfPath ?? storagePath,
    fullPdfUri: fullPdfUri ?? `gs://${fullPdfBucket ?? storageBucket}/${fullPdfPath ?? storagePath}`,
    fullPdfMimeType: fullPdfMimeType ?? contentType,
    fullPdfSize: fullPdfSize ?? fileSize,
    fullPdfSha256: fullPdfSha256 ?? null,
    sourceKind,
    ocrProvider: ocr.provider,
    ocrSource: ocr.source,
    ocrConfidence,
    pageCount: pages.length,
    characterCount
  };
  const problems = pages.flatMap((page) =>
    problemNumbersFromText(page.ocrText).map((problemNumber) => ({
      materialId,
      classId,
      courseId: classId,
      professorId: teacherId,
      teacherId,
      title,
      materialType,
      problemNumber,
      pageStart: page.pageNumber,
      pageEnd: page.pageNumber,
      problemText: page.ocrText,
      source: "regex-from-document-ai-ocr",
      confidence: page.ocrConfidence,
      ocrProvider: ocr.provider,
      ocrSource: ocr.source,
      storageBucket,
      storagePath
    }))
  ) satisfies PdfDetectedProblemMetadata[];

  return { characterCount, material, pageCount: pages.length, pages, problems };
}

export function parseDocumentAiPages(document: DocumentAiDocument, pageOffset = 0): DocumentAiOcrPage[] {
  const fullText = document.text ?? "";

  return (document.pages ?? []).map((page, index) => {
    const pageNumber = Number(page.pageNumber ?? index + 1);
    const layoutText = extractTextFromAnchor(fullText, page.layout);
    const fallbackText = extractPageContainerText(fullText, page);
    const tokenConfidence = averageConfidence(page.tokens?.map((token) => token.layout?.confidence));

    return {
      confidence: normalizeConfidence(page.layout?.confidence ?? tokenConfidence),
      pageNumber: pageOffset + (Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : index + 1),
      text: (layoutText || fallbackText).replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim()
    };
  });
}

function getDocumentAiOcrConfig(): DocumentAiOcrConfig {
  const projectId = process.env.DOCUMENT_AI_PROJECT_ID?.trim()
    || process.env.GOOGLE_CLOUD_PROJECT?.trim()
    || process.env.FIREBASE_PROJECT_ID?.trim()
    || "";
  const location = process.env.DOCUMENT_AI_LOCATION?.trim()
    || process.env.GOOGLE_CLOUD_LOCATION?.trim()
    || "us";
  const processorId = process.env.DOCUMENT_AI_OCR_PROCESSOR_ID?.trim()
    || process.env.GOOGLE_DOCUMENT_AI_OCR_PROCESSOR_ID?.trim()
    || defaultDocumentAiProcessorId;
  const processorName = process.env.DOCUMENT_AI_OCR_PROCESSOR_NAME?.trim() || defaultDocumentAiProcessorName;
  const quotaProjectId = process.env.DOCUMENT_AI_QUOTA_PROJECT_ID?.trim()
    || process.env.GOOGLE_CLOUD_QUOTA_PROJECT?.trim()
    || projectId;

  if (!projectId || !location || !processorId) {
    throw new Error("Document AI OCR requires DOCUMENT_AI_PROJECT_ID or GOOGLE_CLOUD_PROJECT, DOCUMENT_AI_LOCATION, and DOCUMENT_AI_OCR_PROCESSOR_ID.");
  }

  return {
    endpoint: `${location}-documentai.googleapis.com`,
    location,
    processorId,
    processorName,
    projectId,
    quotaProjectId
  };
}

async function postDocumentAiProcess({
  authHeaders,
  mimeType,
  processUrl,
  processorName,
  shard
}: {
  authHeaders: Record<string, string>;
  mimeType: string;
  processUrl: string;
  processorName: string;
  shard: DocumentAiInputShard;
}) {
  const response = await fetchDocumentAi(processUrl, "process", {
    body: JSON.stringify({
      rawDocument: {
        content: shard.buffer.toString("base64"),
        mimeType
      },
      labels: {
        processor: processorName,
        source: "chandra_pdf_ingestion"
      },
      skipHumanReview: true
    }),
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(formatDocumentAiHttpError("process", response.status, detail));
  }

  return ((await response.json()) as { document?: DocumentAiDocument }).document ?? {};
}

async function fetchDocumentAi(url: string, operation: string, init: RequestInit) {
  const timeoutMs =
    readPositiveInteger(process.env.DOCUMENT_AI_OCR_REQUEST_TIMEOUT_MS) ?? defaultDocumentAiRequestTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (caughtError) {
    if (caughtError instanceof Error && caughtError.name === "AbortError") {
      throw new Error(`Document AI ${operation} request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    throw caughtError;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildDocumentAiInputShards({
  inputShardPageCount,
  storageBucket,
  storagePath
}: {
  inputShardPageCount: number;
  storageBucket: string;
  storagePath: string;
}) {
  const buffer = await downloadGcsPdfAssetBuffer({ bucketName: storageBucket, path: storagePath });
  const sourcePdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = sourcePdf.getPageCount();

  if (pageCount <= 0) {
    throw new Error("Stored PDF does not contain any pages for Document AI OCR.");
  }

  const shardSpecs = [];

  for (let pageStart = 1; pageStart <= pageCount; pageStart += inputShardPageCount) {
    shardSpecs.push({
      pageEnd: Math.min(pageCount, pageStart + inputShardPageCount - 1),
      pageStart
    });
  }

  const shards = await mapWithConcurrency(shardSpecs, getDocumentAiShardBuildConcurrency(), async ({ pageEnd, pageStart }) => {
    const shardPdf = await PDFDocument.create();
    const copiedPages = await shardPdf.copyPages(
      sourcePdf,
      Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart - 1 + index)
    );

    copiedPages.forEach((page) => shardPdf.addPage(page));

    return {
      buffer: Buffer.from(await shardPdf.save()),
      pageEnd,
      pageStart
    };
  });

  return shards.sort((first, second) => first.pageStart - second.pageStart);
}

function getDocumentAiInputShardPageCount() {
  return readPositiveInteger(process.env.DOCUMENT_AI_OCR_INPUT_SHARD_PAGE_COUNT)
    ?? defaultDocumentAiInputShardPageCount;
}

function getDocumentAiShardBuildConcurrency() {
  return readPositiveInteger(process.env.DOCUMENT_AI_OCR_SHARD_BUILD_CONCURRENCY) ?? 4;
}

function getDocumentAiOnlineConcurrency() {
  return readPositiveInteger(process.env.DOCUMENT_AI_OCR_ONLINE_CONCURRENCY) ?? defaultDocumentAiOnlineConcurrency;
}

function extractPageContainerText(fullText: string, page: DocumentAiPage) {
  const containers = page.lines?.length ? page.lines : page.paragraphs?.length ? page.paragraphs : page.blocks ?? [];

  return containers
    .map((container) => extractTextFromAnchor(fullText, container.layout))
    .filter(Boolean)
    .join("\n");
}

function extractTextFromAnchor(fullText: string, layout?: DocumentAiLayout) {
  const segments = layout?.textAnchor?.textSegments ?? [];

  return segments
    .map((segment) => {
      const startIndex = Number(segment.startIndex ?? 0);
      const endIndex = Number(segment.endIndex ?? 0);

      if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex) || endIndex <= startIndex) {
        return "";
      }

      return fullText.slice(startIndex, endIndex);
    })
    .join("");
}

function averageConfidence(values: Array<number | undefined> | undefined) {
  const confidenceValues = (values ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!confidenceValues.length) {
    return null;
  }

  return confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
}

function normalizeConfidence(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

async function getGoogleAuthHeaders(quotaProjectId: string) {
  const credentials = getGoogleCredentials();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: [cloudPlatformScope]
  });
  const client = await auth.getClient();
  const quotaAwareClient = client as typeof client & { quotaProjectId?: string };

  if (!quotaAwareClient.quotaProjectId && quotaProjectId && isUserRefreshClient(client)) {
    quotaAwareClient.quotaProjectId = quotaProjectId;
  }

  const headers = await client.getRequestHeaders();
  const authHeaders = Object.fromEntries(headers.entries());

  if (!authHeaders.authorization) {
    throw new Error("Google auth did not return an Authorization header for Document AI.");
  }

  if (!authHeaders["x-goog-user-project"] && quotaProjectId && isUserRefreshClient(client)) {
    authHeaders["x-goog-user-project"] = quotaProjectId;
  }

  return authHeaders;
}

function isUserRefreshClient(client: unknown) {
  return typeof client === "object" && client !== null && client.constructor.name === "UserRefreshClient";
}

function formatDocumentAiHttpError(operation: string, status: number, detail: string) {
  const clippedDetail = detail.slice(0, 500);

  if (status === 403 && /quota project/i.test(detail)) {
    return [
      `Document AI ${operation} failed with 403 because local Google Application Default Credentials do not have a quota project.`,
      "Set GOOGLE_CLOUD_QUOTA_PROJECT or DOCUMENT_AI_QUOTA_PROJECT_ID to the Google Cloud project that owns Document AI, then restart the dev server.",
      clippedDetail
    ].join(" ");
  }

  return `Document AI ${operation} failed with ${status}: ${clippedDetail}`;
}

function getGoogleCredentials(): JWTInput | undefined {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as JWTInput & {
      clientEmail?: string;
      privateKey?: string;
      projectId?: string;
    };

    return {
      client_email: serviceAccount.client_email ?? serviceAccount.clientEmail,
      private_key: (serviceAccount.private_key ?? serviceAccount.privateKey)?.replace(/\\n/g, "\n"),
      project_id: serviceAccount.project_id ?? serviceAccount.projectId
    };
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY ?? process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.DOCUMENT_AI_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;

  if (!clientEmail || !privateKey || !projectId) {
    return undefined;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    project_id: projectId
  };
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrencyLimit: number,
  mapItem: (item: TItem, index: number) => Promise<TResult>
) {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrencyLimit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapItem(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}
