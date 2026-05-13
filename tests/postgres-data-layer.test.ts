import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("core app PostgreSQL migration exists and defines phase 1 tables", () => {
  const migrationPath = join(repoRoot, "migrations/002_core_app_tables.sql");

  assert.equal(existsSync(migrationPath), true);

  const migration = readFileSync(migrationPath, "utf8");
  const tableNames = [
    "accounts",
    "classes",
    "class_enrollments",
    "co_teachers",
    "materials",
    "material_jobs",
    "material_upload_sessions",
    "conversations",
    "messages",
    "message_attachments",
    "student_feedback",
    "student_learning_profiles",
    "learning_profile_revisions",
    "conversation_reviews",
    "student_support",
    "ai_usage_reservations",
    "ai_usage_events",
    "ai_usage_buckets",
    "ai_usage_request_buckets",
    "ai_usage_allowances",
    "audit_logs",
    "security_events",
    "chat_error_references",
    "rate_limits",
    "abuse_lockouts"
  ];

  for (const tableName of tableNames) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(`));
  }

  assert.match(migration, /firebase_uid TEXT NOT NULL UNIQUE/);
  assert.match(migration, /teacher_id TEXT NOT NULL REFERENCES accounts\(id\)/);
  assert.match(migration, /class_id TEXT NOT NULL REFERENCES classes\(id\)/);
  assert.match(migration, /conversation_id TEXT NOT NULL REFERENCES conversations\(id\)/);
  assert.match(migration, /metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
});

test("core migration keeps PDF OCR tables and relates them to app tables", () => {
  const migration = readFileSync(join(repoRoot, "migrations/002_core_app_tables.sql"), "utf8");
  const pdfMigration = readFileSync(join(repoRoot, "migrations/001_pdf_ocr_metadata.sql"), "utf8");

  assert.match(pdfMigration, /CREATE TABLE IF NOT EXISTS pdf_materials/);
  assert.doesNotMatch(migration, /DROP TABLE.*pdf_materials/i);
  assert.match(migration, /to_regclass\('pdf_materials'\)/);
  assert.match(migration, /material_id is intentionally named to align with materials\.id/);
  assert.match(migration, /Intended to align with classes\.id/);
  assert.match(migration, /Future validated constraints after Postgres material\/class backfill/);
});

test("shared Postgres data layer uses the Cloud SQL pg configuration path", () => {
  const postgresSource = readFileSync(join(repoRoot, "frontend/lib/data/postgres.ts"), "utf8");
  const modulePaths = [
    "frontend/lib/data/accounts.ts",
	    "frontend/lib/data/classes.ts",
	    "frontend/lib/data/materials.ts",
	    "frontend/lib/data/conversations.ts",
	    "frontend/lib/data/student-records.ts",
	    "frontend/lib/data/usage.ts",
	    "frontend/lib/data/operational.ts"
	  ];

  assert.match(postgresSource, /from "pg"/);
  assert.match(postgresSource, /new Pool/);
  assert.match(postgresSource, /DATABASE_URL/);
  assert.match(postgresSource, /CLOUD_SQL_POSTGRES_URL/);
  assert.match(postgresSource, /CHANDRA_CLOUD_SQL_POSTGRES_URL/);
  assert.match(postgresSource, /CLOUD_SQL_POSTGRES_SSL_MODE/);
  assert.match(postgresSource, /CLOUD_SQL_POSTGRES_POOL_MAX/);
  assert.match(postgresSource, /POSTGRES_FIRESTORE_FALLBACK/);
  assert.match(postgresSource, /return false;/);
  assert.match(postgresSource, /Production Postgres must not point at localhost/);
  assert.match(postgresSource, /withPostgresTransaction/);

  for (const modulePath of modulePaths) {
    const source = readFileSync(join(repoRoot, modulePath), "utf8");
    assert.match(source, /runPostgresQuery|withPostgresTransaction|PostgresQueryClient/);
    assert.doesNotMatch(source, /firebase-admin\/firestore|firebase\/firestore|adminDb|collection\(/);
  }
});

test("documentation and env examples describe the target data split", () => {
  const docs = readFileSync(join(repoRoot, "docs/DATA_ARCHITECTURE.md"), "utf8");
  const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const configEnvExample = readFileSync(join(repoRoot, "config/env.example"), "utf8");

  assert.match(docs, /Firebase Auth remains the identity provider/);
  assert.match(docs, /Firebase Storage and GCS remain the file\/object store/);
  assert.match(docs, /Postgres and Cloud SQL become the source of truth/);
  assert.match(docs, /Firestore remains available as a legacy fallback/);
  assert.match(envExample, /DATABASE_URL=/);
  assert.match(envExample, /CLOUD_SQL_POSTGRES_URL=/);
  assert.match(configEnvExample, /CHANDRA_CLOUD_SQL_POSTGRES_URL=/);
  assert.match(configEnvExample, /CLOUD_SQL_POSTGRES_POOL_MAX=/);
  assert.match(configEnvExample, /POSTGRES_FIRESTORE_FALLBACK=/);
});
