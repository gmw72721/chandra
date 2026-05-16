#!/usr/bin/env node
import pg from "pg";
import { GoogleAuth } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pdfPageToAgentSearchDocument } from "../frontend/lib/gemini-enterprise-sync.ts";

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const maxInlineDocumentsPerImport = 100;

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
  const pages = await readPendingPdfPages();
  const records = pages
    .map((page) => ({ page, record: pdfPageToAgentSearchDocument(page) }))
    .filter(({ page, record }) => record !== null && shouldSyncPage(page, record))
    .map(({ record }) => record)
    .filter((record) => record !== null);

  console.log(
    `[agent-search-sync] ${args.dryRun ? "dry run: " : ""}prepared ${records.length} searchable documents from ${pages.length} pdf_pages rows.`
  );

  if (records.length && args.dryRun) {
    for (const record of records.slice(0, 3)) {
      console.log(
        `[agent-search-sync] sample ${record.geminiDocumentId} material=${record.materialId} page=${record.pageNumber} chunk=${record.chunkType}`
      );
    }
    console.log("[agent-search-sync] pass --apply to import documents and write agent_search_documents status rows.");
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
        console.log(`[agent-search-sync] requested import for ${batch.length} documents (${importedCount}/${records.length}).`);
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

    console.log(`[agent-search-sync] import requested for ${importedCount} documents.`);
  }
} finally {
  await pool.end().catch(() => {});
}

async function readPendingPdfPages() {
  const limit = Math.max(1, Math.min(args.limit, 5000));
  const params = [limit];
  const filters = [
    "p.ocr_text <> ''"
  ];

  if (args.classId) {
    params.push(args.classId);
    filters.push(`p.class_id = $${params.length}`);
  }

  if (args.materialId) {
    params.push(args.materialId);
    filters.push(`p.material_id = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT
      p.id,
      p.class_id,
      p.teacher_id,
      p.professor_id,
      p.material_id,
      p.material_type,
      p.ocr_text,
      p.page_number,
      p.page_start,
      p.page_asset_uri,
      p.page_asset_mime_type,
      p.page_asset_size,
      p.page_asset_sha256,
      p.page_asset_size_bytes,
      p.page_asset_checksum_sha256,
      p.title,
      dp.problem_numbers,
      asd.content_hash AS synced_content_hash,
      asd.sync_status AS synced_status
    FROM pdf_pages p
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT problem_number, ',') AS problem_numbers
      FROM pdf_detected_problems
      WHERE page_id = p.id
    ) dp ON TRUE
    LEFT JOIN LATERAL (
      SELECT content_hash, sync_status
      FROM agent_search_documents
      WHERE source_table = 'pdf_pages'
        AND source_row_id = p.id::text
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    ) asd ON TRUE
    WHERE ${filters.join("\n      AND ")}
    ORDER BY p.class_id ASC, p.material_id ASC, p.page_number ASC
    LIMIT $1`,
    params
  );

  return result.rows;
}

function shouldSyncPage(page, record) {
  const syncedHash = stringValue(page.synced_content_hash);
  const syncedStatus = stringValue(page.synced_status);

  return !syncedHash || syncedHash !== record.contentHash || syncedStatus === "pending" || syncedStatus === "failed";
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
    throw new Error(`Gemini Enterprise Search import failed with HTTP ${response.status}: ${await response.text()}`);
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

function chunks(values, size) {
  const batches = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
}

function stringValue(value) {
  return String(value ?? "").trim();
}
