import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { attachPdfSlicesToChunks } from "../lib/pdf-embedding-chunks.ts";
import { rankMaterialChunks } from "../lib/retrieval-ranking.ts";
import {
  classifyTutorKnowledgePage,
  chunkTutorKnowledgePages,
  geminiEmbedding2PdfPageLimit
} from "../lib/tutor-knowledge.ts";
import type { SourceDocument } from "../lib/types.ts";

test("220-page PDF mock is chunked into page-aware embedding slices", async () => {
  const docId = "long-pdf-material";
  const title = "Long Course Reader";
  const pages = Array.from({ length: 220 }, (_, index) => ({
    pageNumber: index + 1,
    text: [
      `Section ${index + 1}`,
      ...Array.from(
        { length: 22 },
        () => `This page explains long PDF ingestion and retrieval metadata for page ${index + 1}.`
      ),
      index === 218 ? " Capstone theorem: vectors preserve structure across chunked PDF requests." : ""
    ].join("\n")
  }));
  const sourcePdf = await PDFDocument.create();

  for (let index = 0; index < pages.length; index += 1) {
    sourcePdf.addPage();
  }

  const chunks = await attachPdfSlicesToChunks({
    chunks: chunkTutorKnowledgePages({
      docId,
      pages,
      title
    }),
    pdfBytes: await sourcePdf.save()
  });

  assert.ok(chunks.length > 30);
  assert.ok(chunks.every((chunk) => chunk.pageStart && chunk.pageEnd));
  assert.ok(chunks.every((chunk) => chunk.pageEnd! - chunk.pageStart! + 1 <= geminiEmbedding2PdfPageLimit));
  assert.ok(chunks.every((chunk) => chunk.pdfPart?.mimeType === "application/pdf"));

  const capstoneChunk = chunks.find((chunk) => chunk.content.includes("Capstone theorem"));
  assert.ok(capstoneChunk);

  const embeddedPdf = await PDFDocument.load(capstoneChunk.pdfPart!.data);
  assert.ok(embeddedPdf.getPageCount() <= geminiEmbedding2PdfPageLimit);
  assert.equal(capstoneChunk.docId, docId);
  assert.equal(capstoneChunk.pageStart && capstoneChunk.pageStart > 0, true);
  assert.equal(capstoneChunk.pageEnd && capstoneChunk.pageEnd >= capstoneChunk.pageStart!, true);
  assert.equal(typeof capstoneChunk.section, "string");
  assert.equal(capstoneChunk.chunkText, capstoneChunk.content);

  const document: SourceDocument = {
    chunks: chunks.map((chunk) => ({
      content: chunk.content,
      documentId: docId,
      id: `chunk-${chunk.order}`,
      label: chunk.label,
      materialId: docId,
      materialType: "reading",
      pageNumber: chunk.pageStart,
      sectionHeading: chunk.section,
      title
    })),
    courseId: "class-algebra",
    id: docId,
    kind: "textbook",
    status: "ready",
    title,
    uploadedAt: new Date("2026-05-05T00:00:00.000Z").toISOString()
  };
  const ranked = rankMaterialChunks({
    candidates: document.chunks.map((chunk) => ({ chunk, document })),
    query: "Where is the capstone theorem about vectors preserving structure?"
  });

  assert.equal(ranked.hits[0]?.chunk.id, `chunk-${capstoneChunk.order}`);
});

test("low-text visual pages become page-level chunks", () => {
  const pages = [
    {
      metrics: {
        embeddedImageCount: 1,
        imageCoverageRatio: 0.92,
        lineCount: 1,
        pageArea: 480000,
        textDensity: 0.00002
      },
      pageNumber: 7,
      text: "Graph of the solution region"
    }
  ];
  const chunks = chunkTutorKnowledgePages({
    docId: "visual-pdf",
    pages,
    title: "Visual Worksheet"
  });

  assert.equal(classifyTutorKnowledgePage(pages[0]), "visual-scanned");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageStart, 7);
  assert.equal(chunks[0].pageEnd, 7);
  assert.equal(chunks[0].sourceType, "page-image");
});

test("mixed text and visual pages become page-level chunks", () => {
  const mixedText = [
    "Diagram note one: compare the shaded feasible region with the labeled corner points.",
    "The graph shows a boundary line crossing the vertical axis near four units.",
    "Students should estimate the slope before using algebraic substitution for confirmation.",
    "A small table beside the graph lists possible coordinates and objective values.",
    "The caption asks which point maximizes the expression under both constraints.",
    "Use the arrows in the figure to decide which side of each line is included.",
    "The worked example combines visual inspection with a short inequality check.",
    "Explain why the selected point satisfies every condition shown in the diagram."
  ].join("\n");
  const pages = [
    {
      metrics: {
        embeddedImageCount: 1,
        imageCoverageRatio: 0.48,
        lineCount: 8,
        pageArea: 480000,
        textDensity: 0.00018
      },
      pageNumber: 12,
      text: mixedText
    }
  ];
  const chunks = chunkTutorKnowledgePages({
    docId: "mixed-pdf",
    pages,
    title: "Mixed Worksheet"
  });

  assert.equal(classifyTutorKnowledgePage(pages[0]), "mixed");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageStart, 12);
  assert.equal(chunks[0].pageEnd, 12);
  assert.equal(chunks[0].sourceType, "mixed");
});
