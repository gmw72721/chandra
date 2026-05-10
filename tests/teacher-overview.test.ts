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
  assert.match(serverSource, /filter\(conversationNeedsTeacherReview\)/);
  assert.match(serverSource, /nextActions: buildNextActions/);
  assert.match(serverSource, /type ScoredAction/);
  assert.match(serverSource, /scoreOverviewAction/);
  assert.match(serverSource, /learningSignals/);
  assert.match(serverSource, /rationale: compactRationale/);
  assert.match(serverSource, /Check high-volume student/);
  assert.match(serverSource, /Review student support/);
  assert.match(serverSource, /Check source accuracy/);
  assert.match(serverSource, /rankOverviewActions/);
  assert.match(serverSource, /second\.score - first\.score/);
});

test("teacher overview review queue excludes reviewed conversations even when source flags remain", () => {
  const serverSource = source();
  const buildReviewQueueRowsStart = serverSource.indexOf("function buildReviewQueueRows");
  const buildReviewQueueRowsEnd = serverSource.indexOf("async function buildLearningProfileRows");
  const buildReviewQueueRowsSource = serverSource.slice(buildReviewQueueRowsStart, buildReviewQueueRowsEnd);

  assert.match(buildReviewQueueRowsSource, /filter\(conversationNeedsTeacherReview\)/);
  assert.match(buildReviewQueueRowsSource, /conversation\.reviewStatus === "new"/);
  assert.match(buildReviewQueueRowsSource, /conversation\.reviewStatus === "needs_follow_up"/);
  assert.match(buildReviewQueueRowsSource, /conversation\.reviewStatus === "misunderstanding_spotted"/);
  assert.match(buildReviewQueueRowsSource, /conversation\.reviewStatus === "ai_answer_needs_review"/);
  assert.doesNotMatch(buildReviewQueueRowsSource, /conversation\.sourceAudit\.lowSourceConfidence \|\|/);
  assert.doesNotMatch(buildReviewQueueRowsSource, /conversation\.topic\.toLowerCase\(\)\.includes\("off-topic"\)\s*\)/);
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
  assert.match(componentSource, /overviewReviewQueueRows\.map/);
  assert.match(componentSource, /row\.issue/);
  assert.match(componentSource, /row\.suggestedAction/);
  assert.match(componentSource, /row\.sourceLabel/);
  assert.match(componentSource, /overviewNextActions\.map/);
  assert.match(componentSource, /handleOverviewNextAction/);
  assert.doesNotMatch(componentSource, /overviewPriorityRows\.map/);
  assert.doesNotMatch(componentSource, /overviewRecentActivityRows\.map/);
  assert.doesNotMatch(componentSource, /overviewLearningProfileRows\.map/);
  assert.doesNotMatch(componentSource, /Class activity/);
  assert.doesNotMatch(componentSource, /High question volume today",\s*name:/);
  assert.doesNotMatch(componentSource, /Derivative chain rule", "6 messages"/);
});
