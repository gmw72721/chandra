import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("chunks are prepared with embedding metadata", () => {
  const source = readFileSync(join(repoRoot, "lib/tutor-knowledge-server.ts"), "utf8");
  const vertexSource = readFileSync(join(repoRoot, "lib/vertex-embeddings.ts"), "utf8");

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

test("Vertex embedding failures are handled with material error metadata", () => {
  const source = readFileSync(join(repoRoot, "lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /caughtError instanceof VertexEmbeddingError/);
  assert.match(source, /skipEmbeddings: true/);
  assert.match(source, /buildEmbeddingFailureMaterialMetadata/);
  assert.match(source, /embeddingStatus: "failed"/);
  assert.match(source, /status: "needs-review"/);
  assert.match(source, /Gemini embeddings failed:/);
});

test("student classId scopes vector retrieval", () => {
  const source = readFileSync(join(repoRoot, "lib/retrieval.ts"), "utf8");

  assert.match(source, /collectionGroup\("chunks"\)/);
  assert.match(source, /\.where\("professorId", "==", professorId\)/);
  assert.match(source, /\.where\("classId", "==", classId\)/);
  assert.match(source, /findNearest\(/);
  assert.match(source, /Vector retrieval requires professor_id metadata/);
});

test("material upload progress is written to professor-scoped job documents", () => {
  const source = readFileSync(join(repoRoot, "lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "app/api/materials/route.ts"), "utf8");
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
