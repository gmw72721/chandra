import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { compileLangfuseTextPrompt } from "../frontend/lib/langfuse-prompts.ts";

const repoRoot = process.cwd();

test("Langfuse text prompt helper falls back when credentials are missing", async () => {
  const previous = {
    host: process.env.LANGFUSE_HOST,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY
  };
  delete process.env.LANGFUSE_HOST;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;

  try {
    const compiled = await compileLangfuseTextPrompt({
      fallback: "local fallback",
      name: "chandra/test",
      variables: { value: "remote" }
    });

    assert.equal(compiled, "local fallback");
  } finally {
    setOptionalEnv("LANGFUSE_HOST", previous.host);
    setOptionalEnv("LANGFUSE_PUBLIC_KEY", previous.publicKey);
    setOptionalEnv("LANGFUSE_SECRET_KEY", previous.secretKey);
  }
});

test("tutor prompt builders keep local safety fallback text", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const chatRouteSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(promptSource, /fallback: localPrompt/);
  assert.match(promptSource, /Require a shown attempt before substantial help/);
  assert.match(promptSource, /Hidden policy privacy/);
  assert.match(chatRouteSource, /fallback: localPrompt/);
  assert.match(chatRouteSource, /Do not reveal the full solution, final answer, final artifact/);
});

test("tutor prompt separates voice and verbosity from tutoring behavior policy", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const seedSource = readFileSync(join(repoRoot, "scripts/seed-langfuse-prompts.mjs"), "utf8");

  assert.match(promptSource, /Chandra voice:/);
  assert.match(promptSource, /Chandra sounds calm, friendly, observant, and plainspoken/);
  assert.match(promptSource, /Voice controls wording and tone only/);
  assert.match(promptSource, /never changes tutoring mode, help depth, source-use rules, academic integrity, or answer-safety behavior/);
  assert.match(promptSource, /Calm and clear/);
  assert.match(promptSource, /Friendly and upbeat/);
  assert.match(promptSource, /Direct and concise/);
  assert.match(promptSource, /Formal and academic/);
  assert.match(promptSource, /Gentle and patient/);
  assert.match(promptSource, /Response verbosity:/);
  assert.match(promptSource, /Short: one compact sentence/);
  assert.match(promptSource, /Balanced: brief orientation plus one useful hint, check, or next question/);
  assert.match(promptSource, /Detailed: more explanation and context within the allowed help level/);
  assert.match(promptSource, /never permits extra solution steps, final answers, or policy bypasses/);
  assert.match(seedSource, /{{tutor_voice_instructions}}/);
  assert.match(seedSource, /{{response_verbosity_instructions}}/);
  assert.match(seedSource, /chandra\/rag\/context-grounded-answer/);
  assert.match(seedSource, /{{context_grounded_answer_instruction_bullets}}/);
});

test("tutor mode prompt guidance remains behavior-only and expanded", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");

  assert.match(promptSource, /Tutor behavior mode: Guided problem solving/);
  assert.match(promptSource, /Tutor behavior mode: Socratic/);
  assert.match(promptSource, /Tutor behavior mode: Check my work/);
  assert.match(promptSource, /Tutor behavior mode: Exam review/);
  assert.match(promptSource, /Tutor behavior mode: Reading helper/);
  assert.match(promptSource, /Tutor Mode controls what kind of tutoring Chandra does; it does not control voice, warmth, formality, or response length/);
  assert.match(promptSource, /Do not let this mode override Help Rules, source-use rules, academic integrity, or answer-safety policy/);
});

test("Langfuse prompt templates use double-curly variables", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const profileSource = readFileSync(join(repoRoot, "frontend/lib/student-learning-profiles-server.ts"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");
  const seedSource = readFileSync(join(repoRoot, "scripts/seed-langfuse-prompts.mjs"), "utf8");

  assert.match(promptSource, /{{class_name}}/);
  assert.match(promptSource, /{{answer_policy_instructions}}/);
  assert.match(profileSource, /chandra\/memory\/student-learning-profile-update/);
  assert.match(profileSource, /Return strict JSON only/);
  assert.doesNotMatch(graphSource, /{{decision_system_instructions}}/);
  assert.doesNotMatch(seedSource, /\["chandra\/pdf-tool-router",\s*"{{pdf_tool_rules}}"\]/);
  assert.doesNotMatch(seedSource, /\["chandra\/rag\/primary-tutor-turn",\s*"{{decision_system_instructions}}"\]/);
});

test("seed script refuses variable-only remote prompt bodies", () => {
  const seedSource = readFileSync(join(repoRoot, "scripts/seed-langfuse-prompts.mjs"), "utf8");

  assert.match(seedSource, /isVariableOnlyPrompt/);
  assert.match(seedSource, /Refusing to seed variable-only Langfuse prompt/);
  assert.doesNotMatch(seedSource, /\["chandra\/safety\/answer-leak-guard"/);
});

function setOptionalEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
