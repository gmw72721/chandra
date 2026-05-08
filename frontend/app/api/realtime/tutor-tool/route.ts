import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  askVoiceTutorToolArgsSchema,
  configuredRealtimeModel,
  type CompactRealtimeToolOutput
} from "@/lib/voice-tutor-contracts";
import { getActiveStudentLearningProfileTutorContext } from "@/lib/student-learning-profiles-server";
import {
  ConversationPersistenceError,
  prepareStudentConversationPersistence,
  saveAssistantMessage
} from "@/lib/student-conversations-server";
import { getTeacherClassTutorConfig } from "@/lib/prompts";
import { authorizeTutorChatRequest, TutorChatHttpError, type AuthorizedTutorChatScope } from "@/lib/tutor-chat-auth";
import { normalizeStructuredTutorOutput } from "@/lib/tutor-response";
import type { ChatMessage, TutorApiResponse } from "@/lib/types";

type VoiceTutorBackendResult = {
  compactRealtimeResult?: CompactRealtimeToolOutput;
  progressEvents?: unknown[];
  sectionsShown?: string[];
  skippedSections?: unknown[];
  uiResponse?: {
    assistantMessageId?: string;
    compactContext?: unknown;
    content?: string;
    conversationId?: string;
    message?: string;
    retrievalConfidence?: "high" | "medium" | "low";
    sources?: TutorApiResponse["sources"];
    structuredOutput?: unknown;
    voiceGraphTrace?: unknown;
  };
};

type LearningProfileContext = Awaited<ReturnType<typeof getActiveStudentLearningProfileTutorContext>>;

export async function POST(request: Request) {
  try {
    const rawBody = await readJsonObject(request);
    const parsedToolArgs = askVoiceTutorToolArgsSchema.safeParse(extractRawToolArgs(rawBody));

    if (!parsedToolArgs.success) {
      return voiceToolErrorResponse("Voice tutor tool arguments are invalid.", 400);
    }

    const scope = await authorizeTutorChatRequest(request, parsedToolArgs.data.courseId);
    const modelId = configuredRealtimeModel();
    const studentMessage = voiceStudentMessage(rawBody, parsedToolArgs.data.studentTranscript);
    const [teacherClass, learningProfileContext, persistence] = await Promise.all([
      getTeacherClassTutorConfig(scope.classId),
      getStudentLearningProfileContext(scope),
      prepareVoiceConversationPersistence({
        conversationId: parsedToolArgs.data.conversationId,
        message: studentMessage,
        modelId,
        scope
      })
    ]);
    const conversationId = persistence?.conversationId ?? parsedToolArgs.data.conversationId;
    const backendResponse = await fetch(`${voiceTutorBackendBaseUrl()}/api/voice-tutor/tool`, {
      body: JSON.stringify({
        answerPolicy: teacherClass?.answerPolicy,
        assistantMessageId: persistence?.assistantMessageId,
        classId: scope.classId,
        conversationId,
        professorId: scope.professorId,
        professorName: scope.professorName,
        sourceUsage: teacherClass?.sourceUsage,
        studentLearningProfileContext: privateBackendLearningProfileContext(learningProfileContext),
        toolArgs: {
          ...parsedToolArgs.data,
          conversationId,
          courseId: scope.classId
        }
      }),
      headers: await backendHeaders(),
      method: "POST"
    });

    if (!backendResponse.ok) {
      return voiceToolErrorResponse(await readBackendError(backendResponse), backendResponse.status);
    }

    const voiceResult = (await backendResponse.json()) as VoiceTutorBackendResult;
    const payload = responsePayloadForApp(voiceResult, {
      assistantMessageId: persistence?.assistantMessageId,
      conversationId
    });

    if (persistence) {
      await saveVoiceAssistantMessageWithoutBlocking({
        conversationId: persistence.conversationId,
        modelId,
        response: tutorApiResponseFromVoiceResult(payload),
        scope,
        assistantMessageId: persistence.assistantMessageId
      });
    }

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store"
      }
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError) {
      return voiceToolErrorResponse(caughtError.message, caughtError.status);
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return voiceToolErrorResponse(caughtError.message, caughtError.status);
    }

    console.error("Voice tutor tool error", caughtError);
    return voiceToolErrorResponse("Voice tutor failed.", 500);
  }
}

async function readJsonObject(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extractRawToolArgs(rawBody: Record<string, unknown>) {
  if (rawBody.toolArgs && typeof rawBody.toolArgs === "object") {
    return rawBody.toolArgs;
  }

  if (typeof rawBody.arguments === "string") {
    try {
      return JSON.parse(rawBody.arguments);
    } catch {
      return {};
    }
  }

  if (rawBody.arguments && typeof rawBody.arguments === "object") {
    return rawBody.arguments;
  }

  return rawBody;
}

function voiceStudentMessage(rawBody: Record<string, unknown>, transcript: string): ChatMessage {
  const requestedId = typeof rawBody.studentMessageId === "string" ? rawBody.studentMessageId : "";
  const id = requestedId && !requestedId.includes("/") && requestedId.length <= 200 ? requestedId : `voice-${randomUUID()}`;

  return {
    content: transcript,
    createdAt: new Date().toISOString(),
    id,
    role: "student"
  };
}

async function getStudentLearningProfileContext(scope: AuthorizedTutorChatScope): Promise<LearningProfileContext> {
  if (scope.role !== "student") {
    return {
      digest: "",
      strategies: []
    };
  }

  try {
    return await getActiveStudentLearningProfileTutorContext({
      classId: scope.classId,
      studentId: scope.uid
    });
  } catch (caughtError) {
    console.error("Student learning profile skipped for voice tutor", caughtError);
    return {
      digest: "",
      strategies: []
    };
  }
}

async function prepareVoiceConversationPersistence({
  conversationId,
  message,
  modelId,
  scope
}: {
  conversationId?: string;
  message: ChatMessage;
  modelId: string;
  scope: AuthorizedTutorChatScope;
}) {
  try {
    return await prepareStudentConversationPersistence({
      conversationId,
      messages: [message],
      modelId,
      scope
    });
  } catch (caughtError) {
    if (caughtError instanceof ConversationPersistenceError) {
      throw caughtError;
    }

    console.error("Student conversation persistence skipped before voice tutor", caughtError);
    return null;
  }
}

function privateBackendLearningProfileContext(profileContext: LearningProfileContext) {
  return {
    digest: profileContext.digest,
    strategiesToTryNext: profileContext.strategies
      .filter((strategy) => strategy.source === "strategiesToTryNext")
      .map((strategy) => strategy.label),
    availableStrategies: profileContext.strategies.map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      source: strategy.source
    }))
  };
}

function responsePayloadForApp(
  voiceResult: VoiceTutorBackendResult,
  metadata: { assistantMessageId?: string; conversationId?: string }
) {
  const compactRealtimeResult = voiceResult.compactRealtimeResult ?? {
    currentStep: "",
    nextStep: "",
    searched: false,
    sectionsShown: [],
    sourceLabels: [],
    voiceReply: String(voiceResult.uiResponse?.message ?? ""),
    uiMessageId: metadata.assistantMessageId
  };

  return {
    progressEvents: voiceResult.progressEvents ?? [],
    realtimeToolOutput: {
      ...compactRealtimeResult,
      uiMessageId: metadata.assistantMessageId ?? compactRealtimeResult.uiMessageId
    },
    sectionsShown: voiceResult.sectionsShown ?? compactRealtimeResult.sectionsShown,
    skippedSections: voiceResult.skippedSections ?? [],
    uiResponse: {
      ...voiceResult.uiResponse,
      assistantMessageId: metadata.assistantMessageId ?? voiceResult.uiResponse?.assistantMessageId,
      conversationId: metadata.conversationId ?? voiceResult.uiResponse?.conversationId
    }
  };
}

function tutorApiResponseFromVoiceResult(payload: ReturnType<typeof responsePayloadForApp>): TutorApiResponse {
  const message = String(payload.uiResponse.message ?? payload.realtimeToolOutput.voiceReply ?? "");
  const structuredOutput = normalizeStructuredTutorOutput(payload.uiResponse.structuredOutput, message);

  return {
    assistantMessageId: payload.uiResponse.assistantMessageId,
    content: String(payload.uiResponse.content ?? message),
    conversationId: payload.uiResponse.conversationId,
    message,
    retrievalConfidence: payload.uiResponse.retrievalConfidence ?? "low",
    sources: Array.isArray(payload.uiResponse.sources) ? payload.uiResponse.sources : [],
    ...(structuredOutput ? { structuredOutput } : {})
  };
}

async function saveVoiceAssistantMessageWithoutBlocking({
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
    console.error("Voice tutor assistant persistence skipped", caughtError);
  }
}

function voiceTutorBackendBaseUrl() {
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
    throw new Error("BACKEND_SHARED_SECRET is required for voice tutor backend requests.");
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
    return String(payload.detail ?? payload.error ?? "Voice tutor failed.");
  } catch {
    return "Voice tutor failed.";
  }
}

function voiceToolErrorResponse(error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status
    }
  );
}
