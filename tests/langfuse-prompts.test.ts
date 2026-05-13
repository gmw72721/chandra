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
