#!/usr/bin/env node
import pg from "pg";

const { Pool } = pg;

const tables = [
  "accounts",
  "classes",
  "class_enrollments",
  "co_teachers",
  "materials",
  "material_jobs",
  "conversations",
  "messages",
  "message_attachments",
  "student_feedback",
  "student_learning_profiles",
  "learning_profile_revisions",
  "conversation_reviews",
  "student_support",
  "audit_logs",
  "security_events",
  "chat_error_references"
];

const pool = new Pool({
  connectionString: getDatabaseUrl(),
  max: 1,
  ssl: false
});

try {
  for (const table of tables) {
    const result = await pool.query(`select count(*)::int as count from ${table}`);
    console.log(`${table}: ${result.rows[0].count}`);
  }
} finally {
  await pool.end().catch(() => {});
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL || process.env.CLOUD_SQL_POSTGRES_URL || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL || "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL is required.");
  }
  const url = new URL(databaseUrl);
  if (process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() === "disable") {
    url.searchParams.set("sslmode", "disable");
  }
  return url.toString();
}
