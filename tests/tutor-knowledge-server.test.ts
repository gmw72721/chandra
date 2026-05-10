import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("chunks are prepared with embedding metadata", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const vertexSource = readFileSync(join(repoRoot, "frontend/lib/vertex-embeddings.ts"), "utf8");

  assert.match(source, /prepareTutorKnowledgeChunkData/);
  assert.match(source, /taskType: "RETRIEVAL_DOCUMENT"/);
  assert.match(source, /FieldValue\.vector\(embedding\.values\)/);
  assert.match(source, /embeddingModel: embedding\.model/);
  assert.match(source, /embeddingProvider: embedding\.provider/);
  assert.match(source, /embeddingDimensions: embedding\.dimensions/);
  assert.match(source, /professorId/);
  assert.match(source, /professor_id/);
  assert.match(source, /class_id/);
  assert.match(source, /course_id/);
  assert.match(source, /problemNumbers: problemNumbersFromText/);
  assert.match(source, /page_start: chunk\.pageStart/);
  assert.match(source, /chunk_text: chunk\.chunkText/);
  assert.match(source, /sectionHeading/);
  assert.match(vertexSource, /gemini-embedding-2/);
  assert.match(vertexSource, /:embedContent/);
  assert.match(vertexSource, /outputDimensionality/);
  assert.match(vertexSource, /inline_data/);
  assert.match(vertexSource, /taskType/);
});

test("missing professor metadata is rejected before embedding", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /const professorId = requireProfessorId\(teacherId\)/);
  assert.match(source, /Embedded tutor knowledge requires professor_id metadata/);
  assert.match(source, /const chunkEmbedding = embedding \?\?/);
});

test("Vertex embedding failures are handled with material error metadata", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /caughtError instanceof VertexEmbeddingError/);
  assert.match(source, /skipEmbeddings: true/);
  assert.match(source, /buildEmbeddingFailureMaterialMetadata/);
  assert.match(source, /embeddingStatus: "failed"/);
  assert.match(source, /status: "needs-review"/);
  assert.match(source, /Gemini embeddings failed:/);
});

test("student classId scopes vector retrieval", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/retrieval.ts"), "utf8");

  assert.match(source, /collectionGroup\("chunks"\)/);
  assert.match(source, /\.where\("professorId", "==", professorId\)/);
  assert.match(source, /\.where\("classId", "==", classId\)/);
  assert.match(source, /findNearest\(/);
  assert.match(source, /Vector retrieval requires professor_id metadata/);
  assert.match(source, /pageEnd,\s*\n\s*pageNumber,\s*\n\s*pageStart,/);
});

test("material upload progress is written to professor-scoped job documents", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/route.ts"), "utf8");
  const rulesSource = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(routeSource, /formData\.get\("jobId"\)/);
  assert.match(source, /createMaterialJobProgressWriter/);
  assert.match(source, /collection\("materialJobs"\)/);
  assert.match(source, /step: "embedding_chunks"/);
  assert.match(source, /completedChunks: completed/);
  assert.match(rulesSource, /match \/materialJobs\/\{jobId\}/);
  assert.match(rulesSource, /allow read: if isTargetClassTeacher\(classId\)/);
  assert.match(rulesSource, /allow write: if false/);
});

test("material settings PATCH preserves omitted visibility fields", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/[materialId]/route.ts"), "utf8");

  assert.match(source, /settings: Partial<TutorKnowledgeSourceSettings>/);
  assert.match(source, /const currentSettings = sourceSettingsFromMaterial\(materialSnapshot\.data\(\) \?\? \{\}\)/);
  assert.match(source, /\.\.\.currentSettings,\s*\.\.\.settings/s);
  assert.match(source, /readBooleanWithDefault\(\s*material\.activeForStudents \?\? material\.studentVisible/s);
  assert.match(routeSource, /activeForStudents: body\.activeForStudents/);
  assert.match(routeSource, /requireCitations: body\.requireCitations/);
  assert.doesNotMatch(routeSource, /Boolean\(body\.(?:activeForStudents|requireCitations|teacherOnly)\)/);
});

test("new material uploads inherit class source defaults", () => {
  const classSettingsSource = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");
  const serverSource = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const classCreateRoute = readFileSync(join(repoRoot, "frontend/app/api/classes/route.ts"), "utf8");

  assert.match(classSettingsSource, /defaultSourceDefaultsSettings/);
  assert.match(classSettingsSource, /answerKeysTeacherReviewOnly: true/);
  assert.match(classSettingsSource, /sourceDefaultsForMaterialKind/);
  assert.match(classSettingsSource, /Practice Solutions/);
  assert.match(serverSource, /sourceDefaultsForMaterialKind\(classSnapshot\.data\(\)\?\.sourceDefaults, kind\)/);
  assert.match(serverSource, /configuredSourceDefaults\.activeForStudents/);
  assert.match(serverSource, /configuredSourceDefaults\.citationsRequired/);
  assert.match(classCreateRoute, /sourceDefaults: defaultSourceDefaultsSettings/);
});

test("tutor knowledge uploads original files through the server route", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const rulesSource = readFileSync(join(repoRoot, "storage.rules"), "utf8");

  assert.doesNotMatch(componentSource, /uploadBytesResumable/);
  assert.doesNotMatch(componentSource, /formData\.append\("storagePath", storagePath\)/);
  assert.doesNotMatch(componentSource, /formData\.append\("storageBucket", firebaseConfig\.storageBucket \?\? ""\)/);
  assert.match(componentSource, /formData\.append\("file", materialFile\)/);
  assert.match(source, /formData\.get\("storagePath"\)/);
  assert.match(source, /formData\.get\("storageBucket"\)/);
  assert.match(source, /resolveTutorKnowledgeStorageBucket\(storageBucket\)/);
  assert.match(source, /firebaseConfig\.storageBucket/);
  assert.match(source, /storageBucket: bucketName/);
  assert.match(source, /uploadTutorKnowledgeFile\(\{ classId, file, materialId: materialRef\.id, updateProgress \}\)/);
  assert.match(source, /Saving the original source file to Firebase Storage/);
  assert.match(source, /adminStorage!\.bucket\(\)\.file\(filePath\)/);
  assert.match(source, /storageFile\.save\(buffer/);
  assert.match(source, /const filePath = `classes\/\$\{classId\}\/materials\/\$\{materialId\}\/original\/\$\{safeFileName\}`/);
  assert.match(source, /sourceKind: "file"/);
  assert.match(rulesSource, /coTeachers\[request\.auth\.uid\]/);
  assert.match(rulesSource, /role in \["owner", "co-teacher"\]/);
});

test("deleting tutor knowledge removes source files, chunks, embeddings, jobs, and material", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/[materialId]/route.ts"), "utf8");

  assert.match(routeSource, /await deleteTutorKnowledge\(\{ classId, materialId \}\)/);
  assert.match(source, /deleteMaterialStorageFiles\(\{ classId, filePath, materialId, storageBucket \}\)/);
  assert.match(source, /resolveTutorKnowledgeStorageBucket\(storageBucket\)\.file\(filePath\)\.download\(\)/);
  assert.match(source, /bucket\.getFiles\(\{ prefix: materialStoragePrefix \}\)/);
  assert.match(source, /materialRef\.collection\("chunks"\)\.get\(\)/);
  assert.match(source, /collection\("materialJobs"\)[\s\S]*where\("materialId", "==", materialId\)/);
  assert.match(source, /deleteDocumentsInBatches\(\[[\s\S]*chunksSnapshot\.docs[\s\S]*jobsSnapshot\.docs/s);
  assert.match(source, /await materialRef\.delete\(\)/);
  assert.match(source, /embedding: FieldValue\.vector\(embedding\.values\)/);
});

test("tutor knowledge supports guarded URL ingestion", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");

  assert.match(componentSource, /Paste URL/);
  assert.match(source, /extractChunksFromUrl/);
  assert.match(source, /downloadTutorKnowledgeUrl/);
  assert.match(source, /validatePublicTutorKnowledgeUrl/);
  assert.match(source, /Private, local, and internal URLs are not supported/);
  assert.match(source, /originalSourceUrl/);
  assert.match(source, /text\/html/);
});
