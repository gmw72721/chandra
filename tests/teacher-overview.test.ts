import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const source = () => readFileSync(join(repoRoot, "frontend/lib/teacher-overview-server.ts"), "utf8");

test("teacher overview has a teacher-only route backed by the server aggregator", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/overview/route.ts"), "utf8");

  assert.match(routeSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(routeSource, /getTeacherClassOverview/);
  assert.match(routeSource, /assertOverviewDate\(date\)/);
  assert.match(routeSource, /timezone/);
});

test("teacher overview aggregates existing roster, conversations, knowledge, and profile data", () => {
  const serverSource = source();

  assert.match(serverSource, /listTeacherRosterActivity\(\{ classId, date: overviewDate, timezone: overviewTimezone \}\)/);
  assert.match(serverSource, /listTeacherClassConversations\(\{ classId \}\)/);
  assert.match(serverSource, /collection\("materials"\)/);
  assert.match(serverSource, /collection\("materialJobs"\)/);
  assert.match(serverSource, /collection\("studentLearningProfiles"\)/);
  assert.match(serverSource, /const priorityRows = buildPriorityRows/);
  assert.match(serverSource, /const reviewQueueRows = buildReviewQueueRows/);
  assert.match(serverSource, /nextActions: buildNextActions/);
  assert.match(serverSource, /getOverviewInsightSummary/);
  assert.match(serverSource, /collection\("teacherInsights"\)\.doc\("today"\)/);
  assert.match(serverSource, /type ScoredAction/);
  assert.match(serverSource, /Check high-volume student/);
  assert.match(serverSource, /Review flagged chat/);
  assert.match(serverSource, /sort\(\(first, second\) => second\.score - first\.score/);
});

test("teacher overview uses timezone-aware day keys", () => {
  const serverSource = source();
  const conversationSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");

  assert.match(serverSource, /normalizeOverviewTimezone/);
  assert.match(serverSource, /dateKeyInTimezone/);
  assert.match(serverSource, /formatToParts\(new Date\(millis\)\)/);
  assert.match(conversationSource, /timezone\?: string/);
  assert.match(conversationSource, /dateKey\(createdAt, timezone\)/);
});

test("overview UI consumes API rows instead of screenshot literals", () => {
  const componentSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(componentSource, /TeacherClassOverview/);
  assert.match(componentSource, /\/api\/classes\/\$\{encodeURIComponent\(activeClassId\)\}\/overview/);
  assert.match(componentSource, /overviewPriorityRows\.map/);
  assert.match(componentSource, /overviewRecentActivityRows\.map/);
  assert.match(componentSource, /overviewReviewQueueRows\.map/);
  assert.match(componentSource, /overviewLearningProfileRows\.map/);
  assert.match(componentSource, /overviewNextActions\.map/);
  assert.match(componentSource, /handleOverviewNextAction/);
  assert.doesNotMatch(componentSource, /High question volume today",\s*name:/);
  assert.doesNotMatch(componentSource, /Derivative chain rule", "6 messages"/);
});
