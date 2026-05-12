import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  buildPdfOcrMetadataRecords,
  parseDocumentAiPages
} from "../frontend/lib/google-document-ai-ocr.ts";
import { coercePdfOcrEmbeddingForPostgres } from "../frontend/lib/pdf-ocr-postgres.ts";

const repoRoot = process.cwd();

test("PDF OCR metadata records preserve storage and searchable PostgreSQL fields", () => {
  const records = buildPdfOcrMetadataRecords({
    classId: "class-algebra",
    contentType: "application/pdf",
    fileName: "worksheet.pdf",
    fileSize: 2048,
    materialId: "material-ocr",
    materialType: "assignment",
    ocr: {
      provider: "google-document-ai",
      source: "projects/chandra-f6e13/locations/us/processors/5d3fa32c2ebe2a90",
      pages: [
        {
          confidence: 0.93,
          pageNumber: 4,
          text: "Problem 7. Solve the system using substitution."
        }
      ]
    },
    sourceKind: "file",
    storageBucket: "chandra-f6e13-tutor-knowledge",
    storagePath: "classes/class-algebra/materials/material-ocr/original/worksheet.pdf",
    teacherId: "teacher-1",
    title: "Systems Worksheet"
  });

  assert.equal(records.material.storageUri, "gs://chandra-f6e13-tutor-knowledge/classes/class-algebra/materials/material-ocr/original/worksheet.pdf");
  assert.equal(records.material.ocrProvider, "google-document-ai");
  assert.equal(records.material.ocrSource, "projects/chandra-f6e13/locations/us/processors/5d3fa32c2ebe2a90");
  assert.equal(records.pages[0].pageNumber, 4);
  assert.equal(records.pages[0].pageStart, 4);
  assert.equal(records.pages[0].pageEnd, 4);
  assert.equal(records.pages[0].ocrConfidence, 0.93);
  assert.equal(records.problems[0].problemNumber, "7");
  assert.equal(records.problems[0].source, "regex-from-document-ai-ocr");
  assert.equal(records.problems[0].confidence, 0.93);
});

test("Document AI page parser supports scanned PDF OCR output without embedded PDF text", () => {
  const pages = parseDocumentAiPages({
    text: "Problem 12\nFind the shaded area.",
    pages: [
      {
        pageNumber: 1,
        layout: {
          confidence: 0.88,
          textAnchor: {
            textSegments: [{ startIndex: "0", endIndex: "33" }]
          }
        }
      }
    ]
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages[0].confidence, 0.88);
  assert.match(pages[0].text, /Problem 12/);

  const offsetPages = parseDocumentAiPages({
    text: "Problem 21",
    pages: [
      {
        pageNumber: 2,
        layout: {
          textAnchor: {
            textSegments: [{ startIndex: "0", endIndex: "10" }]
          }
        }
      }
    ]
  }, 10);

  assert.equal(offsetPages[0].pageNumber, 12);
});

test("PDF OCR metadata write drops embeddings that do not match the Postgres vector width", () => {
  const validEmbedding = coercePdfOcrEmbeddingForPostgres({
    createdAt: "2026-05-11T00:00:00.000Z",
    dimensions: 768,
    model: "gemini-embedding-2",
    provider: "vertex-ai",
    taskType: "RETRIEVAL_DOCUMENT",
    values: Array.from({ length: 768 }, (_, index) => index / 768)
  });

  assert.equal(validEmbedding.dimensions, 768);
  assert.match(validEmbedding.vector ?? "", /^\[/);

  const mismatchedEmbedding = coercePdfOcrEmbeddingForPostgres({
    createdAt: "2026-05-11T00:00:00.000Z",
    dimensions: 3072,
    model: "gemini-embedding-2",
    provider: "vertex-ai",
    taskType: "RETRIEVAL_DOCUMENT",
    values: Array.from({ length: 3072 }, (_, index) => index / 3072)
  });

  assert.deepEqual(mismatchedEmbedding, {
    createdAt: null,
    dimensions: null,
    model: null,
    provider: null,
    taskType: null,
    vector: null
  });
});

test("PDF ingestion uses Document AI and PostgreSQL instead of Firestore PDF slices for new uploads", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const dbSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ocr-postgres.ts"), "utf8");
  const gcsSource = readFileSync(join(repoRoot, "frontend/lib/gcs-pdf-page-assets.ts"), "utf8");
  const ocrSource = readFileSync(join(repoRoot, "frontend/lib/google-document-ai-ocr.ts"), "utf8");
  const pdfSaveFunction = source.slice(
    source.indexOf("async function savePdfTutorKnowledgeOcrMetadata"),
    source.indexOf("export async function deleteTutorKnowledge")
  );

  assert.match(source, /runGoogleDocumentAiPdfOcr/);
  assert.match(source, /replacePdfOcrMetadata/);
  assert.match(source, /attachPdfOcrEmbeddings/);
  assert.match(source, /createVertexEmbeddings/);
  assert.match(source, /searchMetadataSource: "postgres"/);
  assert.match(source, /chunkCount: 0/);
  assert.match(source, /embeddingStatus: isVertexEmbeddingConfigured\(\) \? "ready" : "not-configured"/);
  assert.match(source, /filePath: storagePath/);
  assert.match(source, /storageBucket/);
  assert.match(source, /isPdfSource\(fileMetadata\.fileName \?\? sourceFile\?\.name \?\? ""/);
  assert.match(source, /if \(isPdfSource\(fileName, contentType\)\) {\s*return {\s*file: null,/);
  assert.doesNotMatch(source, /pdf-parse/);
  assert.doesNotMatch(source, /PDFParse/);
  assert.doesNotMatch(source, /attachPdfSlicesToChunks/);
  assert.doesNotMatch(pdfSaveFunction, /attachPdfSlicesToChunks/);
  assert.doesNotMatch(pdfSaveFunction, /writeChunks\(/);
  assert.doesNotMatch(pdfSaveFunction, /FieldValue\.vector/);
  assert.match(dbSource, /DATABASE_URL/);
  assert.match(dbSource, /CLOUD_SQL_POSTGRES_URL/);
  assert.match(dbSource, /INSERT INTO pdf_pages/);
  assert.match(dbSource, /full_pdf_bucket/);
  assert.match(dbSource, /page_asset_bucket/);
  assert.match(dbSource, /page_asset_storage_bucket/);
  assert.match(source, /saveCanonicalOriginalPdfAsset/);
  assert.match(source, /getGcsPdfAssetsBucketName/);
  assert.match(source, /saveCanonicalPdfPageAssets/);
  assert.match(source, /canonicalPdfPageAssetPath/);
  assert.match(source, /copyPages\(sourcePdf, \[pageIndex\]\)/);
  assert.match(gcsSource, /@google-cloud\/storage/);
  assert.match(gcsSource, /GCS_PDF_ASSETS_BUCKET/);
  assert.match(gcsSource, /chandra-f6e13-pdf-page-assets/);
  assert.match(gcsSource, /new Storage\(\)/);
  assert.doesNotMatch(gcsSource, /getSignedUrl/);
  assert.match(dbSource, /INSERT INTO pdf_detected_problems/);
  assert.match(dbSource, /embedding/);
  assert.match(dbSource, /::vector/);
  assert.match(ocrSource, /5d3fa32c2ebe2a90/);
  assert.match(ocrSource, /chandra-ocr/);
  assert.match(ocrSource, /defaultDocumentAiInputShardPageCount = 10/);
  assert.match(ocrSource, /buildDocumentAiInputShards/);
  assert.match(ocrSource, /inputShardPageCount/);
  assert.match(ocrSource, /copyPages/);
  assert.match(ocrSource, /:process/);
  assert.match(ocrSource, /rawDocument/);
  assert.match(ocrSource, /shard\.buffer\.toString\("base64"\)/);
  assert.match(ocrSource, /getDocumentAiOnlineConcurrency/);
  assert.doesNotMatch(ocrSource, /:batchProcess/);
  assert.doesNotMatch(ocrSource, /gcsDocuments/);
  assert.match(ocrSource, /parseDocumentAiPages\(document, shard\.pageStart - 1\)/);
  assert.match(source, /ocrInputShardCount: ocr\.inputShardCount/);
  assert.match(source, /ocrInputShardPageCount: ocr\.inputShardPageCount/);
});

test("PDF extract route no longer uses pdf-parse as the uploaded PDF ingestion source", () => {
  const extractRoute = readFileSync(join(repoRoot, "frontend/app/api/materials/extract/route.ts"), "utf8");

  assert.doesNotMatch(extractRoute, /pdf-parse/);
  assert.doesNotMatch(extractRoute, /PDFParse/);
  assert.doesNotMatch(extractRoute, /parser\.getText/);
  assert.match(extractRoute, /extractionMode: "google-document-ai-on-save"/);
});

test("PostgreSQL migration defines page, problem, confidence, source, and search indexes", () => {
  const migration = readFileSync(join(repoRoot, "migrations/001_pdf_ocr_metadata.sql"), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_materials/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_pages/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_detected_problems/);
  assert.match(migration, /storage_bucket TEXT NOT NULL/);
  assert.match(migration, /storage_path TEXT NOT NULL/);
  assert.match(migration, /full_pdf_bucket TEXT/);
  assert.match(migration, /full_pdf_path TEXT/);
  assert.match(migration, /full_pdf_sha256 TEXT/);
  assert.match(migration, /page_asset_bucket TEXT/);
  assert.match(migration, /page_asset_path TEXT/);
  assert.match(migration, /page_asset_sha256 TEXT/);
  assert.match(migration, /page_asset_storage_bucket TEXT/);
  assert.match(migration, /page_asset_storage_path TEXT/);
  assert.match(migration, /page_asset_checksum_sha256 TEXT/);
  assert.match(migration, /page_number INTEGER NOT NULL/);
  assert.match(migration, /problem_number TEXT NOT NULL/);
  assert.match(migration, /ocr_confidence NUMERIC/);
  assert.match(migration, /ocr_provider TEXT NOT NULL/);
  assert.match(migration, /ocr_source TEXT NOT NULL/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(migration, /embedding VECTOR\(768\)/);
  assert.match(migration, /embedding_model TEXT/);
  assert.match(migration, /embedding_provider TEXT/);
  assert.match(migration, /embedding_task_type TEXT/);
  assert.match(migration, /embedding_created_at TIMESTAMPTZ/);
  assert.match(migration, /USING GIN \(text_search\)/);
  assert.match(migration, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(migration, /idx_pdf_pages_material_page/);
  assert.match(migration, /idx_pdf_pages_embedding_hnsw/);
  assert.match(migration, /idx_pdf_detected_problems_material_problem/);
  assert.match(migration, /idx_pdf_detected_problems_embedding_hnsw/);
  assert.match(migration, /idx_pdf_materials_class_professor/);
});

test("PDF page search route uses PostgreSQL OCR metadata and Gemini retrieval query embeddings", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");

  assert.match(route, /searchPdfOcrMetadata/);
  assert.match(route, /searchPdfOcrMetadataVectorOnly/);
  assert.match(route, /createVertexEmbedding/);
  assert.match(route, /taskType: "RETRIEVAL_QUERY"/);
  assert.match(route, /retrievalMode/);
  assert.match(route, /ocrConfidence/);
  assert.match(route, /ocrProvider/);
  assert.match(route, /ocrSource/);
  assert.match(route, /ocrText/);
  assert.match(route, /storageBucket/);
  assert.match(route, /storagePath/);
  assert.match(route, /fullPdfBucket/);
  assert.match(route, /pageAssetBucket/);
  assert.match(route, /pageAssetUri/);
  assert.match(route, /pageAssetStoragePath/);
  assert.doesNotMatch(route, /retrieveCourseContext/);
});

test("PostgreSQL OCR retrieval prioritizes exact lookup before full text and vector search", () => {
  const dbSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ocr-postgres.ts"), "utf8");
  const searchFunction = dbSource.slice(
    dbSource.indexOf("export async function searchPdfOcrMetadata"),
    dbSource.indexOf("export async function replacePdfOcrMetadata")
  );
  const retrievalHelpers = dbSource.slice(
    dbSource.indexOf("async function queryExactProblems"),
    dbSource.indexOf("export async function deletePdfOcrMetadata")
  );
  const retrievalSource = `${searchFunction}\n${retrievalHelpers}`;

  assert.match(searchFunction, /queryExactProblems/);
  assert.match(searchFunction, /queryExactPages/);
  assert.match(searchFunction, /queryTitleMatches/);
  assert.match(searchFunction, /queryFullTextMatches/);
  assert.match(searchFunction, /queryVectorMatches/);
  assert.ok(searchFunction.indexOf("queryExactProblems") < searchFunction.indexOf("queryExactPages"));
  assert.ok(searchFunction.indexOf("queryExactPages") < searchFunction.indexOf("queryTitleMatches"));
  assert.ok(searchFunction.indexOf("queryTitleMatches") < searchFunction.indexOf("queryFullTextMatches"));
  assert.ok(searchFunction.indexOf("queryFullTextMatches") < searchFunction.indexOf("queryVectorMatches"));
  assert.match(retrievalSource, /FROM pdf_pages p/);
  assert.match(retrievalSource, /p\.ocr_text ~\* ANY\(\$3::text\[\]\)/);
  assert.match(retrievalSource, /rankPageSearchRows/);
  assert.doesNotMatch(retrievalSource, /pdf_detected_problems/);
  assert.match(dbSource, /page_number = ANY\(\$3::int\[\]\)/);
  assert.match(dbSource, /text_search @@ plainto_tsquery/);
  assert.match(dbSource, /embedding <=> \$3::vector/);
  assert.match(dbSource, /rankMaterialChunks/);
  assert.doesNotMatch(dbSource, /collectionGroup/);
  assert.doesNotMatch(dbSource, /findNearest/);
});

test("PDF page search route avoids repeating lexical SQL before vector fallback", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");
  const fallbackCall = route.slice(route.indexOf("if (queryEmbedding?.values.length)"));

  assert.match(fallbackCall, /searchPdfOcrMetadataVectorOnly/);
  assert.match(fallbackCall, /query: parsed\.data\.query/);
  assert.doesNotMatch(fallbackCall, /searchPdfOcrMetadata\(/);
});
