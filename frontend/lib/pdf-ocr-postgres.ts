import pg, { type PoolClient, type QueryResultRow } from "pg";
import {
  defaultStructuredPdfEmbeddingDim,
  structuredPdfEmbeddingSource,
  structuredPdfIngestionVersion
} from "./pdf-ingestion-config.ts";
import type { StructuredPageJson } from "./structured-page-validator.ts";
import { problemNumbersFromText, rankMaterialChunks, type RankableChunk } from "./retrieval-ranking.ts";
import type {
  PdfContentEmbeddingMetadata,
  PdfMaterialMetadata,
  PdfPageMetadata,
  PdfPageBlockMetadata
} from "./types.ts";

const { Pool } = pg;
const defaultPoolMax = 5;
const defaultPdfVectorDimensions = 1536;
let pool: pg.Pool | null = null;

export class PdfOcrMetadataDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfOcrMetadataDatabaseError";
  }
}

export type PdfOcrRetrievalMode = "exact_problem" | "exact_page" | "exact_title" | "full_text" | "vector";

export type PdfOcrSearchResult = {
  chunkText: string;
  classId: string;
  docId: string;
  materialId: string;
  materialType: string;
  pageLevelSearchText: string;
  pageEnd: number;
  pageStart: number;
  printedPageEnd: number | null;
  printedPageStart: number | null;
  professorId: string;
  problemNumbers: string[];
  retrievalMode: PdfOcrRetrievalMode;
  score: number;
  sourcePdfPath: string;
  fullPdfBucket: string;
  fullPdfPath: string;
  fullPdfUri: string;
  fullPdfMimeType: string;
  fullPdfSize: number | null;
  fullPdfSha256: string;
  pageAssetBucket: string;
  pageAssetPath: string;
  pageAssetUri: string;
  pageAssetSize: number | null;
  pageAssetSha256: string;
  pageAssetStorageBucket: string;
  pageAssetStoragePath: string;
  pageAssetMimeType: string;
  pageAssetSizeBytes: number | null;
  pageAssetChecksumSha256: string;
  storageBucket: string;
  storagePath: string;
  title: string;
  sourceType?: string;
  sourceId?: string;
  embeddingLevel?: string;
  blockId?: string;
  objectId?: string;
  blockType?: string;
  objectType?: string;
  itemKind?: string;
  itemNumber?: string;
  itemLabel?: string;
  canonicalItemId?: string;
  embeddingSource?: string;
  ingestionVersion?: string;
  embeddingDim?: number | null;
};

export type CachedStructuredPdfPageExtraction = {
  extractionModel: string | null;
  pageAssetChecksumSha256: string;
  structuredPageJson: StructuredPageJson;
};

export function getPdfOcrDatabaseUrl() {
  return (
    process.env.DATABASE_URL?.trim()
    || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
    || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
    || ""
  );
}

export function isPdfOcrPostgresConfigured() {
  return Boolean(getPdfOcrDatabaseUrl());
}

export function assertPdfOcrPostgresConfigured() {
  if (!isPdfOcrPostgresConfigured()) {
    throw new PdfOcrMetadataDatabaseError(
      "Structured PDF metadata requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
    );
  }
}

export function getPdfOcrPool() {
  if (pool) {
    return pool;
  }

  const connectionString = getPdfOcrDatabaseUrl();

  if (!connectionString) {
    throw new PdfOcrMetadataDatabaseError(
      "Structured PDF metadata requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
    );
  }

  pool = new Pool({
    connectionString,
    max: readPositiveInteger(process.env.CLOUD_SQL_POSTGRES_POOL_MAX) ?? defaultPoolMax,
    ssl: readPostgresSslConfig(connectionString)
  });

  return pool;
}

export async function searchPdfOcrMetadata({
  classId,
  limit,
  materialId,
  professorId,
  query
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
  queryVector?: number[];
}) {
  return searchStructuredPdfMetadata({ classId, limit, materialId, professorId, query });
}

export async function searchPdfOcrMetadataVectorOnly({
  classId,
  limit,
  materialId,
  professorId,
  query,
  queryVector
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
  queryVector: number[];
}) {
  return searchStructuredPdfMetadataVectorOnly({ classId, limit, materialId, professorId, query, queryVector });
}

export async function searchStructuredPdfMetadata({
  classId,
  limit,
  materialId,
  professorId,
  query,
  queryVector
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
  queryVector?: number[];
}) {
  const client = await getPdfOcrPool().connect();

  try {
    const normalizedLimit = Math.max(1, Math.min(limit, 20));
    const candidateLimit = Math.max(normalizedLimit * 3, 10);
    const problemNumbers = problemNumbersFromText(query);
    const pageNumbers = pageNumbersFromText(query);
    const candidates: PdfOcrSearchResult[] = [];

    if (problemNumbers.length) {
      const exactProblems = await runStructuredSearchStep(
        "exact problem",
        () =>
          queryStructuredExactProblems({
            classId,
            client,
            limit: candidateLimit,
            materialId,
            problemNumbers,
            professorId
          })
      );
      candidates.push(...exactProblems);
    }

    if (pageNumbers.length) {
      const exactPages = await runStructuredSearchStep(
        "exact page",
        () =>
          queryStructuredExactPages({
            classId,
            client,
            limit: candidateLimit,
            materialId,
            pageNumbers,
            professorId
          })
      );
      candidates.push(...exactPages);
    }

    const metadataMatches = await runStructuredSearchStep(
      "metadata",
      () =>
        queryStructuredMetadataMatches({
          classId,
          client,
          limit: candidateLimit,
          materialId,
          professorId,
          query
        })
    );
    candidates.push(...metadataMatches);

    const fullTextMatches = await runStructuredSearchStep(
      "full text",
      () =>
        queryStructuredFullTextMatches({
          classId,
          client,
          limit: candidateLimit,
          materialId,
          professorId,
          query
        })
    );
    candidates.push(...fullTextMatches);

    if (queryVector?.length) {
      const vectorMatches = await queryStructuredVectorMatches({
        classId,
        client,
        limit: candidateLimit,
        materialId,
        professorId,
        query,
        queryVector
      });
      candidates.push(...vectorMatches);
    }

    const structuredResults = collapseStructuredSearchResults(candidates, normalizedLimit, {
      exactItemMatch: problemNumbers.length > 0
    });

    return structuredResults;
  } catch (caughtError) {
    throw new PdfOcrMetadataDatabaseError("Structured PDF metadata search failed.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

export async function searchStructuredPdfMetadataVectorOnly({
  classId,
  limit,
  materialId,
  professorId,
  query,
  queryVector
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
  queryVector: number[];
}) {
  if (!queryVector.length) {
    return [];
  }

  if (queryVector.length !== defaultStructuredPdfEmbeddingDim) {
    console.warn(
      `Structured PDF vector search skipped: query embedding has ${queryVector.length} dimensions, expected ${defaultStructuredPdfEmbeddingDim}.`
    );
    return [];
  }

  const client = await getPdfOcrPool().connect();

  try {
    const normalizedLimit = Math.max(1, Math.min(limit, 20));

    return await queryStructuredVectorMatches({
      classId,
      client,
      limit: normalizedLimit,
      materialId,
      professorId,
      query,
      queryVector
    });
  } catch (caughtError) {
    if (isMissingStructuredPdfStorageError(caughtError)) {
      console.warn("Structured PDF vector search skipped because structured PDF storage is unavailable.", caughtError);
      return [];
    }

    throw new PdfOcrMetadataDatabaseError("Structured PDF metadata vector search failed.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

export async function replacePdfOcrMetadata({
  blocks = [],
  embeddings = [],
  material,
  pages
}: {
  blocks?: PdfPageBlockMetadata[];
  embeddings?: PdfContentEmbeddingMetadata[];
  material: PdfMaterialMetadata;
  pages: PdfPageMetadata[];
}) {
  const client = await getPdfOcrPool().connect();

  try {
    await client.query("BEGIN");
    await upsertPdfMaterial(client, material);
    await client.query("DELETE FROM pdf_pages WHERE material_id = $1", [material.materialId]);
    const pageIds = new Map<number, number>();

    for (const page of pages) {
      const result = await client.query<{ id: number }>(
        `INSERT INTO pdf_pages (
          material_id, class_id, course_id, professor_id, teacher_id, title, material_type,
          page_number, page_start, page_end, detected_page_label, document_title, chapter, section, section_title,
          page_type, language, structured_page_json, page_level_search_text, page_level_summary,
          extraction_confidence, extraction_warnings, extraction_model, extraction_timestamp,
          ingestion_version, embedding_source, embedding_dim, storage_bucket, storage_path,
          full_pdf_bucket, full_pdf_path, full_pdf_uri, full_pdf_mime_type,
          full_pdf_size, full_pdf_sha256, page_asset_bucket, page_asset_path,
          page_asset_uri, page_asset_size, page_asset_sha256,
          page_asset_storage_bucket, page_asset_storage_path, page_asset_mime_type,
          page_asset_size_bytes, page_asset_checksum_sha256
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18::jsonb, $19, $20,
          $21, $22::text[], $23, $24,
          $25, $26, $27, $28, $29,
          $30, $31, $32, $33,
          $34, $35, $36, $37,
          $38, $39, $40,
          $41, $42, $43, $44, $45
        )
        RETURNING id`,
        [
          page.materialId,
          page.classId,
          page.courseId,
          page.professorId,
          page.teacherId,
          page.title,
          page.materialType,
          page.pageNumber,
          page.pageStart,
          page.pageEnd,
          page.detectedPageLabel ?? null,
          page.documentTitle ?? null,
          page.chapter ?? null,
          page.section ?? null,
          page.sectionTitle ?? null,
          page.pageType ?? null,
          page.language ?? null,
          page.structuredPageJson ? JSON.stringify(page.structuredPageJson) : null,
          page.pageLevelSearchText ?? "",
          page.pageLevelSummary ?? "",
          page.extractionConfidence ?? null,
          page.extractionWarnings ?? [],
          page.extractionModel ?? null,
          page.extractionTimestamp ?? null,
          page.ingestionVersion ?? null,
          page.embeddingSource ?? null,
          page.embeddingDim ?? null,
          page.storageBucket,
          page.storagePath,
          page.fullPdfBucket ?? page.storageBucket,
          page.fullPdfPath ?? page.storagePath,
          page.fullPdfUri ?? `gs://${page.storageBucket}/${page.storagePath}`,
          page.fullPdfMimeType ?? "application/pdf",
          page.fullPdfSize ?? null,
          page.fullPdfSha256 ?? null,
          page.pageAssetBucket ?? page.pageAssetStorageBucket ?? null,
          page.pageAssetPath ?? page.pageAssetStoragePath ?? null,
          page.pageAssetUri ?? (
            (page.pageAssetBucket ?? page.pageAssetStorageBucket) && (page.pageAssetPath ?? page.pageAssetStoragePath)
              ? `gs://${page.pageAssetBucket ?? page.pageAssetStorageBucket}/${page.pageAssetPath ?? page.pageAssetStoragePath}`
              : null
          ),
          page.pageAssetSize ?? page.pageAssetSizeBytes ?? null,
          page.pageAssetSha256 ?? page.pageAssetChecksumSha256 ?? null,
          page.pageAssetStorageBucket ?? page.pageAssetBucket ?? null,
          page.pageAssetStoragePath ?? page.pageAssetPath ?? null,
          page.pageAssetMimeType ?? null,
          page.pageAssetSizeBytes ?? page.pageAssetSize ?? null,
          page.pageAssetChecksumSha256 ?? page.pageAssetSha256 ?? null
        ]
      );

      const insertedPageId = result.rows[0]?.id;

      if (insertedPageId) {
        pageIds.set(page.pageNumber, insertedPageId);
      }
    }

    for (const block of blocks) {
      const pageId = pageIds.get(block.pageNumber);

      if (!pageId) {
        continue;
      }

      await client.query(
        `INSERT INTO pdf_page_blocks (
          material_id, page_id, class_id, course_id, professor_id, teacher_id, page_number,
          block_id, reading_order, block_type, exact_text, corrected_text, math_latex,
          math_ascii, item_kind, item_number, item_label, canonical_item_id,
          searchable_keywords, semantic_summary, relationships, confidence, ingestion_version
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13::text[],
          $14::text[], $15, $16, $17, $18,
          $19::text[], $20, $21::jsonb, $22, $23
        )`,
        [
          block.materialId,
          pageId,
          block.classId,
          block.courseId,
          block.professorId,
          block.teacherId,
          block.pageNumber,
          block.blockId,
          block.readingOrder,
          block.blockType,
          block.exactText,
          block.correctedText,
          block.mathLatex,
          block.mathAscii,
          block.itemKind ?? null,
          block.itemNumber ?? null,
          block.itemLabel ?? null,
          block.canonicalItemId ?? null,
          block.searchableKeywords,
          block.semanticSummary,
          JSON.stringify(block.relationships),
          block.confidence,
          block.ingestionVersion
        ]
      );
    }

    for (const contentEmbedding of embeddings) {
      const pageId = contentEmbedding.pageNumber ? pageIds.get(contentEmbedding.pageNumber) ?? null : null;
      const embedding = coercePdfEmbeddingForPostgres({
        createdAt: contentEmbedding.embeddingCreatedAt,
        dimensions: contentEmbedding.embeddingDim,
        model: contentEmbedding.embeddingModel,
        provider: contentEmbedding.embeddingProvider,
        taskType: contentEmbedding.embeddingTaskType,
        values: contentEmbedding.embedding
      });

      if (!embedding.vector) {
        throw new PdfOcrMetadataDatabaseError(
          `Structured PDF embedding for ${contentEmbedding.sourceType}:${contentEmbedding.sourceId} did not have ${defaultPdfVectorDimensions} dimensions.`
        );
      }

      await client.query(
        `INSERT INTO content_embeddings (
          material_id, page_id, class_id, course_id, professor_id, teacher_id, page_number,
          source_type, source_id, embedding_level, embedding_text, embedding, embedding_dim,
          embedding_model, embedding_provider, embedding_source, embedding_task_type,
          embedding_created_at, ingestion_version, block_id, block_type, reading_order,
          object_id, object_type, title, label, related_block_ids, item_kind, item_number,
          item_label, canonical_item_id, section
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12::vector, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22,
          $23, $24, $25, $26, $27::text[], $28, $29,
          $30, $31, $32
        )`,
        [
          contentEmbedding.materialId,
          pageId,
          contentEmbedding.classId,
          contentEmbedding.courseId,
          contentEmbedding.professorId,
          contentEmbedding.teacherId,
          contentEmbedding.pageNumber,
          contentEmbedding.sourceType,
          contentEmbedding.sourceId,
          contentEmbedding.embeddingLevel,
          contentEmbedding.embeddingText,
          embedding.vector,
          embedding.dimensions,
          embedding.model,
          embedding.provider,
          contentEmbedding.embeddingSource,
          embedding.taskType,
          embedding.createdAt,
          contentEmbedding.ingestionVersion,
          contentEmbedding.blockId ?? null,
          contentEmbedding.blockType ?? null,
          contentEmbedding.readingOrder ?? null,
          contentEmbedding.objectId ?? null,
          contentEmbedding.objectType ?? null,
          contentEmbedding.title ?? null,
          contentEmbedding.label ?? null,
          contentEmbedding.relatedBlockIds ?? [],
          contentEmbedding.itemKind ?? null,
          contentEmbedding.itemNumber ?? null,
          contentEmbedding.itemLabel ?? null,
          contentEmbedding.canonicalItemId ?? null,
          contentEmbedding.section ?? null
        ]
      );
    }

    await client.query("COMMIT");
  } catch (caughtError) {
    await client.query("ROLLBACK").catch(() => {});
    throw new PdfOcrMetadataDatabaseError("Structured PDF metadata could not be written to PostgreSQL.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

export async function upsertStructuredPdfPageMetadata({
  blocks = [],
  embeddings = [],
  material,
  page
}: {
  blocks?: PdfPageBlockMetadata[];
  embeddings?: PdfContentEmbeddingMetadata[];
  material: PdfMaterialMetadata;
  page: PdfPageMetadata;
}) {
  const client = await getPdfOcrPool().connect();

  try {
    await client.query("BEGIN");
    await upsertPdfMaterial(client, material);
    await writeStructuredPdfPageRows(client, {
      blocks,
      embeddings,
      page,
      replaceExistingPageData: true
    });
    await client.query("COMMIT");
  } catch (caughtError) {
    await client.query("ROLLBACK").catch(() => {});
    throw new PdfOcrMetadataDatabaseError("Structured PDF page metadata could not be written to PostgreSQL.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

async function writeStructuredPdfPageRows(
  client: PoolClient,
  {
    blocks,
    embeddings,
    page,
    replaceExistingPageData
  }: {
    blocks: PdfPageBlockMetadata[];
    embeddings: PdfContentEmbeddingMetadata[];
    page: PdfPageMetadata;
    replaceExistingPageData: boolean;
  }
) {
  if (replaceExistingPageData) {
    await client.query("DELETE FROM content_embeddings WHERE material_id = $1 AND page_number = $2", [
      page.materialId,
      page.pageNumber
    ]);
    await client.query("DELETE FROM pdf_page_blocks WHERE material_id = $1 AND page_number = $2", [
      page.materialId,
      page.pageNumber
    ]);
  }

  const result = await client.query<{ id: number }>(
    `INSERT INTO pdf_pages (
      material_id, class_id, course_id, professor_id, teacher_id, title, material_type,
      page_number, page_start, page_end, detected_page_label, document_title, chapter, section, section_title,
      page_type, language, structured_page_json, page_level_search_text, page_level_summary,
      extraction_confidence, extraction_warnings, extraction_model, extraction_timestamp,
      ingestion_version, embedding_source, embedding_dim, storage_bucket, storage_path,
      full_pdf_bucket, full_pdf_path, full_pdf_uri, full_pdf_mime_type,
      full_pdf_size, full_pdf_sha256, page_asset_bucket, page_asset_path,
      page_asset_uri, page_asset_size, page_asset_sha256,
      page_asset_storage_bucket, page_asset_storage_path, page_asset_mime_type,
      page_asset_size_bytes, page_asset_checksum_sha256
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18::jsonb, $19, $20,
      $21, $22::text[], $23, $24,
      $25, $26, $27, $28, $29,
      $30, $31, $32, $33,
      $34, $35, $36, $37,
      $38, $39, $40,
      $41, $42, $43, $44, $45
    )
    ON CONFLICT (material_id, page_number) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      course_id = EXCLUDED.course_id,
      professor_id = EXCLUDED.professor_id,
      teacher_id = EXCLUDED.teacher_id,
      title = EXCLUDED.title,
      material_type = EXCLUDED.material_type,
      page_start = EXCLUDED.page_start,
      page_end = EXCLUDED.page_end,
      detected_page_label = EXCLUDED.detected_page_label,
      document_title = EXCLUDED.document_title,
      chapter = EXCLUDED.chapter,
      section = EXCLUDED.section,
      section_title = EXCLUDED.section_title,
      page_type = EXCLUDED.page_type,
      language = EXCLUDED.language,
      structured_page_json = EXCLUDED.structured_page_json,
      page_level_search_text = EXCLUDED.page_level_search_text,
      page_level_summary = EXCLUDED.page_level_summary,
      extraction_confidence = EXCLUDED.extraction_confidence,
      extraction_warnings = EXCLUDED.extraction_warnings,
      extraction_model = EXCLUDED.extraction_model,
      extraction_timestamp = EXCLUDED.extraction_timestamp,
      ingestion_version = EXCLUDED.ingestion_version,
      embedding_source = EXCLUDED.embedding_source,
      embedding_dim = EXCLUDED.embedding_dim,
      storage_bucket = EXCLUDED.storage_bucket,
      storage_path = EXCLUDED.storage_path,
      full_pdf_bucket = EXCLUDED.full_pdf_bucket,
      full_pdf_path = EXCLUDED.full_pdf_path,
      full_pdf_uri = EXCLUDED.full_pdf_uri,
      full_pdf_mime_type = EXCLUDED.full_pdf_mime_type,
      full_pdf_size = EXCLUDED.full_pdf_size,
      full_pdf_sha256 = EXCLUDED.full_pdf_sha256,
      page_asset_bucket = EXCLUDED.page_asset_bucket,
      page_asset_path = EXCLUDED.page_asset_path,
      page_asset_uri = EXCLUDED.page_asset_uri,
      page_asset_size = EXCLUDED.page_asset_size,
      page_asset_sha256 = EXCLUDED.page_asset_sha256,
      page_asset_storage_bucket = EXCLUDED.page_asset_storage_bucket,
      page_asset_storage_path = EXCLUDED.page_asset_storage_path,
      page_asset_mime_type = EXCLUDED.page_asset_mime_type,
      page_asset_size_bytes = EXCLUDED.page_asset_size_bytes,
      page_asset_checksum_sha256 = EXCLUDED.page_asset_checksum_sha256,
      updated_at = now()
    RETURNING id`,
    [
      page.materialId,
      page.classId,
      page.courseId,
      page.professorId,
      page.teacherId,
      page.title,
      page.materialType,
      page.pageNumber,
      page.pageStart,
      page.pageEnd,
      page.detectedPageLabel ?? null,
      page.documentTitle ?? null,
      page.chapter ?? null,
      page.section ?? null,
      page.sectionTitle ?? null,
      page.pageType ?? null,
      page.language ?? null,
      page.structuredPageJson ? JSON.stringify(page.structuredPageJson) : null,
      page.pageLevelSearchText ?? "",
      page.pageLevelSummary ?? "",
      page.extractionConfidence ?? null,
      page.extractionWarnings ?? [],
      page.extractionModel ?? null,
      page.extractionTimestamp ?? null,
      page.ingestionVersion ?? null,
      page.embeddingSource ?? null,
      page.embeddingDim ?? null,
      page.storageBucket,
      page.storagePath,
      page.fullPdfBucket ?? page.storageBucket,
      page.fullPdfPath ?? page.storagePath,
      page.fullPdfUri ?? `gs://${page.storageBucket}/${page.storagePath}`,
      page.fullPdfMimeType ?? "application/pdf",
      page.fullPdfSize ?? null,
      page.fullPdfSha256 ?? null,
      page.pageAssetBucket ?? page.pageAssetStorageBucket ?? null,
      page.pageAssetPath ?? page.pageAssetStoragePath ?? null,
      page.pageAssetUri ?? (
        (page.pageAssetBucket ?? page.pageAssetStorageBucket) && (page.pageAssetPath ?? page.pageAssetStoragePath)
          ? `gs://${page.pageAssetBucket ?? page.pageAssetStorageBucket}/${page.pageAssetPath ?? page.pageAssetStoragePath}`
          : null
      ),
      page.pageAssetSize ?? page.pageAssetSizeBytes ?? null,
      page.pageAssetSha256 ?? page.pageAssetChecksumSha256 ?? null,
      page.pageAssetStorageBucket ?? page.pageAssetBucket ?? null,
      page.pageAssetStoragePath ?? page.pageAssetPath ?? null,
      page.pageAssetMimeType ?? null,
      page.pageAssetSizeBytes ?? page.pageAssetSize ?? null,
      page.pageAssetChecksumSha256 ?? page.pageAssetSha256 ?? null
    ]
  );
  const pageId = result.rows[0]?.id;

  if (!pageId) {
    throw new PdfOcrMetadataDatabaseError(`Structured PDF page ${page.pageNumber} did not return a database id.`);
  }

  for (const block of blocks) {
    await client.query(
      `INSERT INTO pdf_page_blocks (
        material_id, page_id, class_id, course_id, professor_id, teacher_id, page_number,
        block_id, reading_order, block_type, exact_text, corrected_text, math_latex,
        math_ascii, item_kind, item_number, item_label, canonical_item_id,
        searchable_keywords, semantic_summary, relationships, confidence, ingestion_version
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13::text[],
        $14::text[], $15, $16, $17, $18,
        $19::text[], $20, $21::jsonb, $22, $23
      )`,
      [
        block.materialId,
        pageId,
        block.classId,
        block.courseId,
        block.professorId,
        block.teacherId,
        block.pageNumber,
        block.blockId,
        block.readingOrder,
        block.blockType,
        block.exactText,
        block.correctedText,
        block.mathLatex,
        block.mathAscii,
        block.itemKind ?? null,
        block.itemNumber ?? null,
        block.itemLabel ?? null,
        block.canonicalItemId ?? null,
        block.searchableKeywords,
        block.semanticSummary,
        JSON.stringify(block.relationships),
        block.confidence,
        block.ingestionVersion
      ]
    );
  }

  for (const contentEmbedding of embeddings) {
    const embedding = coercePdfEmbeddingForPostgres({
      createdAt: contentEmbedding.embeddingCreatedAt,
      dimensions: contentEmbedding.embeddingDim,
      model: contentEmbedding.embeddingModel,
      provider: contentEmbedding.embeddingProvider,
      taskType: contentEmbedding.embeddingTaskType,
      values: contentEmbedding.embedding
    });

    if (!embedding.vector) {
      throw new PdfOcrMetadataDatabaseError(
        `Structured PDF embedding for ${contentEmbedding.sourceType}:${contentEmbedding.sourceId} did not have ${defaultPdfVectorDimensions} dimensions.`
      );
    }

    await client.query(
      `INSERT INTO content_embeddings (
        material_id, page_id, class_id, course_id, professor_id, teacher_id, page_number,
        source_type, source_id, embedding_level, embedding_text, embedding, embedding_dim,
        embedding_model, embedding_provider, embedding_source, embedding_task_type,
        embedding_created_at, ingestion_version, block_id, block_type, reading_order,
        object_id, object_type, title, label, related_block_ids, item_kind, item_number,
        item_label, canonical_item_id, section
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12::vector, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23, $24, $25, $26, $27::text[], $28, $29,
        $30, $31, $32
      )`,
      [
        contentEmbedding.materialId,
        pageId,
        contentEmbedding.classId,
        contentEmbedding.courseId,
        contentEmbedding.professorId,
        contentEmbedding.teacherId,
        contentEmbedding.pageNumber,
        contentEmbedding.sourceType,
        contentEmbedding.sourceId,
        contentEmbedding.embeddingLevel,
        contentEmbedding.embeddingText,
        embedding.vector,
        embedding.dimensions,
        embedding.model,
        embedding.provider,
        contentEmbedding.embeddingSource,
        embedding.taskType,
        embedding.createdAt,
        contentEmbedding.ingestionVersion,
        contentEmbedding.blockId ?? null,
        contentEmbedding.blockType ?? null,
        contentEmbedding.readingOrder ?? null,
        contentEmbedding.objectId ?? null,
        contentEmbedding.objectType ?? null,
        contentEmbedding.title ?? null,
        contentEmbedding.label ?? null,
        contentEmbedding.relatedBlockIds ?? [],
        contentEmbedding.itemKind ?? null,
        contentEmbedding.itemNumber ?? null,
        contentEmbedding.itemLabel ?? null,
        contentEmbedding.canonicalItemId ?? null,
        contentEmbedding.section ?? null
      ]
    );
  }
}

export async function getCachedStructuredPdfPageExtractions({
  checksums
}: {
  checksums: string[];
}): Promise<CachedStructuredPdfPageExtraction[]> {
  const uniqueChecksums = [...new Set(checksums.map((checksum) => checksum.trim()).filter(Boolean))];

  if (!uniqueChecksums.length) {
    return [];
  }

  const client = await getPdfOcrPool().connect();

  try {
    const result = await client.query(
      `SELECT DISTINCT ON (page_asset_checksum_sha256)
        page_asset_checksum_sha256,
        structured_page_json,
        extraction_model
      FROM pdf_pages
      WHERE page_asset_checksum_sha256 = ANY($1::text[])
        AND ingestion_version = $2
        AND structured_page_json IS NOT NULL
        AND coalesce(page_type, '') <> 'failed'
      ORDER BY page_asset_checksum_sha256 ASC, extraction_timestamp DESC NULLS LAST, updated_at DESC`,
      [uniqueChecksums, structuredPdfIngestionVersion]
    );

    return result.rows.flatMap((row) => {
      const checksum = String(row.page_asset_checksum_sha256 ?? "").trim();
      const structuredPageJson = row.structured_page_json as StructuredPageJson | null;

      if (!checksum || !structuredPageJson) {
        return [];
      }

      return [{
        extractionModel: row.extraction_model ? String(row.extraction_model) : null,
        pageAssetChecksumSha256: checksum,
        structuredPageJson
      }];
    });
  } finally {
    client.release();
  }
}

async function queryStructuredExactProblems({
  classId,
  client,
  limit,
  materialId,
  problemNumbers,
  professorId
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  problemNumbers: string[];
  professorId: string;
}) {
  const candidateLimit = Math.max(limit * 20, 100);
  const problemPatterns = problemNumbers.map(postgresProblemLocatorPattern).filter(Boolean);

  if (!problemNumbers.length && !problemPatterns.length) {
    return [];
  }

  const result = await client.query(
    `${structuredContentEmbeddingSelectSql("100.0")}
    WHERE ce.class_id = $1
      AND ce.professor_id = $2
      AND ce.ingestion_version = $3
      AND ce.embedding_source = $4
      AND ce.embedding_dim = $5
      AND ($6::text IS NULL OR ce.material_id = $6)
      AND (
        ce.item_number = ANY($7::text[])
        OR ce.item_label = ANY($7::text[])
        OR ce.canonical_item_id = ANY($7::text[])
        OR ce.embedding_text ~* ANY($8::text[])
      )
    ORDER BY
      CASE
        WHEN ce.source_type = 'block' THEN 0
        WHEN ce.source_type = 'learning_object' THEN 1
        ELSE 2
      END,
      ce.page_number ASC,
      ce.reading_order ASC NULLS LAST
    LIMIT $9`,
    [
      classId,
      professorId,
      structuredPdfIngestionVersion,
      structuredPdfEmbeddingSource,
      defaultStructuredPdfEmbeddingDim,
      materialId ?? null,
      problemNumbers,
      problemPatterns,
      candidateLimit
    ]
  );

  return collapseStructuredSearchResults(
    rankPageSearchRows({
      limit: candidateLimit,
      query: `problem ${problemNumbers.join(" ")}`,
      retrievalMode: "exact_problem",
      rows: result.rows
    }).map((hit) => ({ ...hit, score: Math.max(hit.score, 90) })),
    limit,
    { exactItemMatch: true }
  );
}

async function queryStructuredExactPages({
  classId,
  client,
  limit,
  materialId,
  pageNumbers,
  professorId
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  pageNumbers: number[];
  professorId: string;
}) {
  const result = await client.query(
    `SELECT
      p.id::text AS row_id,
      p.material_id,
      p.class_id,
      p.professor_id,
      p.title,
      p.material_type,
      NULL AS problem_number,
      p.page_start,
      p.page_end,
      COALESCE(NULLIF(p.page_level_search_text, ''), NULLIF(p.page_level_summary, ''), '') AS page_level_search_text,
      COALESCE(NULLIF(p.page_level_search_text, ''), NULLIF(p.page_level_summary, ''), '') AS search_text,
      p.storage_bucket,
      p.storage_path,
      p.full_pdf_bucket,
      p.full_pdf_path,
      p.full_pdf_uri,
      p.full_pdf_mime_type,
      p.full_pdf_size,
      p.full_pdf_sha256,
      p.page_asset_bucket,
      p.page_asset_path,
      p.page_asset_uri,
      p.page_asset_size,
      p.page_asset_sha256,
      p.page_asset_storage_bucket,
      p.page_asset_storage_path,
      p.page_asset_mime_type,
      p.page_asset_size_bytes,
      p.page_asset_checksum_sha256,
      'page' AS source_type,
      p.id::text AS source_id,
      'page' AS embedding_level,
      NULL AS block_id,
      NULL AS object_id,
      p.page_type AS block_type,
      p.page_type AS object_type,
      NULL AS item_kind,
      NULL AS item_number,
      p.detected_page_label AS item_label,
      NULL AS canonical_item_id,
      p.embedding_source,
      p.ingestion_version,
      p.embedding_dim,
      95.0 AS score
    FROM pdf_pages p
    WHERE p.class_id = $1
      AND p.professor_id = $2
      AND p.ingestion_version = $3
      AND p.page_number = ANY($4::int[])
      AND ($5::text IS NULL OR p.material_id = $5)
    ORDER BY p.page_number ASC
    LIMIT $6`,
    [classId, professorId, structuredPdfIngestionVersion, pageNumbers, materialId ?? null, limit]
  );

  return collapseStructuredSearchResults(
    result.rows.map((row) => rowToSearchResult(row, "exact_page")),
    limit
  );
}

async function queryStructuredMetadataMatches({
  classId,
  client,
  limit,
  materialId,
  professorId,
  query
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
}) {
  const queryPatterns = structuredMetadataPatterns(query);

  if (!queryPatterns.length) {
    return [];
  }

  const result = await client.query(
    `${structuredContentEmbeddingSelectSql("8.0")}
    WHERE ce.class_id = $1
      AND ce.professor_id = $2
      AND ce.ingestion_version = $3
      AND ce.embedding_source = $4
      AND ce.embedding_dim = $5
      AND ($6::text IS NULL OR ce.material_id = $6)
      AND (
        ce.source_type ILIKE ANY($7::text[])
        OR ce.embedding_level ILIKE ANY($7::text[])
        OR ce.block_type ILIKE ANY($7::text[])
        OR ce.object_type ILIKE ANY($7::text[])
        OR ce.item_kind ILIKE ANY($7::text[])
        OR ce.section ILIKE ANY($7::text[])
        OR ce.title ILIKE ANY($7::text[])
        OR ce.label ILIKE ANY($7::text[])
      )
    ORDER BY score DESC, ce.page_number ASC, ce.reading_order ASC NULLS LAST
    LIMIT $8`,
    [
      classId,
      professorId,
      structuredPdfIngestionVersion,
      structuredPdfEmbeddingSource,
      defaultStructuredPdfEmbeddingDim,
      materialId ?? null,
      queryPatterns,
      limit
    ]
  );

  return collapseStructuredSearchResults(
    result.rows.map((row) => rowToSearchResult(row, "exact_title")),
    limit
  );
}

async function queryStructuredFullTextMatches({
  classId,
  client,
  limit,
  materialId,
  professorId,
  query
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
}) {
  const candidateLimit = Math.max(limit * 20, 100);
  const result = await client.query(
    `${structuredContentEmbeddingSelectSql("60.0 + ts_rank(to_tsvector('english', coalesce(ce.embedding_text, '')), plainto_tsquery('english', $6))")}
    WHERE ce.class_id = $1
      AND ce.professor_id = $2
      AND ce.ingestion_version = $3
      AND ce.embedding_source = $4
      AND ce.embedding_dim = $5
      AND to_tsvector('english', coalesce(ce.embedding_text, '')) @@ plainto_tsquery('english', $6)
      AND ($7::text IS NULL OR ce.material_id = $7)
    ORDER BY score DESC, ce.page_number ASC, ce.reading_order ASC NULLS LAST
    LIMIT $8`,
    [
      classId,
      professorId,
      structuredPdfIngestionVersion,
      structuredPdfEmbeddingSource,
      defaultStructuredPdfEmbeddingDim,
      query,
      materialId ?? null,
      candidateLimit
    ]
  );

  return collapseStructuredSearchResults(
    rankPageSearchRows({
      limit: candidateLimit,
      query,
      retrievalMode: "full_text",
      rows: result.rows
    }),
    limit
  );
}

async function queryStructuredVectorMatches({
  classId,
  client,
  limit,
  materialId,
  professorId,
  query,
  queryVector
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  professorId: string;
  query: string;
  queryVector: number[];
}) {
  const queryVectorLiteral = structuredVectorLiteral(queryVector);

  if (!queryVectorLiteral) {
    return [];
  }

  const candidateLimit = Math.max(limit * 10, 50);
  const result = await client.query(
    `${structuredContentEmbeddingSelectSql(
      "1.0 - (ce.embedding <=> $6::vector)",
      `ce.embedding <=> $6::vector AS vector_distance,
      ce.embedding::text AS embedding_text`
    )}
    WHERE ce.class_id = $1
      AND ce.professor_id = $2
      AND ce.ingestion_version = $3
      AND ce.embedding_source = $4
      AND ce.embedding_dim = $5
      AND ce.embedding IS NOT NULL
      AND ($7::text IS NULL OR ce.material_id = $7)
    ORDER BY ce.embedding <=> $6::vector
    LIMIT $8`,
    [
      classId,
      professorId,
      structuredPdfIngestionVersion,
      structuredPdfEmbeddingSource,
      defaultStructuredPdfEmbeddingDim,
      queryVectorLiteral,
      materialId ?? null,
      candidateLimit
    ]
  );

  return collapseStructuredSearchResults(
    rankVectorSearchRows({
      limit: candidateLimit,
      query,
      queryVector,
      rows: result.rows
    }),
    limit
  );
}

function structuredContentEmbeddingSelectSql(scoreExpression: string, extraSelect = "") {
  return `SELECT
      ce.id::text AS row_id,
      ce.material_id,
      ce.class_id,
      ce.professor_id,
      p.title,
      p.material_type,
      COALESCE(NULLIF(ce.item_number, ''), NULLIF(ce.item_label, '')) AS problem_number,
      ce.page_number AS page_start,
      ce.page_number AS page_end,
      trim(concat_ws(E'\\n',
        NULLIF(ce.title, ''),
        NULLIF(ce.label, ''),
        NULLIF(ce.section, ''),
        NULLIF(ce.embedding_text, '')
      )) AS page_level_search_text,
      trim(concat_ws(E'\\n',
        NULLIF(ce.title, ''),
        NULLIF(ce.label, ''),
        NULLIF(ce.section, ''),
        NULLIF(ce.embedding_text, '')
      )) AS search_text,
      p.storage_bucket,
      p.storage_path,
      p.full_pdf_bucket,
      p.full_pdf_path,
      p.full_pdf_uri,
      p.full_pdf_mime_type,
      p.full_pdf_size,
      p.full_pdf_sha256,
      p.page_asset_bucket,
      p.page_asset_path,
      p.page_asset_uri,
      p.page_asset_size,
      p.page_asset_sha256,
      p.page_asset_storage_bucket,
      p.page_asset_storage_path,
      p.page_asset_mime_type,
      p.page_asset_size_bytes,
      p.page_asset_checksum_sha256,
      ce.source_type,
      ce.source_id,
      ce.embedding_level,
      ce.block_id,
      ce.object_id,
      ce.block_type,
      ce.object_type,
      ce.item_kind,
      ce.item_number,
      ce.item_label,
      ce.canonical_item_id,
      ce.embedding_source,
      ce.ingestion_version,
      ce.embedding_dim,
      ${scoreExpression} AS score
      ${extraSelect ? `, ${extraSelect}` : ""}
    FROM content_embeddings ce
    JOIN pdf_pages p
      ON p.id = ce.page_id
     AND p.material_id = ce.material_id`;
}

async function runStructuredSearchStep(
  label: string,
  callback: () => Promise<PdfOcrSearchResult[]>
) {
  try {
    return await callback();
  } catch (caughtError) {
    if (isMissingStructuredPdfStorageError(caughtError)) {
      console.warn(`Structured PDF ${label} search skipped because structured PDF storage is unavailable.`, caughtError);
      return [];
    }

    throw caughtError;
  }
}

function structuredMetadataPatterns(query: string) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  const recognized = new Set([
    "block",
    "learning_object",
    "page",
    "section",
    "example",
    "examples",
    "definition",
    "definitions",
    "theorem",
    "theorems",
    "proof",
    "proofs",
    "figure",
    "figures",
    "table",
    "tables",
    "equation",
    "equations",
    "exercise",
    "exercises",
    "problem",
    "problems"
  ]);

  return terms
    .filter((term) => recognized.has(term) || /^\d+(?:\.\d+)*[a-z]?$/.test(term))
    .map((term) => `%${term.replace(/[%_]/g, "\\$&")}%`);
}

function structuredVectorLiteral(values: number[]) {
  if (values.length !== defaultStructuredPdfEmbeddingDim) {
    console.warn(
      `Structured PDF vector search skipped: query embedding has ${values.length} dimensions, expected ${defaultStructuredPdfEmbeddingDim}.`
    );
    return null;
  }

  return `[${values.map((value) => Number(value).toString()).join(",")}]`;
}

function collapseStructuredSearchResults(
  results: PdfOcrSearchResult[],
  limit: number,
  options: { exactItemMatch?: boolean } = {}
) {
  const collapsed = new Map<string, PdfOcrSearchResult>();

  for (const result of results) {
    const key = structuredDuplicateKey(result);
    const existing = collapsed.get(key);

    if (!existing || shouldPreferStructuredResult(result, existing, options)) {
      collapsed.set(key, result);
    }
  }

  return [...collapsed.values()]
    .sort((left, right) => right.score - left.score || structuredResultPriority(right, options) - structuredResultPriority(left, options))
    .slice(0, limit);
}

function structuredDuplicateKey(result: PdfOcrSearchResult) {
  return [
    result.materialId,
    result.pageStart,
    result.canonicalItemId || result.itemNumber || result.itemLabel || result.objectId || result.blockId || result.sourceId || "page"
  ].join(":");
}

function shouldPreferStructuredResult(
  next: PdfOcrSearchResult,
  existing: PdfOcrSearchResult,
  options: { exactItemMatch?: boolean }
) {
  if (Math.abs(next.score - existing.score) <= 5) {
    return structuredResultPriority(next, options) > structuredResultPriority(existing, options);
  }

  return next.score > existing.score;
}

function structuredResultPriority(result: PdfOcrSearchResult, options: { exactItemMatch?: boolean }) {
  const sourceType = (result.sourceType ?? "").toLowerCase();
  const embeddingLevel = (result.embeddingLevel ?? "").toLowerCase();
  const source = sourceType || embeddingLevel;

  if (options.exactItemMatch) {
    if (source === "block") {
      return 3;
    }

    if (source === "learning_object") {
      return 2;
    }

    return 1;
  }

  if (source === "learning_object") {
    return 3;
  }

  if (source === "block") {
    return 2;
  }

  return 1;
}

function isMissingStructuredPdfStorageError(error: unknown) {
  const maybeCode = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  return maybeCode === "42P01" || maybeCode === "42703" || /content_embeddings|structured_page_json|embedding_dim/i.test(message);
}

function postgresProblemLocatorPattern(problemNumber: string) {
  const normalized = problemNumber.trim();

  if (!normalized) {
    return "";
  }

  const parts = normalized.split(".");
  const escapedParts = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const numberPattern = escapedParts.join("[[:space:]]*\\.[[:space:]]*");

  return [
    "(^|[[:space:];:({\\[])",
    "((problem|exercise|exercises|question|questions|ex\\.?|number|no\\.?)?[[:space:]]*#?[[:space:]]*)?",
    numberPattern,
    "([).]|[[:space:]]|$)"
  ].join("");
}

function rankVectorSearchRows({
  limit,
  query,
  queryVector,
  rows
}: {
  limit: number;
  query: string;
  queryVector: number[];
  rows: QueryResultRow[];
}) {
  return rankPageSearchRows({
    limit,
    query,
    queryVector,
    retrievalMode: "vector",
    rows
  });
}

function rankPageSearchRows({
  limit,
  query,
  queryVector,
  retrievalMode,
  rows
}: {
  limit: number;
  query: string;
  queryVector?: number[];
  retrievalMode: PdfOcrRetrievalMode;
  rows: QueryResultRow[];
}) {
  const resultByCandidateId = new Map<string, PdfOcrSearchResult>();
  const candidates = rows.flatMap((row, index) => {
    const vector = vectorFromPostgresText(row.embedding_text);

    if (queryVector?.length && !vector.length) {
      return [];
    }

    const result = rowToSearchResult(row, retrievalMode);
    const candidateId = pageCandidateId(row, index);
    resultByCandidateId.set(candidateId, result);

    return [rowToRankableCandidate({
      candidateId,
      result,
      vector,
      vectorDistance: readNullableNumber(row.vector_distance) ?? undefined
    })];
  });

  if (!candidates.length) {
    return rows.slice(0, limit).map((row) => rowToSearchResult(row, retrievalMode));
  }

  const ranked = rankMaterialChunks({
    candidates,
    limit,
    query,
    queryVector
  });

  if (!ranked.hits.length) {
    return rows.slice(0, limit).map((row) => rowToSearchResult(row, retrievalMode));
  }

  return ranked.hits.flatMap((hit) => {
    const result = resultByCandidateId.get(hit.chunk.id);

    if (!result) {
      return [];
    }

    return [{
      ...result,
      problemNumbers: hit.matchedProblemNumber ? [hit.matchedProblemNumber] : result.problemNumbers,
      score: hit.score
    }];
  });
}

function rowToRankableCandidate({
  candidateId,
  result,
  vector,
  vectorDistance
}: {
  candidateId: string;
  result: PdfOcrSearchResult;
  vector?: number[];
  vectorDistance?: number;
}): RankableChunk {
  const materialType = result.materialType || "reading";

  return {
    chunk: {
      id: candidateId,
      classId: result.classId,
      content: result.chunkText,
      documentId: result.materialId,
      label: result.problemNumbers.length === 1 ? `Problem ${result.problemNumbers[0]}` : `Page ${result.pageStart}`,
      materialId: result.materialId,
      materialType,
      pageEnd: result.pageEnd,
      pageNumber: result.pageStart,
      pageStart: result.pageStart,
      problemNumbers: result.problemNumbers,
      professorId: result.professorId,
      teacherId: result.professorId,
      title: result.title,
      ...(vector?.length ? { vector } : {}),
      vectorDistance
    },
    document: {
      chunks: [],
      classId: result.classId,
      courseId: result.classId,
      id: result.materialId,
      kind: sourceDocumentKind(materialType),
      materialType,
      professorId: result.professorId,
      status: "ready",
      teacherId: result.professorId,
      title: result.title,
      uploadedAt: new Date().toISOString()
    }
  };
}

function sourceDocumentKind(materialType: string): RankableChunk["document"]["kind"] {
  const normalized = materialType.trim().toLowerCase();

  if (normalized === "assignment" || normalized === "worksheet" || normalized === "homework" || normalized === "practice-problems") {
    return "assignment";
  }

  if (normalized === "example" || normalized === "worked-example" || normalized === "practice-solutions") {
    return "worked-example";
  }

  if (normalized === "reading" || normalized === "textbook") {
    return "textbook";
  }

  return "lecture-notes";
}

function vectorCandidateId(row: QueryResultRow) {
  return `${String(row.source_kind ?? "row")}:${String(row.row_id ?? "")}`;
}

function pageCandidateId(row: QueryResultRow, index: number) {
  const rowId = String(row.row_id ?? "").trim();

  if (rowId) {
    return vectorCandidateId(row);
  }

  return [
    String(row.material_id ?? "material"),
    String(row.page_start ?? "page"),
    index
  ].join(":");
}

function vectorFromPostgresText(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  const text = String(value ?? "").trim();

  if (!text.startsWith("[") || !text.endsWith("]")) {
    return [];
  }

  return text.slice(1, -1).split(",").map(Number).filter(Number.isFinite);
}

function rowToSearchResult(row: QueryResultRow, retrievalMode: PdfOcrRetrievalMode): PdfOcrSearchResult {
  const pageStart = readInteger(row.page_start, 1);
  const pageEnd = readInteger(row.page_end, pageStart);
  const pageLevelSearchText = String(row.page_level_search_text ?? "");
  const searchText = String(row.search_text ?? pageLevelSearchText);
  const problemNumbers = typeof row.problem_numbers === "string" && row.problem_numbers.trim()
    ? row.problem_numbers.split(",").map((problemNumber: string) => problemNumber.trim()).filter(Boolean)
    : typeof row.problem_number === "string" && row.problem_number.trim()
    ? [row.problem_number.trim()]
    : problemNumbersFromText(searchText);
  const storageBucket = String(row.storage_bucket ?? "");
  const storagePath = String(row.storage_path ?? "");
  const fullPdfBucket = String(row.full_pdf_bucket ?? storageBucket);
  const fullPdfPath = String(row.full_pdf_path ?? storagePath);
  const pageAssetBucket = String(row.page_asset_bucket ?? row.page_asset_storage_bucket ?? "");
  const pageAssetPath = String(row.page_asset_path ?? row.page_asset_storage_path ?? "");
  const pageAssetStorageBucket = String(row.page_asset_storage_bucket ?? pageAssetBucket);
  const pageAssetStoragePath = String(row.page_asset_storage_path ?? pageAssetPath);
  const pageAssetSize = readNullableNumber(row.page_asset_size ?? row.page_asset_size_bytes);
  const pageAssetSha256 = String(row.page_asset_sha256 ?? row.page_asset_checksum_sha256 ?? "");

  return {
    chunkText: searchText,
    classId: String(row.class_id ?? ""),
    docId: String(row.material_id ?? ""),
    materialId: String(row.material_id ?? ""),
    materialType: String(row.material_type ?? ""),
    pageLevelSearchText,
    pageEnd,
    pageStart,
    printedPageEnd: null,
    printedPageStart: null,
    professorId: String(row.professor_id ?? ""),
    problemNumbers,
    retrievalMode,
    score: readNumber(row.score, 0),
    sourcePdfPath: storageBucket && storagePath ? `gs://${storageBucket}/${storagePath}` : storagePath,
    fullPdfBucket,
    fullPdfPath,
    fullPdfUri: String(row.full_pdf_uri ?? (fullPdfBucket && fullPdfPath ? `gs://${fullPdfBucket}/${fullPdfPath}` : "")),
    fullPdfMimeType: String(row.full_pdf_mime_type ?? "application/pdf"),
    fullPdfSize: readNullableNumber(row.full_pdf_size),
    fullPdfSha256: String(row.full_pdf_sha256 ?? ""),
    pageAssetBucket,
    pageAssetPath,
    pageAssetUri: String(row.page_asset_uri ?? (pageAssetBucket && pageAssetPath ? `gs://${pageAssetBucket}/${pageAssetPath}` : "")),
    pageAssetSize,
    pageAssetSha256,
    pageAssetStorageBucket,
    pageAssetStoragePath,
    pageAssetMimeType: String(row.page_asset_mime_type ?? ""),
    pageAssetSizeBytes: pageAssetSize,
    pageAssetChecksumSha256: pageAssetSha256,
    storageBucket,
    storagePath,
    title: String(row.title ?? "Untitled PDF"),
    sourceType: readOptionalResultString(row.source_type),
    sourceId: readOptionalResultString(row.source_id),
    embeddingLevel: readOptionalResultString(row.embedding_level),
    blockId: readOptionalResultString(row.block_id),
    objectId: readOptionalResultString(row.object_id),
    blockType: readOptionalResultString(row.block_type),
    objectType: readOptionalResultString(row.object_type),
    itemKind: readOptionalResultString(row.item_kind),
    itemNumber: readOptionalResultString(row.item_number),
    itemLabel: readOptionalResultString(row.item_label),
    canonicalItemId: readOptionalResultString(row.canonical_item_id),
    embeddingSource: readOptionalResultString(row.embedding_source),
    ingestionVersion: readOptionalResultString(row.ingestion_version),
    embeddingDim: readNullableNumber(row.embedding_dim)
  };
}

export async function deletePdfOcrMetadata(materialId: string) {
  if (!isPdfOcrPostgresConfigured()) {
    return;
  }

  const client = await getPdfOcrPool().connect();

  try {
    await client.query("DELETE FROM pdf_materials WHERE material_id = $1", [materialId]);
  } finally {
    client.release();
  }
}

export async function getPdfPageAssetRecords({
  classId,
  professorId,
  pages
}: {
  classId: string;
  professorId: string;
  pages: Array<{ materialId: string; pageNumber: number }>;
}) {
  if (!pages.length) {
    return [];
  }

  const client = await getPdfOcrPool().connect();
  const values: string[] = [];
  const params: Array<string | number> = [classId, professorId];

  pages.forEach((page, index) => {
    params.push(page.materialId, page.pageNumber);
    values.push(`($${index * 2 + 3}::text, $${index * 2 + 4}::int)`);
  });

  try {
    const result = await client.query(
      `WITH requested(material_id, page_number) AS (VALUES ${values.join(", ")})
      SELECT
        p.material_id,
        p.class_id,
        p.professor_id,
        p.title,
        p.material_type,
        p.page_number,
        p.page_start,
        p.page_end,
        p.page_level_search_text,
        p.extraction_confidence,
        p.extraction_model,
        p.full_pdf_bucket,
        p.full_pdf_path,
        p.full_pdf_uri,
        p.full_pdf_mime_type,
        p.full_pdf_size,
        p.full_pdf_sha256,
        p.page_asset_bucket,
        p.page_asset_path,
        p.page_asset_uri,
        p.page_asset_size,
        p.page_asset_sha256,
        p.page_asset_storage_bucket,
        p.page_asset_storage_path,
        p.page_asset_mime_type,
        p.page_asset_size_bytes,
        p.page_asset_checksum_sha256
      FROM pdf_pages p
      JOIN requested r
        ON r.material_id = p.material_id
       AND r.page_number = p.page_number
      WHERE p.class_id = $1
        AND p.professor_id = $2
      ORDER BY p.material_id ASC, p.page_number ASC`,
      params
    );

    return result.rows;
  } finally {
    client.release();
  }
}

async function upsertPdfMaterial(client: PoolClient, material: PdfMaterialMetadata) {
  await client.query(
    `INSERT INTO pdf_materials (
      material_id, class_id, course_id, professor_id, teacher_id, title, material_type,
      content_type, file_name, file_size, storage_bucket, storage_path, storage_uri,
      full_pdf_bucket, full_pdf_path, full_pdf_uri, full_pdf_mime_type, full_pdf_size,
      full_pdf_sha256,
      source_kind, page_count, character_count,
      search_metadata_source, updated_at, indexed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18,
      $19,
      $20, $21, $22,
      'postgres', now(), now()
    )
    ON CONFLICT (material_id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      course_id = EXCLUDED.course_id,
      professor_id = EXCLUDED.professor_id,
      teacher_id = EXCLUDED.teacher_id,
      title = EXCLUDED.title,
      material_type = EXCLUDED.material_type,
      content_type = EXCLUDED.content_type,
      file_name = EXCLUDED.file_name,
      file_size = EXCLUDED.file_size,
      storage_bucket = EXCLUDED.storage_bucket,
      storage_path = EXCLUDED.storage_path,
      storage_uri = EXCLUDED.storage_uri,
      full_pdf_bucket = EXCLUDED.full_pdf_bucket,
      full_pdf_path = EXCLUDED.full_pdf_path,
      full_pdf_uri = EXCLUDED.full_pdf_uri,
      full_pdf_mime_type = EXCLUDED.full_pdf_mime_type,
      full_pdf_size = EXCLUDED.full_pdf_size,
      full_pdf_sha256 = EXCLUDED.full_pdf_sha256,
      source_kind = EXCLUDED.source_kind,
      page_count = EXCLUDED.page_count,
      character_count = EXCLUDED.character_count,
      search_metadata_source = 'postgres',
      updated_at = now(),
      indexed_at = now()`,
    [
      material.materialId,
      material.classId,
      material.courseId,
      material.professorId,
      material.teacherId,
      material.title,
      material.materialType,
      material.contentType,
      material.fileName,
      material.fileSize,
      material.storageBucket,
      material.storagePath,
      material.storageUri,
      material.fullPdfBucket ?? material.storageBucket,
      material.fullPdfPath ?? material.storagePath,
      material.fullPdfUri ?? material.storageUri,
      material.fullPdfMimeType ?? material.contentType,
      material.fullPdfSize ?? material.fileSize,
      material.fullPdfSha256 ?? null,
      material.sourceKind,
      material.pageCount,
      material.characterCount
    ]
  );
}

function readPostgresSslConfig(connectionString: string) {
  const sslMode = process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() ?? "";

  if (sslMode === "disable" || connectionString.includes("sslmode=disable")) {
    return false;
  }

  if (sslMode === "require" || connectionString.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pageNumbersFromText(text: string) {
  const matches = new Set<number>();
  const patterns = [
    /\b(?:page|pg\.?|p\.?)\s*#?\s*(\d{1,4})\b/gi,
    /\bprinted\s+page\s+(\d{1,4})\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const pageNumber = Number(match[1]);

      if (Number.isInteger(pageNumber) && pageNumber > 0) {
        matches.add(pageNumber);
      }
    }
  }

  return [...matches];
}

function readInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readNullableNumber(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOptionalResultString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

export function coercePdfEmbeddingForPostgres({
  createdAt,
  dimensions,
  model,
  provider,
  taskType,
  values
}: {
  createdAt?: string;
  dimensions?: number;
  model?: string;
  provider?: string;
  taskType?: string;
  values?: number[];
}) {
  const vector = vectorLiteral(values);

  if (!vector) {
    return {
      createdAt: null,
      dimensions: null,
      model: null,
      provider: null,
      taskType: null,
      vector: null
    };
  }

  return {
    createdAt: createdAt ?? null,
    dimensions: values?.length ?? dimensions ?? null,
    model: model ?? null,
    provider: provider ?? null,
    taskType: taskType ?? null,
    vector
  };
}

function vectorLiteral(values: number[] | undefined, options: { warn?: boolean } = {}) {
  if (!values?.length) {
    return null;
  }

  const expectedDimensions = defaultPdfVectorDimensions;

  if (values.length !== expectedDimensions) {
    if (options.warn !== false) {
        console.warn(
          `PDF embedding dimension mismatch: got ${values.length}, expected ${expectedDimensions}.`
        );
    }
    return null;
  }

  return `[${values.map((value) => Number(value).toString()).join(",")}]`;
}

export type PdfOcrMetadataRow = QueryResultRow;
