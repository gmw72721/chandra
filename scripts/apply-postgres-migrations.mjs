#!/usr/bin/env node
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationFiles = [
  "migrations/001_pdf_ocr_metadata.sql",
  "migrations/002_core_app_tables.sql"
];

loadDotEnvLocal();

const databaseUrl =
  process.env.DATABASE_URL?.trim()
  || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
  || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
  || "";

if (!databaseUrl) {
  console.log("[postgres-migrate] No Postgres URL configured; skipping migrations.");
  process.exit(0);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: readPostgresSslConfig(databaseUrl)
});

try {
  await withRetry(async () => {
    const client = await pool.connect();

    try {
      await client.query("SELECT pg_advisory_lock(hashtext('chandra_postgres_migrations'))");

      for (const migrationFile of migrationFiles) {
        const migrationPath = join(root, migrationFile);

        if (!existsSync(migrationPath)) {
          throw new Error(`${migrationFile} is missing.`);
        }

        console.log(`[postgres-migrate] applying ${migrationFile}`);
        await client.query(readFileSync(migrationPath, "utf8"));
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('chandra_postgres_migrations'))").catch(() => {});
      client.release();
    }
  });

  console.log("[postgres-migrate] migrations are up to date.");
} finally {
  await pool.end();
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

async function withRetry(callback) {
  const attempts = Number(process.env.POSTGRES_MIGRATION_ATTEMPTS || "30");
  const delayMs = Number(process.env.POSTGRES_MIGRATION_RETRY_MS || "500");
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callback();
    } catch (caughtError) {
      lastError = caughtError;

      if (attempt === attempts || !isRetryableConnectionError(caughtError)) {
        throw caughtError;
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isRetryableConnectionError(caughtError) {
  const code = caughtError && typeof caughtError === "object" ? caughtError.code : "";
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH";
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
