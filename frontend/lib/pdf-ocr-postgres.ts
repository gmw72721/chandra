import pg, { type PoolClient, type QueryResultRow } from "pg";
import { problemNumbersFromText, rankMaterialChunks, type RankableChunk } from "./retrieval-ranking.ts";
import type { PdfDetectedProblemMetadata, PdfMaterialMetadata, PdfOcrPageMetadata } from "./types.ts";

const { Pool } = pg;
const defaultPoolMax = 5;
let pool: pg.Pool | null = null;

export class PdfOcrMetadataDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfOcrMetadataDatabaseError";
  }
}

export type PdfOcrRetrievalMode = "exact_problem" | "exact_page" | "exact_title" | "full_text";

export type PdfOcrSearchResult = {
  chunkText: string;
  classId: string;
  docId: string;
  materialId: string;
  materialType: string;
  ocrConfidence: number | null;
  ocrProvider: string;
  ocrSource: string;
  ocrText: string;
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
      "PDF OCR metadata requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
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
      "PDF OCR metadata requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
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
  pageBefore,
  professorId,
  query
}: {
  classId: string;
  limit: number;
  materialId?: string;
  pageBefore?: number;
  professorId: string;
  query: string;
}) {
  const client = await getPdfOcrPool().connect();

  try {
    const normalizedLimit = Math.max(1, Math.min(limit, 20));
    const problemNumbers = problemNumbersFromText(query);
    const pageNumbers = pageNumbersFromText(query);

    if (problemNumbers.length) {
      const exactProblems = await queryExactProblems({
        classId,
        client,
        limit: normalizedLimit,
        materialId,
        pageBefore,
        problemNumbers,
        professorId
      });

      if (exactProblems.length) {
        return exactProblems;
      }
    }

    if (pageNumbers.length) {
      const exactPages = await queryExactPages({
        classId,
        client,
        limit: normalizedLimit,
        materialId,
        pageBefore,
        pageNumbers,
        professorId
      });

      if (exactPages.length) {
        return exactPages;
      }
    }

    const titleMatches = await queryTitleMatches({
      classId,
      client,
      limit: normalizedLimit,
      materialId,
      pageBefore,
      professorId,
      query
    });

    if (titleMatches.length) {
      return titleMatches;
    }

    const fullTextMatches = await queryFullTextMatches({
      classId,
      client,
      limit: normalizedLimit,
      materialId,
      pageBefore,
      professorId,
      query
    });

    if (fullTextMatches.length) {
      return fullTextMatches;
    }

    return [];
  } catch (caughtError) {
    throw new PdfOcrMetadataDatabaseError("PDF OCR metadata search failed.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

export async function replacePdfOcrMetadata({
  material,
  pages,
  problems
}: {
  material: PdfMaterialMetadata;
  pages: PdfOcrPageMetadata[];
  problems: PdfDetectedProblemMetadata[];
}) {
  const client = await getPdfOcrPool().connect();

  try {
    await client.query("BEGIN");
    await upsertPdfMaterial(client, material);
    await client.query("DELETE FROM pdf_detected_problems WHERE material_id = $1", [material.materialId]);
    await client.query("DELETE FROM pdf_pages WHERE material_id = $1", [material.materialId]);
    const pageIds = new Map<number, number>();

    for (const page of pages) {
      const result = await client.query<{ id: number }>(
        `INSERT INTO pdf_pages (
          material_id, class_id, course_id, professor_id, teacher_id, title, material_type,
          page_number, page_start, page_end, ocr_text, ocr_provider, ocr_source,
          ocr_confidence, storage_bucket, storage_path,
          full_pdf_bucket, full_pdf_path, full_pdf_uri, full_pdf_mime_type,
          full_pdf_size, full_pdf_sha256, page_asset_bucket, page_asset_path,
          page_asset_uri, page_asset_size, page_asset_sha256,
          page_asset_storage_bucket, page_asset_storage_path, page_asset_mime_type,
          page_asset_size_bytes, page_asset_checksum_sha256
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16,
          $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25, $26, $27,
          $28, $29, $30, $31, $32
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
          page.ocrText,
          page.ocrProvider,
          page.ocrSource,
          page.ocrConfidence ?? null,
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

    for (const problem of problems) {
      const pageId = pageIds.get(problem.pageStart);

      if (!pageId) {
        continue;
      }

      await client.query(
        `INSERT INTO pdf_detected_problems (
          material_id, page_id, class_id, course_id, professor_id, teacher_id, title,
          material_type, problem_number, page_start, page_end, problem_text,
          source, confidence, ocr_provider, ocr_source, storage_bucket, storage_path
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18
        )`,
        [
          problem.materialId,
          pageId,
          problem.classId,
          problem.courseId,
          problem.professorId,
          problem.teacherId,
          problem.title,
          problem.materialType,
          problem.problemNumber,
          problem.pageStart,
          problem.pageEnd,
          problem.problemText,
          problem.source,
          problem.confidence ?? null,
          problem.ocrProvider,
          problem.ocrSource,
          problem.storageBucket,
          problem.storagePath
        ]
      );
    }

    await client.query("COMMIT");
  } catch (caughtError) {
    await client.query("ROLLBACK").catch(() => {});
    throw new PdfOcrMetadataDatabaseError("PDF OCR metadata could not be written to PostgreSQL.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  } finally {
    client.release();
  }
}

async function queryExactProblems({
  classId,
  client,
  limit,
  materialId,
  pageBefore,
  problemNumbers,
  professorId
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  pageBefore?: number;
  problemNumbers: string[];
  professorId: string;
}) {
  const candidateLimit = Math.max(limit * 20, 100);
  const problemPatterns = problemNumbers.map(postgresProblemLocatorPattern).filter(Boolean);

  if (!problemPatterns.length) {
    return [];
  }

  const result = await client.query(
    `SELECT
      p.id::text AS row_id,
      p.material_id,
      p.class_id,
      p.professor_id,
      p.title,
      p.material_type,
      dp.problem_number,
      p.page_start,
      p.page_end,
      COALESCE(NULLIF(btrim(dp.problem_text), ''), p.ocr_text) AS ocr_text,
      p.ocr_confidence,
      p.ocr_provider,
      p.ocr_source,
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
      100.0 AS score
    FROM pdf_detected_problems dp
    INNER JOIN pdf_pages p
      ON p.id = dp.page_id
    WHERE dp.class_id = $1
      AND dp.professor_id = $2
      AND dp.problem_number ~* ANY($3::text[])
      AND ($4::text IS NULL OR dp.material_id = $4)
      AND ($5::int IS NULL OR dp.page_start < $5)
    ORDER BY dp.page_start ASC
    LIMIT $6`,
    [classId, professorId, problemPatterns, materialId ?? null, normalizedPageBefore(pageBefore), candidateLimit]
  );

  return rankPageSearchRows({
    limit,
    query: `problem ${problemNumbers.join(" ")}`,
    retrievalMode: "exact_problem",
    rows: result.rows
  });
}

async function queryExactPages({
  classId,
  client,
  limit,
  materialId,
  pageBefore,
  pageNumbers,
  professorId
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  pageBefore?: number;
  pageNumbers: number[];
  professorId: string;
}) {
  const result = await client.query(
    `SELECT
      material_id,
      class_id,
      professor_id,
      title,
      material_type,
      page_start,
      page_end,
      ocr_text,
      ocr_confidence,
      ocr_provider,
      ocr_source,
      storage_bucket,
      storage_path,
      full_pdf_bucket,
      full_pdf_path,
      full_pdf_uri,
      full_pdf_mime_type,
      full_pdf_size,
      full_pdf_sha256,
      page_asset_bucket,
      page_asset_path,
      page_asset_uri,
      page_asset_size,
      page_asset_sha256,
      page_asset_storage_bucket,
      page_asset_storage_path,
      page_asset_mime_type,
      page_asset_size_bytes,
      page_asset_checksum_sha256,
      95.0 AS score
    FROM pdf_pages
    WHERE class_id = $1
      AND professor_id = $2
      AND page_number = ANY($3::int[])
      AND ($4::text IS NULL OR material_id = $4)
      AND ($5::int IS NULL OR page_start < $5)
    ORDER BY page_number ASC
    LIMIT $6`,
    [classId, professorId, pageNumbers, materialId ?? null, normalizedPageBefore(pageBefore), limit]
  );

  return result.rows.map((row) => rowToSearchResult(row, "exact_page"));
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

async function queryTitleMatches({
  classId,
  client,
  limit,
  materialId,
  pageBefore,
  professorId,
  query
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  pageBefore?: number;
  professorId: string;
  query: string;
}) {
  const result = await client.query(
    `SELECT
      p.material_id,
      p.class_id,
      p.professor_id,
      p.title,
      p.material_type,
      p.page_start,
      p.page_end,
      p.ocr_text,
      p.ocr_confidence,
      p.ocr_provider,
      p.ocr_source,
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
      80.0 + ts_rank(to_tsvector('english', coalesce(p.title, '')), plainto_tsquery('english', $3)) AS score
    FROM pdf_pages p
    WHERE p.class_id = $1
      AND p.professor_id = $2
      AND to_tsvector('english', coalesce(p.title, '')) @@ plainto_tsquery('english', $3)
      AND ($4::text IS NULL OR p.material_id = $4)
      AND ($5::int IS NULL OR p.page_start < $5)
    ORDER BY score DESC, p.page_start ASC
    LIMIT $6`,
    [classId, professorId, query, materialId ?? null, normalizedPageBefore(pageBefore), limit]
  );

  return result.rows.map((row) => rowToSearchResult(row, "exact_title"));
}

async function queryFullTextMatches({
  classId,
  client,
  limit,
  materialId,
  pageBefore,
  professorId,
  query
}: {
  classId: string;
  client: PoolClient;
  limit: number;
  materialId?: string;
  pageBefore?: number;
  professorId: string;
  query: string;
}) {
  const result = await client.query(
    `SELECT
      id::text AS row_id,
      material_id,
      class_id,
      professor_id,
      title,
      material_type,
      NULL AS problem_number,
      page_start,
      page_end,
      ocr_text,
      ocr_confidence,
      ocr_provider,
      ocr_source,
      storage_bucket,
      storage_path,
      full_pdf_bucket,
      full_pdf_path,
      full_pdf_uri,
      full_pdf_mime_type,
      full_pdf_size,
      full_pdf_sha256,
      page_asset_bucket,
      page_asset_path,
      page_asset_uri,
      page_asset_size,
      page_asset_sha256,
      page_asset_storage_bucket,
      page_asset_storage_path,
      page_asset_mime_type,
      page_asset_size_bytes,
      page_asset_checksum_sha256,
      60.0 + ts_rank(text_search, plainto_tsquery('english', $3)) AS score
    FROM pdf_pages
    WHERE class_id = $1
      AND professor_id = $2
      AND text_search @@ plainto_tsquery('english', $3)
      AND ($4::text IS NULL OR material_id = $4)
      AND ($5::int IS NULL OR page_start < $5)
    ORDER BY score DESC, page_start ASC
    LIMIT $6`,
    [classId, professorId, query, materialId ?? null, normalizedPageBefore(pageBefore), limit]
  );

  return rankPageSearchRows({
    limit,
    query,
    retrievalMode: "full_text",
    rows: result.rows
  });
}

function rankPageSearchRows({
  limit,
  query,
  retrievalMode,
  rows
}: {
  limit: number;
  query: string;
  retrievalMode: PdfOcrRetrievalMode;
  rows: QueryResultRow[];
}) {
  const resultByCandidateId = new Map<string, PdfOcrSearchResult>();
  const candidates = rows.flatMap((row, index) => {
    const result = rowToSearchResult(row, retrievalMode);
    const candidateId = pageCandidateId(row, index);
    resultByCandidateId.set(candidateId, result);

    return [rowToRankableCandidate({
      candidateId,
      result
    })];
  });

  if (!candidates.length) {
    return rows.slice(0, limit).map((row) => rowToSearchResult(row, retrievalMode));
  }

  const ranked = rankMaterialChunks({
    candidates,
    limit,
    query
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
  result
}: {
  candidateId: string;
  result: PdfOcrSearchResult;
}): RankableChunk {
  const materialType = result.materialType || "reading";

  return {
    chunk: {
      id: candidateId,
      classId: result.classId,
      content: result.ocrText,
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
      title: result.title
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

function rowCandidateId(row: QueryResultRow) {
  return `${String(row.source_kind ?? "row")}:${String(row.row_id ?? "")}`;
}

function normalizedPageBefore(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null;
}

function pageCandidateId(row: QueryResultRow, index: number) {
  const rowId = String(row.row_id ?? "").trim();

  if (rowId) {
    return rowCandidateId(row);
  }

  return [
    String(row.material_id ?? "material"),
    String(row.page_start ?? "page"),
    index
  ].join(":");
}

function rowToSearchResult(row: QueryResultRow, retrievalMode: PdfOcrRetrievalMode): PdfOcrSearchResult {
  const pageStart = readInteger(row.page_start, 1);
  const pageEnd = readInteger(row.page_end, pageStart);
  const problemNumbers = typeof row.problem_numbers === "string" && row.problem_numbers.trim()
    ? row.problem_numbers.split(",").map((problemNumber: string) => problemNumber.trim()).filter(Boolean)
    : typeof row.problem_number === "string" && row.problem_number.trim()
    ? [row.problem_number.trim()]
    : problemNumbersFromText(String(row.ocr_text ?? ""));
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
    chunkText: String(row.ocr_text ?? ""),
    classId: String(row.class_id ?? ""),
    docId: String(row.material_id ?? ""),
    materialId: String(row.material_id ?? ""),
    materialType: String(row.material_type ?? ""),
    ocrConfidence: readNullableNumber(row.ocr_confidence),
    ocrProvider: String(row.ocr_provider ?? ""),
    ocrSource: String(row.ocr_source ?? ""),
    ocrText: String(row.ocr_text ?? ""),
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
    title: String(row.title ?? "Untitled PDF")
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
        p.id,
        p.material_id,
        p.class_id,
        p.teacher_id,
        p.professor_id,
        p.title,
        p.material_type,
        p.page_number,
        p.page_start,
        p.page_end,
        p.ocr_text,
        p.ocr_confidence,
        p.ocr_provider,
        p.ocr_source,
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
        dp.problem_numbers
      FROM pdf_pages p
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT problem_number, ',') AS problem_numbers
        FROM pdf_detected_problems
        WHERE page_id = p.id
      ) dp ON TRUE
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
      source_kind, ocr_provider, ocr_source, ocr_confidence, page_count, character_count,
      search_metadata_source, updated_at, indexed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18,
      $19,
      $20, $21, $22, $23, $24, $25,
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
      ocr_provider = EXCLUDED.ocr_provider,
      ocr_source = EXCLUDED.ocr_source,
      ocr_confidence = EXCLUDED.ocr_confidence,
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
      material.ocrProvider,
      material.ocrSource,
      material.ocrConfidence ?? null,
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

export type PdfOcrMetadataRow = QueryResultRow;
