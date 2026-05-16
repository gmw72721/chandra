#!/usr/bin/env node
import { GoogleAuth } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";

loadDotEnvLocal();

const args = parseArgs(process.argv.slice(2));
const config = getGeminiEnterpriseConfig();
const body = buildCreateDataStoreBody();

if (args.dryRun) {
  console.log(`[agent-search-datastore] dry run: would create ${config.dataStoreId} in ${config.projectId}/${config.location}.`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

assertGeminiEnterpriseConfigured(config);

const accessToken = await getGoogleAccessToken();
const response = await fetch(createDataStoreUrl(config), {
  body: JSON.stringify(body),
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Goog-User-Project": config.projectId
  },
  method: "POST"
});

if (!response.ok) {
  throw new Error(`Gemini Enterprise Search data store create failed with HTTP ${response.status}: ${await response.text()}`);
}

const payload = await response.json();
console.log(`[agent-search-datastore] create requested: ${payload.name ?? "(operation name unavailable)"}`);

function buildCreateDataStoreBody() {
  return {
    contentConfig: "CONTENT_REQUIRED",
    displayName: args.displayName || "Chandra Course Materials",
    documentProcessingConfig: {
      chunkingConfig: {
        layoutBasedChunkingConfig: {
          chunkSize: args.chunkSize,
          includeAncestorHeadings: true
        }
      },
      defaultParsingConfig: {
        layoutParsingConfig: {}
      }
    },
    industryVertical: "GENERIC",
    solutionTypes: ["SOLUTION_TYPE_SEARCH"]
  };
}

function createDataStoreUrl(config) {
  const host = config.location === "global"
    ? "discoveryengine.googleapis.com"
    : `${config.location}-discoveryengine.googleapis.com`;
  const parent = [
    `projects/${config.projectId}`,
    `locations/${config.location}`,
    `collections/${config.collectionId}`
  ].join("/");

  return `https://${host}/v1alpha/${parent}/dataStores?dataStoreId=${encodeURIComponent(config.dataStoreId)}`;
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

function parseArgs(rawArgs) {
  const parsed = {
    chunkSize: 500,
    displayName: "",
    dryRun: true
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--apply") {
      parsed.dryRun = false;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--display-name") {
      parsed.displayName = stringValue(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--chunk-size") {
      parsed.chunkSize = Number(rawArgs[index + 1] || "500");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.chunkSize) || parsed.chunkSize < 100 || parsed.chunkSize > 500) {
    throw new Error("--chunk-size must be an integer from 100 to 500.");
  }

  return parsed;
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

function stringValue(value) {
  return String(value ?? "").trim();
}
