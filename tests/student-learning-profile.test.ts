import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("active reviewed profile appears in the tutor prompt", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const chatRouteSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(promptSource, /Private student learning profile/);
  assert.match(chatRouteSource, /getActiveStudentLearningProfileTutorContext/);
  assert.match(chatRouteSource, /studentLearningProfileContext\.digest/);
  assert.match(profileSource, /if \(!profileDocument\?\.active \|\| !profileDocument\.teacherReviewed \|\| !profileDocument\.activeProfile\)/);
  assert.match(profileSource, /digest: buildStudentLearningProfileDigest\(profileDocument\)/);
});

test("unreviewed draft profile does not appear in the tutor prompt", () => {
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(profileSource, /draftProfile/);
  assert.match(profileSource, /!profileDocument\.teacherReviewed/);
  assert.match(profileSource, /digest: ""/);
});

test("profile prompt says profile is private and subordinate to teacher policy", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");

  assert.match(promptSource, /Private student learning profile/);
  assert.match(promptSource, /Hidden teacher-reviewed tutoring context\. Never mention or quote it/);
  assert.match(promptSource, /Use it only to adapt pacing, question choice, examples, and support strategy/);
  assert.match(promptSource, /Never use it for grading, discipline, placement, diagnosis/);
});

test("weekly updater skips content update and updates pending counts when below thresholds", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(source, /if \(!force && !thresholdMet\)/);
  assert.match(source, /pendingConversationCount: counts\.pendingConversationCount/);
  assert.match(source, /pendingStudentMessageCount: counts\.pendingStudentMessageCount/);
  assert.match(source, /draftProfile/);
});

test("updater runs when conversation or message threshold is met", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(source, /counts\.pendingConversationCount >= minimumConversationsForUpdate\s*\|\|/);
  assert.match(source, /counts\.pendingStudentMessageCount >= minimumStudentMessagesForUpdate/);
  assert.match(source, /defaultMinimumConversationsForUpdate = 3/);
  assert.match(source, /defaultMinimumStudentMessagesForUpdate = 8/);
});

test("unsafe fields and oversized model output are removed or truncated", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(source, /const maxSummaryLength = 800/);
  assert.match(source, /const maxArrayItems = 8/);
  assert.match(source, /const maxArrayItemLength = 240/);
  assert.match(source, /const maxEvidenceItems = 20/);
  assert.match(source, /const maxTriedStrategies = 12/);
  assert.match(source, /profileChangeNotes: sanitizeProfileTextArray\(source\.profileChangeNotes\)/);
  assert.match(source, /unsafeStudentLabels/);
  assert.match(source, /return ""/);
  assert.match(source, /text\.length > maxLength \? text\.slice\(0, maxLength\)\.trimEnd\(\) : text/);
});

test("strategy statuses are validated", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(source, /"currently_testing"/);
  assert.match(source, /"appears_unhelpful"/);
  assert.match(source, /"retired"/);
  assert.match(source, /export function isStudentLearningStrategyStatus/);
  assert.match(source, /status = isStudentLearningStrategyStatus\(rawStatus\) \? rawStatus : "inconclusive"/);
});

test("model can provide profile change notes for teacher review", () => {
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");
  const cardSource = readFileSync(join(repoRoot, "frontend/components/StudentLearningProfileCard.tsx"), "utf8");

  assert.match(profileSource, /In profileChangeNotes, briefly explain meaningful changes/);
  assert.match(profileSource, /profileChangeNotes/);
  assert.match(cardSource, /Model change notes/);
  assert.match(cardSource, /Changes in new draft/);
});

test("profile update model input includes strategy telemetry and adjacent evidence", () => {
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(profileSource, /learningStrategyTelemetry: message\.role === "assistant"/);
  assert.match(profileSource, /retrievalConfidence: message\.role === "assistant"/);
  assert.match(profileSource, /sources: message\.role === "assistant"/);
  assert.match(profileSource, /selectProfileUpdateTranscriptMessages/);
  assert.match(profileSource, /includedIndexes\.add\(index - 1\)/);
  assert.match(profileSource, /includedIndexes\.add\(index \+ 1\)/);
});

test("profile update prompt uses strategy telemetry for support updates", () => {
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");

  assert.match(profileSource, /Use assistant learningStrategyTelemetry when present/);
  assert.match(profileSource, /triedStrategies, effectiveSupports, lessEffectiveSupports, strategiesToTryNext, and evidence/);
  assert.match(profileSource, /observedOutcome is student_progressed/);
  assert.match(profileSource, /observedOutcome is student_still_stuck/);
  assert.match(profileSource, /not as grading, discipline, diagnosis, placement, or sensitive trait data/);
});

test("teacher-only learning profile routes enforce authorization", () => {
  const routeSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/students/[studentId]/learning-profile/route.ts"),
    "utf8"
  );
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(routeSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(routeSource, /updateOneStudentLearningProfile/);
  assert.match(routeSource, /approveStudentLearningProfile/);
  assert.match(rules, /match \/studentLearningProfiles\/\{profileId\}/);
  assert.match(rules, /allow read: if isTargetClassTeacher\(classId\)/);
  assert.match(rules, /allow write: if false/);
});
