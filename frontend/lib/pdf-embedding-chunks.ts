import { PDFDocument } from "pdf-lib";
import {
  geminiEmbedding2PdfPageLimit,
  type TutorKnowledgeChunk
} from "./tutor-knowledge.ts";
import { TutorKnowledgeHttpError } from "./tutor-knowledge-errors.ts";

export async function attachPdfSlicesToChunks({
  chunks,
  pdfBytes,
  shouldAttachPdfSlice = () => true,
  sourcePdf
}: {
  chunks: TutorKnowledgeChunk[];
  pdfBytes: Uint8Array;
  shouldAttachPdfSlice?: (chunk: TutorKnowledgeChunk) => boolean;
  sourcePdf?: PDFDocument;
}) {
  const loadedSourcePdf = sourcePdf ?? await PDFDocument.load(pdfBytes);
  const pageCount = loadedSourcePdf.getPageCount();
  const pdfPartByPageRange = new Map<string, Promise<NonNullable<TutorKnowledgeChunk["pdfPart"]>>>();

  return Promise.all(
    chunks.map(async (chunk) => {
      if (!shouldAttachPdfSlice(chunk) || !chunk.pageStart || !chunk.pageEnd) {
        return chunk;
      }

      const pageStart = Math.max(1, Math.min(chunk.pageStart, pageCount));
      const pageEnd = Math.max(pageStart, Math.min(chunk.pageEnd, pageCount));

      if (pageEnd - pageStart + 1 > geminiEmbedding2PdfPageLimit) {
        throw new TutorKnowledgeHttpError(
          `PDF chunks must be ${geminiEmbedding2PdfPageLimit} pages or fewer before embedding.`,
          400
        );
      }

      const rangeKey = `${pageStart}:${pageEnd}`;
      let pdfPart = pdfPartByPageRange.get(rangeKey);

      if (!pdfPart) {
        pdfPart = buildPdfPartForPageRange({ pageEnd, pageStart, sourcePdf: loadedSourcePdf });
        pdfPartByPageRange.set(rangeKey, pdfPart);
      }

      return {
        ...chunk,
        pdfPart: await pdfPart
      };
    })
  );
}

async function buildPdfPartForPageRange({
  pageEnd,
  pageStart,
  sourcePdf
}: {
  pageEnd: number;
  pageStart: number;
  sourcePdf: PDFDocument;
}): Promise<NonNullable<TutorKnowledgeChunk["pdfPart"]>> {
  const chunkPdf = await PDFDocument.create();
  const copiedPages = await chunkPdf.copyPages(
    sourcePdf,
    Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart - 1 + index)
  );

  copiedPages.forEach((page) => chunkPdf.addPage(page));

  return {
    data: await chunkPdf.save(),
    mimeType: "application/pdf"
  };
}
