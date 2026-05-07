import assert from "node:assert/strict";
import test from "node:test";
import { createSourceMetadata, rankMaterialChunks } from "../frontend/lib/retrieval-ranking.ts";
import type { RetrievalSourceHint } from "../frontend/lib/retrieval-ranking.ts";
import type { SourceDocument } from "../frontend/lib/types.ts";

type EvalCase = {
  expectedChunkId: string;
  minConfidence?: "low" | "medium" | "high";
  name: string;
  query: string;
  sourceHints?: RetrievalSourceHint[];
};

const confidenceRank = {
  low: 0,
  medium: 1,
  high: 2
};

const documents = [
  makeDocument({
    id: "linear-homework",
    kind: "assignment",
    title: "Linear Equations Homework",
    chunks: [
      {
        content: "Problem 4. Solve x + 2 = 8 and explain each inverse operation.",
        id: "linear-homework-4",
        label: "Problem 4",
        pageNumber: 1,
        problemNumbers: ["4"]
      },
      {
        content: "Problem 8. A gym charges a startup fee plus a monthly cost. Write and solve a linear equation.",
        id: "linear-homework-8",
        label: "Problem 8",
        pageNumber: 2,
        problemNumbers: ["8"]
      }
    ]
  }),
  makeDocument({
    id: "linear-notes",
    kind: "lecture-notes",
    title: "Linear Equation Notes",
    chunks: [
      {
        content: "Inverse operations undo addition, subtraction, multiplication, and division to isolate a variable.",
        id: "linear-notes-inverse",
        label: "Inverse operations",
        pageNumber: 3
      }
    ]
  }),
  makeDocument({
    id: "quadratic-practice",
    kind: "assignment",
    materialType: "practice-problems",
    title: "Quadratic Practice Problems",
    chunks: [
      {
        content: "Question 2. Factor x^2 + 5x + 6, then use the zero product property.",
        id: "quadratic-practice-2",
        label: "Question 2",
        pageNumber: 1,
        problemNumbers: ["2"]
      },
      {
        content: "Question 7. Use the quadratic formula to solve 2x^2 - 3x - 2 = 0.",
        id: "quadratic-practice-7",
        label: "Question 7",
        pageNumber: 2,
        problemNumbers: ["7"]
      }
    ]
  }),
  makeDocument({
    id: "quadratic-solutions",
    kind: "worked-example",
    materialType: "practice-solutions",
    title: "Quadratic Practice Solutions",
    chunks: [
      {
        content: "Solution for question 2: x^2 + 5x + 6 factors as (x + 2)(x + 3).",
        id: "quadratic-solutions-2",
        label: "Solution 2",
        pageNumber: 6,
        problemNumbers: ["2"]
      }
    ]
  }),
  makeDocument({
    id: "systems-worksheet",
    kind: "assignment",
    title: "Systems of Equations Worksheet",
    chunks: [
      {
        content: "Problem 3. Solve the system using substitution: y = 2x + 1 and x + y = 10.",
        id: "systems-worksheet-3",
        label: "Problem 3",
        pageNumber: 1,
        problemNumbers: ["3"]
      }
    ]
  })
];

const evalCases: EvalCase[] = [
  {
    expectedChunkId: "linear-homework-4",
    minConfidence: "high",
    name: "exact assignment and problem number",
    query: "I am on Linear Equations Homework problem 4"
  },
  {
    expectedChunkId: "linear-notes-inverse",
    name: "concept lookup should return notes",
    query: "Can you remind me how inverse operations isolate a variable?"
  },
  {
    expectedChunkId: "quadratic-practice-2",
    minConfidence: "medium",
    name: "student mentions problem text without title",
    query: "question 2 factor x^2 + 5x + 6"
  },
  {
    expectedChunkId: "quadratic-practice-2",
    minConfidence: "medium",
    name: "source hint keeps follow-up on prior problem set",
    query: "what about number 2?",
    sourceHints: [{ title: "Quadratic Practice Problems" }]
  },
  {
    expectedChunkId: "systems-worksheet-3",
    minConfidence: "high",
    name: "worksheet title beats similar equation language",
    query: "Systems of Equations Worksheet #3 substitution"
  }
];

test("retrieval eval returns expected top chunks for realistic student queries", () => {
  const candidates = toCandidates(documents);
  const rows = evalCases.map((evalCase) => {
    const result = rankMaterialChunks({
      candidates,
      limit: 4,
      query: evalCase.query,
      sourceHints: evalCase.sourceHints
    });
    const topHit = result.hits[0];
    const expectedRank = result.hits.findIndex((hit) => hit.chunk.id === evalCase.expectedChunkId) + 1;

    return {
      confidence: result.confidence,
      expectedChunkId: evalCase.expectedChunkId,
      expectedRank,
      name: evalCase.name,
      query: evalCase.query,
      sources: createSourceMetadata(result.hits),
      topChunkId: topHit?.chunk.id ?? "",
      topDocumentTitle: topHit?.document.title ?? "",
      topScore: topHit?.score.toFixed(3) ?? "0.000"
    };
  });

  const top1Accuracy = rows.filter((row) => row.expectedRank === 1).length / rows.length;
  const top3Recall = rows.filter((row) => row.expectedRank >= 1 && row.expectedRank <= 3).length / rows.length;
  const meanReciprocalRank =
    rows.reduce((sum, row) => sum + (row.expectedRank > 0 ? 1 / row.expectedRank : 0), 0) / rows.length;

  const lowConfidenceCorrectRows = rows.filter((row) => row.expectedRank === 1 && row.confidence === "low");

  console.table(
    rows.map(({ confidence, expectedChunkId, expectedRank, name, topChunkId, topDocumentTitle, topScore }) => ({
      confidence,
      expectedChunkId,
      expectedRank,
      name,
      topChunkId,
      topDocumentTitle,
      topScore
    }))
  );
  console.log(
    `Retrieval eval: top1=${formatPercent(top1Accuracy)} top3=${formatPercent(
      top3Recall
    )} mrr=${meanReciprocalRank.toFixed(3)}`
  );
  console.log(
    `Retrieval eval diagnostics: correct-but-low-confidence=${lowConfidenceCorrectRows
      .map((row) => row.name)
      .join(", ") || "none"}`
  );

  for (const row of rows) {
    const evalCase = evalCases.find((candidate) => candidate.name === row.name)!;

    assert.equal(row.expectedRank, 1, `${row.name} returned ${row.topChunkId} instead of ${row.expectedChunkId}`);

    if (evalCase.minConfidence) {
      assert.ok(
        confidenceRank[row.confidence] >= confidenceRank[evalCase.minConfidence],
        `${row.name} confidence was ${row.confidence}, expected at least ${evalCase.minConfidence}`
      );
    }
  }
});

function makeDocument({
  chunks,
  id,
  kind,
  materialType,
  title
}: {
  chunks: Array<{
    content: string;
    id: string;
    label: string;
    pageNumber?: number;
    problemNumbers?: string[];
  }>;
  id: string;
  kind: SourceDocument["kind"];
  materialType?: string;
  title: string;
}): SourceDocument {
  return {
    chunks: chunks.map((chunk) => ({
      content: chunk.content,
      documentId: id,
      id: chunk.id,
      label: chunk.label,
      materialId: id,
      materialType: materialType ?? (kind === "assignment" ? "assignment" : "notes"),
      pageNumber: chunk.pageNumber,
      problemNumbers: chunk.problemNumbers,
      title
    })),
    courseId: "class-a",
    id,
    kind,
    materialType,
    status: "ready",
    title,
    uploadedAt: new Date("2026-05-05T00:00:00.000Z").toISOString()
  };
}

function toCandidates(sourceDocuments: SourceDocument[]) {
  return sourceDocuments.flatMap((document) => document.chunks.map((chunk) => ({ chunk, document })));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
