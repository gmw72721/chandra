import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLASS_CODE_LENGTH,
  formatClassCodeInput,
  generateClassCode,
  normalizeClassCode
} from "../lib/class-code.ts";

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

test("teacher workspace displays the short join code instead of the internal id", () => {
  const source = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");

  assert.match(source, /selectedClass\?\.joinCode/);
  assert.match(source, /Class code: \{selectedClassCode \|\| "Creating code\.\.\."\}/);
  assert.doesNotMatch(source, /Class code: \{selectedClass\.id\}/);
});

test("teacher workspace copies a student auth invite link with the short class code", () => {
  const source = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");

  assert.match(source, /new URL\("\/auth", window\.location\.origin\)/);
  assert.match(source, /inviteUrl\.searchParams\.set\("role", "student"\)/);
  assert.match(source, /inviteUrl\.searchParams\.set\("classId", selectedClassCode\)/);
  assert.match(source, /Copy student invite link/);
});

test("student-entered join codes enroll the student before saving profile classId", () => {
  const authSource = readFileSync(join(repoRoot, "lib/auth.ts"), "utf8");
  const joinSource = readFileSync(join(repoRoot, "app/api/classes/join/route.ts"), "utf8");

  assert.match(authSource, /fetch\("\/api\/classes\/join"/);
  assert.match(authSource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(joinSource, /\.where\("joinCode", "==", classCode\)/);
  assert.match(joinSource, /collection\("classes"\)\.doc\(nextClassId\)\.collection\("students"\)/);
  assert.match(joinSource, /batch\.set\(/);
});

test("teacher roster sync backfills students who already saved the classId", () => {
  const managerSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const syncSource = readFileSync(join(repoRoot, "app/api/classes/[classId]/roster/sync/route.ts"), "utf8");

  assert.match(managerSource, /\/api\/classes\/\$\{encodeURIComponent\(activeClassId\)\}\/roster\/sync/);
  assert.match(syncSource, /collection\("users"\)\.where\("classId", "==", classId\)/);
  assert.match(syncSource, /profile\.role !== "student"/);
  assert.match(syncSource, /classReference\.collection\("students"\)\.doc\(rosterStudentId\)/);
});
