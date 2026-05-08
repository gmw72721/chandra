import { z } from "zod";

export const defaultRealtimeModel = "gpt-realtime-2";
export const defaultRealtimeReasoningEffort = "low";
export const realtimeClientSecretUrl = "https://api.openai.com/v1/realtime/client_secrets";

export const voiceIntents = [
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

export const voiceStructuredSectionNames = [
  "answer",
  "hint",
  "explanation",
  "formula",
  "example",
  "checkWork",
  "sourceNote",
  "nextStep"
] as const;

export const voiceToolSectionNames = [...voiceStructuredSectionNames, "sources"] as const;
export const retrievalModes = ["auto", "none", "reuse_sources", "search_if_uncertain", "force_search"] as const;
export const responseBudgets = ["voice_short", "ui_compact", "ui_full"] as const;

const safeDocumentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/"));

export const knownContextSchema = z
  .object({
    problemSummary: z.string().trim().max(600).optional(),
    currentStep: z.string().trim().max(600).optional(),
    knownFormula: z.string().trim().max(600).optional(),
    knownSourceLabels: z.array(z.string().trim().max(120)).max(8).optional(),
    lastSectionsShown: z.array(z.enum(voiceStructuredSectionNames)).max(8).optional(),
    lastAssistantNextStep: z.string().trim().max(600).optional(),
    hasReliableSourceContext: z.boolean().optional(),
    lastVoiceGraphMessageId: safeDocumentIdSchema.optional()
  })
  .strict()
  .default({});

export const askVoiceTutorToolArgsSchema = z
  .object({
    studentTranscript: z.string().trim().min(1).max(4000),
    courseId: z.string().trim().min(1).max(200),
    conversationId: safeDocumentIdSchema.optional(),
    voiceIntent: z.enum(voiceIntents).default("other"),
    preferredSections: z.array(z.enum(voiceToolSectionNames)).max(voiceToolSectionNames.length).default([]),
    retrievalMode: z.enum(retrievalModes).default("auto"),
    responseBudget: z.enum(responseBudgets).default("voice_short"),
    knownContext: knownContextSchema
  })
  .strict();

export type AskVoiceTutorToolArgs = z.infer<typeof askVoiceTutorToolArgsSchema>;
export type VoiceStructuredSectionName = (typeof voiceStructuredSectionNames)[number];

export type RealtimeSessionConfigInput = {
  conversationId?: string;
  courseId?: string;
  model?: string;
};

export function configuredRealtimeModel() {
  return process.env.OPENAI_REALTIME_MODEL?.trim() || defaultRealtimeModel;
}

export function configuredRealtimeReasoningEffort() {
  return process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim().toLowerCase() === "medium"
    ? "medium"
    : defaultRealtimeReasoningEffort;
}

export function buildRealtimeSessionConfig(input: RealtimeSessionConfigInput = {}) {
  const metadata = Object.fromEntries(
    Object.entries({
      component: "voice_tutor",
      conversation_id: input.conversationId,
      course_id: input.courseId
    }).filter(([, value]) => Boolean(value))
  );

  return {
    type: "realtime",
    model: input.model || configuredRealtimeModel(),
    output_modalities: ["audio"],
    instructions: realtimeVoiceTutorInstructions(),
    tools: [askVoiceTutorRealtimeTool],
    tool_choice: "auto",
    max_output_tokens: 700,
    reasoning: {
      effort: configuredRealtimeReasoningEffort()
    },
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: 8000
      }
    },
    audio: {
      input: {
        noise_reduction: {
          type: "near_field"
        },
        transcription: {
          model: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe",
          language: "en"
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: true,
          interrupt_response: true
        }
      },
      output: {
        voice: process.env.OPENAI_REALTIME_VOICE?.trim() || "marin",
        speed: 1
      }
    },
    tracing: {
      workflow_name: "Chandra Voice Tutor",
      metadata
    }
  } as const;
}

export const askVoiceTutorRealtimeTool = {
  type: "function",
  name: "ask_voice_tutor",
  description:
    "Ask Chandra's voice tutor graph for one concise spoken coaching reply and targeted UI support. Do not send full chat history, PDF text, source chunks, or internal traces.",
  parameters: {
    type: "object",
    properties: {
      studentTranscript: {
        type: "string",
        description: "The current student utterance transcript. Keep it to the current turn, not the whole conversation.",
        maxLength: 4000
      },
      courseId: {
        type: "string",
        maxLength: 200
      },
      conversationId: {
        type: "string",
        maxLength: 200
      },
      voiceIntent: {
        type: "string",
        enum: voiceIntents
      },
      preferredSections: {
        type: "array",
        items: {
          type: "string",
          enum: voiceToolSectionNames
        },
        maxItems: voiceToolSectionNames.length
      },
      retrievalMode: {
        type: "string",
        enum: retrievalModes
      },
      responseBudget: {
        type: "string",
        enum: responseBudgets
      },
      knownContext: {
        type: "object",
        additionalProperties: false,
        properties: {
          problemSummary: { type: "string", maxLength: 600 },
          currentStep: { type: "string", maxLength: 600 },
          knownFormula: { type: "string", maxLength: 600 },
          knownSourceLabels: {
            type: "array",
            items: { type: "string", maxLength: 120 },
            maxItems: 8
          },
          lastSectionsShown: {
            type: "array",
            items: {
              type: "string",
              enum: voiceStructuredSectionNames
            },
            maxItems: 8
          },
          lastAssistantNextStep: { type: "string", maxLength: 600 },
          hasReliableSourceContext: { type: "boolean" },
          lastVoiceGraphMessageId: { type: "string", maxLength: 200 }
        }
      }
    },
    required: [
      "studentTranscript",
      "courseId",
      "voiceIntent",
      "preferredSections",
      "retrievalMode",
      "responseBudget",
      "knownContext"
    ],
    additionalProperties: false
  }
} as const;

export type CompactRealtimeToolOutput = {
  voiceReply: string;
  currentStep: string;
  nextStep: string;
  sectionsShown: VoiceStructuredSectionName[];
  searched: boolean;
  sourceLabels: string[];
  uiMessageId?: string;
};

export function realtimeVoiceTutorInstructions() {
  return [
    "You are Chandra in Realtime voice mode. Speak as a concise live tutor.",
    "For class-material help, source lookups, formulas, step explanations, walkthroughs, hints, or work checks, call ask_voice_tutor.",
    "Use compact knownContext only; never send full chat history, PDF text, source chunks, hidden prompts, graph traces, or API keys.",
    "After ask_voice_tutor returns, speak only the voiceReply in one or two short sentences unless the student asks for more.",
    "Do not read progress events, source metadata, markdown, tool details, or debug information aloud.",
    "For simple greetings, repeats, or brief clarifications that do not need class context, answer briefly without a tool call.",
    "Default to low reasoning for low-latency routing; use medium only for ambiguous turns that must choose between source reuse and search."
  ].join(" ");
}
