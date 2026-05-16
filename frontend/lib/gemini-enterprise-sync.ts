import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import pg from "pg";

const { Pool } = pg;
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const maxInlineDocumentsPerImport = 100;

export type AgentSearchChunkType =
  | "caption"
  | "definition"
  | "example"
  | "formula"
  | "page"
  | "paragraph"
  | "section"
  | "table";

export type PdfPageAgentSearchSource = {
  id?: string | number;
  class_id?: string;
  classId?: string;
  teacher_id?: string;
  teacherId?: string;
  professor_id?: string;
  professorId?: string;
  material_id?: string;
  materialId?: string;
  title?: string;
  material_type?: string;
  materialType?: string;
  page_number?: number;
  pageNumber?: number;
  page_start?: number;
  pageStart?: number;
  ocr_text?: string;
  ocrText?: string;
  page_asset_uri?: string;
  pageAssetUri?: string;
  page_asset_mime_type?: string;
  pageAssetMimeType?: string;
  page_asset_size?: number | string | null;
  pageAssetSize?: number | string | null;
  page_asset_size_bytes?: number | string | null;
  pageAssetSizeBytes?: number | string | null;
  page_asset_sha256?: string | null;
  pageAssetSha256?: string | null;
  page_asset_checksum_sha256?: string | null;
  pageAssetChecksumSha256?: string | null;
  problem_numbers?: string[] | string;
  problemNumbers?: string[];
};

export type AgentSearchDocumentRecord = {
  classId: string;
  teacherId: string;
  professorId: string;
  materialId: string;
  sourceTable: "pdf_pages";
  sourceRowId: string;
  geminiDocumentId: string;
  chunkType: AgentSearchChunkType;
  pageNumber: number;
  contentHash: string;
  document: {
    id: string;
    structData: Record<string, unknown>;
    content:
      | {
          mimeType: "text/plain";
          rawBytes: string;
        }
      | {
          mimeType: "application/pdf";
          uri: string;
        };
  };
};

export type GeminiEnterpriseSyncConfig = {
  collectionId: string;
  dataStoreId: string;
  location: string;
  projectId: string;
};

export type AgentSearchSyncSummary = {
  importedCount: number;
  operationNames: string[];
  skippedReason: string;
  status: "disabled" | "failed" | "import_requested" | "not-configured" | "skipped";
};

export function pdfPageToAgentSearchDocument(page: PdfPageAgentSearchSource): AgentSearchDocumentRecord | null {
  const classId = stringValue(page.class_id ?? page.classId);
  const professorId = stringValue(page.professor_id ?? page.professorId);
  const teacherId = stringValue(page.teacher_id ?? page.teacherId ?? professorId);
  const materialId = stringValue(page.material_id ?? page.materialId);
  const sourceRowId = stringValue(page.id);
  const pageNumber = integerValue(page.page_number ?? page.pageNumber ?? page.page_start ?? page.pageStart);
  const content = stringValue(page.ocr_text ?? page.ocrText);
  const pageAssetUri = stringValue(page.page_asset_uri ?? page.pageAssetUri);
  const pageAssetMimeType = stringValue(page.page_asset_mime_type ?? page.pageAssetMimeType) || "application/pdf";
  const pageAssetSize = integerValue(page.page_asset_size ?? page.pageAssetSize ?? page.page_asset_size_bytes ?? page.pageAssetSizeBytes);
  const pageAssetSha256 = stringValue(page.page_asset_sha256 ?? page.pageAssetSha256 ?? page.page_asset_checksum_sha256 ?? page.pageAssetChecksumSha256);

  if (!classId || !teacherId || !professorId || !materialId || !sourceRowId || !pageNumber) {
    return null;
  }

  const hasPagePdf = pageAssetUri.startsWith("gs://") && pageAssetMimeType.toLowerCase().split(";")[0] === "application/pdf";

  if (!hasPagePdf && !content.trim()) {
    return null;
  }

  const chunkType = inferChunkType(content);
  const geminiDocumentId = stableGeminiDocumentId({ materialId, pageNumber, sourceRowId });
  const contentHash = createHash("sha256")
    .update(hasPagePdf
      ? ["pdf-page", pageAssetUri, pageAssetSha256, pageAssetSize, content].join("|")
      : content)
    .digest("hex");

  return {
    classId,
    teacherId,
    professorId,
    materialId,
    sourceTable: "pdf_pages",
    sourceRowId,
    geminiDocumentId,
    chunkType,
    pageNumber,
    contentHash,
    document: {
      id: geminiDocumentId,
      structData: {
        active_for_students: true,
        chunk_type: chunkType,
        class_id: classId,
        material_id: materialId,
        material_type: stringValue(page.material_type ?? page.materialType),
        page_number: pageNumber,
        problem_numbers: normalizeProblemNumbers(page.problem_numbers ?? page.problemNumbers),
        professor_id: professorId,
        source_row_id: sourceRowId,
        source_table: "pdf_pages",
        teacher_id: teacherId,
        teacher_only: false,
        title: stringValue(page.title) || "Untitled PDF"
      },
      content: hasPagePdf
        ? {
            mimeType: "application/pdf",
            uri: pageAssetUri
          }
        : {
            mimeType: "text/plain",
            rawBytes: Buffer.from(content, "utf8").toString("base64")
          }
    }
  };
}

export function agentSearchImportJsonl(records: AgentSearchDocumentRecord[]) {
  return records.map((record) => JSON.stringify(record.document)).join("\n");
}

export function isGeminiEnterpriseSearchEnabled() {
  return !isFalseyEnv(process.env.GEMINI_ENTERPRISE_SEARCH_ENABLED);
}

export function geminiEnterpriseSyncConfigFromEnv(): GeminiEnterpriseSyncConfig {
  return {
    collectionId: process.env.GEMINI_ENTERPRISE_COLLECTION_ID?.trim() || "default_collection",
    dataStoreId: process.env.GEMINI_ENTERPRISE_DATA_STORE_ID?.trim() || "",
    location: process.env.GEMINI_ENTERPRISE_LOCATION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim() || "global",
    projectId: process.env.GEMINI_ENTERPRISE_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || ""
  };
}

export function missingGeminiEnterpriseSyncConfig(config = geminiEnterpriseSyncConfigFromEnv()) {
  return Object.entries(config)
    .filter(([_key, value]) => !value)
    .map(([key]) => key);
}

export async function syncPdfPagesToAgentSearch({
  pages,
  pool,
  statusOnSuccess = "import_requested"
}: {
  pages: PdfPageAgentSearchSource[];
  pool?: pg.Pool;
  statusOnSuccess?: "import_requested" | "synced";
}): Promise<AgentSearchSyncSummary> {
  if (!isGeminiEnterpriseSearchEnabled()) {
    return { importedCount: 0, operationNames: [], skippedReason: "GEMINI_ENTERPRISE_SEARCH_ENABLED is false", status: "disabled" };
  }

  const config = geminiEnterpriseSyncConfigFromEnv();
  const missingConfig = missingGeminiEnterpriseSyncConfig(config);

  if (missingConfig.length) {
    return {
      importedCount: 0,
      operationNames: [],
      skippedReason: `Missing Gemini Enterprise Search config: ${missingConfig.join(", ")}`,
      status: "not-configured"
    };
  }

  const records = pages.map(pdfPageToAgentSearchDocument).filter((record): record is AgentSearchDocumentRecord => record !== null);

  if (!records.length) {
    return { importedCount: 0, operationNames: [], skippedReason: "No PDF pages had usable Agent Search content", status: "skipped" };
  }

  const syncPool = pool ?? defaultPostgresPool();
  const recordsNeedingSync = await filterAgentSearchRecordsNeedingSync({ pool: syncPool, records });

  if (!recordsNeedingSync.length) {
    return { importedCount: 0, operationNames: [], skippedReason: "All PDF pages are already synced", status: "skipped" };
  }

  const accessToken = await getGoogleAccessToken();
  const operationNames: string[] = [];
  let importedCount = 0;

  for (const batch of chunks(recordsNeedingSync, maxInlineDocumentsPerImport)) {
    try {
      const operation = await importAgentSearchDocuments({
        accessToken,
        config,
        documents: batch.map((record) => record.document)
      });
      const operationName = stringValue(operation.name);
      await upsertAgentSearchStatuses({
        pool: syncPool,
        records: batch,
        status: statusOnSuccess,
        lastError: "",
        operationName
      });
      importedCount += batch.length;
      if (operationName) {
        operationNames.push(operationName);
      }
    } catch (caughtError) {
      await upsertAgentSearchStatuses({
        pool: syncPool,
        records: batch,
        status: "failed",
        lastError: caughtError instanceof Error ? caughtError.message : String(caughtError),
        operationName: ""
      }).catch(() => {});
      throw caughtError;
    }
  }

  return { importedCount, operationNames, skippedReason: "", status: "import_requested" };
}

export async function filterAgentSearchRecordsNeedingSync({
  pool,
  records
}: {
  pool: pg.Pool;
  records: AgentSearchDocumentRecord[];
}) {
  if (!records.length) {
    return [];
  }

  const keys = records.map((record) => [record.sourceTable, record.sourceRowId, record.geminiDocumentId]);
  const result = await pool.query(
    `SELECT source_table, source_row_id, gemini_document_id, content_hash, sync_status
     FROM agent_search_documents
     WHERE (source_table, source_row_id, gemini_document_id) IN (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     )
       AND deleted_at IS NULL`,
    [
      keys.map((key) => key[0]),
      keys.map((key) => key[1]),
      keys.map((key) => key[2])
    ]
  );
  const existing = new Map(
    result.rows.map((row) => [
      recordKey(row.source_table, row.source_row_id, row.gemini_document_id),
      row
    ])
  );

  return records.filter((record) => {
    const row = existing.get(recordKey(record.sourceTable, record.sourceRowId, record.geminiDocumentId));

    return (
      !row
      || stringValue(row.content_hash) !== record.contentHash
      || stringValue(row.sync_status) === "pending"
      || stringValue(row.sync_status) === "failed"
    );
  });
}

export async function importAgentSearchDocuments({
  accessToken,
  config,
  documents,
  fetchImpl = fetch
}: {
  accessToken: string;
  config: GeminiEnterpriseSyncConfig;
  documents: AgentSearchDocumentRecord["document"][];
  fetchImpl?: typeof fetch;
}) {
  const response = await fetchImpl(importDocumentsUrl(config), {
    body: JSON.stringify({
      inlineSource: { documents },
      reconciliationMode: "INCREMENTAL"
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Goog-User-Project": config.projectId
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Gemini Enterprise Search import failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json() as { name?: string };
}

export async function upsertAgentSearchStatuses({
  pool,
  records,
  status,
  lastError,
  operationName
}: {
  pool: pg.Pool;
  records: AgentSearchDocumentRecord[];
  status: "failed" | "import_requested" | "synced";
  lastError: string;
  operationName: string;
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const record of records) {
      await client.query(
        `INSERT INTO agent_search_documents (
          class_id,
          teacher_id,
          professor_id,
          material_id,
          source_table,
          source_row_id,
          gemini_document_id,
          gemini_chunk_id,
          chunk_type,
          page_number,
          content_hash,
          sync_status,
          indexed_at,
          last_error,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, now(), $12, now()
        )
        ON CONFLICT (source_table, source_row_id, gemini_document_id) DO UPDATE SET
          class_id = EXCLUDED.class_id,
          teacher_id = EXCLUDED.teacher_id,
          professor_id = EXCLUDED.professor_id,
          material_id = EXCLUDED.material_id,
          chunk_type = EXCLUDED.chunk_type,
          page_number = EXCLUDED.page_number,
          content_hash = EXCLUDED.content_hash,
          sync_status = EXCLUDED.sync_status,
          indexed_at = EXCLUDED.indexed_at,
          deleted_at = NULL,
          last_error = EXCLUDED.last_error,
          updated_at = now()`,
        [
          record.classId,
          record.teacherId,
          record.professorId,
          record.materialId,
          record.sourceTable,
          record.sourceRowId,
          record.geminiDocumentId,
          record.chunkType,
          record.pageNumber,
          record.contentHash,
          status,
          [operationName, lastError].filter(Boolean).join(" ")
        ]
      );
    }

    await client.query("COMMIT");
  } catch (caughtError) {
    await client.query("ROLLBACK").catch(() => {});
    throw caughtError;
  } finally {
    client.release();
  }
}

export function importDocumentsUrl(config: GeminiEnterpriseSyncConfig) {
  const host = config.location === "global"
    ? "discoveryengine.googleapis.com"
    : `${config.location}-discoveryengine.googleapis.com`;
  const branch = [
    `projects/${config.projectId}`,
    `locations/${config.location}`,
    `collections/${config.collectionId}`,
    `dataStores/${config.dataStoreId}`,
    "branches/default_branch"
  ].join("/");

  return `https://${host}/v1beta/${branch}/documents:import`;
}

function stableGeminiDocumentId({
  materialId,
  pageNumber,
  sourceRowId
}: {
  materialId: string;
  pageNumber: number;
  sourceRowId: string;
}) {
  return createHash("sha256")
    .update(["pdf_pages", materialId, pageNumber, sourceRowId].join(":"))
    .digest("hex")
    .slice(0, 48);
}

function defaultPostgresPool() {
  const databaseUrl =
    process.env.DATABASE_URL?.trim()
    || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
    || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
    || "";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL is required.");
  }

  return new Pool({
    connectionString: databaseUrl,
    max: 1,
    ssl: readPostgresSslConfig(databaseUrl)
  });
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

async function getGoogleAccessToken() {
  const credentials = getGoogleCredentials();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: [cloudPlatformScope]
  });
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Google auth did not return an access token.");
  }

  return token;
}

function getGoogleCredentials() {
  const serviceAccountJson =
    process.env.GEMINI_ENTERPRISE_SERVICE_ACCOUNT_JSON
    ?? process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    ?? process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);

    return {
      client_email: serviceAccount.client_email ?? serviceAccount.clientEmail,
      private_key: (serviceAccount.private_key ?? serviceAccount.privateKey)?.replace(/\\n/g, "\n"),
      project_id: serviceAccount.project_id ?? serviceAccount.projectId
    };
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY ?? process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.GEMINI_ENTERPRISE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;

  if (!clientEmail || !privateKey || !projectId) {
    return undefined;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    project_id: projectId
  };
}

function recordKey(sourceTable: unknown, sourceRowId: unknown, geminiDocumentId: unknown) {
  return [sourceTable, sourceRowId, geminiDocumentId].map(stringValue).join("\n");
}

function chunks<T>(values: T[], size: number) {
  const batches: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
}

function isFalseyEnv(value: string | undefined) {
  return /^(0|false|no|off)$/i.test(String(value ?? "").trim());
}

function inferChunkType(content: string): AgentSearchChunkType {
  if (/\bworked example\b|\bexample\s+\d+/i.test(content)) {
    return "example";
  }
  if (/\bdefinition\b|\bdefine\b/i.test(content)) {
    return "definition";
  }
  if (/\bformula\b|\\(?:frac|sum|int|sqrt)|[=≤≥]/i.test(content)) {
    return "formula";
  }
  if (/\btable\s+\d+/i.test(content)) {
    return "table";
  }
  if (/\bfigure\s+\d+|\bcaption\b/i.test(content)) {
    return "caption";
  }
  if (/\bsection\s+\d+(?:\.\d+)*/i.test(content)) {
    return "section";
  }
  return "page";
}

function normalizeProblemNumbers(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

function integerValue(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
