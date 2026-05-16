#!/usr/bin/env node
import { createHash } from "node:crypto";
import pg from "pg";
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";
import { PDFDocument } from "pdf-lib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const maxInlineDocumentsPerImport = 100;
const maxGeminiContentBytes = 200_000_000;
const targetSplitPartBytes = 180_000_000;

loadDotEnvLocal();

const args = parseArgs(process.argv.slice(2));
const databaseUrl = getDatabaseUrl();
const config = getGeminiEnterpriseConfig();
const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: readPositiveIntegerEnv("POSTGRES_SYNC_CONNECTION_TIMEOUT_MS", 5000),
  max: 1,
  query_timeout: readPositiveIntegerEnv("POSTGRES_SYNC_QUERY_TIMEOUT_MS", 30000),
  ssl: readPostgresSslConfig(databaseUrl)
});

try {
  const materials = await readPendingPdfMaterials();
  const preparedRecords = (
    await Promise.all(materials.map((material) => pdfMaterialToGeminiDocuments(material, { dryRun: args.dryRun })))
  )
    .flat()
    .filter((record) => record !== null);
  const records = await filterRecordsNeedingSync(preparedRecords);

  console.log(
    `[agent-search-pdf-sync] ${args.dryRun ? "dry run: " : ""}prepared ${records.length} PDF documents from ${materials.length} pdf_materials rows.`
  );

  if (records.length && args.dryRun) {
    for (const record of records.slice(0, 3)) {
      console.log(
        `[agent-search-pdf-sync] sample ${record.geminiDocumentId} material=${record.materialId} uri=${redactGcsUri(record.sourceUri)}`
      );
    }
    console.log("[agent-search-pdf-sync] pass --apply to import source PDFs and write agent_search_documents status rows.");
  } else if (records.length) {
    assertGeminiEnterpriseConfigured(config);
    const accessToken = await getGoogleAccessToken();
    let importedCount = 0;

    for (const batch of chunks(records, maxInlineDocumentsPerImport)) {
      try {
        const operation = await importDocuments({
          accessToken,
          config,
          documents: batch.map((record) => record.document)
        });
        await upsertAgentSearchStatuses({
          records: batch,
          status: "import_requested",
          lastError: "",
          operationName: stringValue(operation.name)
        });
        importedCount += batch.length;
        console.log(`[agent-search-pdf-sync] requested import for ${batch.length} PDFs (${importedCount}/${records.length}).`);
      } catch (caughtError) {
        await upsertAgentSearchStatuses({
          records: batch,
          status: "failed",
          lastError: caughtError instanceof Error ? caughtError.message : String(caughtError),
          operationName: ""
        });
        throw caughtError;
      }
    }

    console.log(`[agent-search-pdf-sync] import requested for ${importedCount} PDFs.`);
  }
} finally {
  await pool.end().catch(() => {});
}

async function readPendingPdfMaterials() {
  const limit = Math.max(1, Math.min(args.limit, 5000));
  const params = [limit];
  const filters = [
    "(NULLIF(pm.full_pdf_uri, '') IS NOT NULL OR NULLIF(pm.storage_uri, '') IS NOT NULL)"
  ];

  if (args.classId) {
    params.push(args.classId);
    filters.push(`pm.class_id = $${params.length}`);
  }

  if (args.materialId) {
    params.push(args.materialId);
    filters.push(`pm.material_id = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT
      pm.material_id,
      pm.class_id,
      pm.teacher_id,
      pm.professor_id,
      pm.title,
      pm.material_type,
      pm.content_type,
      pm.file_name,
      pm.full_pdf_uri,
      pm.storage_uri,
      pm.full_pdf_size,
      pm.full_pdf_sha256,
      pm.page_count,
      pm.updated_at
    FROM pdf_materials pm
    WHERE ${filters.join("\n      AND ")}
    ORDER BY pm.class_id ASC, pm.material_id ASC
    LIMIT $1`,
    params
  );

  return result.rows;
}

async function pdfMaterialToGeminiDocuments(material, { dryRun }) {
  const classId = stringValue(material.class_id);
  const teacherId = stringValue(material.teacher_id || material.professor_id);
  const professorId = stringValue(material.professor_id || teacherId);
  const materialId = stringValue(material.material_id);
  const sourceUri = stringValue(material.full_pdf_uri || material.storage_uri);

  if (!classId || !teacherId || !professorId || !materialId || !sourceUri.startsWith("gs://")) {
    return [];
  }

  const title = stringValue(material.title) || "Untitled PDF";
  const sourceSignature = [
    sourceUri,
    stringValue(material.full_pdf_sha256),
    stringValue(material.full_pdf_size),
    stringValue(material.updated_at)
  ].join("|");
  const contentHash = createHash("sha256").update(sourceSignature).digest("hex");
  const fullPdfSize = Number(material.full_pdf_size || 0);

  if (fullPdfSize > maxGeminiContentBytes) {
    const pageCount = Number(material.page_count || 0);
    const partCount = Math.max(2, Math.ceil(fullPdfSize / targetSplitPartBytes));
    const splitParts = dryRun
      ? dryRunSplitParts({ material, partCount, sourceUri, contentHash })
      : await ensureSplitPdfParts({ material, partCount, sourceUri, contentHash });

    return splitParts.map((part) => documentRecordForMaterial({
      classId,
      contentHash: `${contentHash}:part:${part.partNumber}:${part.pageStart}-${part.pageEnd}`,
      fileName: stringValue(material.file_name),
      material,
      materialId,
      pageEnd: part.pageEnd,
      pageNumber: part.pageStart,
      partCount,
      partNumber: part.partNumber,
      professorId,
      sourceRowId: `${materialId}:part:${part.partNumber}`,
      sourceUri: part.uri,
      teacherId,
      title: `${title} (part ${part.partNumber} of ${partCount})`,
    }));
  }

  return [
    documentRecordForMaterial({
      classId,
      contentHash,
      fileName: stringValue(material.file_name),
      material,
      materialId,
      pageEnd: null,
      pageNumber: null,
      partCount: 1,
      partNumber: 1,
      professorId,
      sourceRowId: materialId,
      sourceUri,
      teacherId,
      title,
    })
  ];
}

function documentRecordForMaterial({
  classId,
  contentHash,
  fileName,
  material,
  materialId,
  pageEnd,
  pageNumber,
  partCount,
  partNumber,
  professorId,
  sourceRowId,
  sourceUri,
  teacherId,
  title,
}) {
  const geminiDocumentId = stableGeminiDocumentId({ materialId, sourceUri });

  return {
    classId,
    contentHash,
    geminiDocumentId,
    materialId,
    pageNumber,
    professorId,
    sourceRowId,
    sourceTable: "pdf_materials",
    sourceUri,
    teacherId,
    document: {
      id: geminiDocumentId,
      structData: {
        active_for_students: true,
        chunk_type: "document",
        class_id: classId,
        file_name: fileName,
        material_id: materialId,
        material_type: stringValue(material.material_type),
        page_end: pageEnd,
        page_number: pageNumber,
        page_start: pageNumber,
        part_count: partCount,
        part_number: partNumber,
        professor_id: professorId,
        source_row_id: sourceRowId,
        source_table: "pdf_materials",
        teacher_id: teacherId,
        teacher_only: false,
        title
      },
      content: {
        mimeType: "application/pdf",
        uri: sourceUri
      }
    }
  };
}

async function filterRecordsNeedingSync(records) {
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
      keys.map((key) => key[2]),
    ]
  );
  const existing = new Map(
    result.rows.map((row) => [
      recordKey(row.source_table, row.source_row_id, row.gemini_document_id),
      row,
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

function recordKey(sourceTable, sourceRowId, geminiDocumentId) {
  return [sourceTable, sourceRowId, geminiDocumentId].join("\n");
}

function dryRunSplitParts({ material, partCount, sourceUri, contentHash }) {
  const pageCount = Number(material.page_count || 0);
  const ranges = splitPageRanges(pageCount || partCount, partCount);
  return ranges.map((range, index) => ({
    ...range,
    partNumber: index + 1,
    sizeBytes: 0,
    uri: splitPartUri({ sourceUri, contentHash, partCount, partNumber: index + 1 })
  }));
}

async function ensureSplitPdfParts({ material, partCount, sourceUri, contentHash }) {
  const { bucketName, objectName } = parseGcsUri(sourceUri);
  const storage = new Storage({ projectId: process.env.GEMINI_ENTERPRISE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT });
  const bucket = storage.bucket(bucketName);
  const [sourceBytes] = await bucket.file(objectName).download();
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const ranges = splitPageRanges(sourcePdf.getPageCount(), partCount);
  const parts = [];

  for (let index = 0; index < ranges.length; index += 1) {
    const partNumber = index + 1;
    const range = ranges[index];
    const outputUri = splitPartUri({ sourceUri, contentHash, partCount, partNumber });
    const { bucketName: outputBucketName, objectName: outputObjectName } = parseGcsUri(outputUri);
    const outputBucket = storage.bucket(outputBucketName);
    const outputFile = outputBucket.file(outputObjectName);
    const [exists] = await outputFile.exists();
    let sizeBytes = 0;

    if (exists) {
      const [metadata] = await outputFile.getMetadata();
      sizeBytes = Number(metadata.size || 0);
    } else {
      const partPdf = await PDFDocument.create();
      const pageIndexes = [];
      for (let pageIndex = range.pageStart - 1; pageIndex <= range.pageEnd - 1; pageIndex += 1) {
        pageIndexes.push(pageIndex);
      }
      const copiedPages = await partPdf.copyPages(sourcePdf, pageIndexes);
      for (const page of copiedPages) {
        partPdf.addPage(page);
      }
      const partBytes = await partPdf.save();
      sizeBytes = partBytes.byteLength;

      if (sizeBytes > maxGeminiContentBytes) {
        throw new Error(
          `Split part ${partNumber}/${partCount} for material ${material.material_id} is still too large for Gemini (${sizeBytes} bytes).`
        );
      }

      await outputFile.save(Buffer.from(partBytes), {
        contentType: "application/pdf",
        resumable: false,
        metadata: {
          metadata: {
            chandraMaterialId: stringValue(material.material_id),
            chandraSourceUri: sourceUri,
            chandraSplitPart: String(partNumber),
            chandraSplitPartCount: String(partCount),
          }
        }
      });
    }

    parts.push({
      ...range,
      partNumber,
      sizeBytes,
      uri: outputUri,
    });
  }

  return parts;
}

function splitPageRanges(pageCount, partCount) {
  const normalizedPageCount = Math.max(1, Number(pageCount || 1));
  const normalizedPartCount = Math.max(1, Math.min(Number(partCount || 1), normalizedPageCount));
  const ranges = [];

  for (let index = 0; index < normalizedPartCount; index += 1) {
    const pageStart = Math.floor((index * normalizedPageCount) / normalizedPartCount) + 1;
    const pageEnd = Math.floor(((index + 1) * normalizedPageCount) / normalizedPartCount);
    ranges.push({ pageStart, pageEnd });
  }

  return ranges;
}

function splitPartUri({ sourceUri, contentHash, partCount, partNumber }) {
  const { bucketName, objectName } = parseGcsUri(sourceUri);
  const lastSlash = objectName.lastIndexOf("/");
  const directory = lastSlash >= 0 ? objectName.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? objectName.slice(lastSlash + 1) : objectName;
  const safeBaseName = fileName.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  const splitObjectName = [
    directory,
    "agent-search-splits",
    contentHash.slice(0, 16),
    `${safeBaseName}-part-${partNumber}-of-${partCount}.pdf`,
  ].filter(Boolean).join("/");

  return `gs://${bucketName}/${splitObjectName}`;
}

function parseGcsUri(uri) {
  const match = stringValue(uri).match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS URI: ${uri}`);
  }
  return { bucketName: match[1], objectName: match[2] };
}

async function importDocuments({ accessToken, config, documents }) {
  const response = await fetch(importDocumentsUrl(config), {
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
    throw new Error(`Gemini Enterprise Search PDF import failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function upsertAgentSearchStatuses({ records, status, lastError, operationName }) {
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
          $1, $2, $3, $4, $5, $6, $7, NULL, 'document', NULL, $8, $9, now(), $10, now()
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

function getGeminiEnterpriseConfig() {
  return {
    collectionId: process.env.GEMINI_ENTERPRISE_COLLECTION_ID?.trim() || "default_collection",
    dataStoreId: process.env.GEMINI_ENTERPRISE_DATA_STORE_ID?.trim() || "",
    location: process.env.GEMINI_ENTERPRISE_LOCATION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim() || "global",
    projectId: process.env.GEMINI_ENTERPRISE_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || ""
  };
}

function assertGeminiEnterpriseConfigured(config) {
  const missing = Object.entries(config)
    .filter(([_key, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Missing Gemini Enterprise Search config: ${missing.join(", ")}.`);
  }
}

function importDocumentsUrl(config) {
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

function parseArgs(rawArgs) {
  const parsed = {
    classId: "",
    dryRun: true,
    limit: 100,
    materialId: ""
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--apply") {
      parsed.dryRun = false;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--class-id") {
      parsed.classId = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--material-id") {
      parsed.materialId = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--limit") {
      parsed.limit = Number(rawArgs[index + 1] || "100");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.limit) || parsed.limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }

  return parsed;
}

function getDatabaseUrl() {
  const databaseUrl =
    process.env.DATABASE_URL?.trim()
    || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
    || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
    || "";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL is required.");
  }

  return databaseUrl;
}

function loadDotEnvLocal() {
  const envPath = join(root, ".env.local");

  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function readPostgresSslConfig(connectionString) {
  const sslMode = process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() ?? "";

  if (sslMode === "disable" || connectionString.includes("sslmode=disable")) {
    return false;
  }

  if (sslMode === "require" || connectionString.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stableGeminiDocumentId({ materialId, sourceUri }) {
  return createHash("sha256")
    .update(["pdf_materials", materialId, sourceUri].join(":"))
    .digest("hex")
    .slice(0, 48);
}

function chunks(values, size) {
  const batches = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
}

function redactGcsUri(uri) {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return "<invalid-gcs-uri>";
  }
  return `gs://${match[1]}/.../${match[2].split("/").pop()}`;
}

function stringValue(value) {
  return String(value ?? "").trim();
}
