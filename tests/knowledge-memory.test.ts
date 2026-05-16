import assert from "node:assert/strict";
import test from "node:test";

import { condensedSourceLabels } from "../frontend/lib/chat-message-format.ts";
import { buildChatContextMemory } from "../frontend/lib/chat-context-memory.ts";
import { knowledgeUiColorToken } from "../frontend/lib/knowledge-memory.ts";

test("knowledge usedAs maps to UI color tokens", () => {
  assert.equal(knowledgeUiColorToken("active_problem"), "blue");
  assert.equal(knowledgeUiColorToken("problem_source"), "blue");
  assert.equal(knowledgeUiColorToken("supporting_context"), "neutral");
  assert.equal(knowledgeUiColorToken("definition_reference"), "purple");
  assert.equal(knowledgeUiColorToken("theorem_reference"), "purple");
  assert.equal(knowledgeUiColorToken("example_reference"), "green");
  assert.equal(knowledgeUiColorToken("student_attempt"), "orange");
  assert.equal(knowledgeUiColorToken("not_known"), "neutral");
});

test("knowledge source labels prefer page and problem locators", () => {
  const memory = buildChatContextMemory([
    {
      id: "assistant-1",
      role: "assistant",
      content: "What part are you on?",
      createdAt: "2026-05-13T00:00:00.000Z",
      sources: [
        {
          title: "ACME VOL 1",
          materialType: "problem",
          pageNumber: 98,
          problemNumber: "2.14"
        }
      ]
    }
  ]);

  assert.equal(memory.sourcesUsed?.[0]?.label, "p. 98 · Problem 2.14");
});

test("source chips prefer printed page labels when available", () => {
  const labels = condensedSourceLabels([
    {
      title: "ACME VOL 1",
      materialType: "textbook",
      pageNumber: 127,
      pageStart: 127,
      printedPageNumber: 280,
      printedPageStart: 280,
      problemNumber: "3.4"
    }
  ]);

  assert.deepEqual(labels, ["ACME VOL 1 · problem 3.4 · printed p. 280"]);
});

test("knowledge memory groups retrieved pages under the search query", () => {
  const memory = buildChatContextMemory([
    {
      id: "assistant-1",
      role: "assistant",
      content: "I found Problem 2.20.",
      createdAt: "2026-05-13T00:00:00.000Z",
      langGraphTrace: {
        searchQueries: ["Problem 2.20 ACME VOL 1"],
        selectedPages: [
          {
            title: "ACME VOL 1",
            materialType: "textbook",
            pageStart: 98,
            printedPageStart: 98,
            problemNumbers: ["2.20"],
            retrievalReason: "student_requested_problem",
            searchQuery: "Problem 2.20 ACME VOL 1"
          }
        ],
        stages: ["searching_ocr_metadata"],
        toolCallCount: 1
      }
    }
  ]);

  assert.deepEqual(memory.searchResults, [
    {
      query: "Problem 2.20 ACME VOL 1",
      retrievalReason: "student_requested_problem",
      resultCount: 1,
      pages: [
        {
          materialType: "textbook",
          pageNumber: 98,
          problemNumbers: ["2.20"],
          sourceName: "ACME VOL 1"
        }
      ]
    }
  ]);
});

test("knowledge source labels preserve referenced exercise labels", () => {
  const memory = buildChatContextMemory([
    {
      id: "assistant-1",
      role: "assistant",
      content: "Problem:\n2.14. Given the setup of Exercise 2.13, prove the inequalities.",
      createdAt: "2026-05-13T00:00:00.000Z",
      sources: [
        {
          title: "ACME VOL 1",
          materialType: "problem",
          pageNumber: 98,
          problemNumber: "2.14"
        },
        {
          title: "ACME VOL 1",
          materialType: "problem",
          pageNumber: 58,
          problemNumber: "2.13",
          sourceItemLabel: "Exercise 2.13"
        }
      ]
    }
  ]);

  assert.equal(memory.sourcesUsed?.[1]?.label, "p. 58 · Exercise 2.13");
});

test("saved problems drop leaked support payloads from problem text", () => {
  const memory = buildChatContextMemory([
    {
      id: "assistant-1",
      role: "assistant",
      content: "Problem:\n2.14. Given the setup of Exercise 2.13, prove the rank inequalities.",
      createdAt: "2026-05-13T00:00:00.000Z",
      structuredOutput: {
        sections: {
          problem:
            '2.14. Given the setup of Exercise 2.13, prove the rank inequalities.}{"type":"theorem","topic":"rank-nullity theorem","method":null,"priority":"medium","why":"The student may need the exact theorem statement"}'
        }
      },
      sources: [
        {
          title: "ACME VOL 1",
          materialType: "problem",
          pageNumber: 98,
          problemNumber: "2.14"
        }
      ]
    }
  ]);

  assert.equal(
    memory.savedProblems?.[0]?.problemText,
    "2.14. Given the setup of Exercise 2.13, prove the rank inequalities."
  );
});

test("saved problems fall back to metadata when structured problem text is only support payload", () => {
  const memory = buildChatContextMemory([
    {
      id: "assistant-1",
      role: "assistant",
      content: "I found Problem 2.14 in Chapter 2.",
      createdAt: "2026-05-13T00:00:00.000Z",
      structuredOutput: {
        sections: {
          problem:
            '2.14 and will likely help if the student is stuck on the main idea.}{"type":"theorem","topic":"rank-nullity theorem","method":null,"priority":"medium"}'
        }
      },
      langGraphTrace: {
        selectedMetadataRecords: [
          {
            ocr_text: "2.14. Given the setup of Exercise 2.13, prove the following. (i) rank(KL) <= min(rank(L), rank(K)).",
            page_start: 98,
            problem_numbers: ["2.14"],
            title: "ACME VOL 1"
          }
        ],
        stages: []
      },
      sources: [
        {
          title: "ACME VOL 1",
          materialType: "problem",
          pageNumber: 98,
          problemNumber: "2.14"
        }
      ]
    }
  ]);

  assert.equal(
    memory.savedProblems?.[0]?.problemText,
    "2.14. Given the setup of Exercise 2.13, prove the following. (i) rank(KL) <= min(rank(L), rank(K))."
  );
});
