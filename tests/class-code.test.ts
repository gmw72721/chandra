import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLASS_CODE_LENGTH,
  formatClassCodeInput,
  generateClassCode,
  normalizeClassCode
} from "../frontend/lib/class-code.ts";

const repoRoot = process.cwd();

test("class codes are generated as six letters", () => {
  const classCode = generateClassCode();

  assert.equal(classCode.length, CLASS_CODE_LENGTH);
  assert.match(classCode, /^[A-Z]{6}$/);
});

test("student-entered six-letter class codes normalize to uppercase", () => {
  assert.equal(normalizeClassCode(" abcdef "), "ABCDEF");
  assert.equal(formatClassCodeInput("ab-12cdefg"), "ABCDEF");
});

test("Google signup is shown after required signup profile fields", () => {
  const source = readFileSync(join(repoRoot, "frontend/components/AuthForm.tsx"), "utf8");
  const roleIndex = source.indexOf('htmlFor="role"');
  const classCodeIndex = source.indexOf('htmlFor="class-id"');
  const nameIndex = source.indexOf('htmlFor="name"');
  const googleSignupIndex = source.indexOf("{renderProviderAuthGroup({ showDivider: showEmailSignup })}");
  const emailChoiceIndex = source.indexOf("Use email instead");

  assert.ok(roleIndex >= 0);
  assert.ok(classCodeIndex > roleIndex);
  assert.ok(nameIndex > classCodeIndex);
  assert.ok(googleSignupIndex > nameIndex);
  assert.ok(emailChoiceIndex > googleSignupIndex);
  assert.match(source, /assertSignupProfileFieldsArePresent/);
  assert.match(source, /Enter your name to create an account\./);
  assert.match(source, /showEmailSignup/);
  assert.match(source, /finishPendingRoleProfileSetup/);
  assert.match(source, /createRoleProfile/);
});

test("teacher workspace keeps join codes available without rendering top-page invite controls", () => {
  const source = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(source, /selectedClass\.joinCode/);
  assert.match(source, /ensureClassJoinCode\(selectedClass\.id\)/);
  assert.doesNotMatch(source, /Class code\s*<strong>/);
  assert.doesNotMatch(source, /Copy student invite link/);
});

test("pre-dashboard wizard has a dev-only always-on testing mode", () => {
  const source = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(source, /NEXT_PUBLIC_CHANDRA_PRE_DASHBOARD_MODE/);
  assert.match(source, /chandra\.dev\.preDashboardMode/);
  assert.match(source, /process\.env\.NODE_ENV === "production"/);
  assert.match(source, /preDashboardTestModeLoginUserIdRef\.current === user\.uid/);
  assert.match(source, /setIsPreDashboardWizardActive\(true\)/);
});

test("pre-dashboard wizard step indicators can navigate back without duplicating the class", () => {
  const source = readFileSync(join(repoRoot, "frontend/components/PreDashboardWizard.tsx"), "utf8");

  assert.match(source, /function handleStepSelect\(nextStep: number\)/);
  assert.match(source, /maxStepReached/);
  assert.match(source, /saveWizardProgressBeforeNavigation/);
  assert.match(source, /nextStep > maxStepReached/);
  assert.match(source, /setMaxStepReached\(\(currentMaxStep\) => Math\.max\(currentMaxStep, nextStep\)\)/);
  assert.match(source, /<button\s+key=\{i\}[\s\S]*?className=\{`wizard-step-indicator/);
  assert.match(source, /onClick=\{\(\) => void handleStepSelect\(stepNum\)\}/);
  assert.match(source, /min-width:\s*36px/);
  assert.match(source, /const classId = createdClassId \|\|/);
  assert.match(source, /await saveWizardClassSettings\(classId\)/);
  assert.match(source, /await saveWizardClassSettings\(createdClassId\)/);
  assert.match(source, /appearance: normalizeTeacherClassAppearance\(userAppearance\)/);
  assert.match(source, /themeMood: normalizeTeacherClassThemeMood\(themeMood\)/);
  assert.match(source, /createdClassId \? "Save & Continue" : "Create Class"/);
});

test("student-entered join codes enroll the student through the server route", () => {
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const joinSource = readFileSync(join(repoRoot, "frontend/app/api/classes/join/route.ts"), "utf8");

  assert.match(authSource, /fetch\("\/api\/classes\/join"/);
  assert.match(authSource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(authSource, /requireStudentClassCode\(classId\)/);
  assert.match(authSource, /syncProfile: true/);
  assert.ok(authSource.indexOf("requireStudentClassCode(classId)") < authSource.indexOf("const credential = await createUserWithEmailAndPassword"));
  assert.match(joinSource, /resolveClassCodePostgresFirst\(classCode\)/);
  assert.match(joinSource, /Enter your class code to continue\./);
  assert.match(joinSource, /Class code not found\. Check the code with your teacher\./);
  assert.match(joinSource, /Class lookup is temporarily unavailable/);
  assert.match(joinSource, /Class join profile lookup failed; falling back to Firebase user data/);
  assert.match(joinSource, /firstString\(userData\.email, decodedToken\.email, decodedToken\.firebase\?\.identities\?\.email\?\.\[0\], body\.email\)/);
  assert.match(joinSource, /collection\("classes"\)\.doc\(nextClassId\)\.collection\("students"\)/);
  assert.match(joinSource, /enrollStudentPostgresFirst/);
  assert.ok(joinSource.indexOf("await upsertAccountProfile(profileInput") < joinSource.indexOf("await enrollStudentPostgresFirst"));
  assert.match(joinSource, /batch\.set\(/);
});

test("student class joins are additive and keep enrolled class ids", () => {
  const joinSource = readFileSync(join(repoRoot, "frontend/app/api/classes/join/route.ts"), "utf8");
  const classesSource = readFileSync(join(repoRoot, "frontend/app/api/student/classes/route.ts"), "utf8");
  const firebaseConfigSource = readFileSync(join(repoRoot, "firebase.json"), "utf8");
  const indexSource = readFileSync(join(repoRoot, "firestore.indexes.json"), "utf8");
  const rulesSource = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.doesNotMatch(joinSource, /batch\.delete\(/);
  assert.match(joinSource, /classIds: FieldValue\.arrayUnion\(nextClassId\)/);
  assert.match(classesSource, /Array\.isArray\(profile\.classIds\)/);
  assert.match(classesSource, /classIds\.add\(classId\.trim\(\)\)/);
  assert.match(classesSource, /getRosterClassIdsByEmail\(email\)/);
  assert.match(classesSource, /Student roster class lookup failed; falling back to profile class ids/);
  assert.match(firebaseConfigSource, /"indexes": "firestore\.indexes\.json"/);
  assert.match(indexSource, /"collectionGroup": "students"/);
  assert.match(indexSource, /"fieldPath": "email"/);
  assert.match(indexSource, /"queryScope": "COLLECTION_GROUP"/);
  assert.match(rulesSource, /data\.classIds is list/);
  assert.match(rulesSource, /data\.classIds\.hasAny\(\[classId\]\)/);
});

test("teacher roster sync backfills students who already saved the classId", () => {
  const managerSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const syncSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/roster/sync/route.ts"), "utf8");

  assert.match(managerSource, /\/api\/classes\/\$\{encodeURIComponent\(activeClassId\)\}\/roster\/sync/);
  assert.match(syncSource, /collection\("users"\)\.where\("classId", "==", classId\)/);
  assert.match(syncSource, /profile\.role !== "student"/);
  assert.match(syncSource, /classReference\.collection\("students"\)\.doc\(rosterStudentId\)/);
});

test("teacher class creation uses an authenticated server route", () => {
  const clientSource = readFileSync(join(repoRoot, "frontend/lib/classes.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/route.ts"), "utf8");

  assert.match(clientSource, /fetch\(apiUrl\("\/api\/classes"\)/);
  assert.match(clientSource, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(clientSource, /setDoc\(classReference/);
  assert.match(routeSource, /verifyIdToken\(token\)/);
  assert.match(routeSource, /profile\?\.role !== "teacher"/);
  assert.match(routeSource, /upsertClassPostgresFirst/);
});
