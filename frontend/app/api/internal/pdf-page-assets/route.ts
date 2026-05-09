import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { adminStorage } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const pageSchema = z.object({
  doc_id: z.string().max(500).optional(),
  docId: z.string().max(500).optional(),
  material_type: z.string().max(100).optional(),
  materialType: z.string().max(100).optional(),
  page_end: z.number().int().min(1).max(10000).optional(),
  page_start: z.number().int().min(1).max(10000).optional(),
  pageEnd: z.number().int().min(1).max(10000).optional(),
  pageStart: z.number().int().min(1).max(10000).optional(),
  score: z.number().optional(),
  source_pdf_path: z.string().min(1).max(5000),
  sourcePdfPath: z.string().min(1).max(5000).optional(),
  title: z.string().min(1).max(500).optional()
});

const requestSchema = z.object({
  maxTotalPages: z.number().int().min(1).max(20).optional(),
  pages: z.array(pageSchema).min(1).max(20)
});

type RequestedPage = z.infer<typeof pageSchema>;
const cacheRoot = path.join(process.cwd(), ".chandra-dev", "pdf-assets");
const sourceCacheDirectory = path.join(cacheRoot, "sources");
const pageCacheDirectory = path.join(cacheRoot, "pages");
const sourcePdfCache = new Map<string, Promise<Buffer>>();
const miniPdfCache = new Map<string, Promise<Buffer | null>>();

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);

  if (authError) {
    return authError;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid internal PDF asset request." }, { status: 400 });
  }

  const assets = await buildAssets(parsed.data.pages, parsed.data.maxTotalPages ?? 12);

  return NextResponse.json({ assets });
}

async function buildAssets(pages: RequestedPage[], maxTotalPages: number) {
  const assets = [];
  let pagesUsed = 0;

  for (const page of pages) {
    if (pagesUsed >= maxTotalPages) {
      break;
    }

    const pageStart = page.page_start ?? page.pageStart ?? 1;
    const requestedPageEnd = page.page_end ?? page.pageEnd ?? pageStart;
    const remainingPages = maxTotalPages - pagesUsed;
    const pageEnd = Math.max(pageStart, Math.min(requestedPageEnd, pageStart + remainingPages - 1));
    const asset = metadataOnlyAsset(page, pageStart, pageEnd);
    const sourcePdfPath = page.source_pdf_path ?? page.sourcePdfPath ?? "";

    try {
      const sourcePdf = await loadSourcePdf(sourcePdfPath);
      const miniPdf = await extractCachedMiniPdf(sourcePdfPath, sourcePdf, pageStart, pageEnd);

      if (miniPdf) {
        asset.file_data_url = `data:application/pdf;base64,${miniPdf.toString("base64")}`;
      }
    } catch (error) {
      console.error("Internal PDF asset build failed.", error);
    }

    assets.push(asset);
    pagesUsed += pageEnd - pageStart + 1;
  }

  return assets;
}

function metadataOnlyAsset(page: RequestedPage, pageStart: number, pageEnd: number) {
  const title = page.title ?? "Untitled PDF";

  return {
    citation_label: citationLabel(title, pageStart, pageEnd),
    doc_id: page.doc_id ?? page.docId ?? "",
    images: [],
    material_type: page.material_type ?? page.materialType ?? "",
    page_end: pageEnd,
    page_start: pageStart,
    printed_page_end: null,
    printed_page_start: null,
    score: page.score ?? 0,
    title
  } as {
    citation_label: string;
    doc_id: string;
    file_data_url?: string;
    images: string[];
    material_type: string;
    page_end: number;
    page_start: number;
    printed_page_end: null;
    printed_page_start: null;
    score: number;
    title: string;
  };
}

async function loadSourcePdf(sourcePdfPath: string) {
  const cacheKey = hashCacheKey(sourcePdfPath);
  const cached = sourcePdfCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const pending = loadCachedSourcePdf(sourcePdfPath, cacheKey).catch((error) => {
    sourcePdfCache.delete(cacheKey);
    throw error;
  });

  sourcePdfCache.set(cacheKey, pending);
  return pending;
}

async function loadCachedSourcePdf(sourcePdfPath: string, cacheKey: string) {
  await mkdir(sourceCacheDirectory, { recursive: true });
  const cachePath = path.join(sourceCacheDirectory, `${cacheKey}.pdf`);

  try {
    return await readFile(cachePath);
  } catch {
    const buffer = await downloadSourcePdf(sourcePdfPath);
    await writeFile(cachePath, buffer);
    return buffer;
  }
}

async function downloadSourcePdf(sourcePdfPath: string) {
  const storageReference = parseStorageReference(sourcePdfPath);

  if (storageReference) {
    if (!adminStorage) {
      throw new Error("Firebase Admin Storage is not configured.");
    }

    const { bucketName, objectPath } = storageReference;
    const bucket = bucketName ? adminStorage.bucket(bucketName) : adminStorage.bucket();
    const [buffer] = await bucket.file(objectPath).download();
    return buffer;
  }

  if (sourcePdfPath.startsWith("http://") || sourcePdfPath.startsWith("https://")) {
    const response = await fetch(sourcePdfPath);

    if (!response.ok) {
      throw new Error(`PDF download failed with status ${response.status}.`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  if (!adminStorage) {
    throw new Error("Firebase Admin Storage is not configured.");
  }

  const [buffer] = await adminStorage.bucket().file(sourcePdfPath).download();
  return buffer;
}

async function extractCachedMiniPdf(sourcePdfPath: string, sourcePdf: Buffer, pageStart: number, pageEnd: number) {
  const cacheKey = hashCacheKey(`${sourcePdfPath}:${pageStart}:${pageEnd}`);
  const cached = miniPdfCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const pending = readOrCreateMiniPdf(cacheKey, sourcePdf, pageStart, pageEnd).catch((error) => {
    miniPdfCache.delete(cacheKey);
    throw error;
  });

  miniPdfCache.set(cacheKey, pending);
  return pending;
}

async function readOrCreateMiniPdf(cacheKey: string, sourcePdf: Buffer, pageStart: number, pageEnd: number) {
  await mkdir(pageCacheDirectory, { recursive: true });
  const cachePath = path.join(pageCacheDirectory, `${cacheKey}.pdf`);

  try {
    return await readFile(cachePath);
  } catch {
    const miniPdf = await extractMiniPdf(sourcePdf, pageStart, pageEnd);

    if (!miniPdf) {
      return null;
    }

    const buffer = Buffer.from(miniPdf);
    await writeFile(cachePath, buffer);
    return buffer;
  }
}

async function extractMiniPdf(sourcePdf: Buffer, pageStart: number, pageEnd: number) {
  const source = await PDFDocument.load(sourcePdf, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const indexes = [];

  for (let pageNumber = pageStart; pageNumber <= Math.min(pageEnd, pageCount); pageNumber += 1) {
    indexes.push(pageNumber - 1);
  }

  if (!indexes.length) {
    return null;
  }

  const output = await PDFDocument.create();
  const copiedPages = await output.copyPages(source, indexes);

  for (const page of copiedPages) {
    output.addPage(page);
  }

  return output.save();
}

function hashCacheKey(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function parseStorageReference(sourcePdfPath: string) {
  if (sourcePdfPath.startsWith("gs://")) {
    const bucketAndPath = sourcePdfPath.slice("gs://".length);
    const separatorIndex = bucketAndPath.indexOf("/");

    if (separatorIndex > 0) {
      return {
        bucketName: bucketAndPath.slice(0, separatorIndex),
        objectPath: bucketAndPath.slice(separatorIndex + 1)
      };
    }
  }

  try {
    const parsed = new URL(sourcePdfPath);

    if (parsed.hostname === "storage.googleapis.com") {
      const [bucketName, ...pathParts] = parsed.pathname.split("/").filter(Boolean);

      if (bucketName && pathParts.length) {
        return {
          bucketName,
          objectPath: decodeURIComponent(pathParts.join("/"))
        };
      }
    }

    if (parsed.hostname === "firebasestorage.googleapis.com") {
      const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);

      if (match) {
        return {
          bucketName: decodeURIComponent(match[1]),
          objectPath: decodeURIComponent(match[2])
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function citationLabel(title: string, pageStart: number, pageEnd: number) {
  const pages = pageStart === pageEnd ? `page ${pageStart}` : `pages ${pageStart}-${pageEnd}`;
  return `${title}, ${pages}`;
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
