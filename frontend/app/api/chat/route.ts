import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  creativityToTemperature,
  normalizeAnswerPolicySettings,
  normalizeSourceUsageSettings,
  responseLengthToMaxTokens,
  type AnswerPolicySettings,
  type SourceUsageSettings
} from "@/lib/class-settings";
import {
  buildLearningStrategyTelemetry,
  stripTeacherOnlyTutorResponseFields,
  type LearningStrategyProfileContext
} from "@/lib/learning-strategy-telemetry";
import {
  AiUsageLimitError,
  estimateAiRequestTokens,
  finalizeAiTokenUsage,
  getClientIpAddress,
  normalizeAiTokenUsage,
  releaseAiTokenReservation,
  reserveAiTokenUsage,
  type AiUsageReservation,
  type AiTokenUsage,
  type StudentAiUsageStatus
} from "@/lib/ai-usage-limits";
import { defaultOpenRouterModelId } from "@/lib/model-options";
import {
  captureException,
  logEvent,
  logApiRequest,
  logProviderFailure,
  requestIdFromRequest,
  withRequestIdHeader
} from "@/lib/observability";
import { buildTutorSystemPrompt, getTeacherClassTutorConfig, toProviderMessages } from "@/lib/prompts";
import { maxStudentAttachmentsPerMessage } from "@/lib/student-attachments-server";
import { writeAuditLog, writeChatErrorReference } from "@/lib/audit-log";
import { getActiveStudentLearningProfileTutorContext } from "@/lib/student-learning-profiles-server";
import {
  ConversationPersistenceError,
  prepareStudentConversationPersistence,
  saveAssistantMessage,
  type StudentConversationPersistence
} from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";
import {
  normalizeStructuredTutorOutput,
  normalizeTutorResponse,
  tutorHintLevels,
  tutorModes,
  tutorStudentActions
} from "@/lib/tutor-response";
import type { ChatMessage, TutorApiResponse, TutorModelCallUsage } from "@/lib/types";

const STUDENT_TUTOR_BACKEND_UNAVAILABLE_MESSAGE =
  "Chandra is having trouble connecting. Try again in a moment.";
const STUDENT_TUTOR_RESPONSE_FAILED_MESSAGE =
  "Chandra is having trouble responding right now. Try again in a moment.";
const maxChatMessagesPerRequest = 40;
const maxChatMessageCharacters = 12000;
const maxChatRequestCharacters = 60000;
const maxAttachmentContextCharacters = 4000;

const safeDocumentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/"));

const chatRequestSchema = z.object({
  attachmentIds: z.array(safeDocumentIdSchema).max(maxStudentAttachmentsPerMessage()).optional(),
  conversationId: safeDocumentIdSchema.optional(),
  courseId: z.string().optional(),
  modelId: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({
      id: safeDocumentIdSchema,
      role: z.enum(["student", "teacher", "assistant", "system"]),
      content: z.string().max(maxChatMessageCharacters),
      createdAt: z.string(),
      langGraphTrace: z
        .object({
          finishReason: z.string().optional(),
          inputTokenBreakdown: z
            .array(
              z.object({
                characters: z.number().optional(),
                detail: z.string().optional(),
                estimatedTokens: z.number(),
                id: z.string(),
                kind: z.string(),
                label: z.string(),
                purpose: z.string().optional(),
                stage: z.string().optional()
              })
            )
            .optional(),
          modelCallUsage: z
            .array(
              z.object({
                inputTokens: z.number(),
                model: z.string(),
                outputTokens: z.number(),
                purpose: z.string(),
                reasoningEffort: z.string().optional(),
                reasoningTokens: z.number(),
                stage: z.string(),
                totalTokens: z.number()
              })
            )
            .optional(),
          searchQueries: z.array(z.string()),
          selectedPages: z.array(
            z.object({
              citationLabel: z.string().optional(),
              docId: z.string().optional(),
              materialType: z.string().optional(),
              pageEnd: z.number().optional(),
              pageStart: z.number().optional(),
              printedPageEnd: z.number().optional(),
              printedPageStart: z.number().optional(),
              title: z.string().optional()
            })
          ),
          stages: z.array(z.string()),
          toolCallCount: z.number()
        })
        .optional(),
      sources: z
        .array(
          z.object({
            citationsRequired: z.boolean().optional(),
            materialType: z.string(),
            pageNumber: z.number().optional(),
            problemNumber: z.string().optional(),
            title: z.string()
          })
        )
        .optional(),
      structuredOutput: z
        .union([
          z.object({
            sections: z.object({
              answer: z.string(),
              problem: z.string().optional(),
              hint: z.string().optional(),
              explanation: z.string().optional(),
              formula: z.string().optional(),
              example: z.string().optional(),
              checkWork: z.string().optional(),
              sourceNote: z.string().optional(),
              nextStep: z.string().optional()
            }),
            metadata: z.object({
              hintLevel: z.enum(tutorHintLevels),
              sourceConfidence: z.enum(["high", "medium", "low"]),
              studentActionNeeded: z.enum(tutorStudentActions),
              mode: z.enum(tutorModes)
            })
          }),
          z.object({
            answer: z.string(),
            nextQuestion: z.string().optional(),
            hintLevel: z.enum(tutorHintLevels),
            sourceConfidence: z.enum(["high", "medium", "low"]),
            studentActionNeeded: z.enum(tutorStudentActions),
            mode: z.enum(tutorModes)
          })
        ])
        .optional()
    })
  ).min(1).max(maxChatMessagesPerRequest)
}).superRefine((value, context) => {
  const totalCharacters = value.messages.reduce((total, message) => total + message.content.length, 0);

  if (totalCharacters > maxChatRequestCharacters) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Chat request is too large.",
      path: ["messages"]
    });
  }
});

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const startedAt = performance.now();
  let response: Response;
  let userId: string | undefined;

  try {
    response = await handlePost(request, requestId, (scopeUserId) => {
      userId = scopeUserId;
    });
  } catch (caughtError) {
    await captureException(caughtError, {
      event: "student_chat.unhandled",
      method: "POST",
      requestId,
      route: "/api/chat",
      userId
    });
    const chatError = reportStudentChatError({
      caughtError,
      code: classifyUnexpectedChatError(caughtError),
      phase: "request",
      requestId,
      userId
    });
    response = NextResponse.json(studentChatErrorPayload(chatError), { status: 500 });
  }

  logApiRequest({
    latencyMs: performance.now() - startedAt,
    method: "POST",
    requestId,
    route: "/api/chat",
    status: response.status,
    userId
  });

  return withRequestIdHeader(response, requestId);
}

async function handlePost(request: Request, requestId: string, setUserId: (userId: string) => void) {
  let preparedRequest: PreparedBackendChatRequest | null = null;

  try {
    const requestBody = await readJsonRequest(request);

    if (!requestBody.ok) {
      const chatError = reportStudentChatError({
        caughtError: requestBody.caughtError,
        code: "CHAT_REQUEST_INVALID",
        phase: "request",
        requestId
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: 400 });
    }

    const parsed = chatRequestSchema.safeParse(requestBody.value);

    if (!parsed.success) {
      const chatError = reportStudentChatError({
        caughtError: parsed.error,
        code: "CHAT_REQUEST_INVALID",
        phase: "request",
        requestId
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: 400 });
    }

    preparedRequest = await buildBackendChatRequest(request, parsed.data);
    setUserId(preparedRequest.scope.uid);

    if (parsed.data.stream) {
      return streamTutorResponse(preparedRequest, requestId);
    }

    const backendRequestStartedAt = performance.now();
    const response = await fetch(`${langGraphBackendBaseUrl()}/api/langgraph/chat`, {
      body: JSON.stringify(preparedRequest.backendRequest),
      headers: await backendHeaders(requestId),
      method: "POST"
    });
    const backendDurationMs = performance.now() - backendRequestStartedAt;

    if (!response.ok) {
      await releaseAiTokenReservationSafely(preparedRequest.aiUsageReservation, requestId);
      const detail = await readBackendError(response);
      const chatError = reportStudentChatError({
        backendDetail: detail,
        backendStatus: response.status,
        classId: preparedRequest.scope.classId,
        code: classifyBackendResponseError(response.status, detail),
        conversationId: preparedRequest.persistence?.conversationId,
        phase: "response",
        requestId,
        userId: preparedRequest.scope.uid,
        userRole: preparedRequest.scope.role
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: response.status });
    }

    const backendPayload = (await response.json()) as RawTutorApiResponse;
    const actualTokens = actualTokenUsageFromTutorPayload(backendPayload);
    const usageStatus = await finalizeAiTokenUsage({
      actualUsage: actualTokens,
      reservation: preparedRequest.aiUsageReservation
    });
    const tutorResponse = withLearningStrategyTelemetry(
      normalizeTutorResponse(backendPayload),
      preparedRequest.learningProfileTelemetryContext
    );

    if (preparedRequest.persistence) {
      await saveAssistantMessageWithoutBlockingTutorResponse({
        assistantMessageId: preparedRequest.persistence.assistantMessageId,
        conversationId: preparedRequest.persistence.conversationId,
        modelId: preparedRequest.persistence.modelId,
        requestId,
        response: tutorResponse,
        scope: preparedRequest.scope
      });
    }

    return NextResponse.json(
      withStudentAiUsageStatus(
        tutorResponseForScope({
          actualTokens,
          backendPayload,
          durationMs: backendDurationMs,
          preparedRequest,
          requestId,
          response: withConversationMetadata(tutorResponse, preparedRequest.persistence)
        }),
        usageStatus ?? preparedRequest.aiUsageReservation?.studentStatus
      )
    );
  } catch (caughtError) {
    if (!(caughtError instanceof AiUsageLimitError)) {
      await releaseAiTokenReservationSafely(preparedRequest?.aiUsageReservation ?? null, requestId);
    }

    if (caughtError instanceof AiUsageLimitError) {
      await logChatAccessDecision({
        classId: preparedRequest?.scope.classId,
        decision: "quota_exceeded",
        metadata: {
          quotaScope: caughtError.quotaScope
        },
        requestId,
        userId: preparedRequest?.scope.uid
      });
      const chatError = reportStudentChatError({
        caughtError,
        code: "CHAT_AI_USAGE_EXHAUSTED",
        classId: preparedRequest?.scope.classId,
        conversationId: preparedRequest?.persistence?.conversationId,
        phase: "response",
        requestId,
        userId: preparedRequest?.scope.uid,
        userRole: preparedRequest?.scope.role
      });
      return NextResponse.json(
        {
          ...studentChatErrorPayload(chatError),
          aiUsageStatus: caughtError.studentStatus
        },
        { status: caughtError.status }
      );
    }

    if (caughtError instanceof TutorChatHttpError) {
      if (caughtError.decision) {
        await logChatAccessDecision({
          classId: caughtError.classId,
          decision: caughtError.decision,
          requestId,
          userId: caughtError.userId
        });
      }
      const chatError = reportStudentChatError({
        caughtError,
        code: classifyTutorChatHttpError(caughtError),
        classId: preparedRequest?.scope.classId ?? caughtError.classId,
        conversationId: preparedRequest?.persistence?.conversationId,
        phase: "request",
        requestId,
        userId: preparedRequest?.scope.uid ?? caughtError.userId
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      const chatError = reportStudentChatError({
        caughtError,
        code: classifyConversationPersistenceError(caughtError),
        classId: preparedRequest?.scope.classId,
        conversationId: preparedRequest?.persistence?.conversationId,
        phase: "response",
        requestId,
        userId: preparedRequest?.scope.uid,
        userRole: preparedRequest?.scope.role
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: caughtError.status });
    }

    const chatError = reportStudentChatError({
      caughtError,
      code: classifyUnexpectedChatError(caughtError),
      classId: preparedRequest?.scope.classId,
      conversationId: preparedRequest?.persistence?.conversationId,
      phase: "response",
      requestId,
      userId: preparedRequest?.scope.uid,
      userRole: preparedRequest?.scope.role
    });
    return NextResponse.json(studentChatErrorPayload(chatError), { status: 500 });
  }
}

type ParsedChatRequest = z.infer<typeof chatRequestSchema>;
type RawTutorApiResponse = Partial<TutorApiResponse> & {
  tokenUsage?: {
    actual?: unknown;
    calls?: unknown;
  };
};

async function readJsonRequest(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as unknown };
  } catch (caughtError) {
    return { caughtError, ok: false as const };
  }
}

async function buildBackendChatRequest(request: Request, data: ParsedChatRequest) {
  const scope = await authorizeTutorChatRequest(request, data.courseId);
  const courseId = scope.classId;
  const teacherClassPromise = getTeacherClassTutorConfig(courseId);
  const studentLearningProfileContextPromise =
    scope.role === "student"
      ? getStudentLearningProfileContextForTutor({
          classId: courseId,
          studentId: scope.uid
        })
      : Promise.resolve(emptyLearningStrategyProfileContext());
  const messages = data.messages.map((message) => ({
    ...message,
    structuredOutput: normalizeStructuredTutorOutput(message.structuredOutput, message.content)
  })) as ChatMessage[];
  const [teacherClass, studentLearningProfileContext] = await Promise.all([
    teacherClassPromise,
    studentLearningProfileContextPromise
  ]);
  const classModelSettings = teacherClass?.modelSettings;
  const model =
    classModelSettings?.modelId ||
    data.modelId ||
    process.env.DEFAULT_STUDENT_MODEL ||
    process.env.DEFAULT_MODEL ||
    defaultOpenRouterModelId;
  const temperature = creativityToTemperature(classModelSettings?.creativity ?? 35);
  const maxTokens = responseLengthToMaxTokens(classModelSettings?.responseLength ?? "medium");
  const reasoningEffort = classModelSettings?.reasoningEffort ?? "medium";

  if (model === "demo-guided") {
    throw new TutorChatHttpError("Choose a real OpenRouter model for tutor chat.", 400);
  }

  const systemPrompt = [
    await buildTutorSystemPrompt({
      courseId,
      retrievalHits: [],
      studentLearningProfileDigest: studentLearningProfileContext.digest,
      teacherClass
    }),
    buildPdfToolChoosingTutorSystemPrompt(teacherClass?.sourceUsage, teacherClass?.answerPolicy)
  ].join("\n\n");

  const persistence = await prepareStudentConversationPersistenceForTutor({
    attachmentIds: data.attachmentIds ?? [],
    conversationId: data.conversationId,
    messages,
    modelId: model,
    scope
  });
  const providerMessages = toProviderMessages(
    systemPrompt,
    appendAttachmentContextToStudentMessage(messages, persistence)
  );
  const estimatedTokens = estimateAiRequestTokens({
    attachmentCount: persistence?.attachments.length ?? 0,
    maxTokens,
    messages: providerMessages,
    useClassMaterialsFirst: teacherClass?.sourceUsage?.useClassMaterialsFirst !== false
  });
  const aiUsageReservation = scope.role === "teacher"
    ? null
    : await reserveAiTokenUsage({
        classId: courseId,
        estimatedInputTokens: Math.max(1, estimatedTokens - maxTokens),
        estimatedOutputTokens: maxTokens,
        estimatedTokens,
        ipAddress: getClientIpAddress(request),
        modelId: model,
        provider: "langgraph",
        requestLimits: classModelSettings?.requestLimits,
        role: scope.role,
        studentId: scope.uid,
        tokenLimits: classModelSettings?.tokenLimits,
        userId: scope.uid
      });

  return {
    aiUsageReservation,
    backendRequest: {
      classId: courseId,
      conversationId: persistence?.conversationId,
      latestStudentMessageId: persistence?.studentMessage.id,
      professorId: scope.professorId,
      professorName: scope.professorName,
      studentId: scope.role === "student" ? scope.uid : undefined,
      modelId: model,
      temperature,
      maxTokens,
      reasoningEffort,
      answerPolicy: teacherClass?.answerPolicy,
          aiUsageReservation: aiUsageReservation
        ? {
            estimatedTokens: aiUsageReservation.estimatedTokens,
            id: aiUsageReservation.id,
            studentId: scope.role === "student" ? scope.uid : undefined
          }
        : undefined,
      sourceUsage: teacherClass?.sourceUsage,
      studentLearningProfileContext: privateBackendLearningProfileContext(studentLearningProfileContext),
      messages: providerMessages
    },
    learningProfileTelemetryContext: studentLearningProfileContext,
    persistence,
    scope
  };
}

type PreparedBackendChatRequest = Awaited<ReturnType<typeof buildBackendChatRequest>>;

function emptyLearningStrategyProfileContext(): LearningStrategyProfileContext {
  return {
    digest: "",
    strategies: []
  };
}

function privateBackendLearningProfileContext(profileContext: LearningStrategyProfileContext) {
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

async function getStudentLearningProfileContextForTutor(input: { classId: string; studentId: string }) {
  try {
    return await getActiveStudentLearningProfileTutorContext(input);
  } catch (caughtError) {
    console.error("Student learning profile skipped for tutor chat", JSON.stringify({
      classId: input.classId,
      message: errorMessageForLog(caughtError),
      studentId: input.studentId
    }));
    return emptyLearningStrategyProfileContext();
  }
}

async function prepareStudentConversationPersistenceForTutor({
  attachmentIds,
  conversationId,
  messages,
  modelId,
  scope
}: {
  attachmentIds: string[];
  conversationId?: string;
  messages: ChatMessage[];
  modelId: string;
  scope: Awaited<ReturnType<typeof authorizeTutorChatRequest>>;
}) {
  try {
    return await prepareStudentConversationPersistence({
      attachmentIds,
      conversationId,
      messages,
      modelId,
      scope
    });
  } catch (caughtError) {
    if (caughtError instanceof ConversationPersistenceError) {
      throw caughtError;
    }

    console.error("Student conversation persistence skipped before tutor chat", JSON.stringify({
      classId: scope.classId,
      conversationId,
      message: errorMessageForLog(caughtError),
      studentId: scope.uid
    }));
    return null;
  }
}

function appendAttachmentContextToStudentMessage(
  messages: ChatMessage[],
  persistence: StudentConversationPersistence | null
) {
  if (!persistence?.attachments.length) {
    return messages;
  }

  return messages.map((message) => {
    if (message.id !== persistence.studentMessage.id || message.role !== "student") {
      return message;
    }

    return {
      ...message,
      attachments: persistence.attachments,
      content: [
        message.content,
        buildAttachmentTutorContext(persistence.attachments)
      ].filter(Boolean).join("\n\n")
    };
  });
}

function buildAttachmentTutorContext(attachments: StudentConversationPersistence["attachments"]) {
  const lines = [
    "Student uploaded homework attachments for this message:",
    ...attachments.map((attachment, index) => {
      const details = [
        `${index + 1}. ${attachment.fileName}`,
        `${attachment.fileType.toUpperCase()}`,
        formatAttachmentSize(attachment.fileSize),
        attachment.pageCount ? `${attachment.pageCount} page${attachment.pageCount === 1 ? "" : "s"}` : ""
      ].filter(Boolean).join(" | ");
      const extractedText = attachment.extractedText?.trim();

      if (extractedText) {
        return `${details}\nExtracted text:\n${extractedText.slice(0, maxAttachmentContextCharacters)}`;
      }

      return `${details}\nNo readable PDF text was stored for this attachment. Do not invent file contents; ask the student to upload a text-readable PDF or paste the relevant problem text.`;
    })
  ];

  return lines.join("\n");
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown size";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${Math.ceil(bytes / 1024)} KB`;
}

function streamTutorResponse(preparedRequest: PreparedBackendChatRequest, requestId: string) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        send({
          message: "Deciding whether class PDFs are needed.",
          stage: "reading_question",
          type: "step"
        });

        const backendRequestStartedAt = performance.now();
        const response = await fetch(`${langGraphBackendBaseUrl()}/api/langgraph/chat/stream`, {
          body: JSON.stringify(preparedRequest.backendRequest),
          headers: await backendHeaders(requestId),
          method: "POST"
        });

        if (!response.ok) {
          await releaseAiTokenReservationSafely(preparedRequest.aiUsageReservation, requestId);
          const detail = await readBackendError(response);
          const chatError = reportStudentChatError({
            backendDetail: detail,
            backendStatus: response.status,
            classId: preparedRequest.scope.classId,
            code: classifyBackendResponseError(response.status, detail),
            conversationId: preparedRequest.persistence?.conversationId,
            phase: "stream",
            requestId,
            userId: preparedRequest.scope.uid,
            userRole: preparedRequest.scope.role
          });
          send({
            errorCode: chatError.code,
            errorId: chatError.errorId,
            message: studentChatErrorMessage(chatError),
            stage: "error",
            type: "error"
          });
          return;
        }

        const reader = response.body?.getReader();

        if (!reader) {
          const chatError = reportStudentChatError({
            code: "TUTOR_BACKEND_STREAM_MISSING",
            classId: preparedRequest.scope.classId,
            conversationId: preparedRequest.persistence?.conversationId,
            phase: "stream",
            requestId,
            userId: preparedRequest.scope.uid,
            userRole: preparedRequest.scope.role
          });
          send({
            errorCode: chatError.code,
            errorId: chatError.errorId,
            message: studentChatErrorMessage(chatError),
            stage: "error",
            type: "error"
          });
          return;
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
              const backendPayload = event.payload as RawTutorApiResponse;
              const actualTokens = actualTokenUsageFromTutorPayload(backendPayload);
              const usageStatus = await finalizeAiTokenUsage({
                actualUsage: actualTokens,
                reservation: preparedRequest.aiUsageReservation
              });
              const tutorResponse = withLearningStrategyTelemetry(
                normalizeTutorResponse(backendPayload),
                preparedRequest.learningProfileTelemetryContext
              );

              if (preparedRequest.persistence) {
                await saveAssistantMessageWithoutBlockingTutorResponse({
                  assistantMessageId: preparedRequest.persistence.assistantMessageId,
                  conversationId: preparedRequest.persistence.conversationId,
                  modelId: preparedRequest.persistence.modelId,
                  requestId,
                  response: tutorResponse,
                  scope: preparedRequest.scope
                });
              }

              send({
                payload: withStudentAiUsageStatus(
                  tutorResponseForScope({
                    actualTokens,
                    backendPayload,
                    durationMs: performance.now() - backendRequestStartedAt,
                    preparedRequest,
                    requestId,
                    response: withConversationMetadata(tutorResponse, preparedRequest.persistence)
                  }),
                  usageStatus ?? preparedRequest.aiUsageReservation?.studentStatus
                ),
                type: "final"
              });
            } else if (event.type === "error") {
              await releaseAiTokenReservationSafely(preparedRequest.aiUsageReservation, requestId);
              const backendDetail = typeof event.message === "string" ? event.message : "";
              const chatError = reportStudentChatError({
                backendDetail,
                code: classifyBackendStreamError(backendDetail),
                classId: preparedRequest.scope.classId,
                conversationId: preparedRequest.persistence?.conversationId,
                phase: "stream",
                requestId,
                userId: preparedRequest.scope.uid,
                userRole: preparedRequest.scope.role
              });
              send({
                errorCode: chatError.code,
                errorId: chatError.errorId,
                message: studentChatErrorMessage(chatError),
                stage: "error",
                type: "error"
              });
            } else {
              send(event);
            }
          }
        }
      } catch (caughtError) {
        await releaseAiTokenReservationSafely(preparedRequest.aiUsageReservation, requestId);
        const chatError = reportStudentChatError({
          caughtError,
          code: classifyUnexpectedChatError(caughtError),
          classId: preparedRequest.scope.classId,
          conversationId: preparedRequest.persistence?.conversationId,
          phase: "stream",
          requestId,
          userId: preparedRequest.scope.uid,
          userRole: preparedRequest.scope.role
        });
        send({
          errorCode: chatError.code,
          errorId: chatError.errorId,
          message: studentChatErrorMessage(chatError),
          stage: "error",
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

type StudentChatErrorCode =
  | "CHAT_CLASS_DISABLED"
  | "CHAT_STUDENT_BLOCKED"
  | "CHAT_CLASS_NOT_FOUND"
  | "CHAT_CLASS_REQUIRED"
  | "CHAT_AI_USAGE_EXHAUSTED"
  | "CHAT_CONVERSATION_FORBIDDEN"
  | "CHAT_CONVERSATION_ID_INVALID"
  | "CHAT_CONVERSATION_NOT_FOUND"
  | "CHAT_MODEL_NOT_CONFIGURED"
  | "CHAT_PROFILE_REQUIRED"
  | "CHAT_REQUEST_INVALID"
  | "CHAT_ROLE_UNSUPPORTED"
  | "CHAT_SIGN_IN_REQUIRED"
  | "CHAT_STUDENT_EMAIL_REQUIRED"
  | "CHAT_TEACHER_SETUP_REQUIRED"
  | "CHAT_TEACHER_PREVIEW_FORBIDDEN"
  | "CHAT_TEACHER_PREVIEW_CLASS_REQUIRED"
  | "TUTOR_BACKEND_AUTH_FAILED"
  | "TUTOR_BACKEND_ERROR"
  | "TUTOR_BACKEND_RATE_LIMITED"
  | "TUTOR_BACKEND_REQUEST_TOO_LARGE"
  | "TUTOR_BACKEND_REQUEST_FAILED"
  | "TUTOR_BACKEND_SETUP_INCOMPLETE"
  | "TUTOR_BACKEND_STREAM_FAILED"
  | "TUTOR_BACKEND_STREAM_INVALID"
  | "TUTOR_BACKEND_STREAM_MISSING"
  | "TUTOR_BACKEND_TIMEOUT"
  | "TUTOR_BACKEND_UNREACHABLE"
  | "TUTOR_CHAT_FAILED";

type ReportedStudentChatError = {
  code: StudentChatErrorCode;
  errorId: string;
  studentMessage: string;
};

function reportStudentChatError({
  backendDetail,
  backendStatus,
  classId,
  caughtError,
  code,
  conversationId,
  phase,
  requestId,
  userId,
  userRole
}: {
  backendDetail?: string;
  backendStatus?: number;
  classId?: string;
  caughtError?: unknown;
  code: StudentChatErrorCode;
  conversationId?: string;
  phase?: "request" | "response" | "stream";
  requestId?: string;
  userId?: string;
  userRole?: string;
}): ReportedStudentChatError {
  const errorId = randomUUID().slice(0, 8).toUpperCase();
  const studentMessage = studentMessageForChatError(code);
  const providerMetadata = backendStatus || code.startsWith("TUTOR_BACKEND_")
    ? {
        provider: "fastapi-backend",
        providerErrorClass: code,
        providerStatus: backendStatus
      }
    : {};

  if (providerMetadata.provider) {
    logProviderFailure({
      provider: providerMetadata.provider,
      providerErrorClass: providerMetadata.providerErrorClass,
      providerStatus: providerMetadata.providerStatus,
      requestId,
      route: "/api/chat"
    });
  }

  console.error("Student chat error", JSON.stringify({
    backendBaseUrl: langGraphBackendBaseUrlForLog(),
    backendDetail,
    backendStatus,
    classId,
    code,
    conversationId,
    errorId,
    message: errorMessageForLog(caughtError),
    phase,
    requestId,
    ...providerMetadata
  }));

  void writeChatErrorReference({
    backendDetail,
    backendStatus,
    classId,
    code,
    conversationId,
    errorId,
    message: errorMessageForLog(caughtError),
    phase,
    provider: providerMetadata.provider,
    providerErrorClass: providerMetadata.providerErrorClass,
    providerStatus: providerMetadata.providerStatus,
    requestId,
    route: "/api/chat",
    userId,
    userRole
  });

  return {
    code,
    errorId,
    studentMessage
  };
}

function langGraphBackendBaseUrlForLog() {
  try {
    return langGraphBackendBaseUrl();
  } catch {
    return "<missing BACKEND_API_BASE_URL>";
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

function tutorResponseForScope({
  actualTokens,
  backendPayload,
  durationMs,
  preparedRequest,
  requestId,
  response
}: {
  actualTokens: AiTokenUsage;
  backendPayload: RawTutorApiResponse;
  durationMs: number;
  preparedRequest: PreparedBackendChatRequest;
  requestId: string;
  response: TutorApiResponse;
}): TutorApiResponse {
  const safeResponse = studentSafeTutorResponse(response);

  if (preparedRequest.scope.role !== "teacher") {
    return safeResponse;
  }

  return {
    ...safeResponse,
    debugInfo: buildTutorDebugInfo({
      actualTokens,
      backendPayload,
      durationMs,
      preparedRequest,
      requestId
    })
  };
}

function buildTutorDebugInfo({
  actualTokens,
  backendPayload,
  durationMs,
  preparedRequest,
  requestId
}: {
  actualTokens: AiTokenUsage;
  backendPayload: RawTutorApiResponse;
  durationMs: number;
  preparedRequest: PreparedBackendChatRequest;
  requestId: string;
}) {
  const trace = backendPayload.langGraphTrace;
  const stages = Array.isArray(trace?.stages) ? trace.stages.map(String) : [];
  const modelCallUsage = normalizeModelCallUsage(backendPayload.tokenUsage?.calls ?? trace?.modelCallUsage);
  const providerRequestCount = Math.max(
    modelCallUsage.length,
    countProviderStages(stages),
    actualTokens.totalTokens > 0 ? 1 : 0
  );
  const toolCallCount = nonnegativeDebugInteger(trace?.toolCallCount);
  const searchQueryCount = Array.isArray(trace?.searchQueries) ? trace.searchQueries.length : 0;
  const inputTokenBreakdown = normalizeInputTokenBreakdown(trace?.inputTokenBreakdown);
  const estimatedOutputTokens = nonnegativeDebugInteger(preparedRequest.backendRequest.maxTokens);
  const estimatedTotalTokens = nonnegativeDebugInteger(preparedRequest.aiUsageReservation?.estimatedTokens);
  const estimatedInputTokens = Math.max(0, estimatedTotalTokens - estimatedOutputTokens);

  return {
    actualTokens,
    backendRequestCount: 1,
    durationMs: Math.max(0, Math.round(durationMs)),
    estimatedTokens: {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      reasoningTokens: 0,
      totalTokens: estimatedTotalTokens
    },
    finishReason: typeof trace?.finishReason === "string" ? trace.finishReason : undefined,
    inputTokenBreakdown,
    modelCallUsage,
    modelId: preparedRequest.backendRequest.modelId,
    provider: "langgraph",
    providerRequestCount,
    requestId,
    searchQueryCount,
    selectedPageCount: Array.isArray(trace?.selectedPages) ? trace.selectedPages.length : 0,
    stageCount: stages.length,
    stages,
    toolCallCount,
    totalRequestCount: 1 + providerRequestCount + toolCallCount
  };
}

function normalizeInputTokenBreakdown(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => ({
      characters: nonnegativeDebugInteger(item.characters),
      detail: typeof item.detail === "string" ? item.detail : "",
      estimatedTokens: nonnegativeDebugInteger(item.estimatedTokens ?? item.estimated_tokens),
      id: String(item.id ?? `input-section-${index + 1}`),
      kind: String(item.kind ?? "unknown"),
      label: String(item.label ?? `Input section ${index + 1}`),
      purpose: item.purpose ? String(item.purpose) : undefined,
      stage: item.stage ? String(item.stage) : undefined
    }))
    .filter((item) => item.estimatedTokens > 0);
}

function normalizeModelCallUsage(value: unknown): TutorModelCallUsage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      inputTokens: nonnegativeDebugInteger(item.inputTokens ?? item.input_tokens),
      model: String(item.model ?? ""),
      outputTokens: nonnegativeDebugInteger(item.outputTokens ?? item.output_tokens),
      purpose: String(item.purpose ?? ""),
      reasoningEffort: item.reasoningEffort || item.reasoning_effort ? String(item.reasoningEffort ?? item.reasoning_effort) : undefined,
      reasoningTokens: nonnegativeDebugInteger(item.reasoningTokens ?? item.reasoning_tokens),
      stage: String(item.stage ?? ""),
      totalTokens: nonnegativeDebugInteger(item.totalTokens ?? item.total_tokens)
    }));
}

function countProviderStages(stages: string[]) {
  return stages.filter((stage) => stage.startsWith("openrouter_")).length;
}

function nonnegativeDebugInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}

function studentChatErrorPayload(error: ReportedStudentChatError) {
  return {
    error: studentChatErrorMessage(error),
    errorCode: error.code,
    errorId: error.errorId
  };
}

function studentChatErrorMessage(error: ReportedStudentChatError) {
  if (error.code === "CHAT_AI_USAGE_EXHAUSTED") {
    return error.studentMessage;
  }

  return `${error.studentMessage} Code: ${error.code}. Reference: ${error.errorId}.`;
}

function studentMessageForChatError(code: StudentChatErrorCode) {
  switch (code) {
    case "CHAT_SIGN_IN_REQUIRED":
      return "Please sign in again before chatting with Chandra.";
    case "CHAT_PROFILE_REQUIRED":
      return "Your account needs a student profile before chatting. Ask your teacher for help.";
    case "CHAT_CLASS_REQUIRED":
      return "Join a class before chatting with Chandra.";
    case "CHAT_CLASS_NOT_FOUND":
      return "Your saved class was not found. Ask your teacher for the current class code.";
    case "CHAT_CLASS_DISABLED":
      return "Your teacher has paused chat for this class.";
    case "CHAT_STUDENT_BLOCKED":
      return "Chat is paused for your account right now. Ask your teacher for help.";
    case "CHAT_TEACHER_SETUP_REQUIRED":
      return "This class needs a setup fix before chat can start. Ask your teacher for help.";
    case "CHAT_TEACHER_PREVIEW_CLASS_REQUIRED":
      return "Choose a class before previewing student chat.";
    case "CHAT_TEACHER_PREVIEW_FORBIDDEN":
      return "Only this class's teachers can preview this chat.";
    case "CHAT_ROLE_UNSUPPORTED":
      return "Use a student account to chat with Chandra.";
    case "CHAT_MODEL_NOT_CONFIGURED":
      return "Chandra is not fully set up for this class yet. Ask your teacher for help.";
    case "CHAT_STUDENT_EMAIL_REQUIRED":
      return "Your account is missing an email for saved chats. Ask your teacher for help.";
    case "CHAT_CONVERSATION_NOT_FOUND":
      return "That saved chat could not be found. Start a new chat and try again.";
    case "CHAT_CONVERSATION_FORBIDDEN":
      return "You do not have access to that saved chat. Start a new chat and try again.";
    case "CHAT_CONVERSATION_ID_INVALID":
      return "I could not save this message. Start a new chat and try again.";
    case "CHAT_REQUEST_INVALID":
      return "I could not send that message. Refresh the page and try again.";
    case "CHAT_AI_USAGE_EXHAUSTED":
      return "Sorry, you have reached your Chandra usage limit. Ask your professor to allow more usage.";
    case "TUTOR_BACKEND_REQUEST_TOO_LARGE":
      return "This chat is too large to send. Start a new chat and try again.";
    case "TUTOR_BACKEND_UNREACHABLE":
      return STUDENT_TUTOR_BACKEND_UNAVAILABLE_MESSAGE;
    case "TUTOR_BACKEND_TIMEOUT":
      return "That took too long to answer. Try sending it again.";
    case "TUTOR_BACKEND_RATE_LIMITED":
      return "Chandra is getting too many requests right now. Try again soon.";
    case "TUTOR_BACKEND_AUTH_FAILED":
    case "TUTOR_BACKEND_SETUP_INCOMPLETE":
      return "Chandra's tutor service needs a setup fix. Ask your teacher for help.";
    case "TUTOR_BACKEND_STREAM_MISSING":
    case "TUTOR_BACKEND_STREAM_INVALID":
    case "TUTOR_BACKEND_STREAM_FAILED":
    case "TUTOR_BACKEND_REQUEST_FAILED":
    case "TUTOR_BACKEND_ERROR":
    case "TUTOR_CHAT_FAILED":
      return STUDENT_TUTOR_RESPONSE_FAILED_MESSAGE;
  }
}

function classifyTutorChatHttpError(error: TutorChatHttpError): StudentChatErrorCode {
  const message = error.message.toLowerCase();

  if (message.includes("sign in")) {
    return "CHAT_SIGN_IN_REQUIRED";
  }

  if (message.includes("profile")) {
    return "CHAT_PROFILE_REQUIRED";
  }

  if (message.includes("needs a class")) {
    return "CHAT_CLASS_REQUIRED";
  }

  if (message.includes("choose a class")) {
    return "CHAT_TEACHER_PREVIEW_CLASS_REQUIRED";
  }

  if (message.includes("only the class teacher") || message.includes("only this class's teachers")) {
    return "CHAT_TEACHER_PREVIEW_FORBIDDEN";
  }

  if (message.includes("saved class was not found")) {
    return "CHAT_CLASS_NOT_FOUND";
  }

  if (message.includes("teacher has paused chat")) {
    return "CHAT_CLASS_DISABLED";
  }

  if (message.includes("chat is paused")) {
    return "CHAT_STUDENT_BLOCKED";
  }

  if (message.includes("missing teacher ownership metadata")) {
    return "CHAT_TEACHER_SETUP_REQUIRED";
  }

  if (message.includes("real openrouter model")) {
    return "CHAT_MODEL_NOT_CONFIGURED";
  }

  if (message.includes("student account")) {
    return "CHAT_ROLE_UNSUPPORTED";
  }

  return error.status === 401 ? "CHAT_SIGN_IN_REQUIRED" : "CHAT_REQUEST_INVALID";
}

function classifyConversationPersistenceError(error: ConversationPersistenceError): StudentChatErrorCode {
  const message = error.message.toLowerCase();

  if (message.includes("student email")) {
    return "CHAT_STUDENT_EMAIL_REQUIRED";
  }

  if (message.includes("conversation was not found")) {
    return "CHAT_CONVERSATION_NOT_FOUND";
  }

  if (message.includes("only") && message.includes("own class conversations")) {
    return "CHAT_CONVERSATION_FORBIDDEN";
  }

  if (message.includes("invalid")) {
    return "CHAT_CONVERSATION_ID_INVALID";
  }

  return "CHAT_CONVERSATION_ID_INVALID";
}

function classifyBackendResponseError(status: number, detail: string): StudentChatErrorCode {
  const normalizedDetail = detail.toLowerCase();

  if (status === 401 || normalizedDetail.includes("authentication failed")) {
    return "TUTOR_BACKEND_AUTH_FAILED";
  }

  if (status === 403 && normalizedDetail.includes("secret")) {
    return "TUTOR_BACKEND_AUTH_FAILED";
  }

  if (
    normalizedDetail.includes("not installed") ||
    normalizedDetail.includes("pip install") ||
    normalizedDetail.includes("backend_shared_secret")
  ) {
    return "TUTOR_BACKEND_SETUP_INCOMPLETE";
  }

  if (status === 408 || status === 504 || normalizedDetail.includes("timeout") || normalizedDetail.includes("timed out")) {
    return "TUTOR_BACKEND_TIMEOUT";
  }

  if (normalizedDetail.includes("ai usage reservation required")) {
    return "TUTOR_BACKEND_REQUEST_FAILED";
  }

  if (status === 429 || normalizedDetail.includes("rate limit")) {
    if (normalizedDetail.includes("ai usage limit")) {
      return "CHAT_AI_USAGE_EXHAUSTED";
    }

    return "TUTOR_BACKEND_RATE_LIMITED";
  }

  if (status === 413 || normalizedDetail.includes("too large")) {
    return "TUTOR_BACKEND_REQUEST_TOO_LARGE";
  }

  if (status >= 500) {
    return "TUTOR_BACKEND_ERROR";
  }

  return "TUTOR_BACKEND_REQUEST_FAILED";
}

function classifyBackendStreamError(detail: string): StudentChatErrorCode {
  const normalizedDetail = detail.toLowerCase();

  if (normalizedDetail.includes("json") || normalizedDetail.includes("parse")) {
    return "TUTOR_BACKEND_STREAM_INVALID";
  }

  if (normalizedDetail.includes("timeout") || normalizedDetail.includes("timed out")) {
    return "TUTOR_BACKEND_TIMEOUT";
  }

  if (normalizedDetail.includes("ai usage reservation required")) {
    return "TUTOR_BACKEND_REQUEST_FAILED";
  }

  if (normalizedDetail.includes("rate limit")) {
    return "TUTOR_BACKEND_RATE_LIMITED";
  }

  if (normalizedDetail.includes("ai usage limit")) {
    return "CHAT_AI_USAGE_EXHAUSTED";
  }

  if (
    normalizedDetail.includes("openrouter_api_key") ||
    normalizedDetail.includes("openrouter_http_referer") ||
    normalizedDetail.includes("frontend_origin") ||
    normalizedDetail.includes("next_internal_base_url") ||
    normalizedDetail.includes("not installed") ||
    normalizedDetail.includes("pip install") ||
    normalizedDetail.includes("backend_shared_secret")
  ) {
    return "TUTOR_BACKEND_SETUP_INCOMPLETE";
  }

  return "TUTOR_BACKEND_STREAM_FAILED";
}

function classifyUnexpectedChatError(caughtError: unknown): StudentChatErrorCode {
  if (isBackendFetchFailure(caughtError)) {
    return "TUTOR_BACKEND_UNREACHABLE";
  }

  if (isBackendConfigurationError(caughtError)) {
    return "TUTOR_BACKEND_SETUP_INCOMPLETE";
  }

  if (caughtError instanceof SyntaxError) {
    return "TUTOR_BACKEND_STREAM_INVALID";
  }

  return "TUTOR_CHAT_FAILED";
}

function errorMessageForLog(caughtError: unknown) {
  if (!caughtError) {
    return undefined;
  }

  return caughtError instanceof Error ? caughtError.message : String(caughtError);
}

function isBackendFetchFailure(caughtError: unknown) {
  return caughtError instanceof TypeError && caughtError.message.toLowerCase().includes("fetch failed");
}

function isBackendConfigurationError(caughtError: unknown) {
  if (!(caughtError instanceof Error)) {
    return false;
  }

  return (
    caughtError.message.includes("BACKEND_API_BASE_URL") ||
    caughtError.message.includes("BACKEND_SHARED_SECRET") ||
    caughtError.message.includes("BACKEND_ID_TOKEN_AUDIENCE")
  );
}

async function backendHeaders(requestId: string) {
  const sharedSecret = process.env.BACKEND_SHARED_SECRET?.trim();

  if (!sharedSecret) {
    throw new Error("BACKEND_SHARED_SECRET is required for tutor backend requests.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
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
    return String(payload.detail ?? payload.error ?? "");
  } catch {
    return "";
  }
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

function withStudentAiUsageStatus(
  response: TutorApiResponse,
  usageStatus: StudentAiUsageStatus | null | undefined
): TutorApiResponse {
  if (!usageStatus) {
    return response;
  }

  return {
    ...response,
    aiUsageStatus: usageStatus
  };
}

function actualTokenUsageFromTutorPayload(payload: RawTutorApiResponse) {
  return normalizeAiTokenUsage(payload.tokenUsage?.actual);
}

async function releaseAiTokenReservationSafely(
  reservation: AiUsageReservation | null | undefined,
  requestId: string
) {
  try {
    await releaseAiTokenReservation(reservation ?? null);
  } catch (caughtError) {
    console.error("AI token reservation release failed", JSON.stringify({
      message: errorMessageForLog(caughtError),
      requestId,
      reservationId: reservation?.id
    }));
  }
}

async function logChatAccessDecision({
  classId,
  decision,
  metadata = {},
  requestId,
  userId
}: {
  classId?: string;
  decision: "class_chat_disabled" | "quota_exceeded" | "student_chat_blocked";
  metadata?: Record<string, string | number | boolean | null | undefined>;
  requestId: string;
  userId?: string;
}) {
  const eventType = `student_chat.${decision}`;
  const safeMetadata = {
    classId,
    decision,
    requestId,
    userId,
    ...metadata
  };

  logEvent(eventType, "warn", safeMetadata);
  await writeAuditLog({
    actor: { uid: userId ?? null },
    eventType,
    metadata: safeMetadata,
    route: "/api/chat",
    target: { classId: classId ?? null, userId: userId ?? null }
  });
}

async function saveAssistantMessageWithoutBlockingTutorResponse({
  assistantMessageId,
  conversationId,
  modelId,
  requestId,
  response,
  scope
}: {
  assistantMessageId: string;
  conversationId: string;
  modelId: string;
  requestId?: string;
  response: TutorApiResponse;
  scope: PreparedBackendChatRequest["scope"];
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
    reportStudentChatError({
      caughtError,
      classId: scope.classId,
      code:
        caughtError instanceof ConversationPersistenceError
          ? classifyConversationPersistenceError(caughtError)
          : "CHAT_CONVERSATION_ID_INVALID",
      conversationId,
      phase: "response",
      requestId,
      userId: scope.uid,
      userRole: scope.role
    });
  }
}

function buildPdfToolChoosingTutorSystemPrompt(
  sourceUsageValue?: SourceUsageSettings,
  answerPolicyValue?: AnswerPolicySettings
) {
  const sourceUsage = normalizeSourceUsageSettings(sourceUsageValue);
  const answerPolicy = normalizeAnswerPolicySettings(answerPolicyValue);
  const sourcePriorityRules = sourceUsage.useClassMaterialsFirst
    ? [
        "- For exact task lookup, search assignment/problem PDFs first; use textbook/readings only if no task-source match is found.",
        "- For any concrete assignment, pasted problem, or prompt, check the exact class source before helping.",
        "- After locating the task, search textbook/readings only when method, concept, or example support is needed.",
        "- For textbook section/chapter requests, search `textbook reading` plus the exact marker and topic words; do not assume a title.",
        "- For conceptual method/example questions, search textbook/readings/examples so the explanation uses class wording."
      ]
    : [
        "- Search class PDFs for specific worksheets, assignments, pages, problem numbers, notes, lectures, textbook sections, rubrics, diagrams, tables, equations, examples, or prior source-backed follow-ups.",
        "- For self-contained conceptual questions, answer directly unless class material would materially improve the help."
      ];
  const preferredSourceRules = [
    `- Preferred source type: ${sourceUsage.preferredSourceType}.`,
    ...(sourceUsage.preferredSourceType === "Textbook first"
      ? ["- For solving help, prefer textbook/readings/examples before worksheets unless the student asked for a specific worksheet problem."]
      : []),
    ...(sourceUsage.preferredSourceType === "Worked examples"
      ? ["- Prefer worked-example/example PDFs when the student needs explanation or practice."]
      : []),
    ...(sourceUsage.preferredSourceType === "Homework and textbook"
      ? ["- Prefer homework/problem-set pages for exact task lookup and textbook/readings for method or concept support."]
      : []),
    ...(sourceUsage.preferredSourceType === "Uploaded class materials"
      ? ["- Prefer uploaded class-specific materials whenever retrieval is useful."]
      : [])
  ];
  const directAnswerRules = answerPolicy.refuseAnswerOnlyRequests
    ? [
        "- If the student asks for the answer or a submission-ready version of the exact task, do not complete it. Use retrieval only if needed for a similar example walkthrough.",
        "- Treat homework-ready wording, proof paragraphs, complete submissions, and `example of what I can say` for the exact task as direct-answer requests.",
        "- After refusing, do not keep completing the exact task; offer a similar example or to check the student's attempted step."
      ]
    : [
        "- If the student asks for an answer, avoid answer-only output. Explain the reasoning and check understanding.",
        "- Do not use retrieval solely to complete a graded worksheet wholesale."
      ];
  const citationRules = sourceUsage.citeSourcePages
    ? [
        pdfToolSourceUseInstruction(sourceUsage),
        "- If a selected page shows a printed page number, use that printed page in the answer."
      ]
    : [pdfToolSourceUseInstruction(sourceUsage)];
  const unclearSourceRule = sourceUsage.askClarificationIfSourceUnclear
    ? "- After retrieval, answer only from selected pages. If they still do not answer the question and no sharper query is available, ask for the exact title, page, problem, or pasted text."
    : "- After retrieval, if selected pages are weak, state the uncertainty and give cautious general help without inventing source details.";

  return [
    "LangGraph PDF retrieval:",
    "Tool: search_pdf_pages({ query, student_reason }) searches indexed class PDF page windows from homework, worksheets, assignments, textbook/readings, notes, and examples, then LangGraph opens selected pages for the final answer.",
    "",
    "Use search_pdf_pages before answering when class PDFs could help solve, explain, or locate the student's question:",
    ...sourcePriorityRules,
    ...directAnswerRules.slice(0, 1),
    ...preferredSourceRules,
    "- Use it for class-source references like uploaded materials, pages/sections/problem numbers/titles, and source-backed follow-ups such as `part b` or `that example`.",
    "- Do not use it for off-topic or non-course requests; briefly redirect those.",
    "",
    "Skip the tool for greetings, study planning, off-topic support, unrelated coding, or trivial self-contained questions. For concrete assignments or pasted problems, check class materials first. For method/concept teaching, retrieve only when textbook/readings/examples would materially improve the help.",
    "",
    "Query rules:",
    "- Usually make one focused query from the student's wording plus source type, known title/page/section/problem number, topic/method, and recent source context.",
    "- For locate/find requests, start with a locator verb and assignment-style source terms; add textbook only if the student asked for it or task-source search failed.",
    "- For textbook section/chapter requests, use `textbook reading`, the exact marker, and topic words; use a title only if the student or prior citation named it.",
    "- For solving help tied to a specific source, search both the exact task and method support if needed; for location-only requests, find the task page and stop.",
    "- Reuse already-selected relevant pages and prior citations; follow-up searches should target only the missing support.",
    "- If multiple searches help, keep them complementary: task/page, method/concept, and maybe one nearby worked example.",
    "- Every call must include a five-word `student_reason` such as `Checking exact task and page`.",
    "- Make at most 3 searches, preserve names/numbers/symbols/quoted wording, and only search again with a genuinely new sharper query. Never repeat the same query or a trivial variant.",
    "",
    "Answering rules:",
    "- If retrieval is needed, call search_pdf_pages and wait for selected pages before answering.",
    "- If retrieval is not needed, answer directly.",
    unclearSourceRule,
    ...directAnswerRules.slice(1),
    "- If the student asks to see, locate, read, copy, quote, restate, identify, or ask what a specific source item says, treat it as source-text lookup: retrieve the exact source and provide the visible text when quoting is allowed, without solving it or requiring an attempt first. Source items include problems, exercises, questions, prompts, passages, lemmas, theorems, definitions, propositions, corollaries, examples, rubrics, tables, captions, and pages.",
    "- For source-text lookup, the lookup exception wins over attempt-first and direct-answer restrictions as long as you only provide the visible source wording and do not solve, prove, apply, or complete the task.",
    "- Retrieval does not override attempt-first. For exact graded-looking tasks without student work, orient with sources, then ask what they tried or where they are stuck.",
    "- In that first reply, do not provide task-specific starts, intermediate values, thesis claims, code, structure, exact next steps, or other work that begins completing the task unless the student asked for concept explanation, source lookup, or a similar example.",
    "- Treat requests for proof paragraphs, student-style wording, sentence starters, outlines, scaffolds, or all-parts breakdowns for the exact task as requests for the final artifact.",
    "- Similar examples must be meaningfully different and cannot complete any part of the assigned response.",
    "- Follow-ups like `I still need help`, `yes`, `tell me more`, or `explain like I am 5` are not attempts; keep helping conceptually or use a non-identical example.",
    "- Do not reveal the full solution, final answer, final artifact, final code, thesis, outline, or a multi-step solution chain for the exact task before the student shows work.",
    "- If section pages are mismatched, or pages only locate the task without method support, search again before giving solving help.",
    ...citationRules,
    "- Verify student calculations before affirming them; if something is wrong, point out the first wrong step or value.",
    "- Once attempt-first is satisfied or not applicable, use a targeted question or small nudge rather than stating the next move outright.",
    "",
    "Student-facing section guidance:",
    "- Default to one clean answer plus useful optional sections when they improve scanability or learning.",
    "- Do not fill every section. Leave unused structured fields empty; each section should support the answer because that format is genuinely helpful for this turn.",
    "- If content does not fit a section's narrow purpose, keep it in the main answer instead of forcing it into a labeled section.",
    "- Do not duplicate the same idea in both the main answer and a labeled section.",
    "- Allowed labels are only `Problem:`, `Hint:`, `Why this works:`, `Formula:`, `Example:`, and `Check your work:`.",
    "- Use `Problem:` only for the academic exercise/question/task statement the student is working on, not for an issue/error. If you use it, put only the problem statement there and keep location/source context or any main reply to a short follow-up offer outside that section.",
    "- Use `Hint:` for one small nudge when the student needs a push. Keep it short, direct, and not a solution step chain; do not put formulas, citations, or multiple bullet-like ideas in `Hint:`.",
    "- Use `Why this works:` for calm conceptual explanation. Prefer 1-2 short paragraphs or a few compact bullets when it clarifies the reasoning.",
    "- Use `Formula:` only when there is one main rule, theorem, identity, or equation worth isolating. Put only the formula or formulas there, not citations or explanatory prose. If you need to explain where a formula comes from, put that in the main answer or `Why this works:` instead.",
    "- Use `Example:` when giving or discussing a genuinely similar example. Make the example visibly different from the student's exact task; when useful, separate it into `Setup:` and `Move:` lines.",
    "- Use `Check your work:` only when the student has shown work or asks for validation. Make it evaluative and concise, using short lines such as `Looks right:`, `First issue:`, `What to fix:`, or `Try again with:` when they fit.",
    "- Use `nextStep` metadata/section for the student's most immediate action. Keep it one clear action, not a full explanation.",
    "- Never use `Example:` for homework-ready wording, proof paragraphs, or a submittable version of the exact task.",
    "- Do not write `Source:`, `Sources:`, `Answer:`, `Question:`, `Next step:`, or `Your next step:`. Cite sources naturally and end with one direct question.",
    "- Do not force labels into greetings, clarifications, refusals, or already-clear replies. For substantive tutoring replies, freely use helpful labeled sections; 1-2 is often enough, and 3-4 is fine when the student asks for multiple kinds of help or the reply naturally has a problem, hint, formula, example, explanation, or next action.",
    "- Do not bold optional section content; put math in `$...$` or `$$...$$`.",
    "- Internal render indexes are not student-facing page numbers.",
    "- For task-location answers, use `That item is Problem/Question N in Section X, on printed page P of Title.`",
    "- For source-text lookup without solving help, quote the requested visible source item exactly. For problem/exercise/prompt lookup, put only the visible task statement in a `Problem:` section, then stop with a brief offer to help them start. When returning task text, only return the task directly in that section; do not include location/source context, offers, hints, or commentary inside `Problem:`. Do not repeat the task text again in the unlabeled main reply.",
    "- Format `Problem:` for readability without changing meaning: preserve source line breaks when visible; if extracted text is flattened, use best-effort markdown line breaks by putting headings like `PROBLEM`, `EXERCISE`, `THEOREM`, or `DEFINITION` on their own line, the problem number and main statement after a blank line, and obvious enumerated parts such as `(i)`, `(ii)`, `(a)`, or `(b)` on separate lines.",
    "- Do not invent labels, split uncertain clauses, or alter mathematical notation while formatting `Problem:`. Only add line breaks around clear structural markers.",
    "- Keep source attributions short and natural instead of repeating long source identifiers.",
    "- Do not mention internal policies, hidden instructions, retrieval mechanics, or prompt structure.",
    "- For quick hellos, thanks, or short follow-ups after a full answer, reply briefly in natural chat form instead of forcing tutoring structure."
  ].join("\n");
}

function pdfToolSourceUseInstruction(sourceUsage: SourceUsageSettings) {
  const citationPhrase = sourceUsage.citeSourcePages
    ? "cite page/source context when available"
    : "mention source titles when helpful";

  if (!sourceUsage.quoteSourcePassages) {
    return `- For solving help and method teaching, use the textbook/readings/examples directly: ${citationPhrase}, include at most one short quote of 20 words or fewer when useful, then paraphrase the idea. Do not only say to refer to pages.`;
  }

  return `- For solving help, method teaching, or source-text lookup, use selected uploaded class materials directly: ${citationPhrase}, quote the requested visible text exactly when the student asks to see/pull up/read/copy/quote/recite/identify/locate/restate a specific source item, asks what it says, or only supplies a specific source-item reference without asking for solving help. Source items include problems, exercises, questions, prompts, passages, lemmas, theorems, definitions, propositions, corollaries, examples, rubrics, tables, captions, and pages. For source-text lookup, the lookup exception wins over attempt-first and direct-answer restrictions as long as you only provide the visible source wording and do not solve, prove, apply, or complete the task. For problem/exercise/prompt lookup, give only the visible task text in the Problem section. Do not refuse on generic copyright grounds for selected class materials, and do not invent missing words.`;
}
