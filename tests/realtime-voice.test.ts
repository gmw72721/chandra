import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  askVoiceTutorRealtimeTool,
  askVoiceTutorToolArgsSchema,
  buildRealtimeSessionConfig,
  defaultRealtimeModel,
  defaultRealtimeReasoningEffort,
  voiceStructuredSectionNames
} from "../frontend/lib/voice-tutor-contracts.ts";

const repoRoot = process.cwd();

test("Realtime voice session defaults to gpt-realtime-2 with low reasoning", () => {
  delete process.env.OPENAI_REALTIME_MODEL;
  delete process.env.OPENAI_REALTIME_REASONING_EFFORT;

  const session = buildRealtimeSessionConfig({ courseId: "class-algebra" });

  assert.equal(session.model, defaultRealtimeModel);
  assert.equal(session.reasoning.effort, defaultRealtimeReasoningEffort);
  assert.equal(session.tools[0].name, "ask_voice_tutor");
});

test("voice tutor tool schema validates request limits and old section names", () => {
  const parsed = askVoiceTutorToolArgsSchema.parse({
    courseId: "class-algebra",
    knownContext: {
      currentStep: "Set the equations equal.",
      knownSourceLabels: ["Worksheet 4 p. 2"]
    },
    preferredSections: ["hint", "nextStep"],
    responseBudget: "voice_short",
    retrievalMode: "none",
    studentTranscript: "Can I get a hint?",
    voiceIntent: "hint"
  });

  assert.equal(parsed.studentTranscript, "Can I get a hint?");
  assert.deepEqual([...voiceStructuredSectionNames], [
    "answer",
    "hint",
    "explanation",
    "formula",
    "example",
    "checkWork",
    "sourceNote",
    "nextStep"
  ]);
  assert.throws(() =>
    askVoiceTutorToolArgsSchema.parse({
      courseId: "class-algebra",
      knownContext: {},
      preferredSections: ["sourceChunk"],
      responseBudget: "voice_short",
      retrievalMode: "none",
      studentTranscript: "x",
      voiceIntent: "hint"
    })
  );
  assert.throws(() =>
    askVoiceTutorToolArgsSchema.parse({
      courseId: "class-algebra",
      knownContext: {},
      preferredSections: ["hint"],
      responseBudget: "voice_short",
      retrievalMode: "none",
      studentTranscript: "x".repeat(4001),
      voiceIntent: "hint"
    })
  );
  assert.equal(askVoiceTutorRealtimeTool.parameters.additionalProperties, false);
});

test("Realtime session endpoint authorizes and never returns the server OpenAI API key", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/realtime/session/route.ts"), "utf8");

  assert.match(source, /authorizeTutorChatRequest/);
  assert.match(source, /process\.env\.OPENAI_API_KEY/);
  assert.match(source, /realtimeClientSecretUrl/);
  assert.match(source, /safeRealtimeSessionResponse/);
  assert.match(source, /clientSecret/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_OPENAI_API_KEY/);
  const safeResponseSource = source.slice(source.indexOf("function safeRealtimeSessionResponse"));
  assert.doesNotMatch(safeResponseSource, /OPENAI_API_KEY|apiKey/);
});

test("voice tutor tool endpoint separates compact Realtime output from full UI output", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/realtime/tutor-tool/route.ts"), "utf8");

  assert.match(source, /authorizeTutorChatRequest/);
  assert.match(source, /prepareStudentConversationPersistence/);
  assert.match(source, /\/api\/voice-tutor\/tool/);
  assert.match(source, /realtimeToolOutput/);
  assert.match(source, /uiResponse/);
  assert.match(source, /compactRealtimeResult/);
});

test("typed chat route stays on the existing LangGraph backend path", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /\/api\/langgraph\/chat/);
  assert.match(source, /\/api\/langgraph\/chat\/stream/);
  assert.doesNotMatch(source, /voice_tutor/);
  assert.doesNotMatch(source, /ask_voice_tutor/);
  assert.doesNotMatch(source, /gpt-realtime-2/);
});
