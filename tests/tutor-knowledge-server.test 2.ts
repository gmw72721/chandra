import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  buildEmbeddingFailureMaterialMetadata,
  prepareTutorKnowledgeChunkData
} from "../lib/tutor-knowledge-server.ts";
import { normalizeRetrievalScope } from "../lib/retrieval.ts";
import { VertexEmbeddingError } from "../lib/vertex-embeddings.ts";

const repoRoot = process.cwd();

test("chunks are prepared with embedding metadata", async () => {
  const data = await prepareTutorKnowledgeChunkData({
    classId: "class-algebra",
    chunk: {
      content: "Problem 12. Solve x + 4 = 10.",
      label: "Page 3",
      order: 0
    },
    createEmbedding: async ({ taskType }) => ({
      dimensions: 3,
      model: "gemini-embedding-001",
      provider: "vertex-ai",
      taskType,
      values: [0.1, 0.2, 0.3]
    }),
    materialId: "material-1",
    materialType: "assignment",
    professorName: "Ada Lovelace",
    teacherId: "teacher-1",
    title: "Linear Homework"
  });
  const embedding = data.embedding as { toArray: () => number[] };

  assert.equal(data.classId, "class-algebra");
  assert.equal(data.class_id, "class-algebra");
  assert.equal(data.course_id, "class-algebra");
  assert.equal(data.materialId, "material-1");
  assert.equal(data.title, "Linear Homework");
  assert.equal(data.materialType, "assignment");
  assert.equal(data.professorId, "teacher-1");
  assert.equal(data.professor_id, "teacher-1");
  assert.equal(data.professorName, "Ada Lovelace");
  assert.equal(data.professor_name, "Ada Lovelace");
  assert.equal(data.teacherId, "teacher-1");
  assert.deepEqual(data.problemNumbers, ["12"]);
  assert.equal(data.pageNumber, 3);
  assert.equal(data.embeddingProvider, "vertex-ai");
  assert.equal(data.embeddingModel, "gemini-embedding-001");
  assert.equal(data.embeddingDimensions, 3);
  assert.deepEqual(embedding.toArray(), [0.1, 0.2, 0.3]);
});

test("missing professor metadata is rejected before embedding", async () => {
  await assert.rejects(
    () =>
      prepareTutorKnowledgeChunkData({
        classId: "class-algebra",
        chunk: {
          content: "Solve x + 4 = 10.",
          label: "Knowledge chunk 1",
          order: 0
        },
        createEmbedding: async () => {
          throw new Error("embedding should not run without professor_id");
        },
        materialId: "material-1",
        materialType: "assignment",
        teacherId: "",
        title: "Linear Homework"
      }),
    /professor_id/
  );
});

test("Vertex embedding failures are handled with material error metadata", async () => {
  const embeddingError = new VertexEmbeddingError("Vertex AI embedding generation failed.", {
    cause: new Error("permission denied")
  });

  await assert.rejects(
    () =>
      prepareTutorKnowledgeChunkData({
        classId: "class-algebra",
        chunk: {
          content: "Solve x + 4 = 10.",
          label: "Knowledge chunk 1",
          order: 0
        },
        createEmbedding: async () => {
          throw embeddingError;
        },
        materialId: "material-1",
        materialType: "assignment",
        teacherId: "teacher-1",
        title: "Linear Homework"
      }),
    VertexEmbeddingError
  );

  const metadata = buildEmbeddingFailureMaterialMetadata(embeddingError);

  assert.equal(metadata.status, "needs-review");
  assert.equal(metadata.embeddingStatus, "failed");
  assert.match(metadata.embeddingError, /permission denied/);
});

test("student classId scopes vector retrieval", () => {
  const source = readFileSync(join(repoRoot, "lib/retrieval.ts"), "utf8");

  assert.match(source, /collectionGroup\("chunks"\)/);
  assert.match(source, /\.where\("professorId", "==", professorId\)/);
  assert.match(source, /\.where\("classId", "==", classId\)/);
  assert.match(source, /findNearest\(/);
  assert.throws(() => normalizeRetrievalScope({ classId: "class-algebra", professorId: "" }), /professor_id/);
});
