#!/usr/bin/env node
import pg from "pg";
import { GoogleAuth } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";

loadDotEnvLocal();

const args = parseArgs(process.argv.slice(2));
const config = getGeminiEnterpriseConfig();
assertGeminiEnterpriseConfigured(config);

let lastReady = false;
const startedAt = Date.now();

do {
  lastReady = await runReadinessCheck();

  if (!args.wait || lastReady) {
    break;
  }

  if (Date.now() - startedAt >= args.timeoutMs) {
    break;
  }

  await sleep(args.intervalMs);
} while (true);

if (args.strict && !lastReady) {
  process.exitCode = 1;
}

async function runReadinessCheck() {
  const accessToken = await getGoogleAccessToken();
  const [ledgerSummary, documentsResponse] = await Promise.all([
    readLedgerSummary().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    listDocuments({ accessToken, config, pageSize: args.pageSize }),
  ]);

  printLedgerSummary(ledgerSummary);

  const documents = Array.isArray(documentsResponse.documents) ? documentsResponse.documents : [];
  const documentSummary = summarizeDocuments(documents);
  printDocumentSummary({ documents, documentSummary });

  const searchContext = chooseSearchContext({ documents, classId: args.classId, professorId: args.professorId });
  const searchResponse = await searchDataStore({
    accessToken,
    config,
    filter: searchContext.filter,
    pageSize: args.topK,
    query: args.query,
  });
  const searchResults = Array.isArray(searchResponse.results) ? searchResponse.results : [];
  printSearchSummary({ searchContext, searchResponse, searchResults });

  const ready = documentSummary.readyCount > 0 && searchResults.length > 0;
  console.log(`[agent-search-ready] demo_ready=${ready ? "yes" : "no"}`);
  if (!ready && args.wait) {
    console.log(`[agent-search-ready] waiting ${args.intervalMs}ms before checking again...`);
  }

  return ready;
}

async function readLedgerSummary() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    return { skipped: "DATABASE_URL is not configured." };
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: readPositiveIntegerEnv("POSTGRES_SYNC_CONNECTION_TIMEOUT_MS", 5000),
    max: 1,
    query_timeout: readPositiveIntegerEnv("POSTGRES_SYNC_QUERY_TIMEOUT_MS", 30000),
    ssl: readPostgresSslConfig(databaseUrl),
  });

  try {
    const result = await pool.query(
      `SELECT sync_status, count(*)::int AS count
       FROM agent_search_documents
       WHERE deleted_at IS NULL
       GROUP BY sync_status
       ORDER BY sync_status ASC`
    );
    const recentResult = await pool.query(
      `SELECT material_id, source_table, source_row_id, gemini_document_id, sync_status, last_error
       FROM agent_search_documents
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 5`
    );

    return { rows: result.rows, recentRows: recentResult.rows };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function listDocuments({ accessToken, config, pageSize }) {
  const response = await fetch(`${documentsUrl(config)}?pageSize=${encodeURIComponent(String(pageSize))}`, {
    headers: authHeaders({ accessToken, projectId: config.projectId }),
  });

  if (!response.ok) {
    throw new Error(`Gemini Enterprise Search document list failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function searchDataStore({ accessToken, config, filter, pageSize, query }) {
  const payload = {
    query,
    pageSize,
    contentSearchSpec: {
      searchResultMode: "CHUNKS",
      chunkSpec: {
        numPreviousChunks: 1,
        numNextChunks: 1,
      },
      snippetSpec: {
        returnSnippet: true,
      },
    },
  };

  if (filter) {
    payload.filter = filter;
  }

  const response = await fetch(searchUrl(config), {
    body: JSON.stringify(payload),
    headers: {
      ...authHeaders({ accessToken, projectId: config.projectId }),
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Gemini Enterprise Search sample query failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

function printLedgerSummary(summary) {
  if (summary.error) {
    console.log(`[agent-search-ready] ledger unavailable: ${summary.error}`);
    return;
  }

  if (summary.skipped) {
    console.log(`[agent-search-ready] ledger skipped: ${summary.skipped}`);
    return;
  }

  const statusText = summary.rows.length
    ? summary.rows.map((row) => `${row.sync_status || "unknown"}=${row.count}`).join(", ")
    : "no rows";
  console.log(`[agent-search-ready] ledger ${statusText}`);
}

function printDocumentSummary({ documents, documentSummary }) {
  console.log(
    `[agent-search-ready] datastore documents=${documents.length} ready=${documentSummary.readyCount} pending=${documentSummary.pendingCount} error=${documentSummary.errorCount}`
  );

  for (const document of documents.slice(0, args.verbose ? args.pageSize : 8)) {
    const structData = readStructData(document);
    const status = readIndexStatus(document);
    const title = stringValue(structData.title || document.id || document.name || "untitled");
    const materialId = stringValue(structData.material_id || "");
    const message = status.message ? ` ${status.message}` : "";
    console.log(
      `[agent-search-ready] doc ${status.state} title="${truncate(title, 58)}" material=${materialId || "-"}${message}`
    );
  }
}

function printSearchSummary({ searchContext, searchResponse, searchResults }) {
  const semanticState = stringValue(searchResponse.summary?.summarySkippedReasons?.join(", ") || searchResponse.semanticState || "");
  const filterText = searchContext.filter ? ` filter=${searchContext.filter}` : " filter=<none>";
  console.log(`[agent-search-ready] sample query="${args.query}" results=${searchResults.length}${filterText}`);
  if (semanticState) {
    console.log(`[agent-search-ready] search state=${semanticState}`);
  }

  for (const result of searchResults.slice(0, 3)) {
    const source = normalizeSearchResult(result);
    console.log(
      `[agent-search-ready] result title="${truncate(source.title, 58)}" material=${source.materialId || "-"} page=${source.pageNumber || "-"} chunk=${source.chunkType || "-"}`
    );
  }
}

function summarizeDocuments(documents) {
  return documents.reduce(
    (summary, document) => {
      const status = readIndexStatus(document);
      if (status.state === "error") {
        summary.errorCount += 1;
      } else if (status.state === "pending") {
        summary.pendingCount += 1;
      } else {
        summary.readyCount += 1;
      }
      return summary;
    },
    { errorCount: 0, pendingCount: 0, readyCount: 0 }
  );
}

function readIndexStatus(document) {
  const indexStatus = document.indexStatus && typeof document.indexStatus === "object" ? document.indexStatus : {};
  const pendingMessage = stringValue(indexStatus.pendingMessage || indexStatus.pending_message);
  const errorMessage = stringValue(indexStatus.errorMessage || indexStatus.error_message || indexStatus.error);

  if (errorMessage) {
    return { message: truncate(errorMessage, 120), state: "error" };
  }

  if (pendingMessage) {
    return { message: truncate(pendingMessage, 120), state: "pending" };
  }

  return { message: "", state: "ready" };
}

function chooseSearchContext({ documents, classId, professorId }) {
  const explicitClassId = stringValue(classId);
  const explicitProfessorId = stringValue(professorId);
  if (explicitClassId && explicitProfessorId) {
    return { filter: buildCourseMaterialFilter({ classId: explicitClassId, professorId: explicitProfessorId }) };
  }

  const indexedDocument = documents.find((document) => {
    const status = readIndexStatus(document);
    const structData = readStructData(document);
    return (
      status.state === "ready"
      && stringValue(structData.class_id)
      && stringValue(structData.professor_id || structData.teacher_id)
    );
  }) || documents.find((document) => {
    const structData = readStructData(document);
    return stringValue(structData.class_id) && stringValue(structData.professor_id || structData.teacher_id);
  });

  if (!indexedDocument) {
    return { filter: "" };
  }

  const structData = readStructData(indexedDocument);
  return {
    filter: buildCourseMaterialFilter({
      classId: stringValue(structData.class_id),
      professorId: stringValue(structData.professor_id || structData.teacher_id),
    }),
  };
}

function buildCourseMaterialFilter({ classId, professorId }) {
  return [
    textAnyFilter("class_id", classId),
    `(${textAnyFilter("teacher_id", professorId)} OR ${textAnyFilter("professor_id", professorId)})`,
    'active_for_students = "true"',
    'teacher_only = "false"',
  ].filter(Boolean).join(" AND ");
}

function textAnyFilter(field, value) {
  const normalized = stringValue(value);
  return normalized ? `${field}: ANY(${JSON.stringify(normalized)})` : "";
}

function normalizeSearchResult(result) {
  const document = result.document && typeof result.document === "object" ? result.document : {};
  const chunk = result.chunk && typeof result.chunk === "object" ? result.chunk : {};
  const documentMetadata = chunk.documentMetadata && typeof chunk.documentMetadata === "object" ? chunk.documentMetadata : {};
  const pageSpan = chunk.pageSpan && typeof chunk.pageSpan === "object" ? chunk.pageSpan : {};
  const structData = {
    ...readStructData(document),
    ...readStructData(documentMetadata),
    ...(chunk.structData && typeof chunk.structData === "object" ? chunk.structData : {}),
  };
  const derived = document.derivedStructData && typeof document.derivedStructData === "object" ? document.derivedStructData : {};

  return {
    chunkType: stringValue(structData.chunk_type || structData.chunkType),
    materialId: stringValue(structData.material_id || structData.materialId),
    pageNumber: stringValue(structData.page_number || structData.pageNumber || pageSpan.pageStart),
    title: stringValue(structData.title || documentMetadata.title || derived.title || document.id || result.id || "Class material"),
  };
}

function readStructData(document) {
  return document.structData && typeof document.structData === "object" ? document.structData : {};
}

async function getGoogleAccessToken() {
  const credentials = getGoogleCredentials();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: [cloudPlatformScope],
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
      project_id: serviceAccount.project_id ?? serviceAccount.projectId,
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
    project_id: projectId,
  };
}

function getGeminiEnterpriseConfig() {
  return {
    collectionId: process.env.GEMINI_ENTERPRISE_COLLECTION_ID?.trim() || "default_collection",
    dataStoreId: process.env.GEMINI_ENTERPRISE_DATA_STORE_ID?.trim() || "",
    location: process.env.GEMINI_ENTERPRISE_LOCATION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim() || "global",
    projectId: process.env.GEMINI_ENTERPRISE_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "",
    servingConfigId: process.env.GEMINI_ENTERPRISE_SERVING_CONFIG_ID?.trim() || "default_search",
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

function documentsUrl(config) {
  return `${apiBaseUrl(config)}/v1beta/${branchPath(config)}/documents`;
}

function searchUrl(config) {
  return `${apiBaseUrl(config)}/v1beta/${servingConfigPath(config)}:search`;
}

function apiBaseUrl(config) {
  return config.location === "global"
    ? "https://discoveryengine.googleapis.com"
    : `https://${config.location}-discoveryengine.googleapis.com`;
}

function branchPath(config) {
  return [
    `projects/${config.projectId}`,
    `locations/${config.location}`,
    `collections/${config.collectionId}`,
    `dataStores/${config.dataStoreId}`,
    "branches/default_branch",
  ].join("/");
}

function servingConfigPath(config) {
  return [
    `projects/${config.projectId}`,
    `locations/${config.location}`,
    `collections/${config.collectionId}`,
    `dataStores/${config.dataStoreId}`,
    `servingConfigs/${config.servingConfigId}`,
  ].join("/");
}

function authHeaders({ accessToken, projectId }) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Goog-User-Project": projectId,
  };
}

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL?.trim()
    || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
    || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
    || ""
  );
}

function readPostgresSslConfig(databaseUrl) {
  if (process.env.POSTGRES_SSL?.toLowerCase() === "true") {
    return { rejectUnauthorized: false };
  }

  if (/localhost|127\.0\.0\.1|cloudsql|sslmode=disable/.test(databaseUrl)) {
    return false;
  }

  return undefined;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseArgs(rawArgs) {
  const parsed = {
    classId: "",
    intervalMs: 30000,
    pageSize: 20,
    professorId: "",
    query: "worked example formula method",
    strict: false,
    timeoutMs: 600000,
    topK: 5,
    verbose: false,
    wait: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--class-id") {
      parsed.classId = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--interval-ms") {
      parsed.intervalMs = Number(rawArgs[index + 1] || "");
      index += 1;
    } else if (arg === "--page-size") {
      parsed.pageSize = Number(rawArgs[index + 1] || "");
      index += 1;
    } else if (arg === "--professor-id") {
      parsed.professorId = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--query") {
      parsed.query = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--strict") {
      parsed.strict = true;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(rawArgs[index + 1] || "");
      index += 1;
    } else if (arg === "--top-k") {
      parsed.topK = Number(rawArgs[index + 1] || "");
      index += 1;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--wait") {
      parsed.wait = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const numericName of ["intervalMs", "pageSize", "timeoutMs", "topK"]) {
    if (!Number.isInteger(parsed[numericName]) || parsed[numericName] <= 0) {
      throw new Error(`--${kebabCase(numericName)} must be a positive integer.`);
    }
  }

  return parsed;
}

function loadDotEnvLocal() {
  for (const filePath of [resolve(root, ".env.local"), resolve(root, "frontend/.env.local")]) {
    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function truncate(value, maxLength) {
  const text = stringValue(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
