import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLowConfidenceTutorMessage,
  createSourceMetadata,
  hasExactLookupSignal,
  materialTypeForKind,
  problemNumbersFromText,
  rankMaterialChunks
} from "../frontend/lib/retrieval-ranking.ts";
import type { SourceDocument } from "../frontend/lib/types.ts";

test("title matching improves retrieval ranking", () => {
  const homework = makeDocument({
    id: "linear-homework",
    kind: "assignment",
    title: "Linear Equations Homework",
    chunks: [{ content: "Solve each equation.", id: "chunk-homework", problemNumbers: ["4"] }]
  });
  const notes = makeDocument({
    id: "equation-notes",
    kind: "lecture-notes",
    title: "Equation Notes",
    chunks: [{ content: "Linear equations use inverse operations.", id: "chunk-notes" }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([notes, homework]),
    query: "I am on Linear Equations Homework problem 4"
  });

  assert.equal(result.hits[0]?.document.id, "linear-homework");
});

test("vector results still combine with title matching", () => {
  const homework = makeDocument({
    id: "linear-homework",
    kind: "assignment",
    title: "Linear Equations Homework",
    chunks: [
      {
        content: "Solve each equation.",
        id: "chunk-homework",
        vector: [0.95, 0.05]
      }
    ]
  });
  const notes = makeDocument({
    id: "equation-notes",
    kind: "lecture-notes",
    title: "Equation Notes",
    chunks: [
      {
        content: "Linear equations use inverse operations.",
        id: "chunk-notes",
        vector: [1, 0]
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([notes, homework]),
    query: "I am on Linear Equations Homework",
    queryVector: [1, 0]
  });

  assert.equal(result.hits[0]?.document.id, "linear-homework");
});

test("assignment material type boost wins for homework-like problem queries", () => {
  const assignment = makeDocument({
    id: "worksheet",
    kind: "assignment",
    title: "Practice Worksheet",
    chunks: [{ content: "Solve x + 2 = 8", id: "assignment-chunk", problemNumbers: ["7"] }]
  });
  const notes = makeDocument({
    id: "notes",
    kind: "lecture-notes",
    title: "Practice Notes",
    chunks: [{ content: "Solve x + 2 = 8", id: "notes-chunk", problemNumbers: ["7"] }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([notes, assignment]),
    query: "number 7 on the worksheet: solve x + 2 = 8"
  });

  assert.equal(result.hits[0]?.document.id, "worksheet");
});

test("explicit page requests outrank broad semantic similarity", () => {
  const requestedPage = makeDocument({
    id: "calc-reader",
    kind: "textbook",
    title: "Calculus Reader",
    chunks: [
      {
        content: "A sparse page with the printed exercise table.",
        id: "page-129",
        pageNumber: 129,
        vector: [0.6, 0.4]
      }
    ]
  });
  const semanticNeighbor = makeDocument({
    id: "calc-notes",
    kind: "lecture-notes",
    title: "Calculus Notes",
    chunks: [
      {
        content: "Limits, derivatives, and integrals are reviewed with many related examples.",
        id: "nearby-topic",
        pageNumber: 33,
        vector: [1, 0]
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([semanticNeighbor, requestedPage]),
    query: "Can you find page 129 in the calculus reader?",
    queryVector: [1, 0]
  });

  assert.equal(result.hits[0]?.chunk.id, "page-129");
});

test("numbered item matches can override an adjacent explicit page miss", () => {
  const requestedPageWithoutItem = makeDocument({
    id: "linear-algebra-reader",
    kind: "textbook",
    title: "Linear Algebra Reader",
    chunks: [
      {
        content: "The chapter discussion continues with determinant examples and applications.",
        id: "page-41",
        pageNumber: 41
      }
    ]
  });
  const numberedItemPage = makeDocument({
    id: "linear-algebra-reader",
    kind: "textbook",
    title: "Linear Algebra Reader",
    chunks: [
      {
        content: "Problems. 2.2. Recall the vector space V = (0, oo) given in Problem 1.1.",
        id: "page-42",
        pageNumber: 42
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([requestedPageWithoutItem, numberedItemPage]),
    query: "page 41 problem 2.2"
  });

  assert.equal(result.hits[0]?.chunk.id, "page-42");
  assert.deepEqual(problemNumbersFromText("Problem 2.2, Exercise 2.3, and question 4."), ["2.2", "2.3", "4"]);
});

test("page range chunks keep page citations in source metadata", () => {
  const requestedRange = makeDocument({
    id: "calc-reader",
    kind: "textbook",
    title: "Calculus Reader",
    chunks: [
      {
        content: "Exercises 9 through 16 cover integration by parts.",
        id: "pages-128-130",
        pageEnd: 130,
        pageStart: 128
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([requestedRange]),
    query: "Can you find page 129 in the calculus reader?"
  });
  const sources = createSourceMetadata(result.hits);

  assert.equal(result.hits[0]?.chunk.id, "pages-128-130");
  assert.equal(sources[0]?.pageNumber, 128);
});

test("exact problem signals beat a slightly better vector match", () => {
  const exactProblem = makeDocument({
    id: "practice",
    kind: "assignment",
    title: "Integration Practice",
    chunks: [
      {
        content: "Problem 17. Evaluate the integral from 1 to 6 of 12x^3 - 9x^2 + 2.",
        id: "problem-17",
        problemNumbers: ["17"],
        vector: [0.7, 0.3]
      }
    ]
  });
  const semanticNeighbor = makeDocument({
    id: "notes",
    kind: "lecture-notes",
    title: "Integration Notes",
    chunks: [
      {
        content: "Worked examples for definite integrals and polynomial antiderivatives.",
        id: "nearby-notes",
        vector: [1, 0]
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([semanticNeighbor, exactProblem]),
    query: "problem 17 integral from 1 to 6 of 12x^3 - 9x^2 + 2",
    queryVector: [1, 0]
  });

  assert.equal(result.hits[0]?.chunk.id, "problem-17");
});

test("practice problems and solutions have distinct material types", () => {
  assert.equal(materialTypeForKind("Practice Problems"), "practice-problems");
  assert.equal(materialTypeForKind("Practice Solutions"), "practice-solutions");
});

test("source priority breaks otherwise similar retrieval ties", () => {
  const normalSource = makeDocument({
    id: "normal-notes",
    kind: "lecture-notes",
    title: "Limits Notes",
    chunks: [{ content: "A limit describes the value a function approaches.", id: "normal-limit" }]
  });
  const primarySource = makeDocument({
    id: "primary-reader",
    kind: "textbook",
    priority: "primary",
    title: "Limits Reader",
    chunks: [{ content: "A limit describes the value a function approaches.", id: "primary-limit" }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([normalSource, primarySource]),
    query: "limit value function approaches"
  });

  assert.equal(result.hits[0]?.document.id, "primary-reader");
});

test("source hints keep vague follow-ups on the previous material", () => {
  const previousMaterial = makeDocument({
    id: "practice-problems",
    kind: "assignment",
    materialType: "practice-problems",
    title: "Unit 4 Practice Problems",
    chunks: [{ content: "Part c asks students to compare the intercepts.", id: "practice-c" }]
  });
  const otherMaterial = makeDocument({
    id: "practice-solutions",
    kind: "worked-example",
    materialType: "practice-solutions",
    title: "Unit 4 Practice Solutions",
    chunks: [{ content: "Part c asks students to compare the intercepts.", id: "solutions-c" }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([otherMaterial, previousMaterial]),
    query: "what about part c?",
    sourceHints: [{ title: "Unit 4 Practice Problems" }]
  });

  assert.equal(result.hits[0]?.document.id, "practice-problems");
});

test("page source hints keep vague follow-ups on the same page range", () => {
  const previousReading = makeDocument({
    id: "chapter-reader",
    kind: "textbook",
    title: "Chapter 4 Reader",
    chunks: [
      {
        content: "The comparison test applies when each term is bounded by a convergent series.",
        id: "reader-pages-41-42",
        pageEnd: 42,
        pageStart: 41
      }
    ]
  });
  const nearbyNotes = makeDocument({
    id: "series-notes",
    kind: "lecture-notes",
    title: "Series Notes",
    chunks: [
      {
        content: "The comparison test applies when each term is bounded by a convergent series.",
        id: "series-comparison"
      }
    ]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([nearbyNotes, previousReading]),
    query: "can you explain that example again?",
    sourceHints: [{ pageNumber: 42, title: "Chapter 4 Reader" }]
  });

  assert.equal(result.hits[0]?.chunk.id, "reader-pages-41-42");
});

test("problem number matching handles common student patterns", () => {
  assert.deepEqual(problemNumbersFromText("Can you help with problem 4, Q2, #7, and number 11?"), [
    "4",
    "11",
    "7",
    "2"
  ]);
});

test("problem number matching handles OCR-spaced dotted exercise numbers", () => {
  assert.ok(
    problemNumbersFromText("no 2 14 Given the setup of Exercise 2.13").includes("2.14")
  );
  assert.ok(problemNumbersFromText("2 .14. Given the setup").includes("2.14"));
});

test("concept method queries with equations do not force exact lookup", () => {
  assert.equal(
    hasExactLookupSignal("Explain rank-nullity / how do I prove inequalities like rank(KL) <= rank(L)?"),
    false
  );
  assert.equal(hasExactLookupSignal("where is rank(KL) <= rank(L) in the PDF?"), true);
});

test("problem number match is returned in source metadata", () => {
  const assignment = makeDocument({
    id: "linear-homework",
    kind: "assignment",
    title: "Linear Equations Homework",
    chunks: [{ content: "Problem 4. Solve x + 2 = 8", id: "chunk-4", problemNumbers: ["4"] }]
  });
  const result = rankMaterialChunks({
    candidates: toCandidates([assignment]),
    query: "problem 4"
  });
  const sources = createSourceMetadata(result.hits);

  assert.equal(sources[0]?.title, "Linear Equations Homework");
  assert.equal(sources[0]?.problemNumber, "4");
});

test("keyword fallback works when embeddings are missing", () => {
  const notes = makeDocument({
    id: "equation-notes",
    kind: "lecture-notes",
    title: "Equation Notes",
    chunks: [{ content: "Linear equations use inverse operations.", id: "chunk-notes" }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([notes]),
    query: "How do inverse operations work?"
  });

  assert.equal(result.hits[0]?.chunk.id, "chunk-notes");
});

test("source metadata is returned for retrieved chunks", () => {
  const notes = makeDocument({
    id: "equation-notes",
    kind: "lecture-notes",
    title: "Equation Notes",
    chunks: [{ content: "Linear equations use inverse operations.", id: "chunk-notes" }]
  });

  const result = rankMaterialChunks({
    candidates: toCandidates([notes]),
    query: "inverse operations"
  });
  const sources = createSourceMetadata(result.hits);

  assert.deepEqual(sources[0], {
    materialType: "notes",
    title: "Equation Notes"
  });
});

test("low-confidence retrieval triggers a clarification message", () => {
  const notes = makeDocument({
    id: "notes",
    kind: "lecture-notes",
    title: "Quadratic Notes",
    chunks: [{ content: "Factoring quadratics with the zero product property.", id: "notes-chunk" }]
  });
  const result = rankMaterialChunks({
    candidates: toCandidates([notes]),
    query: "photosynthesis lab conclusion"
  });
  const message = buildLowConfidenceTutorMessage("photosynthesis lab conclusion", true);

  assert.equal(result.confidence, "low");
  assert.match(message, /not confident/i);
  assert.match(message, /paste the exact problem text|worksheet title/i);
});

function makeDocument({
  chunks,
  id,
  kind,
  materialType,
  priority,
  title
}: {
  chunks: Array<{
    content: string;
    id: string;
    pageEnd?: number;
    pageNumber?: number;
    pageStart?: number;
    problemNumbers?: string[];
    vector?: number[];
  }>;
  id: string;
  kind: SourceDocument["kind"];
  materialType?: string;
  priority?: SourceDocument["priority"];
  title: string;
}): SourceDocument {
  return {
    chunks: chunks.map((chunk) => ({
      content: chunk.content,
      documentId: id,
      id: chunk.id,
      label: chunk.id,
      materialId: id,
      materialType: materialType ?? (kind === "assignment" ? "assignment" : "notes"),
      pageEnd: chunk.pageEnd,
      pageNumber: chunk.pageNumber,
      pageStart: chunk.pageStart,
      problemNumbers: chunk.problemNumbers,
      title,
      vector: chunk.vector
    })),
    courseId: "class-a",
    id,
    kind,
    priority,
    status: "ready",
    title,
    uploadedAt: new Date("2026-05-05T00:00:00.000Z").toISOString()
  };
}

function toCandidates(documents: SourceDocument[]) {
  return documents.flatMap((document) => document.chunks.map((chunk) => ({ chunk, document })));
}
