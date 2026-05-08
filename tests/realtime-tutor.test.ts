import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  askChandraTutorArgsSchema,
  buildRealtimeKnownContext,
  buildRealtimeSessionConfig,
  buildRealtimeTutorToolResult,
  sanitizeRealtimeKnownContext,
  voiceProgressEventForProgressEvent
} from "../frontend/lib/realtime-tutor.ts";

const repoRoot = process.cwd();

test("Realtime session defaults to gpt-realtime-2 with low reasoning", () => {
  const previousModel = process.env.OPENAI_REALTIME_MODEL;
  delete process.env.OPENAI_REALTIME_MODEL;

  const config = buildRealtimeSessionConfig({ courseId: "class-1" });

  assert.equal(config.model, "gpt-realtime-2");
  assert.deepEqual(config.reasoning, { effort: "low" });
  assert.equal(config.tools[0].name, "ask_chandra_tutor");
  assert.deepEqual(config.audio.input, {
    noise_reduction: {
      type: "near_field"
    },
    turn_detection: {
      create_response: false,
      eagerness: "low",
      interrupt_response: false,
      type: "semantic_vad"
    }
  });
  assert.equal(config.truncation.token_limits.post_instructions, 1200);

  if (previousModel === undefined) {
    delete process.env.OPENAI_REALTIME_MODEL;
  } else {
    process.env.OPENAI_REALTIME_MODEL = previousModel;
  }
});

test("Realtime session config keeps controller prompt compact", () => {
  const config = buildRealtimeSessionConfig({
    conversationId: "conversation-1",
    courseId: "class-1",
    knownContext: {
      currentStep: "Identify which value the problem asks you to solve for before choosing a formula.",
      hasReliableSourceContext: true,
      knownFormula: "d = rt",
      knownSourceLabels: ["Worksheet 4 p. 2", "Notes 3 p. 7"],
      lastAssistantNextStep: "Which value is unknown?",
      lastSectionsShown: ["hint", "nextStep"],
      problemSummary: "A rate-time-distance problem from the worksheet."
    }
  });

  assert.ok(config.instructions.length < 1200);
  assert.ok(JSON.stringify(config.tools[0]).length < 1700);
  assert.ok(JSON.stringify(config).length < 3400);
});

test("Realtime voice is gated so side conversations do not auto-interrupt", () => {
  const config = buildRealtimeSessionConfig({ courseId: "class-1" });
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.equal(config.audio.input.turn_detection.create_response, false);
  assert.equal(config.audio.input.turn_detection.interrupt_response, false);
  assert.match(config.instructions, /Help only when addressed to Chandra/);
  assert.match(config.instructions, /do not speak or call tools/);
  assert.match(config.instructions, /Do not speak progress updates/);
  assert.match(studentSource, /Checking if that was for Chandra/);
  assert.match(studentSource, /realtimeAddressedResponseInstructions/);
  assert.match(studentSource, /produce no spoken output/);
  assert.match(studentSource, /realtimeTutorToolInProgressRef/);
  assert.match(studentSource, /realtimeResponseInProgressRef\.current \|\| realtimeTutorToolInProgressRef\.current/);
});

test("Realtime source does not contain the forbidden transcription model", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/realtime-tutor.ts"), "utf8");
  const sessionRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/session/route.ts"), "utf8");
  const forbiddenModelPattern = new RegExp(["gpt", "realtime", "whisper"].join("-"));

  assert.doesNotMatch(source, forbiddenModelPattern);
  assert.doesNotMatch(sessionRoute, forbiddenModelPattern);
});

test("Realtime session endpoint never returns the server OpenAI API key", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/realtime/session/route.ts"), "utf8");

  assert.match(source, /process\.env\.OPENAI_API_KEY/);
  assert.match(source, /\/v1\/realtime\/client_secrets/);
  assert.doesNotMatch(source, /OPENAI_API_KEY,\s*$/m);
  assert.doesNotMatch(source, /apiKey:/);
});

test("Realtime endpoints authenticate with tutor chat authorization", () => {
  const sessionRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/session/route.ts"), "utf8");
  const tutorToolRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/tutor-tool/route.ts"), "utf8");

  assert.match(sessionRoute, /authorizeTutorChatRequest\(request, parsed\.data\.courseId\)/);
  assert.match(tutorToolRoute, /authorizeTutorChatRequest\(request, args\.courseId\)/);
});

test("ask_chandra_tutor validates strict schema and compact size", () => {
  const valid = askChandraTutorArgsSchema.parse({
    courseId: "class-1",
    knownContext: {
      currentStep: "identify the unknown",
      hasReliableSourceContext: true,
      knownSourceLabels: ["Worksheet 4 p. 2"]
    },
    preferredSections: ["hint", "nextStep"],
    responseBudget: "voice_short",
    retrievalMode: "reuse_sources",
    studentTranscript: "Can you help me start?",
    voiceIntent: "hint"
  });

  assert.equal(valid.voiceIntent, "hint");
  assert.throws(() =>
    askChandraTutorArgsSchema.parse({
      ...valid,
      extra: "not allowed"
    })
  );
  assert.throws(() => askChandraTutorArgsSchema.parse({ ...valid, studentTranscript: "" }));
  assert.throws(() => askChandraTutorArgsSchema.parse({ ...valid, courseId: "   " }));
});

test("Realtime routes enforce size before parsing JSON", () => {
  const sessionRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/session/route.ts"), "utf8");
  const tutorToolRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/tutor-tool/route.ts"), "utf8");

  assert.match(sessionRoute, /await request\.text\(\)/);
  assert.match(tutorToolRoute, /await request\.text\(\)/);
  assert.doesNotMatch(sessionRoute, /await request\.json\(\)/);
  assert.doesNotMatch(tutorToolRoute, /await request\.json\(\)/);
  assert.match(sessionRoute, /anchor: "created_at"/);
});

test("compact known context excludes full chat, PDF text, source objects, and trace", () => {
  const compact = sanitizeRealtimeKnownContext({
    currentStep: "Use the chain rule.",
    fullChatHistory: "do not include",
    fullPdfText: "do not include",
    knownSourceLabels: ["Worksheet 4 p. 2"],
    langGraphTrace: { searchQueries: ["hidden"] },
    sourceObjects: [{ chunk_text: "hidden" }]
  });

  assert.deepEqual(compact, {
    currentStep: "Use the chain rule.",
    knownSourceLabels: ["Worksheet 4 p. 2"]
  });
});

test("Realtime function output is compact and separate from full UI response", () => {
  const result = buildRealtimeTutorToolResult({
    args: {
      courseId: "class-1",
      preferredSections: ["hint", "nextStep"],
      responseBudget: "voice_short",
      retrievalMode: "auto",
      studentTranscript: "help me start",
      voiceIntent: "hint"
    },
    progressEvents: [{ message: "Reading your question.", stage: "reading_question", type: "step" }],
    response: {
      assistantMessageId: "msg-1",
      content: "Hint: Identify the unknown.\n\nWhat variable are you solving for?",
      langGraphTrace: {
        searchQueries: ["full query should stay in UI only"],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      },
      message: "Hint: Identify the unknown.\n\nWhat variable are you solving for?",
      retrievalConfidence: "low",
      sources: [],
      structuredOutput: {
        metadata: {
          hintLevel: "guided_step",
          mode: "guided_problem_solving",
          sourceConfidence: "low",
          studentActionNeeded: "try_next_step"
        },
        sections: {
          answer: "",
          hint: "Identify the unknown.",
          nextStep: "What variable are you solving for?"
        }
      }
    },
    voiceProgressEvents: []
  });

  assert.equal(result.uiResponse.langGraphTrace?.searchQueries[0], "full query should stay in UI only");
  assert.equal(result.realtimeFunctionOutput.uiMessageId, "msg-1");
  assert.deepEqual(Object.keys(result.realtimeFunctionOutput).sort(), [
    "currentStep",
    "nextStep",
    "searched",
    "sectionsShown",
    "sourceLabels",
    "uiMessageId",
    "voiceReply"
  ].sort());
  assert.equal(JSON.stringify(result.realtimeFunctionOutput).includes("full query should stay in UI only"), false);
});

test("Realtime compact voice reply prefers the current intent section", () => {
  const result = buildRealtimeTutorToolResult({
    args: {
      courseId: "class-1",
      knownContext: {
        currentStep: "This stale previous step should not be spoken first."
      },
      preferredSections: ["formula", "nextStep"],
      responseBudget: "voice_short",
      retrievalMode: "auto",
      studentTranscript: "What formula do I use?",
      voiceIntent: "show_formula"
    },
    progressEvents: [],
    response: {
      content: "Formula: Use d=rt. Which value is unknown?",
      message: "Formula: Use d=rt. Which value is unknown?",
      retrievalConfidence: "low",
      sources: [],
      structuredOutput: {
        metadata: {
          hintLevel: "guided_step",
          mode: "guided_problem_solving",
          sourceConfidence: "low",
          studentActionNeeded: "try_next_step"
        },
        sections: {
          answer: "",
          formula: "Use d=rt.",
          nextStep: "Which value is unknown?"
        }
      }
    },
    voiceProgressEvents: []
  });

  assert.equal(result.realtimeFunctionOutput.voiceReply, "Use d=rt.");
  assert.equal(result.realtimeFunctionOutput.currentStep, "Use d=rt.");
});

test("Realtime source lookup voice reply briefly names the problem", () => {
  const result = buildRealtimeTutorToolResult({
    args: {
      courseId: "class-1",
      preferredSections: ["answer", "sources"],
      responseBudget: "ui_full",
      retrievalMode: "force_search",
      studentTranscript: "Read exercise 2.14.",
      voiceIntent: "find_source"
    },
    progressEvents: [],
    response: {
      content: "Exercise 2.14. Prove the two rank inequalities...",
      message: "Exercise 2.14. Prove the two rank inequalities...",
      retrievalConfidence: "high",
      sources: [{ materialType: "textbook", pageNumber: 87, title: "ACME Textbook" }],
      structuredOutput: {
        metadata: {
          hintLevel: "none",
          mode: "source_lookup",
          sourceConfidence: "high",
          studentActionNeeded: "review_source"
        },
        sections: {
          answer: "Exercise 2.14. Prove the two rank inequalities..."
        }
      }
    },
    voiceProgressEvents: []
  });

  assert.equal(
    result.realtimeFunctionOutput.voiceReply,
    "The problem says: Exercise 2.14. Prove the two rank inequalities... I put the full text in the chat."
  );
  assert.equal(result.realtimeFunctionOutput.currentStep, "Source text shown in UI.");
  assert.equal(JSON.stringify(result.realtimeFunctionOutput).includes("structuredOutput"), false);
  assert.equal(JSON.stringify(result.realtimeFunctionOutput).includes("Prove the two rank inequalities"), true);
});

test("voice progress is separate, short, and not every UI progress event speaks", () => {
  const reading = voiceProgressEventForProgressEvent({
    message: "Reading your question.",
    stage: "reading_question",
    type: "step"
  });
  const searching = voiceProgressEventForProgressEvent({
    message: "Checking exact problem and page",
    stage: "searching_pages",
    type: "search_batch"
  });

  assert.equal(reading?.speak, false);
  assert.equal(searching?.speak, true);
  assert.ok((searching?.voiceLine.length ?? 0) < "Checking exact problem and page".length + 30);
});

test("buildRealtimeKnownContext keeps only compact tutor state", () => {
  const context = buildRealtimeKnownContext({
    assistantMessageId: "assistant-1",
    content: "full markdown answer",
    langGraphTrace: {
      searchQueries: ["hidden"],
      selectedPages: [],
      stages: [],
      toolCallCount: 1
    },
    message: "full markdown answer",
    retrievalConfidence: "high",
    sources: [{ materialType: "worksheet", pageNumber: 2, title: "Worksheet 4" }],
    structuredOutput: {
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "high",
        studentActionNeeded: "try_next_step"
      },
      sections: {
        answer: "Use the setup from Worksheet 4.",
        formula: "$a^2+b^2=c^2$",
        nextStep: "Which side is the hypotenuse?"
      }
    }
  });

  assert.equal(context.hasReliableSourceContext, true);
  assert.deepEqual(context.knownSourceLabels, ["Worksheet 4 p. 2"]);
  assert.equal(JSON.stringify(context).includes("hidden"), false);
});

test("student voice UI does not expose the server OpenAI API key", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /className="student-voice-button"/);
  assert.doesNotMatch(studentSource, /OPENAI_API_KEY/);
  assert.doesNotMatch(studentSource, /process\.env/);
});

test("student voice session uses Firebase auth and ephemeral Realtime client secret", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /const token = await user\.getIdToken\(\)/);
  assert.match(studentSource, /fetch\(apiUrl\("\/api\/realtime\/session"\)/);
  assert.match(studentSource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(studentSource, /courseId: activeCourseIdRef\.current/);
  assert.match(studentSource, /conversationId: activeConversationIdRef\.current \|\| undefined/);
  assert.match(studentSource, /knownContext: realtimeKnownContextRef\.current/);
  assert.match(studentSource, /const ephemeralKey = sessionResponse\.clientSecret\?\.value/);
  assert.match(studentSource, /Authorization: `Bearer \$\{ephemeralKey\}`/);
  assert.match(studentSource, /createDataChannel\("oai-events"\)/);
  assert.match(studentSource, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(studentSource, /https:\/\/api\.openai\.com\/v1\/realtime\/calls/);
});

test("student voice tutor stream appends UI response and returns only compact function output", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /fetch\(apiUrl\("\/api\/realtime\/tutor-tool"\)/);
  assert.match(studentSource, /stream: true/);
  assert.match(studentSource, /appendRealtimeTutorUiResponse\(result\.uiResponse, token\)/);
  assert.match(studentSource, /appendRealtimeTutorVoiceReply\(functionCall\.callId, result\.realtimeFunctionOutput\)/);
  assert.match(studentSource, /sendRealtimeFunctionOutput\(functionCall\.callId, result\.realtimeFunctionOutput\)/);
  assert.match(studentSource, /type: "function_call_output"/);
  assert.match(studentSource, /output: JSON\.stringify\(realtimeFunctionOutput\)/);
  assert.doesNotMatch(studentSource, /output: JSON\.stringify\(result\)/);
  assert.doesNotMatch(studentSource, /output: JSON\.stringify\(result\.uiResponse\)/);
});

test("student voice progress stays in UI and does not create separate Realtime speech", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /updateChatProgressFromRealtimeEvent\(streamEvent\.progressEvent\)/);
  assert.match(studentSource, /trackRealtimeVoiceProgressEvent\(streamEvent\.voiceProgressEvent\)/);
  assert.match(studentSource, /realtimeProgressEventKey\(streamEvent\.progressEvent\)/);
  assert.match(studentSource, /realtimeProgressKeysRef\.current\.has\(progressKey\)/);
  assert.match(studentSource, /realtimeVoiceProgressKeysRef/);
  assert.doesNotMatch(studentSource, /Say exactly this brief progress update/);
  assert.doesNotMatch(studentSource, /setVoiceProgressMessage\(voiceProgressEvent\.voiceLine\)/);
});

test("student voice dialogue panel keeps voice progress separate from answer text", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(studentSource, /VoiceDialoguePanel/);
  assert.match(studentSource, /text: args\.studentTranscript/);
  assert.match(studentSource, /appendRealtimeTutorVoiceReply/);
  assert.match(studentSource, /readRealtimeVoiceReply\(realtimeFunctionOutput\)/);
  assert.match(studentSource, /speaker: "chandra"/);
  assert.match(studentSource, /voiceProgressMessage/);
  assert.match(studentSource, /isVoiceTutorProgressVisible/);
  assert.match(studentSource, /<VoiceDialoguePanel[\s\S]*progressMessage=/);
  assert.doesNotMatch(studentSource, /readRealtimeResponseId/);
  assert.doesNotMatch(studentSource, /appendRealtimeAssistantDialogueDelta/);
  assert.doesNotMatch(studentSource, /finalizeRealtimeAssistantDialogue/);
  assert.match(studentSource, /recentVoiceDialogueTurns/);
  assert.doesNotMatch(studentSource, /queueRealtimeFunctionVoiceReplyCaption/);
  assert.doesNotMatch(studentSource, /startQueuedRealtimeVoiceReplyCaption/);
  assert.doesNotMatch(studentSource, /startRealtimeDialogueTextReveal/);
  assert.doesNotMatch(studentSource, /clearRealtimeDialogueRevealTimers/);
  assert.doesNotMatch(studentSource, /currentSource !== "audio"/);
  assert.doesNotMatch(studentSource, /source === "text" && currentSource === "audio"/);
  assert.doesNotMatch(studentSource, /shouldReplaceTextFallback/);
  assert.doesNotMatch(studentSource, /appendRealtimeFunctionVoiceReply/);
  assert.match(styles, /\.voice-dialogue-progress/);
  assert.match(styles, /\.voice-dialogue-panel/);
  assert.match(styles, /right: 48px/);
});

test("Realtime source lookup is prompted to return problem text instead of hints", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const realtimeSource = readFileSync(join(repoRoot, "frontend/lib/realtime-tutor.ts"), "utf8");
  const toolRoute = readFileSync(join(repoRoot, "frontend/app/api/realtime/tutor-tool/route.ts"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");

  assert.match(studentSource, /isProblemReferenceVoiceRequest/);
  assert.match(studentSource, /voiceIntent: shouldForceSourceLookup \? "find_source"/);
  assert.match(studentSource, /preferredSections: shouldForceSourceLookup \? \["answer", "sources"\]/);
  assert.match(realtimeSource, /lookup=>find_source,\[answer,sources\],force_search,ui_full/);
  assert.match(toolRoute, /Answer section must start with `Problem text:`/);
  assert.match(toolRoute, /put the full visible problem or passage text in the Answer section/);
  assert.match(graphSource, /Answer section must start with `Problem text:`/);
  assert.match(graphSource, /put the full visible problem or passage text in the Answer section/);
  assert.match(graphSource, /source_lookup_problem_text_answer/);
  assert.match(graphSource, /extract_requested_problem_text_from_pages/);
  assert.match(graphSource, /return \{"answer", "sourceNote"\}/);
  assert.match(graphSource, /mode == "force_search" and intent == "find_source"/);
});

test("student typed chat API behavior remains unchanged with voice mode present", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const sendMessageStart = studentSource.indexOf("async function sendMessage");
  const sendMessageEnd = studentSource.indexOf("async function toggleVoiceMode");
  const sendMessageSource = studentSource.slice(sendMessageStart, sendMessageEnd);

  assert.match(sendMessageSource, /async function sendMessage\(event: FormEvent<HTMLFormElement>\)/);
  assert.match(sendMessageSource, /fetch\(apiUrl\("\/api\/chat"\)/);
  assert.match(sendMessageSource, /messages: nextMessages/);
  assert.match(sendMessageSource, /stream: true/);
  assert.match(sendMessageSource, /conversationId: activeSelectedConversationId \|\| undefined/);
  assert.doesNotMatch(sendMessageSource, /clientSecret/);
});
