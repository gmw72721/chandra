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
