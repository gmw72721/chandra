import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const pageSchema = z.object({
  chunk_text: z.string().max(3000).optional(),
  chunkText: z.string().max(3000).optional(),
  chunkTextPreview: z.string().max(3000).optional(),
  doc_id: z.string().max(500).optional(),
  docId: z.string().max(500).optional(),
  material_type: z.string().max(100).optional(),
  materialType: z.string().max(100).optional(),
  page_end: z.number().int().min(1).max(10000).optional(),
  page_start: z.number().int().min(1).max(10000).optional(),
  pageEnd: z.number().int().min(1).max(10000).optional(),
  pageStart: z.number().int().min(1).max(10000).optional(),
  score: z.number().optional(),
  section: z.string().max(500).optional(),
  source_type: z.string().max(100).optional(),
  sourceType: z.string().max(100).optional(),
  source_pdf_path: z.string().max(5000).optional(),
  sourcePdfPath: z.string().min(1).max(5000).optional(),
  title: z.string().min(1).max(500).optional()
});

const requestSchema = z.object({
  maxTotalPages: z.number().int().min(1).max(20).optional(),
  pages: z.array(pageSchema).min(1).max(20)
});

type RequestedPage = z.infer<typeof pageSchema>;

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
  const selectedPages = [];
  let pagesUsed = 0;

  for (const page of pages) {
    if (pagesUsed >= maxTotalPages) {
      break;
    }

    const pageStart = page.page_start ?? page.pageStart ?? 1;
    const requestedPageEnd = page.page_end ?? page.pageEnd ?? pageStart;
    const remainingPages = maxTotalPages - pagesUsed;
    const pageEnd = Math.max(pageStart, Math.min(requestedPageEnd, pageStart + remainingPages - 1));
    selectedPages.push({ page, pageEnd, pageStart });
    pagesUsed += pageEnd - pageStart + 1;
  }

  return Promise.all(
    selectedPages.map(({ page, pageEnd, pageStart }) => buildAsset(page, pageStart, pageEnd))
  );
}

async function buildAsset(page: RequestedPage, pageStart: number, pageEnd: number) {
  return metadataOnlyAsset(page, pageStart, pageEnd);
}

function metadataOnlyAsset(page: RequestedPage, pageStart: number, pageEnd: number) {
  const title = page.title ?? "Untitled PDF";

  return {
    citation_label: citationLabel(title, pageStart, pageEnd),
    chunk_text: compactTextPreview(page.chunk_text ?? page.chunkText ?? page.chunkTextPreview ?? ""),
    doc_id: page.doc_id ?? page.docId ?? "",
    images: [],
    material_type: page.material_type ?? page.materialType ?? "",
    page_end: pageEnd,
    page_start: pageStart,
    printed_page_end: null,
    printed_page_start: null,
    score: page.score ?? 0,
    section: page.section ?? "",
    source_type: page.source_type ?? page.sourceType ?? "",
    source_pdf_path: page.source_pdf_path ?? page.sourcePdfPath ?? "",
    title
  } as {
    citation_label: string;
    chunk_text: string;
    doc_id: string;
    images: string[];
    material_type: string;
    page_end: number;
    page_start: number;
    printed_page_end: null;
    printed_page_start: null;
    score: number;
    section: string;
    source_type: string;
    source_pdf_path: string;
    title: string;
  };
}

function compactTextPreview(text: string) {
  const preview = text.replace(/\s+/g, " ").trim();
  if (preview.length <= 700) {
    return preview;
  }

  return preview.slice(0, 700).replace(/\s+\S*$/, "").trim();
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
