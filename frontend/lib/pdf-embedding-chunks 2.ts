import { PDFDocument } from "pdf-lib";
import {
  geminiEmbedding2PdfPageLimit,
  type TutorKnowledgeChunk
} from "./tutor-knowledge.ts";
import { TutorKnowledgeHttpError } from "./tutor-knowledge-errors.ts";

export async function attachPdfSlicesToChunks({
  chunks,
  pdfBytes
}: {
  chunks: TutorKnowledgeChunk[];
  pdfBytes: Uint8Array;
}) {
  const sourcePdf = await PDFDocument.load(pdfBytes);
  const pageCount = sourcePdf.getPageCount();

  return Promise.all(
    chunks.map(async (chunk) => {
      if (!chunk.pageStart || !chunk.pageEnd) {
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

      const chunkPdf = await PDFDocument.create();
      const copiedPages = await chunkPdf.copyPages(
        sourcePdf,
        Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart - 1 + index)
      );

      copiedPages.forEach((page) => chunkPdf.addPage(page));

      return {
        ...chunk,
        pdfPart: {
          data: await chunkPdf.save(),
          mimeType: "application/pdf"
        }
      };
    })
  );
}
