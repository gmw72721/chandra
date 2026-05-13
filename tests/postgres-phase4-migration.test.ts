import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("AI usage writes use Postgres usage tables with Firestore fallback", () => {
  const usage = source("frontend/lib/ai-usage-limits.ts");
  const data = source("frontend/lib/data/usage.ts");

  assert.match(usage, /reserveAiUsagePostgres/);
  assert.match(usage, /finalizeAiUsagePostgres/);
  assert.match(usage, /adjustAiUsageReservationPostgres/);
  assert.match(usage, /upsertAiUsageAllowancePostgres/);
  assert.match(usage, /collection\("aiUsageReservations"\)/);
  assert.match(usage, /collection\("aiUsageEvents"\)/);
  assert.match(usage, /collection\("aiUsageBuckets"\)/);
  assert.match(data, /INSERT INTO ai_usage_reservations/);
  assert.match(data, /INSERT INTO ai_usage_events/);
  assert.match(data, /INSERT INTO ai_usage_buckets/);
  assert.match(data, /INSERT INTO ai_usage_request_buckets/);
  assert.match(data, /INSERT INTO ai_usage_allowances/);
});

test("rate limits, lockouts, audit logs, security events, and chat errors write Postgres-first", () => {
  const rateLimit = source("frontend/lib/firestore-rate-limit.ts");
  const lockout = source("frontend/lib/abuse-lockout.ts");
  const audit = source("frontend/lib/audit-log.ts");
  const operational = source("frontend/lib/data/operational.ts");

  assert.match(rateLimit, /checkRateLimitPostgres/);
  assert.match(rateLimit, /collection\("rateLimits"\)/);
  assert.match(lockout, /getAbuseLockoutPostgres/);
  assert.match(lockout, /recordAbuseFailurePostgres/);
  assert.match(lockout, /resetAbuseLockoutPostgres/);
  assert.match(lockout, /collection\("abuseLockouts"\)/);
  assert.match(audit, /writeAuditLogPostgres/);
  assert.match(audit, /writeSecurityEventPostgres/);
  assert.match(audit, /writeChatErrorReferencePostgres/);
  assert.match(audit, /collection\("auditLogs"\)/);
  assert.match(audit, /collection\("securityEvents"\)/);
  assert.match(audit, /collection\("chatErrorReferences"\)/);
  assert.match(operational, /INSERT INTO rate_limits/);
  assert.match(operational, /INSERT INTO abuse_lockouts/);
  assert.match(operational, /INSERT INTO audit_logs/);
  assert.match(operational, /INSERT INTO security_events/);
  assert.match(operational, /INSERT INTO chat_error_references/);
});

test("health check reports Postgres, Firebase Admin/Auth, Storage, and PDF OCR table status", () => {
  const health = source("frontend/app/api/health/route.ts");

  assert.match(health, /checkPostgres/);
  assert.match(health, /queryPostgres\("SELECT 1"\)/);
  assert.match(health, /checkFirebaseAdmin/);
  assert.match(health, /adminAuth\.listUsers\(1\)/);
  assert.match(health, /checkFirebaseStorage/);
  assert.match(health, /adminStorage\.bucket\(\)\.getMetadata/);
  assert.match(health, /checkPdfOcrSearchTables/);
  assert.match(health, /to_regclass\('pdf_materials'\)/);
  assert.match(health, /to_regclass\('pdf_pages'\)/);
});

test("final architecture docs describe status, migrations, backfill, and remaining Firestore dependencies", () => {
  const docs = source("docs/DATA_ARCHITECTURE.md");

  assert.match(docs, /Postgres-first data model/);
  assert.match(docs, /Applying SQL Migrations/);
  assert.match(docs, /psql "\$DATABASE_URL" -f migrations\/001_pdf_ocr_metadata\.sql/);
  assert.match(docs, /Legacy Backfill Plan/);
  assert.match(docs, /Remaining Cleanup/);
  assert.match(docs, /userPresence/);
  assert.match(docs, /Firebase Storage\/GCS/);
});
