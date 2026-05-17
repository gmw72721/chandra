import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  structuredPdfEmbeddingDim,
  structuredPdfEmbeddingSource,
  structuredPdfIngestionVersion
} from "../frontend/lib/pdf-ingestion-config.ts";
import { coercePdfEmbeddingForPostgres } from "../frontend/lib/pdf-ocr-postgres.ts";
import {
  buildStructuredEmbeddingRecords
} from "../frontend/lib/structured-embedding-builder.ts";
import { parseAndValidateStructuredPageJson } from "../frontend/lib/structured-page-validator.ts";

const repoRoot = process.cwd();

test("structured Gemini page JSON validates, normalizes, and builds multi-level embedding text", () => {
  const result = parseAndValidateStructuredPageJson(`
\`\`\`json
{
  "schema_version": "universal_textbook_page_v1",
  "page": {
    "page_number": 4,
    "detected_page_label": "4",
    "document_title": "Systems Worksheet",
    "chapter": null,
    "section": "4.1",
    "section_title": "Substitution",
    "page_type": "exercise",
    "language": "en",
    "overall_confidence": 1.4
  },
  "blocks": [
    {
      "block_id": "block_001",
      "type": "exercise",
      "reading_order": 2,
      "exact_text": "7. Solve x + y = 5.",
      "corrected_text": "7. Solve x + y = 5.",
      "math": { "latex": ["x+y=5"], "normalized_ascii": ["x + y = 5"] },
      "item_metadata": {
        "item_kind": "exercise",
        "item_number": "7",
        "item_label": "7",
        "canonical_item_id": "section_4.1_exercise_7"
      },
      "searchable_keywords": ["substitution", "linear system"],
      "semantic_summary": "Exercise asking students to solve a linear system using substitution.",
      "relationships": [],
      "confidence": 0.94
    },
    {
      "block_id": "block_001",
      "type": "heading",
      "reading_order": 1,
      "exact_text": "Exercises",
      "corrected_text": "Exercises",
      "math": {},
      "item_metadata": {},
      "searchable_keywords": [],
      "semantic_summary": "",
      "relationships": [],
      "confidence": 0.8
    }
  ],
  "page_level_search_text": "Exercises 7. Solve x + y = 5. substitution linear system",
  "page_level_summary": "Exercise page for substitution.",
  "detected_learning_objects": [
    {
      "object_id": "object_001",
      "object_type": "exercise",
      "title": null,
      "label": "Exercise 7",
      "related_block_ids": ["block_001", "missing_block"],
      "searchable_keywords": ["solve system"],
      "semantic_summary": "Single exercise about solving a system.",
      "confidence": 0.91
    }
  ],
  "extraction_warnings": []
}
\`\`\`
`);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.page.page.overall_confidence, 1);
  assert.equal(result.page.blocks[0].type, "heading");
  assert.equal(result.page.blocks[0].block_id, "block_001_02");
  assert.match(result.warnings.join("\n"), /duplicate block_id repaired/);

  const records = buildStructuredEmbeddingRecords({
    documentId: "material-structured",
    page: result.page,
    pageNumber: 4,
    title: "Systems Worksheet"
  });

  assert.equal(records.filter((record) => record.sourceType === "block").length, 0);
  assert.equal(records.filter((record) => record.sourceType === "learning_object").length, 1);
  assert.equal(records.filter((record) => record.sourceType === "page").length, 1);
  assert.equal(records[0].embeddingDim, 1536);
  assert.equal(records[0].embeddingSource, structuredPdfEmbeddingSource);
  assert.equal(records[0].ingestionVersion, structuredPdfIngestionVersion);
  assert.match(records.find((record) => record.sourceType === "learning_object")?.embeddingText ?? "", /Single exercise/);
  assert.match(records.find((record) => record.sourceType === "page")?.embeddingText ?? "", /page for substitution/);
});

test("structured PDF embedding vectors must be 1536 dimensions", () => {
  const validEmbedding = coercePdfEmbeddingForPostgres({
    createdAt: "2026-05-11T00:00:00.000Z",
    dimensions: 1536,
    model: "gemini-embedding-2",
    provider: "vertex-ai",
    taskType: "RETRIEVAL_DOCUMENT",
    values: Array.from({ length: 1536 }, (_, index) => index / 1536)
  });

  assert.equal(validEmbedding.dimensions, 1536);
  assert.match(validEmbedding.vector ?? "", /^\[/);

  const mismatchedEmbedding = coercePdfEmbeddingForPostgres({
    createdAt: "2026-05-11T00:00:00.000Z",
    dimensions: 1535,
    model: "gemini-embedding-2",
    provider: "vertex-ai",
    taskType: "RETRIEVAL_DOCUMENT",
    values: Array.from({ length: 1535 }, (_, index) => index / 1535)
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

test("structured PDF embedding dimension ignores unrelated global embedding config", () => {
  const previousVertexDimensions = process.env.VERTEX_EMBEDDING_DIMENSIONS;
  const previousPdfIngestionDimensions = process.env.PDF_INGESTION_EMBEDDING_DIM;

  try {
    process.env.VERTEX_EMBEDDING_DIMENSIONS = "1024";
    delete process.env.PDF_INGESTION_EMBEDDING_DIM;

    assert.equal(structuredPdfEmbeddingDim(), 1536);

    process.env.PDF_INGESTION_EMBEDDING_DIM = "1024";
    assert.throws(
      () => structuredPdfEmbeddingDim(),
      /Structured PDF embeddings must be 1536-dimensional/
    );
  } finally {
    restoreEnv("VERTEX_EMBEDDING_DIMENSIONS", previousVertexDimensions);
    restoreEnv("PDF_INGESTION_EMBEDDING_DIM", previousPdfIngestionDimensions);
  }
});

test("PDF ingestion uses Gemini structured pages and PostgreSQL instead of raw page-text chunk embeddings", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const dbSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ocr-postgres.ts"), "utf8");
  const gcsSource = readFileSync(join(repoRoot, "frontend/lib/gcs-pdf-page-assets.ts"), "utf8");
  const configSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ingestion-config.ts"), "utf8");
  const extractorSource = readFileSync(join(repoRoot, "frontend/lib/gemini-page-extractor.ts"), "utf8");
  const vertexSource = readFileSync(join(repoRoot, "frontend/lib/vertex-embeddings.ts"), "utf8");
  const pdfSaveFunction = source.slice(
    source.indexOf("async function savePdfTutorKnowledgeOcrMetadata"),
    source.indexOf("export async function deleteTutorKnowledge")
  );

  assert.match(source, /extractStructuredPageWithGemini/);
  assert.match(source, /extractStructuredPagesWithGeminiBatch/);
  assert.match(source, /getCachedStructuredPdfPageExtractions/);
  assert.match(source, /pdfPageAssetSaveConcurrency/);
  assert.match(source, /structuredPageExtractionConcurrency/);
  assert.match(source, /structuredPageDirectExtractionConcurrency/);
  assert.match(source, /structuredPageBatchMinPages/);
  assert.match(source, /const pageExtractionConcurrency = attemptedBatchExtraction && !hasPendingDirectExtractions/);
  assert.match(source, /mapWithConcurrency\(\s*pageAssets,\s*pageExtractionConcurrency/);
  assert.match(source, /parseAndValidateStructuredPageJson/);
  assert.match(source, /buildStructuredEmbeddingRecords/);
  assert.match(source, /replacePdfOcrMetadata/);
  assert.match(source, /attachStructuredPdfEmbeddings/);
  assert.match(source, /createVertexEmbeddings/);
  assert.match(source, /dimensions: structuredPdfEmbeddingDim\(\)/);
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
  assert.match(dbSource, /SELECT DISTINCT ON \(page_asset_checksum_sha256\)/);
  assert.match(dbSource, /INSERT INTO pdf_page_blocks/);
  assert.match(dbSource, /INSERT INTO content_embeddings/);
  assert.match(dbSource, /structured_page_json/);
  assert.match(dbSource, /page_level_search_text/);
  assert.match(dbSource, /full_pdf_bucket/);
  assert.match(dbSource, /page_asset_bucket/);
  assert.match(dbSource, /page_asset_storage_bucket/);
  assert.match(source, /saveCanonicalOriginalPdfAsset/);
  assert.match(source, /getGcsPdfAssetsBucketName/);
  assert.match(source, /saveCanonicalPdfPageAssets/);
  assert.match(source, /preloadPageExtractions/);
  assert.match(source, /preloadedExtraction/);
  assert.match(source, /createAsyncLimiter/);
  assert.match(source, /persistedPageCount/);
  assert.match(source, /canonicalPdfPageAssetPath/);
  assert.match(source, /copyPages\(sourcePdf, \[pageIndex\]\)/);
  assert.match(gcsSource, /@google-cloud\/storage/);
  assert.match(gcsSource, /GCS_PDF_ASSETS_BUCKET/);
  assert.match(gcsSource, /chandra-f6e13-pdf-page-assets/);
  assert.match(gcsSource, /new Storage\(\)/);
  assert.doesNotMatch(gcsSource, /getSignedUrl/);
  assert.match(dbSource, /embedding/);
  assert.match(dbSource, /::vector/);
  assert.match(configSource, /gemini-3-flash-preview/);
  assert.match(configSource, /defaultStructuredPageDirectExtractionConcurrency = 32/);
  assert.match(configSource, /defaultStructuredPageBatchMinPages = 200/);
  assert.match(configSource, /defaultPdfPageAssetSaveConcurrency = 10/);
  assert.match(extractorSource, /You are a textbook page extraction engine/);
  assert.match(extractorSource, /Return only valid JSON matching this schema/);
  assert.match(extractorSource, /batchPredictionJobs/);
  assert.match(extractorSource, /instancesFormat: "jsonl"/);
  assert.match(extractorSource, /fileData/);
  assert.match(extractorSource, /pageAssetUri/);
  assert.match(extractorSource, /cachedGoogleAccessToken/);
  assert.match(extractorSource, /GEMINI_PAGE_BATCH_TIMEOUT_MS/);
  assert.match(extractorSource, /24 \* 60 \* 60 \* 1000/);
  assert.match(extractorSource, /completionStats/);
  assert.match(extractorSource, /collectVertexBatchPredictionOutputs/);
  assert.match(extractorSource, /thinkingLevel: "MINIMAL"/);
  assert.match(extractorSource, /thinkingBudget: 0/);
  assert.match(extractorSource, /aiplatform\.googleapis\.com/);
  assert.match(extractorSource, /aiplatform\.us\.rep\.googleapis\.com/);
  assert.match(dbSource, /upsertStructuredPdfPageMetadata/);
  assert.match(dbSource, /ON CONFLICT \(material_id, page_number\) DO UPDATE SET/);
  assert.match(source, /persistStructuredPageResult/);
  assert.match(source, /onPartialPageIndexed/);
  assert.match(source, /partialIndexReady/);
  assert.match(source, /await deletePdfOcrMetadata\(materialId\)/);
  assert.match(source, /records\.persistedPageCount < records\.pages\.length/);
  assert.match(source, /pdfProcessingMode/);
  assert.match(source, /useBatchExtraction && uncachedPageAssets\.length >= batchMinPages/);
  assert.match(source, /can move to embeddings/);
  assert.match(vertexSource, /GEMINI_EMBEDDING_BATCH_CONCURRENCY/);
  assert.match(vertexSource, /VERTEX_EMBEDDING_CONCURRENCY/);
  assert.match(vertexSource, /provider === "developer"/);
  assert.match(vertexSource, /provider === "vertex"/);
  assert.match(vertexSource, /aiplatform\.us\.rep\.googleapis\.com/);
  assert.match(vertexSource, /mapWithConcurrency\(batches, batchConcurrency/);
  assert.doesNotMatch(pdfSaveFunction, /rawText: pageSearchText/);
});

test("PDF extract route no longer uses pdf-parse as the uploaded PDF ingestion source", () => {
  const extractRoute = readFileSync(join(repoRoot, "frontend/app/api/materials/extract/route.ts"), "utf8");

  assert.doesNotMatch(extractRoute, /pdf-parse/);
  assert.doesNotMatch(extractRoute, /PDFParse/);
  assert.doesNotMatch(extractRoute, /parser\.getText/);
  assert.match(extractRoute, /extractionMode: "gemini-structured-page-on-save"/);
});

test("PostgreSQL migration defines structured page, block, embedding, and search indexes", () => {
  const migration = readFileSync(join(repoRoot, "migrations/001_pdf_ocr_metadata.sql"), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_materials/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_pages/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_page_blocks/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS content_embeddings/);
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
  assert.match(migration, /block_id TEXT NOT NULL/);
  assert.match(migration, /item_number TEXT/);
  assert.match(migration, /canonical_item_id TEXT/);
  assert.match(migration, /structured_page_json JSONB/);
  assert.match(migration, /page_level_search_text TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /text_search TSVECTOR GENERATED ALWAYS AS \(to_tsvector\('english', coalesce\(page_level_search_text, ''\)\)\) STORED/);
  assert.match(migration, /embedding_source TEXT/);
  assert.match(migration, /ingestion_version TEXT/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(migration, /embedding VECTOR\(1536\)/);
  assert.match(migration, /embedding_dim INTEGER NOT NULL DEFAULT 1536/);
  assert.match(migration, /embedding_model TEXT/);
  assert.match(migration, /embedding_provider TEXT/);
  assert.match(migration, /embedding_task_type TEXT/);
  assert.match(migration, /embedding_created_at TIMESTAMPTZ/);
  assert.match(migration, /USING GIN \(text_search\)/);
  assert.match(migration, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(migration, /idx_pdf_pages_material_page/);
  assert.match(migration, /idx_pdf_pages_structured_checksum_cache/);
  assert.match(migration, /idx_content_embeddings_hnsw/);
  assert.match(migration, /idx_pdf_page_blocks_item/);
  assert.match(migration, /idx_pdf_materials_class_professor/);
  assert.doesNotMatch(migration, new RegExp(`embedding VECTOR\\(${structuredPdfEmbeddingDim() / 2}\\)`));
});

test("PDF page search route uses structured PostgreSQL metadata and Gemini retrieval query embeddings", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");

  assert.match(route, /searchStructuredPdfMetadata/);
  assert.doesNotMatch(route, /searchPdfOcrMetadata\(/);
  assert.doesNotMatch(route, /searchPdfOcrMetadataVectorOnly/);
  assert.doesNotMatch(route, /searchStructuredPdfMetadataVectorOnly/);
  assert.match(route, /createVertexEmbeddings/);
  assert.match(route, /dimensions: defaultStructuredPdfEmbeddingDim/);
  assert.match(route, /taskType: "RETRIEVAL_QUERY"/);
  assert.match(route, /retrievalMode/);
  assert.match(route, /chunk_text: page\.chunkText/);
  assert.match(route, /pageLevelSearchText/);
  assert.match(route, /storageBucket/);
  assert.match(route, /storagePath/);
  assert.match(route, /fullPdfBucket/);
  assert.match(route, /pageAssetBucket/);
  assert.match(route, /pageAssetUri/);
  assert.match(route, /pageAssetStoragePath/);
  assert.match(route, /sourceType/);
  assert.match(route, /embeddingLevel/);
  assert.match(route, /ingestionVersion/);
  assert.match(route, /embeddingDim/);
  assert.doesNotMatch(route, /retrieveCourseContext/);
});

test("PostgreSQL structured PDF retrieval merges exact, full-text, and vector candidates", () => {
  const dbSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ocr-postgres.ts"), "utf8");
  const structuredSearchFunction = dbSource.slice(
    dbSource.indexOf("export async function searchStructuredPdfMetadata"),
    dbSource.indexOf("export async function searchStructuredPdfMetadataVectorOnly")
  );
  const retrievalHelpers = dbSource.slice(
    dbSource.indexOf("async function queryStructuredExactProblems"),
    dbSource.indexOf("function rowToRankableCandidate")
  );

  assert.match(structuredSearchFunction, /queryStructuredExactProblems/);
  assert.match(structuredSearchFunction, /queryStructuredExactPages/);
  assert.match(structuredSearchFunction, /queryStructuredMetadataMatches/);
  assert.match(structuredSearchFunction, /queryStructuredFullTextMatches/);
  assert.match(structuredSearchFunction, /queryStructuredVectorMatches/);
  assert.match(structuredSearchFunction, /candidates\.push\(\.\.\.exactProblems\)/);
  assert.match(structuredSearchFunction, /candidates\.push\(\.\.\.metadataMatches\)/);
  assert.match(structuredSearchFunction, /candidates\.push\(\.\.\.fullTextMatches\)/);
  assert.match(structuredSearchFunction, /candidates\.push\(\.\.\.vectorMatches\)/);
  assert.match(structuredSearchFunction, /collapseStructuredSearchResults/);
  assert.match(retrievalHelpers, /FROM pdf_pages p/);
  assert.match(retrievalHelpers, /FROM content_embeddings ce/);
  assert.match(retrievalHelpers, /rankPageSearchRows/);
  assert.match(dbSource, /page_number = ANY\(\$4::int\[\]\)/);
  assert.match(dbSource, /to_tsvector\('english', coalesce\(ce\.embedding_text, ''\)\)/);
  assert.match(dbSource, /ce\.embedding <=> \$6::vector/);
  assert.match(dbSource, /rankMaterialChunks/);
  assert.doesNotMatch(dbSource, /collectionGroup/);
  assert.doesNotMatch(dbSource, /findNearest/);
});

test("PDF page search route passes one structured vector into hybrid search instead of running vector fallback", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");
  const routeSearchBlock = route.slice(route.indexOf("const queryEmbedding"), route.indexOf("const responsePayload"));

  assert.match(routeSearchBlock, /createPdfSearchQueryEmbedding/);
  assert.match(routeSearchBlock, /searchStructuredPdfMetadata/);
  assert.match(routeSearchBlock, /queryVector: queryEmbedding\?\.values/);
  assert.match(routeSearchBlock, /shouldUseStructuredVectorSearch/);
  assert.doesNotMatch(routeSearchBlock, /searchStructuredPdfMetadataVectorOnly/);
  assert.doesNotMatch(routeSearchBlock, /searchPdfOcrMetadata\(/);
});

test("structured PDF search uses structured content embeddings and strict 1536-dimensional filters", () => {
  const dbSource = readFileSync(join(repoRoot, "frontend/lib/pdf-ocr-postgres.ts"), "utf8");
  const structuredSearchSource = dbSource.slice(
    dbSource.indexOf("async function queryStructuredExactProblems"),
    dbSource.indexOf("function rowToRankableCandidate")
  );
  const hybridEntrySource = dbSource.slice(
    dbSource.indexOf("export async function searchStructuredPdfMetadata"),
    dbSource.indexOf("export async function searchStructuredPdfMetadataVectorOnly")
  );

  assert.match(structuredSearchSource, /FROM content_embeddings ce/);
  assert.match(structuredSearchSource, /JOIN pdf_pages p/);
  assert.match(structuredSearchSource, /ce\.ingestion_version = \$3/);
  assert.match(structuredSearchSource, /ce\.embedding_source = \$4/);
  assert.match(structuredSearchSource, /ce\.embedding_dim = \$5/);
  assert.match(structuredSearchSource, /defaultStructuredPdfEmbeddingDim/);
  assert.match(structuredSearchSource, /structuredPdfEmbeddingSource/);
  assert.match(structuredSearchSource, /structuredPdfIngestionVersion/);
  assert.match(structuredSearchSource, /item_number = ANY/);
  assert.match(structuredSearchSource, /canonical_item_id = ANY/);
  assert.match(structuredSearchSource, /to_tsvector\('english', coalesce\(ce\.embedding_text, ''\)\)/);
  assert.match(structuredSearchSource, /ce\.embedding <=> \$6::vector/);
  assert.match(structuredSearchSource, /query embedding has \$\{values\.length\} dimensions/);
  assert.match(hybridEntrySource, /candidates\.push\(\.\.\.metadataMatches\)/);
  assert.match(hybridEntrySource, /candidates\.push\(\.\.\.fullTextMatches\)/);
  assert.match(hybridEntrySource, /candidates\.push\(\.\.\.vectorMatches\)/);
  assert.doesNotMatch(structuredSearchSource, /p\.embedding <=>/);
});

test("route does not use legacy PDF vector fallback", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");

  assert.doesNotMatch(route, /searchPdfOcrMetadataVectorOnly/);
  assert.doesNotMatch(route, /searchPdfOcrMetadata\(\{/);
  assert.match(route, /searchStructuredPdfMetadata\(\{/);
});

test("teacher retrieval-test route can surface structured PDF search results for a requested material", () => {
  const route = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/materials/retrieval-test/route.ts"), "utf8");

  assert.match(route, /searchStructuredPdfForRetrievalTest/);
  assert.match(route, /searchStructuredPdfMetadata/);
  assert.doesNotMatch(route, /searchStructuredPdfMetadataVectorOnly/);
  assert.match(route, /materialId/);
  assert.match(route, /defaultStructuredPdfEmbeddingDim/);
  assert.match(route, /createVertexEmbeddings/);
  assert.match(route, /queryVector: queryEmbedding\?\.values/);
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
