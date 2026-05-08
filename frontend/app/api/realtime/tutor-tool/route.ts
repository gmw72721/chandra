import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { creativityToTemperature, responseLengthToMaxTokens } from "@/lib/class-settings";
import {
  buildLearningStrategyTelemetry,
  stripTeacherOnlyTutorResponseFields,
  type LearningStrategyProfileContext
} from "@/lib/learning-strategy-telemetry";
import { defaultOpenRouterModelId } from "@/lib/model-options";
import { buildTutorSystemPrompt, getTeacherClassTutorConfig, toProviderMessages } from "@/lib/prompts";
import {
  askChandraTutorArgsSchema,
  buildRealtimeTutorToolResult,
  dedupeVoiceProgressEvents,
  sanitizeRealtimeKnownContext,
  voiceProgressEventForProgressEvent,
  type AskChandraTutorArgs,
  type RealtimeVoiceProgressEvent
} from "@/lib/realtime-tutor";
import { getActiveStudentLearningProfileTutorContext } from "@/lib/student-learning-profiles-server";
import {
  ConversationPersistenceError,
  prepareStudentConversationPersistence,
  saveAssistantMessage,
  type StudentConversationPersistence
} from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError, type AuthorizedTutorChatScope } from "@/lib/tutor-chat-auth";
import { normalizeTutorResponse } from "@/lib/tutor-response";
import type { ChatMessage, TutorApiResponse } from "@/lib/types";

const maxRealtimeTutorToolPayloadCharacters = 12000;

const realtimeTutorToolRequestSchema = askChandraTutorArgsSchema
  .extend({
    stream: z.boolean().optional()
  })
  .strict();

export async function POST(request: Request) {
  try {
    const body = await readRealtimeTutorToolRequestBody(request);

    if (body.tooLarge) {
      return realtimeTutorToolErrorResponse("Realtime tutor tool request is too large.", 413);
    }

    if (body.invalidJson) {
      return realtimeTutorToolErrorResponse("Invalid Realtime tutor tool request.", 400);
    }

    const parsed = realtimeTutorToolRequestSchema.safeParse(body.value);

    if (!parsed.success) {
      return realtimeTutorToolErrorResponse("Invalid Realtime tutor tool request.", 400);
    }

    const { stream, ...args } = parsed.data;
    const preparedRequest = await buildRealtimeTutorBackendRequest(request, args);

    if (stream) {
      return streamRealtimeTutorTool(preparedRequest);
    }

    return NextResponse.json(await runRealtimeTutorTool(preparedRequest));
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError) {
      return realtimeTutorToolErrorResponse(caughtError.message, caughtError.status);
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return realtimeTutorToolErrorResponse(caughtError.message, caughtError.status);
    }

    if (caughtError instanceof RealtimeTutorToolError) {
      return realtimeTutorToolErrorResponse(caughtError.message, caughtError.status);
    }

    console.error("Realtime tutor tool failed", caughtError);
    return realtimeTutorToolErrorResponse("Chandra could not answer this voice request.", 500);
  }
}

async function buildRealtimeTutorBackendRequest(request: Request, args: AskChandraTutorArgs) {
  const scope = await authorizeTutorChatRequest(request, args.courseId);
  const courseId = scope.classId;
  const teacherClassPromise = getTeacherClassTutorConfig(courseId);
  const studentLearningProfileContextPromise =
    scope.role === "student"
      ? getStudentLearningProfileContextForTutor({
          classId: courseId,
          studentId: scope.uid
        })
      : Promise.resolve(emptyLearningStrategyProfileContext());
  const [teacherClass, studentLearningProfileContext] = await Promise.all([
    teacherClassPromise,
    studentLearningProfileContextPromise
  ]);
  const classModelSettings = teacherClass?.modelSettings;
  const model =
    classModelSettings?.modelId ||
    process.env.DEFAULT_STUDENT_MODEL ||
    process.env.DEFAULT_MODEL ||
    defaultOpenRouterModelId;

  if (model === "demo-guided") {
    throw new TutorChatHttpError("Choose a real OpenRouter model for tutor chat.", 400);
  }

  const studentMessage: ChatMessage = {
    content: args.studentTranscript,
    createdAt: new Date().toISOString(),
    id: `voice-${randomUUID()}`,
    role: "student"
  };
  const messages = [studentMessage];
  const systemPrompt = [
    await buildTutorSystemPrompt({
      courseId,
      retrievalHits: [],
      studentLearningProfileDigest: studentLearningProfileContext.digest,
      teacherClass
    }),
    buildVoiceLangGraphPrompt(args)
  ].join("\n\n");
  const maxTokens = voiceResponseBudgetToMaxTokens(
    args.responseBudget,
    responseLengthToMaxTokens(classModelSettings?.responseLength ?? "medium")
  );
  const persistence = await prepareStudentConversationPersistenceForTutor({
    conversationId: args.conversationId,
    messages,
    modelId: model,
    scope
  });

  return {
    args: {
      ...args,
      courseId,
      knownContext: sanitizeRealtimeKnownContext(args.knownContext)
    },
    backendRequest: {
      answerPolicy: teacherClass?.answerPolicy,
      classId: courseId,
      known_context: sanitizeRealtimeKnownContext(args.knownContext),
      maxTokens,
      messages: toProviderMessages(systemPrompt, messages),
      modelId: model,
      preferred_sections: args.preferredSections,
      professorId: scope.professorId,
      professorName: scope.professorName,
      reasoningEffort: classModelSettings?.reasoningEffort ?? "medium",
      response_budget: args.responseBudget,
      retrieval_mode: args.retrievalMode,
      sourceUsage: teacherClass?.sourceUsage,
      studentLearningProfileContext: privateBackendLearningProfileContext(studentLearningProfileContext),
      temperature: creativityToTemperature(classModelSettings?.creativity ?? 35),
      voice_intent: args.voiceIntent
    },
    learningProfileTelemetryContext: studentLearningProfileContext,
    persistence,
    scope
  };
}

type PreparedRealtimeTutorToolRequest = Awaited<ReturnType<typeof buildRealtimeTutorBackendRequest>>;

async function runRealtimeTutorTool(
  preparedRequest: PreparedRealtimeTutorToolRequest,
  onProgress?: (event: {
    progressEvent: Record<string, unknown>;
    voiceProgressEvent?: RealtimeVoiceProgressEvent;
  }) => void
) {
  const progressEvents: Array<Record<string, unknown>> = [];
  const voiceProgressEvents: RealtimeVoiceProgressEvent[] = [];
  const emittedVoiceProgressKeys = new Set<string>();
  const recordProgress = (progressEvent: Record<string, unknown>) => {
    progressEvents.push(progressEvent);
    const voiceProgressEvent = voiceProgressEventForProgressEvent(progressEvent);
    const shouldEmitVoiceProgressEvent =
      voiceProgressEvent !== null && !emittedVoiceProgressKeys.has(voiceProgressEvent.dedupeKey);

    if (voiceProgressEvent) {
      voiceProgressEvents.push(voiceProgressEvent);
    }

    if (voiceProgressEvent && shouldEmitVoiceProgressEvent) {
      emittedVoiceProgressKeys.add(voiceProgressEvent.dedupeKey);
    }

    onProgress?.({
      progressEvent,
      ...(voiceProgressEvent && shouldEmitVoiceProgressEvent ? { voiceProgressEvent } : {})
    });
  };

  recordProgress({
    message: "Reading your question.",
    stage: "reading_question",
    type: "step"
  });

  const response = await fetch(`${langGraphBackendBaseUrl()}/api/langgraph/chat/stream`, {
    body: JSON.stringify(preparedRequest.backendRequest),
    headers: await backendHeaders(),
    method: "POST"
  });

  if (!response.ok) {
    throw new RealtimeTutorToolError(await readBackendError(response), response.status);
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new RealtimeTutorToolError("Tutor backend stream was missing.", 502);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as Record<string, unknown>;

      if (event.type === "final" && event.payload) {
        recordProgress({
          message: "Writing answer.",
          stage: "writing_answer",
          type: "step"
        });
        const tutorResponse = withLearningStrategyTelemetry(
          normalizeTutorResponse(event.payload as Partial<TutorApiResponse>),
          preparedRequest.learningProfileTelemetryContext
        );
        const responseWithMetadata = studentSafeTutorResponse(
          withConversationMetadata(tutorResponse, preparedRequest.persistence)
        );

        if (preparedRequest.persistence) {
          await saveAssistantMessageWithoutBlockingTutorResponse({
            assistantMessageId: preparedRequest.persistence.assistantMessageId,
            conversationId: preparedRequest.persistence.conversationId,
            modelId: preparedRequest.persistence.modelId,
            response: responseWithMetadata,
            scope: preparedRequest.scope
          });
        }

        return buildRealtimeTutorToolResult({
          args: preparedRequest.args,
          progressEvents,
          response: responseWithMetadata,
          voiceProgressEvents: dedupeVoiceProgressEvents(voiceProgressEvents)
        });
      }

      if (event.type === "error") {
        throw new RealtimeTutorToolError(String(event.message ?? "Tutor backend stream failed."), 502);
      }

      recordProgress(event);
    }
  }

  throw new RealtimeTutorToolError("Tutor backend did not return a final response.", 502);
}

function streamRealtimeTutorTool(preparedRequest: PreparedRealtimeTutorToolRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await runRealtimeTutorTool(preparedRequest, (event) => {
          send({
            progressEvent: event.progressEvent,
            type: "progress",
            ...(event.voiceProgressEvent ? { voiceProgressEvent: event.voiceProgressEvent } : {})
          });
        });

        send({
          payload: result,
          type: "final"
        });
      } catch (caughtError) {
        send({
          error: caughtError instanceof Error ? caughtError.message : "Realtime tutor tool failed.",
          type: "error"
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8"
    }
  });
}

function buildVoiceLangGraphPrompt(args: AskChandraTutorArgs) {
  return [
    "Voice tutor mode:",
    "- The Realtime model is handling speech and routing. LangGraph is the tutoring source of truth.",
    "- Produce structured UI support, not a long spoken script.",
    "- Preferred sections are preferences only; choose the smallest useful set.",
    "- Usually include a nextStep unless the student only asked to locate a source.",
    "- If voiceIntent is find_source, or if the student asks to find, read, show, quote, restate, or pull up a specific problem, exercise, page, passage, or bare reference, treat it as problem-statement/source lookup.",
    "- For problem-statement/source lookup, search the class material, put the full visible problem or passage text in the Answer section with source/page context, do not solve it, and do not replace it with a hint or next step.",
    "- For problem-statement/source lookup, the Answer section must start with `Problem text:` followed by the exact visible wording from the selected source. Do not summarize it as `asks you to...`.",
    "- If the visible problem depends on a setup or referenced exercise that is also visible in retrieved context, include that exact wording under `Referenced setup:`. If the full wording is not visible, state only what is visible and what reference is missing; do not invent.",
    "- For problem-statement/source lookup, omit Hint and nextStep unless the student also explicitly asks for help starting after the problem text is shown.",
    "- Do not include examples unless the student asks or an example clearly helps without completing the exact task.",
    "- Keep output compact when responseBudget is voice_short or ui_compact.",
    `- voiceIntent: ${args.voiceIntent}.`,
    `- preferredSections: ${args.preferredSections.join(", ") || "none"}.`,
    `- retrievalMode: ${args.retrievalMode}.`,
    `- responseBudget: ${args.responseBudget}.`,
    `- knownContext: ${JSON.stringify(sanitizeRealtimeKnownContext(args.knownContext))}.`
  ].join("\n");
}

function voiceResponseBudgetToMaxTokens(responseBudget: AskChandraTutorArgs["responseBudget"], classMaxTokens: number) {
  if (responseBudget === "voice_short") {
    return Math.min(classMaxTokens, 900);
  }

  if (responseBudget === "ui_compact") {
    return Math.min(classMaxTokens, 1600);
  }

  return classMaxTokens;
}

function emptyLearningStrategyProfileContext(): LearningStrategyProfileContext {
  return {
    digest: "",
    strategies: []
  };
}

function privateBackendLearningProfileContext(profileContext: LearningStrategyProfileContext) {
  return {
    availableStrategies: profileContext.strategies.map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      source: strategy.source
    })),
    digest: profileContext.digest,
    strategiesToTryNext: profileContext.strategies
      .filter((strategy) => strategy.source === "strategiesToTryNext")
      .map((strategy) => strategy.label)
  };
}

async function getStudentLearningProfileContextForTutor(input: { classId: string; studentId: string }) {
  try {
    return await getActiveStudentLearningProfileTutorContext(input);
  } catch (caughtError) {
    console.error("Student learning profile skipped for realtime tutor", JSON.stringify({
      classId: input.classId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      studentId: input.studentId
    }));
    return emptyLearningStrategyProfileContext();
  }
}

async function prepareStudentConversationPersistenceForTutor({
  conversationId,
  messages,
  modelId,
  scope
}: {
  conversationId?: string;
  messages: ChatMessage[];
  modelId: string;
  scope: AuthorizedTutorChatScope;
}) {
  try {
    return await prepareStudentConversationPersistence({
      conversationId,
      messages,
      modelId,
      scope
    });
  } catch (caughtError) {
    if (caughtError instanceof ConversationPersistenceError) {
      throw caughtError;
    }

    console.error("Realtime conversation persistence skipped before tutor chat", JSON.stringify({
      classId: scope.classId,
      conversationId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      studentId: scope.uid
    }));
    return null;
  }
}

function withLearningStrategyTelemetry(
  response: TutorApiResponse,
  profileContext: LearningStrategyProfileContext
): TutorApiResponse {
  return {
    ...response,
    learningStrategyTelemetry: buildLearningStrategyTelemetry({
      profileContext,
      response
    })
  };
}

function studentSafeTutorResponse(response: TutorApiResponse): TutorApiResponse {
  return stripTeacherOnlyTutorResponseFields(response);
}

function withConversationMetadata(
  response: TutorApiResponse,
  persistence: StudentConversationPersistence | null
): TutorApiResponse {
  if (!persistence) {
    return response;
  }

  return {
    ...response,
    assistantMessageId: persistence.assistantMessageId,
    conversationId: persistence.conversationId
  };
}

async function saveAssistantMessageWithoutBlockingTutorResponse({
  assistantMessageId,
  conversationId,
  modelId,
  response,
  scope
}: {
  assistantMessageId: string;
  conversationId: string;
  modelId: string;
  response: TutorApiResponse;
  scope: AuthorizedTutorChatScope;
}) {
  try {
    await saveAssistantMessage({
      assistantMessageId,
      conversationId,
      modelId,
      response,
      scope
    });
  } catch (caughtError) {
    console.error("Realtime assistant message persistence skipped", caughtError);
  }
}

function langGraphBackendBaseUrl() {
  const configuredBaseUrl = process.env.BACKEND_API_BASE_URL?.trim();

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://127.0.0.1:8000";
  }

  throw new Error("BACKEND_API_BASE_URL is required in production.");
}

async function backendHeaders() {
  const sharedSecret = process.env.BACKEND_SHARED_SECRET?.trim();

  if (!sharedSecret) {
    throw new Error("BACKEND_SHARED_SECRET is required for tutor backend requests.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Chandra-Internal-Secret": sharedSecret
  };
  const identityToken = await backendIdentityToken();

  if (identityToken) {
    headers["X-Serverless-Authorization"] = `Bearer ${identityToken}`;
  }

  return headers;
}

async function backendIdentityToken() {
  const audience = process.env.BACKEND_ID_TOKEN_AUDIENCE?.trim();

  if (!audience) {
    return "";
  }

  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
    {
      cache: "no-store",
      headers: {
        "Metadata-Flavor": "Google"
      }
    }
  );

  if (!response.ok) {
    throw new Error("BACKEND_ID_TOKEN_AUDIENCE is configured, but App Hosting could not mint a backend identity token.");
  }

  return (await response.text()).trim();
}

async function readBackendError(response: Response) {
  try {
    const payload = await response.json();
    return String(payload.detail ?? payload.error ?? "Tutor backend request failed.");
  } catch {
    return "Tutor backend request failed.";
  }
}

function realtimeTutorToolErrorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

async function readRealtimeTutorToolRequestBody(request: Request) {
  const rawBody = await request.text();

  if (rawBody.length > maxRealtimeTutorToolPayloadCharacters) {
    return { invalidJson: false, tooLarge: true, value: undefined };
  }

  try {
    return { invalidJson: false, tooLarge: false, value: rawBody ? JSON.parse(rawBody) : {} };
  } catch {
    return { invalidJson: true, tooLarge: false, value: undefined };
  }
}

class RealtimeTutorToolError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
