import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("account profile writes and reads use Postgres helpers before Firestore fallback", () => {
  const route = source("frontend/app/api/account/profile/route.ts");
  const auth = source("frontend/lib/auth.ts");
  const settings = source("frontend/app/api/account/settings/route.ts");
  const resolveLogin = source("frontend/app/api/auth/resolve-login/route.ts");

  assert.match(route, /upsertAccountProfile/);
  assert.match(route, /getAccountProfile/);
  assert.match(route, /verifyIdToken\(token\)/);
  assert.match(auth, /\/api\/account\/profile/);
  assert.match(settings, /getAccountProfile/);
  assert.match(settings, /upsertAccountProfile/);
  assert.match(settings, /assertAccountUsernameAvailable/);
  assert.match(resolveLogin, /resolveLoginEmailPostgresFirst/);
  assert.ok(resolveLogin.indexOf("resolveLoginEmailPostgresFirst") < resolveLogin.indexOf("collection(\"users\")"));
});

test("class creation, settings, roster, and co-teacher writes go through Postgres helpers", () => {
  const classesRoute = source("frontend/app/api/classes/route.ts");
  const classClient = source("frontend/lib/classes.ts");
  const settingsRoute = source("frontend/app/api/classes/[classId]/settings/route.ts");
  const studentsRoute = source("frontend/app/api/classes/[classId]/students/route.ts");
  const joinRoute = source("frontend/app/api/classes/join/route.ts");
  const coTeachersRoute = source("frontend/app/api/classes/[classId]/co-teachers/route.ts");

  assert.match(classesRoute, /upsertClassPostgresFirst/);
  assert.match(classesRoute, /resolveClassCodePostgresFirst/);
  assert.match(settingsRoute, /updateClassSettings/);
  assert.match(classClient, /\/api\/classes\/\$\{encodeURIComponent\(classId\)\}\/settings/);
  assert.match(studentsRoute, /enrollStudentPostgresFirst/);
  assert.match(joinRoute, /enrollStudentPostgresFirst/);
  assert.match(joinRoute, /resolveClassCodePostgresFirst/);
  assert.match(coTeachersRoute, /upsertCoTeacher/);
  assert.match(coTeachersRoute, /updateCoTeacherRole/);
  assert.match(coTeachersRoute, /removeCoTeacher/);
});

test("Postgres-first reads keep Firestore fallback paths", () => {
  const server = source("frontend/lib/data/server.ts");
  const studentClasses = source("frontend/app/api/student/classes/route.ts");
  const tutorKnowledge = source("frontend/lib/tutor-knowledge-server.ts");

  assert.match(server, /tryPostgresData/);
  assert.match(server, /Postgres path failed; using Firestore fallback/);
  assert.match(server, /collection\("users"\)/);
  assert.match(server, /collection\("classes"\)/);
  assert.match(server, /collection\("students"\)/);
  assert.match(studentClasses, /listStudentClassIdsPostgresFirst/);
  assert.match(studentClasses, /getRosterClassIdsByEmail/);
  assert.match(tutorKnowledge, /getClassSnapshotPostgresFirst/);
  assert.match(tutorKnowledge, /getMaterialById/);
});

test("material metadata, job progress, and visibility use Postgres without moving file storage", () => {
  const materials = source("frontend/lib/tutor-knowledge-server.ts");
  const classClient = source("frontend/lib/classes.ts");
  const classMaterialsRoute = source("frontend/app/api/classes/[classId]/materials/route.ts");
  const uploadSession = source("frontend/app/api/materials/upload-session/route.ts");
  const materialData = source("frontend/lib/data/materials.ts");

  assert.match(materials, /upsertMaterial/);
  assert.match(materials, /upsertMaterialJob/);
  assert.match(materials, /material\.metadata\.processing\.write/);
  assert.match(materials, /updateMaterialVisibility/);
  assert.match(materials, /replacePdfOcrMetadata/);
  assert.match(materials, /adminStorage/);
  assert.match(classClient, /\/api\/classes\/\$\{encodeURIComponent\(classId\)\}\/materials/);
  assert.doesNotMatch(classClient, /collection\(db!, "classes", classId, "materials"\)/);
  assert.match(classMaterialsRoute, /listClassMaterials/);
  assert.match(uploadSession, /createMaterialUploadSession/);
  assert.match(materialData, /INSERT INTO materials/);
  assert.match(materialData, /INSERT INTO material_jobs/);
  assert.match(materialData, /active_for_students = \$2/);
});

test("Firebase Auth token verification remains the authorization boundary", () => {
  const routes = [
    "frontend/app/api/account/profile/route.ts",
    "frontend/app/api/account/settings/route.ts",
    "frontend/app/api/classes/route.ts",
    "frontend/app/api/classes/join/route.ts",
    "frontend/app/api/classes/resolve/route.ts",
    "frontend/lib/tutor-knowledge-server.ts"
  ];

  for (const route of routes) {
    assert.match(source(route), /verifyIdToken\(token\)/, route);
  }
});
