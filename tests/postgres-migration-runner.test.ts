import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("Postgres migration runner discovers all numbered SQL migrations", () => {
  const source = readFileSync(join(repoRoot, "scripts/apply-postgres-migrations.mjs"), "utf8");

  assert.match(source, /function discoverMigrationFiles\(\)/);
  assert.match(source, /readdirSync\(migrationsDir\)/);
  assert.match(source, /\^\\d\+_\.\*\\\.sql\$/);
  assert.doesNotMatch(source, /const migrationFiles = \[\s*"migrations\/001_pdf_ocr_metadata\.sql"/);
});
