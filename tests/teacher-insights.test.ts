import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const source = () => readFileSync(join(repoRoot, "frontend/lib/teacher-insights-server.ts"), "utf8");

test("teacher insight ranges normalize and filter timestamps", () => {
  const serverSource = source();

  assert.match(serverSource, /export function normalizeTeacherInsightRange/);
  assert.match(serverSource, /return insightRanges\.has\(value as TeacherInsightRange\)/);
  assert.match(serverSource, /export function getTeacherInsightRangeWindow/);
  assert.match(serverSource, /range === "yesterday"/);
  assert.match(serverSource, /range === "7d" \|\| range === "30d"/);
  assert.match(serverSource, /timestamp >= start\.getTime\(\) && timestamp <= end\.getTime\(\)/);
});

test("normalization clamps bad and partial model JSON", () => {
  const serverSource = source();

  assert.match(serverSource, /normalizeTeacherInsightsContent/);
  assert.match(serverSource, /maxSummaryBodyLength = 900/);
  assert.match(serverSource, /source\.evidence\.slice\(0, maxEvidenceChips\)/);
  assert.match(serverSource, /source\.trends\.slice\(0, maxTrends\)/);
  assert.match(serverSource, /source\.misconceptionTimeline\s*\.slice\(0, maxMisconceptions\)/s);
  assert.match(serverSource, /source\.recommendations\s*\.slice\(0, maxRecommendations\)/s);
  assert.match(serverSource, /source\.evidenceLinks\s*\.slice\(0, maxEvidenceLinks\)/s);
  assert.match(serverSource, /clampNonNegativeInteger\(source\.evidenceCount, 999\)/);
  assert.match(serverSource, /sanitizeSparkline/);
  assert.match(serverSource, /unsafeInsightLabels/);
});

test("safe fallback response is deterministic", () => {
  const serverSource = source();

  assert.match(serverSource, /export function buildEmptyTeacherInsightsDocument/);
  assert.match(serverSource, /conversationCount: 0/);
  assert.match(serverSource, /generatedAt: ""/);
  assert.match(serverSource, /No class insight generated yet/);
  assert.match(serverSource, /Generate class insights after recent student conversations are available/);
});

test("feedback payload actions are validated", () => {
  const serverSource = source();

  assert.match(serverSource, /const feedbackActions = new Set<TeacherInsightFeedbackAction>/);
  assert.match(serverSource, /"useful"/);
  assert.match(serverSource, /"notUseful"/);
  assert.match(serverSource, /"dismiss"/);
  assert.match(serverSource, /"markResolved"/);
  assert.match(serverSource, /"addNote"/);
  assert.match(serverSource, /throw new ConversationPersistenceError\("Choose a valid insight feedback action\.", 400\)/);
  assert.match(serverSource, /normalizedAction === "addNote" && !normalizedNote/);
});

test("system prompt constrains class-level teaching insight output", () => {
  const serverSource = source();

  assert.match(serverSource, /Generate private class-level teaching_insights/);
  assert.match(serverSource, /Do not diagnose students/);
  assert.match(serverSource, /protected or sensitive traits/);
  assert.match(serverSource, /Return this JSON shape exactly/);
  assert.match(serverSource, /conversationId and messageId/);
});

test("server generation mirrors profile architecture without live OpenRouter calls in tests", () => {
  const serverSource = source();

  assert.match(serverSource, /export type TeacherInsightsGenerator = \(input: TeacherInsightsModelInput\) => Promise<unknown>/);
  assert.match(serverSource, /generator \?\? generateTeacherInsightsWithOpenRouter/);
  assert.match(serverSource, /response_format: \{ type: "json_object" \}/);
  assert.match(serverSource, /temperature: 0\.2/);
  assert.match(serverSource, /TEACHER_INSIGHTS_MODEL/);
  assert.match(serverSource, /collection\("teacherInsights"\)\.doc\(range\)/);
  assert.match(serverSource, /collection\("revisions"\)\.add/);
});

test("model input construction is bounded and includes evidence metadata", () => {
  const serverSource = source();

  assert.match(serverSource, /const insightModelMaxConversations = 30/);
  assert.match(serverSource, /const insightModelMaxMessagesPerConversation = 12/);
  assert.match(serverSource, /sanitizeTranscriptText\(message\.content\)/);
  assert.match(serverSource, /retrievalConfidence: message\.role === "assistant"/);
  assert.match(serverSource, /selectedPages: message\.role === "assistant"/);
  assert.match(serverSource, /sources: message\.role === "assistant"/);
  assert.match(serverSource, /learningProfileDraftCount/);
  assert.match(serverSource, /collection\("materials"\)/);
});

test("generated insight sections are grounded against actual conversations", () => {
  const serverSource = source();

  assert.match(serverSource, /applyDeterministicInsightStats/);
  assert.match(serverSource, /resolveInsightEvidenceConversations/);
  assert.match(serverSource, /matchConversationsByText/);
  assert.match(serverSource, /misconceptionTimeline/);
  assert.match(serverSource, /seenInConversations: citedConversations\.length/);
  assert.match(serverSource, /inferMisconceptionStatus/);
  assert.match(serverSource, /recommendations = insight\.recommendations/);
  assert.match(serverSource, /evidenceCount: citedConversations\.length/);
  assert.match(serverSource, /evidenceLinks = insight\.evidenceLinks/);
  assert.match(serverSource, /conversationCount: citedConversations\.length/);
  assert.match(serverSource, /buildSummaryEvidenceChips/);
});

test("teacher-only insight routes and Firestore rules are server owned", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/insights/route.ts"), "utf8");
  const feedbackRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/insights/feedback/route.ts"),
    "utf8"
  );
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(routeSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(routeSource, /updateClassTeacherInsights/);
  assert.match(feedbackRouteSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(feedbackRouteSource, /saveTeacherInsightFeedback/);
  assert.match(rules, /match \/teacherInsights\/\{rangeKey\}/);
  assert.match(rules, /allow read: if isTargetClassTeacher\(classId\)/);
  assert.match(rules, /allow write: if false/);
});
