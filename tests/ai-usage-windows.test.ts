import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("student usage windows keep independent daily and weekly anchors", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");
  const dataSource = readFileSync(join(repoRoot, "frontend/lib/data/usage.ts"), "utf8");
  const migrationSource = readFileSync(join(repoRoot, "migrations/002_core_app_tables.sql"), "utf8");

  assert.match(usageSource, /dayAnchorAt: Date/);
  assert.match(usageSource, /weekAnchorAt: Date/);
  assert.match(usageSource, /day: anchoredBucketWindow\(now, anchor\.dayAnchorAt, "day"\)/);
  assert.match(usageSource, /week: anchoredBucketWindow\(now, anchor\.weekAnchorAt, "week"\)/);
  assert.match(usageSource, /function activeStudentAiUsageAnchor/);
  assert.match(usageSource, /anchoredBucketWindowExpired\(now, anchor\.dayAnchorAt, "day"\) \? now : anchor\.dayAnchorAt/);
  assert.match(usageSource, /anchoredBucketWindowExpired\(now, anchor\.weekAnchorAt, "week"\) \? now : anchor\.weekAnchorAt/);
  assert.match(usageSource, /updateAiUsageAnchorPostgres/);
  assert.match(dataSource, /day_anchor_at/);
  assert.match(dataSource, /week_anchor_at/);
  assert.match(migrationSource, /day_anchor_at TIMESTAMPTZ/);
  assert.match(migrationSource, /week_anchor_at TIMESTAMPTZ/);
});

test("student request quotas use anchored usage windows", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");

  assert.match(usageSource, /usageWindows,\s*\n\s*userId: quotaUserId/);
  assert.match(usageSource, /const studentDayBucket = usageWindows\?\.day\.bucketKey \?\? dayBucket/);
  assert.match(usageSource, /const studentWeekBucket = usageWindows\?\.week\.bucketKey \?\? weekBucket/);
  assert.match(usageSource, /dayBucket: studentDayBucket/);
  assert.match(usageSource, /dayBucket: studentWeekBucket/);
});
