import assert from "node:assert/strict";
import test from "node:test";

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
