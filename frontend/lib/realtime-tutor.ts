import { z } from "zod";
import type { TutorApiResponse, TutorSource, TutorStructuredSections } from "./types";

export const realtimeVoiceIntents = [
  "hint",
  "show_formula",
  "find_source",
  "explain_step",
  "walkthrough",
  "check_work",
  "clarify",
  "repeat",
  "other"
] as const;

export const realtimeTutorSections = [
  "answer",
  "hint",
  "explanation",
  "formula",
  "example",
  "checkWork",
  "sources",
  "nextStep"
] as const;

export const realtimeRetrievalModes = [
  "auto",
  "none",
  "reuse_sources",
  "search_if_uncertain",
  "force_search"
] as const;

export const realtimeResponseBudgets = ["voice_short", "ui_compact", "ui_full"] as const;

const compactString = (maxLength: number) => z.string().trim().max(maxLength);
const requiredCompactString = (maxLength: number) => compactString(maxLength).min(1);

export const realtimeKnownContextSchema = z.object({
  problemSummary: compactString(500).optional(),
  currentStep: compactString(300).optional(),
  knownFormula: compactString(300).optional(),
  knownSourceLabels: z.array(compactString(160)).max(6).optional(),
  lastSectionsShown: z.array(z.enum(realtimeTutorSections)).max(8).optional(),
  lastAssistantNextStep: compactString(300).optional(),
  hasReliableSourceContext: z.boolean().optional(),
  lastLangGraphMessageId: compactString(200).optional()
});

export const askChandraTutorArgsSchema = z
  .object({
    studentTranscript: requiredCompactString(4000),
    courseId: requiredCompactString(200),
    conversationId: requiredCompactString(200).refine((value) => !value.includes("/")).optional(),
    voiceIntent: z.enum(realtimeVoiceIntents),
    preferredSections: z.array(z.enum(realtimeTutorSections)).max(8),
    retrievalMode: z.enum(realtimeRetrievalModes),
    responseBudget: z.enum(realtimeResponseBudgets),
    knownContext: realtimeKnownContextSchema.optional()
  })
  .strict();

export type AskChandraTutorArgs = z.infer<typeof askChandraTutorArgsSchema>;
export type RealtimeKnownContext = z.infer<typeof realtimeKnownContextSchema>;

export type RealtimeVoiceProgressEvent = {
  dedupeKey: string;
  speak: boolean;
  stage: string;
  voiceLine: string;
};

export const askChandraTutorTool = {
  type: "function",
  name: "ask_chandra_tutor",
  description:
    "Call LangGraph for tutor UI sections, PDF/source lookup, hints, formulas, walkthroughs, and check-work.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      studentTranscript: {
        type: "string"
      },
      courseId: {
        type: "string"
      },
      conversationId: {
        type: "string"
      },
      voiceIntent: {
        type: "string",
        enum: realtimeVoiceIntents
      },
      preferredSections: {
        type: "array",
        items: { type: "string", enum: realtimeTutorSections },
        maxItems: 8
      },
      retrievalMode: {
        type: "string",
        enum: realtimeRetrievalModes
      },
      responseBudget: {
        type: "string",
        enum: realtimeResponseBudgets
      },
      knownContext: {
        type: "object",
        additionalProperties: false,
        properties: {
          problemSummary: { type: "string" },
          currentStep: { type: "string" },
          knownFormula: { type: "string" },
          knownSourceLabels: { type: "array", items: { type: "string" }, maxItems: 6 },
          lastSectionsShown: { type: "array", items: { type: "string", enum: realtimeTutorSections }, maxItems: 8 },
          lastAssistantNextStep: { type: "string" },
          hasReliableSourceContext: { type: "boolean" },
          lastLangGraphMessageId: { type: "string" }
        }
      }
    },
    required: [
      "studentTranscript",
      "courseId",
      "voiceIntent",
      "preferredSections",
      "retrievalMode",
      "responseBudget"
    ]
  }
} as const;

export function realtimeModel() {
  return process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2";
}

export function realtimeVoice() {
  return process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
}

export function realtimeClientSecretTtlSeconds() {
  const parsed = Number.parseInt(process.env.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS || "", 10);
  if (!Number.isFinite(parsed)) {
    return 60;
  }

  return Math.max(30, Math.min(parsed, 300));
}

export function realtimePostInstructionsTokenLimit() {
  const parsed = Number.parseInt(process.env.OPENAI_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT || "", 10);
  if (!Number.isFinite(parsed)) {
    return 1200;
  }

  return Math.max(400, Math.min(parsed, 4000));
}

export function buildRealtimeSessionConfig(input: {
  conversationId?: string;
  courseId: string;
  knownContext?: RealtimeKnownContext;
}) {
  return {
    type: "realtime",
    model: realtimeModel(),
    output_modalities: ["audio"],
    instructions: realtimeVoiceInstructions(input),
    audio: {
      input: {
        noise_reduction: {
          type: "near_field"
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: false,
          interrupt_response: false
        }
      },
      output: {
        voice: realtimeVoice()
      }
    },
    reasoning: {
      effort: "low"
    },
    tools: [askChandraTutorTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: realtimePostInstructionsTokenLimit()
      }
    }
  };
}

export function publicRealtimeSessionConfig(sessionConfig: ReturnType<typeof buildRealtimeSessionConfig>) {
  return {
    audio: {
      outputVoice: sessionConfig.audio.output.voice
    },
    model: sessionConfig.model,
    reasoning: sessionConfig.reasoning,
    toolChoice: sessionConfig.tool_choice,
    toolNames: sessionConfig.tools.map((tool) => tool.name),
    truncation: sessionConfig.truncation
  };
}

export function realtimeVoiceInstructions(input: {
  conversationId?: string;
  courseId: string;
  knownContext?: RealtimeKnownContext;
}) {
  const knownContext = sanitizeRealtimeKnownContext(input.knownContext);
  return [
    "Chandra voice tutor. Speak <=2 short sentences.",
    "Help only when addressed to Chandra, clear tutoring is requested, or user answers Chandra.",
    "If background/unclear/ambiguous, do not speak or call tools.",
    "Call ask_chandra_tutor for tutoring, grounding, sources, hints, formulas, walkthroughs, check-work.",
    "LangGraph decides retrieval/UI. Do not solve from memory when class/PDFs may matter.",
    "Intent map: hint=>hint,nextStep; show_formula=>formula,nextStep; check_work=>checkWork,nextStep.",
    "Source/page/problem lookup=>find_source,[answer,sources],force_search,ui_full; voiceIntent=find_source,preferredSections=[answer,sources],retrievalMode=force_search.",
    "For lookup, say one brief sentence about the problem/passage and that the full text is in chat.",
    "Do not speak progress updates; progress is shown in the app UI.",
    "Use low reasoning for routing; medium only if a response explicitly asks.",
    `courseId=${input.courseId}`,
    input.conversationId ? `conversationId=${input.conversationId}` : "",
    Object.keys(knownContext).length ? `ctx=${realtimeInstructionContext(knownContext)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function realtimeInstructionContext(context: RealtimeKnownContext) {
  return [
    context.problemSummary ? `problem:${compactPlainText(context.problemSummary, 120)}` : "",
    context.currentStep ? `step:${compactPlainText(context.currentStep, 90)}` : "",
    context.knownFormula ? `formula:${compactPlainText(context.knownFormula, 80)}` : "",
    context.knownSourceLabels?.length ? `sources:${context.knownSourceLabels.slice(0, 3).join(";")}` : "",
    context.lastAssistantNextStep ? `next:${compactPlainText(context.lastAssistantNextStep, 90)}` : "",
    typeof context.hasReliableSourceContext === "boolean" ? `reliable:${context.hasReliableSourceContext ? "yes" : "no"}` : "",
    context.lastSectionsShown?.length ? `shown:${context.lastSectionsShown.slice(0, 4).join(",")}` : ""
  ]
    .filter(Boolean)
    .join("|");
}

export function sanitizeRealtimeKnownContext(value: unknown): RealtimeKnownContext {
  const record = isRecord(value) ? value : {};
  const sanitized: RealtimeKnownContext = {};
  const problemSummary = compactPlainText(record.problemSummary, 500);
  const currentStep = compactPlainText(record.currentStep, 300);
  const knownFormula = compactPlainText(record.knownFormula, 300);
  const lastAssistantNextStep = compactPlainText(record.lastAssistantNextStep, 300);
  const lastLangGraphMessageId = compactPlainText(record.lastLangGraphMessageId, 200);
  const knownSourceLabels = compactStringList(record.knownSourceLabels, 6, 160);
  const lastSectionsShown = compactStringList(record.lastSectionsShown, 8, 40).filter(isTutorSection);

  if (problemSummary) {
    sanitized.problemSummary = problemSummary;
  }
  if (currentStep) {
    sanitized.currentStep = currentStep;
  }
  if (knownFormula) {
    sanitized.knownFormula = knownFormula;
  }
  if (knownSourceLabels.length) {
    sanitized.knownSourceLabels = knownSourceLabels;
  }
  if (lastSectionsShown.length) {
    sanitized.lastSectionsShown = lastSectionsShown;
  }
  if (lastAssistantNextStep) {
    sanitized.lastAssistantNextStep = lastAssistantNextStep;
  }
  if (typeof record.hasReliableSourceContext === "boolean") {
    sanitized.hasReliableSourceContext = record.hasReliableSourceContext;
  }
  if (lastLangGraphMessageId) {
    sanitized.lastLangGraphMessageId = lastLangGraphMessageId;
  }

  return sanitized;
}

export function buildRealtimeKnownContext(response: TutorApiResponse): RealtimeKnownContext {
  const sections = response.structuredOutput?.sections;
  const sectionsShown = sections
    ? realtimeTutorSections.filter((section) => section !== "sources" && Boolean(sections[section as keyof TutorStructuredSections]))
    : [];
  const knownSourceLabels = sourceLabels(response.sources);
  const context: RealtimeKnownContext = {
    hasReliableSourceContext: response.retrievalConfidence === "high" && knownSourceLabels.length > 0,
    knownSourceLabels,
    lastSectionsShown: sectionsShown,
    lastLangGraphMessageId: response.assistantMessageId
  };

  if (sections?.answer) {
    context.problemSummary = compactPlainText(sections.answer, 180);
  }
  if (sections?.hint || sections?.explanation || response.message) {
    context.currentStep = compactPlainText(sections?.hint || sections?.explanation || response.message, 140);
  }
  if (sections?.formula) {
    context.knownFormula = compactPlainText(sections.formula, 180);
  }
  if (sections?.nextStep) {
    context.lastAssistantNextStep = compactPlainText(sections.nextStep, 180);
  }

  return sanitizeRealtimeKnownContext(context);
}

export function voiceProgressEventForProgressEvent(event: Record<string, unknown>): RealtimeVoiceProgressEvent | null {
  const stage = typeof event.stage === "string" ? event.stage : "";
  const mapped = voiceProgressByStage[stage];

  if (!mapped) {
    return null;
  }

  return {
    dedupeKey: stage,
    speak: mapped.speak,
    stage,
    voiceLine: mapped.voiceLine
  };
}

export function dedupeVoiceProgressEvents(events: RealtimeVoiceProgressEvent[]) {
  const seen = new Set<string>();
  const deduped: RealtimeVoiceProgressEvent[] = [];

  for (const event of events) {
    if (seen.has(event.dedupeKey)) {
      continue;
    }

    seen.add(event.dedupeKey);
    deduped.push(event);
  }

  return deduped;
}

export function buildRealtimeTutorToolResult(input: {
  args: AskChandraTutorArgs;
  progressEvents: Array<Record<string, unknown>>;
  response: TutorApiResponse & {
    sectionsShown?: string[];
    skippedSections?: Array<{ reason: string; section: string }>;
  };
  voiceProgressEvents: RealtimeVoiceProgressEvent[];
}) {
  const sections = input.response.structuredOutput?.sections;
  const sectionsShown = input.response.sectionsShown?.length
    ? input.response.sectionsShown
    : inferSectionsShown(sections, input.response.sources);
  const sourceLabelList = sourceLabels(input.response.sources);
  const fallbackSourceLabels = compactStringList(input.args.knownContext?.knownSourceLabels, 4, 160);
  const compactResult = {
    currentStep:
      input.args.voiceIntent === "find_source"
        ? "Source text shown in UI."
        : compactPlainText(
            sections?.hint ||
              sections?.explanation ||
              sections?.formula ||
              sections?.checkWork ||
              sections?.answer ||
              input.args.knownContext?.currentStep ||
              "",
            120
          ),
    nextStep: compactPlainText(sections?.nextStep || input.args.knownContext?.lastAssistantNextStep || "", 160),
    searched: Boolean(
      input.response.langGraphTrace?.toolCallCount ||
        input.response.langGraphTrace?.searchQueries?.length ||
        input.response.sources?.length
    ),
    sectionsShown,
    sourceLabels: sourceLabelList.length ? sourceLabelList : fallbackSourceLabels.slice(0, 4),
    uiMessageId: input.response.assistantMessageId,
    voiceReply: buildVoiceReply(sections, input.response.message, input.args.voiceIntent)
  };

  return {
    progressEvents: input.progressEvents,
    realtimeFunctionOutput: compactResult,
    sectionsShown,
    skippedSections: input.response.skippedSections ?? skippedPreferredSections(input.args, sectionsShown),
    uiResponse: input.response,
    voiceProgressEvents: input.voiceProgressEvents
  };
}

function buildVoiceReply(
  sections: TutorStructuredSections | undefined,
  fallbackMessage: string,
  voiceIntent: AskChandraTutorArgs["voiceIntent"]
) {
  const candidate = voiceReplyCandidate(sections, fallbackMessage, voiceIntent);
  const compact = compactPlainText(stripMarkdown(candidate), 220);

  if (!compact) {
    return "I have a short next step ready in the UI.";
  }

  return compact.endsWith(".") || compact.endsWith("?") || compact.endsWith("!") ? compact : `${compact}.`;
}

function voiceReplyCandidate(
  sections: TutorStructuredSections | undefined,
  fallbackMessage: string,
  voiceIntent: AskChandraTutorArgs["voiceIntent"]
) {
  if (voiceIntent === "show_formula") {
    return sections?.formula || sections?.explanation || sections?.nextStep || sections?.answer || fallbackMessage;
  }

  if (voiceIntent === "check_work") {
    return sections?.checkWork || sections?.nextStep || sections?.answer || fallbackMessage;
  }

  if (voiceIntent === "find_source") {
    return buildSourceLookupVoiceReply(sections?.answer || fallbackMessage);
  }

  if (sections?.hint || sections?.nextStep) {
    return "I put a hint and next step in the chat.";
  }

  return (
    sections?.explanation ||
    sections?.formula ||
    sections?.checkWork ||
    sections?.answer ||
    fallbackMessage
  );
}

function buildSourceLookupVoiceReply(answer: string) {
  const problemText = sourceLookupProblemText(answer);

  if (!problemText) {
    return "I put the full problem in the chat.";
  }

  const snippet = compactPlainText(problemText, 170);
  const sentence = snippet.endsWith(".") || snippet.endsWith("?") || snippet.endsWith("!") ? snippet : `${snippet}.`;
  return `The problem says: ${sentence} I put the full text in the chat.`;
}

function sourceLookupProblemText(answer: string) {
  const text = stripMarkdown(answer)
    .replace(/^problem text:\s*/i, "")
    .replace(/\s+(?:source|source context|sources):\s+.*$/i, "")
    .trim();

  return text;
}

function inferSectionsShown(sections: TutorStructuredSections | undefined, sources: TutorSource[]) {
  const shown = sections
    ? realtimeTutorSections.filter((section) => {
        if (section === "sources") {
          return sources.length > 0;
        }
        return Boolean(sections[section as keyof TutorStructuredSections]);
      })
    : [];

  return shown;
}

function skippedPreferredSections(args: AskChandraTutorArgs, sectionsShown: string[]) {
  return args.preferredSections
    .filter((section) => !sectionsShown.includes(section))
    .map((section) => ({
      reason: "LangGraph chose a smaller useful section set for this voice turn.",
      section
    }));
}

function sourceLabels(sources: TutorSource[] = []) {
  return sources
    .slice(0, 4)
    .map((source) => compactPlainText(formatSourceLabel(source), 160))
    .filter(Boolean);
}

function formatSourceLabel(source: TutorSource) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function compactPlainText(value: unknown, maxLength: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, maxLength).trim();
  return clipped.includes(" ") ? clipped.split(" ").slice(0, -1).join(" ").trim() || clipped : clipped;
}

function compactStringList(value: unknown, maxCount: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, maxCount)
    .map((item) => compactPlainText(item, maxLength))
    .filter(Boolean);
}

function isTutorSection(value: string): value is (typeof realtimeTutorSections)[number] {
  return realtimeTutorSections.includes(value as (typeof realtimeTutorSections)[number]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\$+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const voiceProgressByStage: Record<string, { speak: boolean; voiceLine: string }> = {
  reading_question: {
    speak: false,
    voiceLine: "I'm checking what you're asking."
  },
  searching_pages: {
    speak: true,
    voiceLine: "I'm checking the class pages for that."
  },
  opening_pages: {
    speak: true,
    voiceLine: "I found a likely page and I'm opening it."
  },
  reading_pages: {
    speak: false,
    voiceLine: "I'm reading the relevant part now."
  },
  writing_answer: {
    speak: true,
    voiceLine: "I'm turning that into a short next step."
  }
};
