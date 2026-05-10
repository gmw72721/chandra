import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  conversationRetentionCutoffDate,
  isConversationExpiredForRetention
} from "../frontend/lib/conversation-retention-policy.ts";

const repoRoot = process.cwd();

test("resolve-login uses uniform responses, Firestore rate limiting, and abuse logging", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/auth/resolve-login/route.ts"), "utf8");
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const lockoutSource = readFileSync(join(repoRoot, "frontend/lib/abuse-lockout.ts"), "utf8");

  assert.match(routeSource, /checkFirestoreRateLimit/);
  assert.match(routeSource, /checkAbuseLockout/);
  assert.match(routeSource, /recordAbuseFailure/);
  assert.match(routeSource, /auth\.resolve-login/);
  assert.match(routeSource, /auth\.resolve_login\.failed_lookup_repeated/);
  assert.match(routeSource, /auth\.resolve_login\.rate_limited/);
  assert.match(lockoutSource, /failures: 5, cooldownMs: 5 \* 60 \* 1000/);
  assert.match(lockoutSource, /failures: 10, cooldownMs: 30 \* 60 \* 1000/);
  assert.match(lockoutSource, /failures: 20, cooldownMs: 24 \* 60 \* 60 \* 1000/);
  assert.match(lockoutSource, /defaultResetWindowMs = 60 \* 60 \* 1000/);
  assert.match(lockoutSource, /clientFingerprint/);
  assert.match(routeSource, /genericResolveLoginResponse/);
  assert.doesNotMatch(routeSource, /No account matches that username/);
  assert.doesNotMatch(routeSource, /status: 404/);
  assert.match(authSource, /Invalid username\/email or password/);
  assert.doesNotMatch(authSource, /No account matches that username/);
});

test("password reset flow uses Firebase reset email without account enumeration", () => {
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const authFormSource = readFileSync(join(repoRoot, "frontend/components/AuthForm.tsx"), "utf8");

  assert.match(authSource, /sendPasswordResetEmail/);
  assert.match(authSource, /requestPasswordReset/);
  assert.match(authSource, /If an account matches that email or username/);
  assert.match(authSource, /\.catch\(\(\) => undefined\)/);
  assert.match(authFormSource, /mode === "reset"/);
  assert.match(authFormSource, /Send reset link/);
  assert.doesNotMatch(authFormSource, /No account matches/);
});

test("class join and teacher invite signup use server-side lockouts with generic failures", () => {
  const resolveSource = readFileSync(join(repoRoot, "frontend/app/api/classes/resolve/route.ts"), "utf8");
  const joinSource = readFileSync(join(repoRoot, "frontend/app/api/classes/join/route.ts"), "utf8");
  const teacherSignupSource = readFileSync(join(repoRoot, "frontend/app/api/teacher-signup/route.ts"), "utf8");

  assert.match(resolveSource, /checkAbuseLockout/);
  assert.match(resolveSource, /recordAbuseFailure/);
  assert.match(resolveSource, /namespace: "classes\.resolve"/);
  assert.doesNotMatch(resolveSource, /Class code was not found/);
  assert.match(joinSource, /checkAbuseLockout/);
  assert.match(joinSource, /recordAbuseFailure/);
  assert.match(joinSource, /namespace: "classes\.join"/);
  assert.doesNotMatch(joinSource, /Class code was not found/);
  assert.match(teacherSignupSource, /teacher_invite\.signup/);
  assert.match(teacherSignupSource, /checkAbuseLockout/);
  assert.match(teacherSignupSource, /recordAbuseFailure/);
  assert.match(teacherSignupSource, /genericTeacherInviteError/);
  assert.doesNotMatch(teacherSignupSource, /Use a valid teacher invite link to create a teacher account/);
});

test("teacher invites are hash-only, single-use, listable, revocable, and audited", () => {
  const inviteRoute = readFileSync(join(repoRoot, "frontend/app/api/teacher-invites/route.ts"), "utf8");
  const signupRoute = readFileSync(join(repoRoot, "frontend/app/api/teacher-signup/route.ts"), "utf8");
  const teacherSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");

  assert.match(inviteRoute, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(inviteRoute, /hashInviteToken\(inviteToken\)/);
  assert.match(inviteRoute, /collection\("teacherInvites"\)\.doc\(tokenHash\)\.set/);
  assert.match(inviteRoute, /export async function GET/);
  assert.match(inviteRoute, /export async function DELETE/);
  assert.match(inviteRoute, /inviteUrl: status === "active"/);
  assert.match(signupRoute, /resolveInviteDocumentId/);
  assert.match(inviteRoute, /revokedAt: FieldValue\.serverTimestamp/);
  assert.match(inviteRoute, /teacher_invite\.created/);
  assert.match(inviteRoute, /teacher_invite\.revoked/);
  assert.match(signupRoute, /invite\?\.usedAt/);
  assert.match(signupRoute, /invite\?\.revokedAt/);
  assert.match(signupRoute, /teacher_invite\.used/);
  assert.doesNotMatch(inviteRoute, /inviteToken,\s*$/m);
  assert.match(teacherSource, /loadTeacherInvites/);
  assert.match(teacherSource, /revokeTeacherInvite/);
  assert.match(teacherSource, /teacherInviteFilterOptions/);
  assert.match(teacherSource, /copyTeacherInviteLink\(invite/);
  assert.match(teacherSource, /Used by/);
});

test("account deletion requires fresh auth and protects owned teacher classes", () => {
  const deleteRoute = readFileSync(join(repoRoot, "frontend/app/api/account/delete/route.ts"), "utf8");
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const teacherSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(deleteRoute, /hasRecentAuthentication\(decodedToken\.auth_time\)/);
  assert.match(deleteRoute, /activeTeacherOwnedClasses/);
  assert.match(deleteRoute, /Transfer or delete active classes before deleting your teacher account/);
  assert.match(deleteRoute, /anonymizeStudentAccountData/);
  assert.match(deleteRoute, /studentDeleted: true/);
  assert.match(deleteRoute, /adminAuth!\.revokeRefreshTokens\(decodedToken\.uid\)/);
  assert.match(deleteRoute, /adminAuth!\.deleteUser\(decodedToken\.uid\)/);
  assert.match(deleteRoute, /account\.deleted/);
  assert.match(authSource, /deleteCurrentAccount/);
  assert.match(authSource, /reauthenticateWithCredential/);
  assert.match(authSource, /\/api\/account\/delete/);
  assert.match(teacherSource, /Delete account/);
  assert.match(studentSource, /Delete account/);
});

test("session revocation exists and account changes can revoke refresh tokens", () => {
  const revokeRoute = readFileSync(join(repoRoot, "frontend/app/api/account/sessions/revoke/route.ts"), "utf8");
  const accountRoute = readFileSync(join(repoRoot, "frontend/app/api/account/settings/route.ts"), "utf8");
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const teacherSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(revokeRoute, /adminAuth!\.revokeRefreshTokens\(decodedToken\.uid\)/);
  assert.match(revokeRoute, /account\.sessions\.revoked/);
  assert.match(accountRoute, /shouldRevokeRefreshTokens/);
  assert.match(accountRoute, /adminAuth!\.revokeRefreshTokens\(decodedToken\.uid\)/);
  assert.match(authSource, /signOutAllSessions/);
  assert.match(authSource, /\/api\/account\/sessions\/revoke/);
  assert.match(teacherSource, /Sign out all sessions/);
  assert.match(studentSource, /Sign out all sessions/);
  assert.match(teacherSource, /metadata\.lastSignInTime/);
  assert.match(studentSource, /metadata\.lastSignInTime/);
});

test("audit and security logs are server-owned and unreadable from Firestore clients", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");
  const auditSource = readFileSync(join(repoRoot, "frontend/lib/audit-log.ts"), "utf8");
  const inviteRoute = readFileSync(join(repoRoot, "frontend/app/api/teacher-invites/route.ts"), "utf8");
  const coTeacherRoute = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/co-teachers/route.ts"), "utf8");
  const materialRoute = readFileSync(join(repoRoot, "frontend/app/api/materials/route.ts"), "utf8");
  const materialDetailRoute = readFileSync(join(repoRoot, "frontend/app/api/materials/[materialId]/route.ts"), "utf8");
  const studentDataRoute = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/students/[studentId]/data/route.ts"),
    "utf8"
  );

  assert.match(auditSource, /collection\("auditLogs"\)\.add/);
  assert.match(auditSource, /collection\("securityEvents"\)\.add/);
  assert.match(auditSource, /collection\("chatErrorReferences"\)\.doc\(normalizeReferenceId\(errorId\)\)\.set/);
  assert.match(rules, /match \/auditLogs\/\{auditLogId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/securityEvents\/\{securityEventId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/chatErrorReferences\/\{errorId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/rateLimits\/\{rateLimitId\}[\s\S]*allow read, write: if false/);
  assert.match(inviteRoute, /teacher_invite\.created/);
  assert.match(coTeacherRoute, /class\.co_teacher\.(added|updated|removed)/);
  assert.match(materialRoute, /material\.uploaded/);
  assert.match(materialDetailRoute, /material\.deleted/);
  assert.match(studentDataRoute, /student_data\.exported/);
  assert.match(studentDataRoute, /student_data\.deleted/);
});

test("conversation retention cutoff behavior matches class privacy settings", () => {
  const now = new Date("2026-05-10T12:00:00.000Z");

  assert.equal(conversationRetentionCutoffDate("forever", now), null);
  assert.equal(conversationRetentionCutoffDate("unknown", now), null);
  assert.equal(conversationRetentionCutoffDate("30-days", now)?.toISOString(), "2026-04-10T12:00:00.000Z");
  assert.equal(conversationRetentionCutoffDate("90-days", now)?.toISOString(), "2026-02-09T12:00:00.000Z");
  assert.equal(conversationRetentionCutoffDate("1-year", now)?.toISOString(), "2025-05-10T12:00:00.000Z");
  assert.equal(
    isConversationExpiredForRetention({
      lastActivity: "2026-04-09T23:59:59.000Z",
      now,
      retention: "30-days"
    }),
    true
  );
  assert.equal(
    isConversationExpiredForRetention({
      lastActivity: "2026-04-10T12:00:00.000Z",
      now,
      retention: "30-days"
    }),
    false
  );
});

test("conversation retention is enforced through a protected admin route", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/admin/retention/conversations/route.ts"), "utf8");
  const retentionSource = readFileSync(join(repoRoot, "frontend/lib/conversation-retention.ts"), "utf8");
  const envExample = readFileSync(join(repoRoot, "config/env.example"), "utf8");

  assert.match(routeSource, /CONVERSATION_RETENTION_SECRET/);
  assert.match(routeSource, /LEARNING_PROFILE_UPDATE_SECRET/);
  assert.match(routeSource, /enforceConversationRetention/);
  assert.match(retentionSource, /privacySettings.*conversationRetention/s);
  assert.match(retentionSource, /collection\("conversations"\)/);
  assert.match(retentionSource, /collection\("messages"\)/);
  assert.match(envExample, /CONVERSATION_RETENTION_SECRET=/);
});

test("student-facing routes do not return teacher-only profile, review, material, or telemetry fields", () => {
  const studentClassesRoute = readFileSync(join(repoRoot, "frontend/app/api/student/classes/route.ts"), "utf8");
  const studentConversationRoute = readFileSync(join(repoRoot, "frontend/app/api/student/conversations/route.ts"), "utf8");
  const studentMessagesRoute = readFileSync(
    join(repoRoot, "frontend/app/api/student/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );
  const conversationServerSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const studentAttachmentsSource = readFileSync(join(repoRoot, "frontend/lib/student-attachments-server.ts"), "utf8");
  const chatRoute = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(studentClassesRoute, /type StudentClassSummary/);
  assert.doesNotMatch(studentClassesRoute, /behaviorInstructions|answerPolicy|sourceUsage|privacySettings/);
  assert.match(studentConversationRoute, /scope\.role !== "student"/);
  assert.match(studentMessagesRoute, /scope\.role !== "student"/);
  assert.match(conversationServerSource, /listStudentConversationMessages/);
  assert.match(conversationServerSource, /conversation\.studentId !== studentId/);
  assert.doesNotMatch(
    conversationServerSource.match(/export async function listStudentConversationMessages[\s\S]*?function conversationDocToSummary/)?.[0] ?? "",
    /learningStrategyTelemetry|privateNote|conversationReviews/
  );
  assert.match(studentAttachmentsSource, /assertStudentScope\(scope\)/);
  assert.match(studentAttachmentsSource, /attachment\.studentId !== scope\.uid/);
  assert.match(chatRoute, /stripTeacherOnlyTutorResponseFields/);
  assert.match(chatRoute, /privateBackendLearningProfileContext/);
});
