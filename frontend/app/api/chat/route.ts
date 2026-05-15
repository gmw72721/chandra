import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  creativityToTemperature,
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeResponseFormatSettings,
  normalizeSourceUsageSettings,
  normalizeTutorBehavior,
  verboseToMaxTokens,
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
import { getTeacherClassTutorConfig, toProviderMessages } from "@/lib/prompts";
import { compileLangfuseTextPrompt } from "@/lib/langfuse-prompts";
import { maxStudentAttachmentFileBytes, maxStudentAttachmentsPerMessage } from "@/lib/student-attachments-server";
import { writeAuditLog, writeChatErrorReference } from "@/lib/audit-log";
import { adminStorage } from "@/lib/firebase-admin";
import { getActiveStudentLearningProfileTutorContext } from "@/lib/student-learning-profiles-server";
import {
  ConversationPersistenceError,
  listStudentConversationMessages,
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
import type { ChatMessage, MessageAttachment, TutorApiResponse, TutorModelCallUsage } from "@/lib/types";

const STUDENT_TUTOR_BACKEND_UNAVAILABLE_MESSAGE =
  "Chandra is having trouble connecting. Try again in a moment.";
const STUDENT_TUTOR_RESPONSE_FAILED_MESSAGE =
  "Chandra is having trouble responding right now. Try again in a moment.";
const maxChatMessagesPerRequest = 40;
const maxChatMessageCharacters = 12000;
const maxChatRequestCharacters = 60000;
const maxAttachmentContextCharacters = 4000;
const defaultMaxAttachmentFilePayloadBytes = 8 * 1024 * 1024;
const maxDirectAttachmentDataUrlCharacters = Math.ceil(defaultMaxAttachmentFilePayloadBytes * 1.5);
export const pdfToolRouterLangfusePromptName = "chandra/routing/pdf-tool-router";
export const pdfToolRouterAnsweringRulesLangfusePromptName = "chandra/routing/pdf-tool-router-answering-rules";
export const pdfToolRouterLangfuseTemplate = [
  "LangGraph PDF retrieval:",
  "Tool: search_pdf_pages({ query, retrieval_reason }) searches indexed PostgreSQL OCR metadata for class PDF pages/problems from homework, worksheets, assignments, textbook/readings, notes, and examples.",
  "",
  "Use search_pdf_pages before answering when class PDFs could help solve, explain, or locate the student's question:",
  "{{source_priority_rules}}",
  "{{first_direct_answer_rule}}",
  "{{preferred_source_rules}}",
  "- Use it for class-source references like uploaded materials, pages/sections/problem numbers/titles, and source-backed follow-ups such as `part b` or `that example`.",
  "- If the latest student turn includes a student-uploaded image or PDF attachment, let the multimodal tutor inspect the uploaded homework, notes, worksheet, problem, diagram, reading, or other academic task directly, and also use search_pdf_pages when the student asks for a specific class source item or class PDFs could help locate, compare, or support the answer.",
  "- Do not treat unrelated uploaded photos or personal images such as pets, people, rooms, food, memes, or scenery as class material. Briefly redirect those to course material.",
  "- Do not use it for off-topic or non-course requests such as relationships, family conflict, emotional support, unrelated coding. Briefly redirect those to course material.",
  "",
  "Skip the tool for greetings, study planning, off-topic support, unrelated coding, or trivial self-contained questions. For concrete assignments or pasted problems, check class materials first. For method/concept teaching, retrieve only when textbook/readings/examples would materially improve the help.",
  "",
  "Query rules:",
  "- Usually make one focused query from the student's wording plus source type, known title/page/section/problem number, topic/method, and recent source context.",
  "- For locate/find requests, start with a locator verb and assignment-style source terms; add textbook only if the student asked for it or task-source search failed.",
  "- For find-similar-example requests such as `show me an example`, `give me an example`, `is there a similar example`, or `worked example`, call search_pdf_pages with retrieval_reason `needed_example_page` before refusing or answering from memory.",
  "- For find-similar-example requests, do not search only the assigned problem number. Build example searches from topic/method words, distinctive symbols, class source type, and section/chapter context.",
  "- Similar-example search queries should prefer terms such as `worked example`, `example`, `textbook reading`, `lecture notes`, `method`, and the concept name; avoid `problem 2.14`/page locators unless the search is only trying to identify the surrounding section.",
  "- For textbook section/chapter requests, use `textbook reading`, the exact marker, and topic words; use a title only if the student or prior citation named it.",
  "- For solving help tied to a specific source, search both the exact task and method support if needed; for location-only requests, find the task page and stop.",
  "- Reuse already-retrieved relevant OCR metadata records and prior citations; follow-up searches should target only the missing support.",
  "- If multiple searches help, keep them complementary and run one per distinct need: task/page, method/concept, and maybe one nearby worked example. For find-example requests, prefer method/concept plus worked-example searches before exact task lookup.",
  "- Every call must include `retrieval_reason`: `student_requested_problem`, `needed_supporting_page`, `needed_example_page`, `student_changed_problem`, or `previous_search_failed`.",
  "- Make at most 3 searches, preserve names/numbers/symbols/quoted wording, and only search again with a genuinely new sharper query. Never repeat the same query or a trivial variant.",
  "",
  "Answering rules:",
  "- If retrieval is needed, first call search_pdf_pages. Before the search runs, you may give a useful immediate response with appropriate sections from the student message, active source context, or chat history, then say briefly what class-material item you are checking next. Do not invent source facts before retrieval.",
  "- For a bare problem, exercise, question, page, or section number such as `2.20`, do not ask the student for a page photo, textbook title, full problem text, or source name before searching available class OCR metadata. Treat it as a source lookup, call search_pdf_pages, and keep visible output to a brief main-answer status while the lookup runs.",
  "- If retrieval is not needed, answer directly.",
  "{{unclear_source_rule}}",
  "{{answering_rules_tail}}"
].join("\n");

export const pdfToolRouterAnsweringRulesLangfuseTemplate = [
  "{{direct_answer_rules_tail}}",
  "- If the student asks to see, locate, read, copy, quote, restate, identify, or ask what a specific source item says, treat it as source-text lookup: retrieve the exact source and provide the visible text when quoting is allowed, without solving it or requiring an attempt first. Source items include problems, exercises, questions, prompts, passages, lemmas, theorems, definitions, propositions, corollaries, examples, rubrics, tables, captions, and pages.",
  "- For source-text lookup, the lookup exception wins over attempt-first and direct-answer restrictions as long as you only provide the visible source wording and do not solve, prove, apply, or complete the task.",
  "- Retrieval does not override attempt-first. For exact graded-looking tasks without student work, orient with sources, then ask what they tried or where they are stuck.",
  "- For a bare stuck/start follow-up after the problem statement was already shown, keep the whole reply short and prefer a single `Hint:`. Add mainChat only for necessary non-hint context or a distinct request for the student's attempted step.",
  "- In that first reply, do not provide task-specific starts, intermediate values, thesis claims, code, structure, exact next steps, or other work that begins completing the task unless the student asked for concept explanation, source lookup, or a similar example.",
  "- Before an attempt on math/proof tasks, do not write the exact setup, expand the assigned expressions, list the formulas to plug in, or tell the student to perform the specific computation. Use one conceptual nudge or ask for one tiny entry, definition, or comparison they can supply.",
  "- If the student asks Chandra to check/review their work, inspect the visible attempt or ask for the attempted step; do not search class materials just because the request says `check my work`. Search only if the student explicitly asks to compare their work against a source, rubric, answer key, textbook page, class note, or other class material.",
  "- Do not say `I can't give a worked example here` when the student asks for an example. A similar, non-identical example is allowed; search class examples first when class PDFs may contain one.",
  "- Treat requests for proof paragraphs, student-style wording, sentence starters, proof scaffolds, or all-parts breakdowns for the exact task as requests for the final artifact.",
  "- Similar examples must be meaningfully different and cannot complete any part of the assigned response.",
  "- Follow-ups like `I still need help`, `yes`, `tell me more`, `that hint is too vague`, `that hint is not adding more`, or `explain like I am 5` are not attempts; keep helping conceptually or use a non-identical example.",
  "- Do not reveal the full solution, final answer, final artifact, final code, thesis, outline, or a multi-step solution chain for the exact task before the student shows work.",
  "- If section pages are mismatched, or pages only locate the task without method support, search again before giving solving help.",
  "{{citation_rules}}",
  "- When students show work or ask for validation, internally evaluate it, but support inspection rather than giving a correctness verdict. Point to the specific step to justify or tighten without saying whether the final answer is correct or wrong.",
  "- Unless teacher policy explicitly allows answer checking, avoid student-facing verdict labels such as `correct`, `incorrect`, `right`, `wrong`, `yes`, `no`, `that's the answer`, `your first part is right`, or `the mistake is`. Prefer learning-process language such as `You're using a relevant idea`, `This is a useful direction`, `One place to tighten is`, `Check this part carefully`, `Can you justify this step?`, or `What would make this implication valid?`.",
  "- Once attempt-first is satisfied or not applicable, ask the student to complete one small piece; do not provide the result or a chain of several moves.",
  "{{student_facing_section_guidance}}"
].join("\n");

const safeDocumentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/"));
const tutorConfusionChoiceSchema = z.object({
  description: z.string().min(1).max(180).optional(),
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  message: z.string().min(1).max(240)
});
const tutorConfusionChoicesSchema = z.array(tutorConfusionChoiceSchema).min(2).max(80);
const chatDebugOptionsSchema = z.object({
  forceAiUsageBlocked: z.boolean().optional(),
  forceAiUsageNearLimit: z.boolean().optional(),
  forceConfusionChoices: z.boolean().optional(),
  forceNoRetrieval: z.boolean().optional(),
  forceRetrieval: z.boolean().optional(),
  forceStudentView: z.boolean().optional()
});
const teacherPreviewTutorSettingsSchema = z.object({
  answerPolicy: z.record(z.unknown()).optional(),
  behaviorInstructions: z.string().max(4000).optional(),
  behaviorTitle: z.string().max(80).optional(),
  modelSettings: z.record(z.unknown()).optional(),
  responseFormat: z.record(z.unknown()).optional()
});
const attachmentFilePayloadSchema = z.object({
  dataUrl: z.string().startsWith("data:").max(maxDirectAttachmentDataUrlCharacters),
  fileName: z.string().min(1).max(200),
  fileSize: z.number().int().positive().max(maxStudentAttachmentFileBytes()),
  fileType: z.enum(["image", "pdf"]),
  id: safeDocumentIdSchema,
  mimeType: z.string().min(1).max(120)
});
const chatMessageAttachmentSchema = z.object({
  classId: z.string().max(200),
  conversationId: safeDocumentIdSchema,
  createdAt: z.unknown(),
  dataUrl: z.string().startsWith("data:").max(maxDirectAttachmentDataUrlCharacters).optional(),
  extractedText: z.string().nullable().optional(),
  fileName: z.string().min(1).max(200),
  fileSize: z.number().int().positive().max(maxStudentAttachmentFileBytes()),
  fileType: z.enum(["image", "pdf"]),
  id: safeDocumentIdSchema,
  messageId: z.string().nullable().optional(),
  mimeType: z.string().min(1).max(120),
  pageCount: z.number().nullable().optional(),
  storageKey: z.string().max(1000),
  studentId: z.string().max(200),
  updatedAt: z.unknown(),
  uploadStatus: z.enum(["uploading", "ready", "failed"])
});

const chatRequestSchema = z.object({
  attachmentIds: z.array(safeDocumentIdSchema).max(maxStudentAttachmentsPerMessage()).optional(),
  attachmentFiles: z.array(attachmentFilePayloadSchema).max(maxStudentAttachmentsPerMessage()).optional(),
  conversationId: safeDocumentIdSchema.optional(),
  courseId: z.string().optional(),
  debugOptions: chatDebugOptionsSchema.optional(),
  modelId: z.string().optional(),
  teacherPreviewTutorSettings: teacherPreviewTutorSettingsSchema.optional(),
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({
      id: safeDocumentIdSchema,
      role: z.enum(["student", "teacher", "assistant", "system"]),
      attachments: z.array(chatMessageAttachmentSchema).max(maxStudentAttachmentsPerMessage()).optional(),
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
          knowledgeItems: z
            .array(
              z.object({
                assignmentId: z.string().optional(),
                chatId: z.string(),
                classId: z.string().optional(),
                content: z.string().optional(),
                createdAt: z.unknown(),
                id: z.string(),
                kind: z.enum(["problem", "pdf_page", "student_upload"]),
                linkedProblemId: z.string().optional(),
                ocrText: z.string().optional(),
                page: z.number().optional(),
                pdfId: z.string().optional(),
                problemId: z.string().optional(),
                reason: z.string(),
                sourceId: z.string().optional(),
                sourceName: z.string(),
                summary: z.string().optional(),
                uiColor: z.enum(["blue", "neutral", "purple", "green", "orange"]).optional(),
                updatedAt: z.unknown(),
                usedAs: z.enum([
                  "active_problem",
                  "problem_source",
                  "supporting_context",
                  "definition_reference",
                  "theorem_reference",
                  "example_reference",
                  "student_attempt"
                ])
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
          problemUnderstandingState: z
            .object({
              activeProblemId: z.string().optional(),
              conceptsUnderstood: z.array(z.string()).optional(),
              completedParts: z.array(z.string()).optional(),
              completedSteps: z.array(z.string()).optional(),
              currentPart: z.string().optional(),
              currentStep: z.string().optional(),
              currentStepStatus: z.string().optional(),
              knownConfusions: z.array(z.string()).optional(),
              lastHintSummary: z.string().optional(),
              lastStudentAttemptSummary: z.string().optional(),
              level: z.number().optional(),
              problemStatus: z.string().optional(),
              reasons: z.array(z.string()).optional(),
              understandingLevel: z.number().optional(),
              updatedAt: z.unknown().optional(),
              visibleParts: z.array(z.string()).optional()
            })
            .optional(),
          activeProblemDecision: z
            .object({
              completedParts: z.array(z.string()).optional(),
              confidence: z.string().optional(),
              currentPart: z.string().optional(),
              isActualProblem: z.boolean().optional(),
              problemSource: z.string().optional(),
              problemText: z.string().optional(),
              reason: z.string().optional(),
              relationToPreviousProblem: z.string().optional(),
              visibleParts: z.array(z.string()).optional()
            })
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
              problemNumbers: z.array(z.string()).optional(),
              title: z.string().optional()
            })
          ),
          stages: z.array(z.string()),
          toolCallCount: z.number(),
          tutorPlan: z.record(z.unknown()).optional()
        })
        .optional(),
      sources: z
        .array(
          z.object({
            citationsRequired: z.boolean().optional(),
            id: z.string().optional(),
            materialType: z.string(),
            pdfId: z.string().optional(),
            pageNumber: z.number().optional(),
            problemNumber: z.string().optional(),
            problemNumbers: z.array(z.string()).optional(),
            reason: z.string().optional(),
            retrievalReason: z.string().optional(),
            sourceId: z.string().optional(),
            title: z.string(),
            usedAs: z
              .enum([
                "active_problem",
                "problem_source",
                "supporting_context",
                "definition_reference",
                "theorem_reference",
                "example_reference",
                "student_attempt"
              ])
              .optional()
          })
        )
        .optional(),
      studentMessageMode: z.enum(["ask", "work"]).optional(),
      structuredOutput: z
        .union([
          z.object({
            sections: z.object({
              mainChat: z.string().optional(),
              answer: z.string().optional(),
              problem: z.string().optional(),
              hint: z.string().optional(),
              explanation: z.string().optional(),
              formula: z.string().optional(),
              example: z.string().optional(),
              checkWork: z.string().optional(),
              sourceNote: z.string().optional()
            }),
            sectionOrder: z
              .array(
                z.enum([
                  "mainChat",
                  "answer",
                  "problem",
                  "hint",
                  "explanation",
                  "formula",
                  "example",
                  "checkWork",
                  "sourceNote"
                ])
              )
              .optional(),
            confusionPrompt: z.string().max(240).optional(),
            confusionChoices: tutorConfusionChoicesSchema.optional(),
            metadata: z.object({
              hintLevel: z.enum(tutorHintLevels),
              choiceDisplay: z.enum(["problem_selection"]).optional(),
              problemNumber: z.string().optional(),
              problemSummary: z.string().optional(),
              sourceConfidence: z.enum(["high", "medium", "low"]),
              studentActionNeeded: z.enum(tutorStudentActions),
              mode: z.enum(tutorModes)
            })
          }).superRefine((value, context) => {
            if (
              value.confusionChoices &&
              value.confusionChoices.length > 6 &&
              value.metadata.choiceDisplay !== "problem_selection"
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Generic confusion choices must include 2 to 6 choices.",
                path: ["confusionChoices"]
              });
            }
          }),
          z.object({
            answer: z.string(),
            nextQuestion: z.string().optional(),
            hintLevel: z.enum(tutorHintLevels),
            sourceConfidence: z.enum(["high", "medium", "low"]),
            studentActionNeeded: z.enum(tutorStudentActions),
            mode: z.enum(tutorModes)
          }),
          z.record(z.unknown())
        ])
        .nullable()
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
  const previewSettings = scope.role === "teacher" ? data.teacherPreviewTutorSettings : undefined;
  const classAnswerPolicy = previewSettings?.answerPolicy
    ? normalizeAnswerPolicySettings(previewSettings.answerPolicy)
    : teacherClass?.answerPolicy;
  const classBehaviorTitle = previewSettings?.behaviorTitle
    ? normalizeTutorBehavior(previewSettings.behaviorTitle)
    : teacherClass?.behaviorTitle;
  const classBehaviorInstructions =
    typeof previewSettings?.behaviorInstructions === "string"
      ? previewSettings.behaviorInstructions
      : teacherClass?.behaviorInstructions;
  const classModelSettings = previewSettings?.modelSettings
    ? normalizeClassModelSettings({
        ...(teacherClass?.modelSettings ?? {}),
        ...previewSettings.modelSettings
      })
    : teacherClass?.modelSettings;
  const classResponseFormat = previewSettings?.responseFormat
    ? normalizeResponseFormatSettings({
        ...(teacherClass?.responseFormat ?? {}),
        ...previewSettings.responseFormat
      })
    : teacherClass?.responseFormat;
  const model =
    classModelSettings?.modelId ||
    data.modelId ||
    process.env.DEFAULT_STUDENT_MODEL ||
    process.env.DEFAULT_MODEL ||
    defaultOpenRouterModelId;
  const temperature = creativityToTemperature(classModelSettings?.creativity ?? 35);
  const maxTokens = verboseToMaxTokens(classModelSettings?.verbose ?? "standard");
  const reasoningEffort = classModelSettings?.reasoningEffort ?? "low";

  if (model === "demo-guided") {
    throw new TutorChatHttpError("Choose a real OpenRouter model for tutor chat.", 400);
  }

  const persistence = await prepareStudentConversationPersistenceForTutor({
    attachmentIds: data.attachmentIds ?? [],
    conversationId: data.conversationId,
    messages,
    modelId: model,
    scope
  });
  const directAttachmentFiles = normalizeDirectAttachmentFilePayloads({
    files: dedupeDirectAttachmentFilePayloads([
      ...(data.attachmentFiles ?? []),
      ...directAttachmentFilePayloadsFromMessages(messages)
    ]),
    scopeRole: scope.role
  });
  const conversationMessages = await loadConversationMessagesForTutor({
    fallbackMessages: messages,
    persistence,
    scope
  });
  const persistedAttachmentContexts = recentConversationAttachmentsForModel(conversationMessages, persistence);
  const providerMessages = toProviderMessages(
    "",
    appendAttachmentContextToStudentMessage(
      conversationMessages,
      persistence,
      directAttachmentFiles,
      persistedAttachmentContexts
    )
  );
  const studentAttachmentFiles = [
    ...(await buildStudentAttachmentFilePayloads(persistedAttachmentContexts)),
    ...directAttachmentFiles
  ];
  const estimatedTokens = estimateAiRequestTokens({
    attachmentCount: studentAttachmentFiles.length,
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
      answerPolicy: classAnswerPolicy,
      aiUsageReservation: aiUsageReservation
        ? {
            estimatedTokens: aiUsageReservation.estimatedTokens,
            id: aiUsageReservation.id,
            studentId: scope.role === "student" ? scope.uid : undefined
          }
        : undefined,
      behaviorInstructions: classBehaviorInstructions,
      behaviorTitle: classBehaviorTitle,
      modelSettings: classModelSettings,
      responseFormat: classResponseFormat,
      sourceUsage: teacherClass?.sourceUsage,
      debugOptions: {
        forceConfusionChoices: scope.role === "teacher" && data.debugOptions?.forceConfusionChoices === true,
        forceNoRetrieval: scope.role === "teacher" && data.debugOptions?.forceNoRetrieval === true,
        forceRetrieval: scope.role === "teacher" && data.debugOptions?.forceRetrieval === true
      },
      studentLearningProfileContext: privateBackendLearningProfileContext(studentLearningProfileContext),
      studentAttachmentFiles,
      messages: providerMessages
    },
    debugOptions: {
      forceAiUsageBlocked: scope.role === "teacher" && data.debugOptions?.forceAiUsageBlocked === true,
      forceAiUsageNearLimit: scope.role === "teacher" && data.debugOptions?.forceAiUsageNearLimit === true,
      forceConfusionChoices: scope.role === "teacher" && data.debugOptions?.forceConfusionChoices === true,
      forceNoRetrieval: scope.role === "teacher" && data.debugOptions?.forceNoRetrieval === true,
      forceRetrieval: scope.role === "teacher" && data.debugOptions?.forceRetrieval === true,
      forceStudentView: scope.role === "teacher" && data.debugOptions?.forceStudentView === true
    },
    learningProfileTelemetryContext: studentLearningProfileContext,
    persistence,
    scope
  };
}

async function loadConversationMessagesForTutor({
  fallbackMessages,
  persistence,
  scope
}: {
  fallbackMessages: ChatMessage[];
  persistence: StudentConversationPersistence | null;
  scope: Awaited<ReturnType<typeof authorizeTutorChatRequest>>;
}) {
  if (!persistence || scope.role !== "student") {
    return fallbackMessages;
  }

  return listStudentConversationMessages({
    classId: scope.classId,
    conversationId: persistence.conversationId,
    studentId: scope.uid
  });
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

type StudentAttachmentContext = {
  extractedText?: string | null;
  fileName: string;
  fileSize: number;
  fileType: "image" | "pdf";
  pageCount?: number | null;
};

function appendAttachmentContextToStudentMessage(
  messages: ChatMessage[],
  persistence: StudentConversationPersistence | null,
  directAttachmentFiles: StudentAttachmentFilePayload[] = [],
  persistedAttachmentContexts: MessageAttachment[] = []
) {
  const attachments = directAttachmentFiles.length ? directAttachmentFiles : persistedAttachmentContexts;

  if (!attachments.length) {
    return messages;
  }

  const targetMessageId =
    persistence?.studentMessage.id ??
    [...messages].reverse().find((message) => message.role === "student")?.id;

  return messages.map((message) => {
    if (message.id !== targetMessageId || message.role !== "student") {
      return message;
    }

    return {
      ...message,
      ...(persistence?.attachments.length ? { attachments: persistence.attachments } : {}),
      content: [
        message.content,
        buildAttachmentTutorContext(attachments)
      ].filter(Boolean).join("\n\n")
    };
  });
}

function buildAttachmentTutorContext(attachments: StudentAttachmentContext[]) {
  const lines = [
    "Student uploaded homework attachments available for this turn:",
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

      return `${details}\nNo extracted text was stored for this attachment. Use the attached file payload when available; do not invent file contents.`;
    })
  ];

  return lines.join("\n");
}

type StudentAttachmentFilePayload = {
  extractedText?: string | null;
  fileType: "image" | "pdf";
  id: string;
  dataUrl?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
};

function directAttachmentFilePayloadsFromMessages(
  messages: Array<ChatMessage & { attachments?: Array<MessageAttachment & { dataUrl?: string }> }>
): z.infer<typeof attachmentFilePayloadSchema>[] {
  const files: z.infer<typeof attachmentFilePayloadSchema>[] = [];

  for (const message of [...messages].reverse()) {
    if (message.role !== "student") {
      continue;
    }

    for (const attachment of [...(message.attachments ?? [])].reverse()) {
      if (files.length >= maxStudentAttachmentsPerMessage()) {
        return files;
      }

      if (attachment.uploadStatus !== "ready" || !attachment.dataUrl) {
        continue;
      }

      files.push({
        dataUrl: attachment.dataUrl,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        fileType: attachment.fileType,
        id: attachment.id,
        mimeType: attachment.mimeType || defaultMimeTypeForAttachment(attachment.fileType)
      });
    }
  }

  return files;
}

function dedupeDirectAttachmentFilePayloads(files: z.infer<typeof attachmentFilePayloadSchema>[]) {
  const dedupedFiles: z.infer<typeof attachmentFilePayloadSchema>[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    if (seenIds.has(file.id)) {
      continue;
    }

    seenIds.add(file.id);
    dedupedFiles.push(file);
  }

  return dedupedFiles.slice(0, maxStudentAttachmentsPerMessage());
}

function normalizeDirectAttachmentFilePayloads({
  files,
  scopeRole
}: {
  files: z.infer<typeof attachmentFilePayloadSchema>[];
  scopeRole: "student" | "teacher";
}): StudentAttachmentFilePayload[] {
  if (!files.length) {
    return [];
  }

  if (scopeRole !== "teacher") {
    return [];
  }

  const maxTotalBytes = readPositiveInteger(process.env.STUDENT_ATTACHMENT_MODEL_MAX_TOTAL_BYTES) ?? defaultMaxAttachmentFilePayloadBytes;
  let totalBytes = 0;

  return files.flatMap((file) => {
    const mimeType = normalizeAttachmentMimeType(file.mimeType);
    const dataUrl = normalizeAttachmentDataUrlForModel(file.dataUrl, mimeType);

    if (!dataUrl) {
      throw new TutorChatHttpError("Teacher preview attachment data is invalid.", 400);
    }

    if (file.fileSize <= 0 || totalBytes + file.fileSize > maxTotalBytes) {
      throw new TutorChatHttpError("Teacher preview attachments must be 8 MB or smaller in total.", 413);
    }

    totalBytes += file.fileSize;

    return [{
      dataUrl,
      fileName: file.fileName.trim(),
      fileSize: file.fileSize,
      fileType: file.fileType,
      id: file.id,
      mimeType
    }];
  });
}

async function buildStudentAttachmentFilePayloads(attachments: MessageAttachment[]): Promise<StudentAttachmentFilePayload[]> {
  if (!attachments.length || !adminStorage) {
    return [];
  }

  const maxTotalBytes = readPositiveInteger(process.env.STUDENT_ATTACHMENT_MODEL_MAX_TOTAL_BYTES) ?? defaultMaxAttachmentFilePayloadBytes;
  let totalBytes = 0;
  const files: StudentAttachmentFilePayload[] = [];

  for (const attachment of attachments) {
    if (attachment.uploadStatus !== "ready") {
      continue;
    }

    if (attachment.fileSize <= 0) {
      continue;
    }

    if (totalBytes + attachment.fileSize > maxTotalBytes) {
      if (attachmentRequiresBinaryModelPayload(attachment)) {
        throw new TutorChatHttpError(oversizedAttachmentModelMessage(attachment, maxTotalBytes), 413);
      }

      files.push(textOnlyStudentAttachmentPayload(attachment));
      continue;
    }

    try {
      const [buffer] = await adminStorage.bucket().file(attachment.storageKey).download();

      if (buffer.length <= 0 || totalBytes + buffer.length > maxTotalBytes) {
        if (attachmentRequiresBinaryModelPayload(attachment)) {
          throw new TutorChatHttpError(oversizedAttachmentModelMessage(attachment, maxTotalBytes), 413);
        }

        files.push(textOnlyStudentAttachmentPayload(attachment));
        continue;
      }

      totalBytes += buffer.length;
      files.push({
        extractedText: attachment.extractedText ?? null,
        fileType: attachment.fileType,
        id: attachment.id,
        dataUrl: `data:${attachment.mimeType || defaultMimeTypeForAttachment(attachment.fileType)};base64,${buffer.toString("base64")}`,
        fileName: attachment.fileName,
        fileSize: buffer.length,
        mimeType: attachment.mimeType || defaultMimeTypeForAttachment(attachment.fileType)
      });
    } catch (caughtError) {
      if (caughtError instanceof TutorChatHttpError) {
        throw caughtError;
      }

      console.warn("Student attachment file payload skipped.", {
        attachmentId: attachment.id,
        message: errorMessageForLog(caughtError)
      });

      if (attachmentRequiresBinaryModelPayload(attachment)) {
        throw new TutorChatHttpError("Attachment could not be prepared for Chandra to inspect. Try uploading it again.", 502);
      }

      files.push(textOnlyStudentAttachmentPayload(attachment));
    }
  }

  return files;
}

function recentConversationAttachmentsForModel(
  messages: ChatMessage[],
  persistence: StudentConversationPersistence | null
): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  const seenAttachmentIds = new Set<string>();

  for (const attachment of persistence?.attachments ?? []) {
    appendModelAttachment(attachments, seenAttachmentIds, attachment);
  }

  for (const message of [...messages].reverse()) {
    for (const attachment of message.attachments ?? []) {
      appendModelAttachment(attachments, seenAttachmentIds, attachment);
      if (attachments.length >= maxStudentAttachmentsPerMessage()) {
        return attachments;
      }
    }
  }

  return attachments;
}

function appendModelAttachment(
  attachments: MessageAttachment[],
  seenAttachmentIds: Set<string>,
  attachment: MessageAttachment
) {
  const storageKey = String(attachment.storageKey ?? "").trim();

  if (
    attachments.length >= maxStudentAttachmentsPerMessage() ||
    attachment.uploadStatus !== "ready" ||
    !attachment.id ||
    !storageKey ||
    seenAttachmentIds.has(attachment.id)
  ) {
    return;
  }

  seenAttachmentIds.add(attachment.id);
  attachments.push({
    ...attachment,
    storageKey
  });
}

function defaultMimeTypeForAttachment(fileType: "image" | "pdf") {
  return fileType === "image" ? "image/png" : "application/pdf";
}

function attachmentRequiresBinaryModelPayload(attachment: StudentAttachmentContext) {
  if (attachment.fileType === "image") {
    return true;
  }

  return !attachment.extractedText?.trim();
}

function textOnlyStudentAttachmentPayload(attachment: StudentAttachmentContext & { id: string; mimeType: string }): StudentAttachmentFilePayload {
  return {
    extractedText: attachment.extractedText ?? null,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    fileType: attachment.fileType,
    id: attachment.id,
    mimeType: attachment.mimeType || defaultMimeTypeForAttachment(attachment.fileType)
  };
}

function oversizedAttachmentModelMessage(attachment: StudentAttachmentContext, maxBytes: number) {
  const typeLabel = attachment.fileType === "image" ? "image" : "PDF";
  return `That ${typeLabel} is too large for Chandra to inspect directly. Upload it under ${formatAttachmentSize(maxBytes)}, or reduce the file size and try again.`;
}

function normalizeAttachmentDataUrlForModel(dataUrl: string, mimeType: string) {
  const normalizedMimeType = normalizeAttachmentMimeType(mimeType);
  const trimmedDataUrl = dataUrl.trim();
  const base64Marker = ";base64,";
  const markerIndex = trimmedDataUrl.indexOf(base64Marker);

  if (!normalizedMimeType || !trimmedDataUrl.startsWith("data:") || markerIndex < 0) {
    return "";
  }

  const headerMimeType = normalizeAttachmentMimeType(trimmedDataUrl.slice("data:".length, markerIndex).split(";")[0] ?? "");
  const base64Payload = trimmedDataUrl.slice(markerIndex + base64Marker.length).trim();

  if (!base64Payload) {
    return "";
  }

  if (headerMimeType && headerMimeType !== "application/octet-stream" && headerMimeType !== normalizedMimeType) {
    return "";
  }

  return `data:${normalizedMimeType};base64,${base64Payload}`;
}

function normalizeAttachmentMimeType(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return "image/jpeg";
  }

  if (normalized === "application/x-pdf") {
    return "application/pdf";
  }

  return normalized;
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
          message: "Reading your question...",
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
          await releaseAiTokenReservationSafely(preparedRequest.aiUsageReservation, requestId);
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
        let emittedQuickResponseModelCallCount = 0;

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
              const debugBackendPayload = debugBackendPayloadAfterEmittedQuickResponses(
                backendPayload,
                emittedQuickResponseModelCallCount
              );
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

              const scopedTutorResponse = withTutorDebugResponseOverrides(
                tutorResponseForScope({
                  actualTokens: actualTokenUsageFromTutorPayload(debugBackendPayload),
                  backendPayload: debugBackendPayload,
                  durationMs: performance.now() - backendRequestStartedAt,
                  preparedRequest,
                  requestId,
                  response: withConversationMetadata(tutorResponse, preparedRequest.persistence)
                }),
                preparedRequest
              );

              send({
                payload: withStudentAiUsageStatus(
                  scopedTutorResponse,
                  forcedTutorDebugAiUsageStatus(preparedRequest) ??
                    usageStatus ??
                    preparedRequest.aiUsageReservation?.studentStatus
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
            } else if (event.type === "quick_response") {
              const message = typeof event.message === "string" ? event.message : "";
              const quickBackendPayload = event as RawTutorApiResponse;
              const quickModelCalls = normalizeModelCallUsage(quickBackendPayload.tokenUsage?.calls);
              const quickResponseEvent: Record<string, unknown> = {
                ...event,
                structuredOutput: normalizeStructuredTutorOutput(event.structuredOutput, message)
              };

              if (preparedRequest.scope.role === "teacher" && !preparedRequest.debugOptions.forceStudentView) {
                quickResponseEvent.debugInfo = buildTutorDebugInfo({
                  actualTokens: actualTokenUsageFromTutorPayload(quickBackendPayload),
                  backendPayload: quickBackendPayload,
                  durationMs: performance.now() - backendRequestStartedAt,
                  preparedRequest,
                  requestId
                });
              }

              emittedQuickResponseModelCallCount = Math.max(
                emittedQuickResponseModelCallCount,
                quickModelCalls.length
              );
              send({
                ...quickResponseEvent
              });
            } else if (
              event.type === "section_start" ||
              event.type === "section_delta" ||
              event.type === "section_done"
            ) {
              send(event);
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

  if (preparedRequest.scope.role !== "teacher" || preparedRequest.debugOptions.forceStudentView) {
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

function withTutorDebugResponseOverrides(
  response: TutorApiResponse,
  preparedRequest: PreparedBackendChatRequest
): TutorApiResponse {
  if (preparedRequest.scope.role !== "teacher" || !preparedRequest.debugOptions.forceConfusionChoices) {
    return response;
  }

  return response;
}

function forcedTutorDebugAiUsageStatus(preparedRequest: PreparedBackendChatRequest): StudentAiUsageStatus | null {
  if (preparedRequest.scope.role !== "teacher") {
    return null;
  }

  if (preparedRequest.debugOptions.forceAiUsageBlocked) {
    return {
      blocked: true,
      dailyLimit: 100,
      dailyUsed: 100,
      nearLimit: false,
      resetHint: "today",
      todayPercentRemaining: 0,
      weekPercentRemaining: 0,
      weeklyLimit: 400,
      weeklyUsed: 400
    };
  }

  if (preparedRequest.debugOptions.forceAiUsageNearLimit) {
    return {
      blocked: false,
      dailyLimit: 100,
      dailyUsed: 92,
      nearLimit: true,
      resetHint: "today",
      todayPercentRemaining: 8,
      weekPercentRemaining: 12,
      weeklyLimit: 400,
      weeklyUsed: 352
    };
  }

  return null;
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

function debugBackendPayloadAfterEmittedQuickResponses(
  backendPayload: RawTutorApiResponse,
  emittedQuickResponseModelCallCount: number
): RawTutorApiResponse {
  if (emittedQuickResponseModelCallCount <= 0) {
    return backendPayload;
  }

  const calls = normalizeModelCallUsage(backendPayload.tokenUsage?.calls ?? backendPayload.langGraphTrace?.modelCallUsage);
  const remainingCalls = calls.slice(emittedQuickResponseModelCallCount);

  const actual = sumModelCallUsageTokens(remainingCalls);

  return {
    ...backendPayload,
    langGraphTrace: backendPayload.langGraphTrace
      ? {
          ...backendPayload.langGraphTrace,
          modelCallUsage: remainingCalls
        }
      : backendPayload.langGraphTrace,
    tokenUsage: {
      ...backendPayload.tokenUsage,
      actual,
      calls: remainingCalls
    }
  };
}

function sumModelCallUsageTokens(calls: TutorModelCallUsage[]): AiTokenUsage {
  return calls.reduce<AiTokenUsage>(
    (total, call) => ({
      inputTokens: total.inputTokens + call.inputTokens,
      outputTokens: total.outputTokens + call.outputTokens,
      reasoningTokens: (total.reasoningTokens ?? 0) + call.reasoningTokens,
      totalTokens: total.totalTokens + call.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  );
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
      return "You're out of tutoring time for today. Ask your professor for more.";
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

async function buildPdfToolChoosingTutorSystemPrompt(
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
        "- Treat homework-ready wording, proof paragraphs, complete submissions, and `give me an example of what I can say` for the exact task as direct-answer requests.",
        "- After refusing, do not keep completing the exact task; offer a similar example or to check the student's attempted step."
      ]
    : [
        "- If the student asks for an answer, avoid answer-only output. Explain the reasoning and check understanding.",
        "- Do not use retrieval solely to complete a graded worksheet wholesale."
      ];
  const citationRules = sourceUsage.citeSourcePages
    ? [
        pdfToolSourceUseInstruction(sourceUsage),
        "- If a retrieved OCR metadata record shows a printed page number, use that printed page in the answer."
      ]
    : [pdfToolSourceUseInstruction(sourceUsage)];
  const unclearSourceRule = sourceUsage.askClarificationIfSourceUnclear
    ? "- After retrieval, answer only from the returned OCR metadata records. If they still do not answer the question and no sharper query is available, ask for the exact title, page, problem, or pasted text."
    : "- After retrieval, if the OCR metadata records are weak, state the uncertainty and give cautious general help without inventing source details.";

	  const localPrompt = [
    "LangGraph PDF retrieval:",
    "Tool: search_pdf_pages({ query, retrieval_reason }) searches indexed PostgreSQL OCR metadata for class PDF pages/problems from homework, worksheets, assignments, textbook/readings, notes, and examples.",
    "",
    "Use search_pdf_pages before answering when class PDFs could help solve, explain, or locate the student's question:",
    ...sourcePriorityRules,
    ...directAnswerRules.slice(0, 1),
    ...preferredSourceRules,
    "- Use it for class-source references like uploaded materials, pages/sections/problem numbers/titles, and source-backed follow-ups such as `part b` or `that example`.",
    "- If the latest student turn includes a student-uploaded image or PDF attachment, let the multimodal tutor inspect the uploaded homework, notes, worksheet, problem, diagram, reading, or other academic task directly, and also use search_pdf_pages when the student asks for a specific class source item or class PDFs could help locate, compare, or support the answer.",
    "- Do not use it for off-topic or non-course requests such as relationships, family conflict, emotional support, unrelated coding. Briefly redirect those to course material.",
    "",
    "Skip the tool for greetings, study planning, off-topic support, unrelated coding, or trivial self-contained questions. For concrete assignments or pasted problems, check class materials first. For method/concept teaching, retrieve only when textbook/readings/examples would materially improve the help.",
    "",
    "Query rules:",
    "- Usually make one focused query from the student's wording plus source type, known title/page/section/problem number, topic/method, and recent source context.",
    "- For locate/find requests, start with a locator verb and assignment-style source terms; add textbook only if the student asked for it or task-source search failed.",
    "- For find-similar-example requests such as `show me an example`, `give me an example`, `is there a similar example`, or `worked example`, call search_pdf_pages with retrieval_reason `needed_example_page` before refusing or answering from memory.",
    "- For find-similar-example requests, do not search only the assigned problem number. Build example searches from topic/method words, distinctive symbols, class source type, and section/chapter context.",
    "- Similar-example search queries should prefer terms such as `worked example`, `example`, `textbook reading`, `lecture notes`, `method`, and the concept name; avoid `problem 2.14`/page locators unless the search is only trying to identify the surrounding section.",
    "- For textbook section/chapter requests, use `textbook reading`, the exact marker, and topic words; use a title only if the student or prior citation named it.",
    "- For solving help tied to a specific source, search both the exact task and method support if needed; for location-only requests, find the task page and stop.",
    "- Reuse already-retrieved relevant OCR metadata records and prior citations; follow-up searches should target only the missing support.",
    "- If multiple searches help, keep them complementary and run one per distinct need: task/page, method/concept, and maybe one nearby worked example. For find-example requests, prefer method/concept plus worked-example searches before exact task lookup.",
    "- Every call must include `retrieval_reason`: `student_requested_problem`, `needed_supporting_page`, `needed_example_page`, `student_changed_problem`, or `previous_search_failed`.",
    "- Make at most 3 searches, preserve names/numbers/symbols/quoted wording, and only search again with a genuinely new sharper query. Never repeat the same query or a trivial variant.",
    "",
    "Answering rules:",
    "- If retrieval is needed, first call search_pdf_pages. Before the search runs, you may give a useful immediate response with appropriate sections from the student message, active source context, or chat history, then say briefly what class-material item you are checking next. Do not invent source facts before retrieval.",
    "- For a bare problem, exercise, question, page, or section number such as `2.20`, do not ask the student for a page photo, textbook title, full problem text, or source name before searching available class OCR metadata. Treat it as a source lookup, call search_pdf_pages, and keep visible output to a brief mainChat status while the lookup runs.",
    "- If retrieval is not needed, answer directly.",
    unclearSourceRule,
    ...directAnswerRules.slice(1),
    "- If the student asks to see, locate, read, copy, quote, restate, identify, or ask what a specific source item says, treat it as source-text lookup: retrieve the exact source and provide the visible text when quoting is allowed, without solving it or requiring an attempt first. Source items include problems, exercises, questions, prompts, passages, lemmas, theorems, definitions, propositions, corollaries, examples, rubrics, tables, captions, and pages.",
    "- For source-text lookup, the lookup exception wins over attempt-first and direct-answer restrictions as long as you only provide the visible source wording and do not solve, prove, apply, or complete the task.",
    "- Retrieval does not override attempt-first. For exact graded-looking tasks without student work, orient with sources, then ask what they tried or where they are stuck.",
    "- For a bare stuck/start follow-up after the problem statement was already shown, keep the whole reply short and prefer a single `Hint:`. Add mainChat only for necessary non-hint context or a distinct request for the student's attempted step.",
    "- In that first reply, do not provide task-specific starts, intermediate values, thesis claims, code, structure, exact next steps, or other work that begins completing the task unless the student asked for concept explanation, source lookup, or a similar example.",
    "- Before an attempt on math/proof tasks, do not write the exact setup, expand the assigned expressions, list the formulas to plug in, or tell the student to perform the specific computation. Use one conceptual nudge or ask for one tiny entry, definition, or comparison they can supply.",
    "- If the student asks Chandra to check/review their work, inspect the visible attempt or ask for the attempted step; do not search class materials just because the request says `check my work`. Search only if the student explicitly asks to compare their work against a source, rubric, answer key, textbook page, class note, or other class material.",
    "- Do not say `I can't give a worked example here` when the student asks for an example. A similar, non-identical example is allowed; search class examples first when class PDFs may contain one.",
    "- Treat requests for proof paragraphs, student-style wording, sentence starters, proof scaffolds, or all-parts breakdowns for the exact task as requests for the final artifact.",
    "- Similar examples must be meaningfully different and cannot complete any part of the assigned response.",
    "- Follow-ups like `I still need help`, `yes`, `tell me more`, `that hint is too vague`, `that hint is not adding more`, or `explain like I am 5` are not attempts; keep helping conceptually or use a non-identical example.",
    "- Do not reveal the full solution, final answer, final artifact, final code, thesis, outline, or a multi-step solution chain for the exact task before the student shows work.",
    "- If section pages are mismatched, or pages only locate the task without method support, search again before giving solving help.",
    ...citationRules,
    "- When students show work or ask for validation, internally evaluate it, but support inspection rather than giving a correctness verdict. Point to the specific step to justify or tighten without saying whether the final answer is correct or wrong.",
    "- Unless teacher policy explicitly allows answer checking, avoid student-facing verdict labels such as `correct`, `incorrect`, `right`, `wrong`, `yes`, `no`, `that's the answer`, `your first part is right`, or `the mistake is`. Prefer learning-process language such as `You're using a relevant idea`, `This is a useful direction`, `One place to tighten is`, `Check this part carefully`, `Can you justify this step?`, or `What would make this implication valid?`.",
    "- Once attempt-first is satisfied or not applicable, ask the student to complete one small piece; do not provide the result or a chain of several moves.",
    "",
    "Student-facing section guidance:",
    "- For substantive tutoring replies, use optional sections only when they add new value; never output sections just because the schema supports them.",
    "- A strong early/light-help reply, including vague stuck messages like `I am lost` or explicit requests for a hint, is often just one short `Hint:` or one clear question. If `Hint:` carries the nudge, omit mainChat unless it adds necessary non-hint context.",
    "- When guided help genuinely needs structure, keep the tutoring nudge in `Hint:`. Add mainChat only when a brief non-hint orientation, source/context note, or concrete immediate action is necessary and distinct.",
    "- Orientation names the kind of task or thinking move the student is doing; it should not repeat the hint, announce that a hint is coming, or begin solving the task.",
    "- Hint gives the single key idea needed next and connects it to the exact student task, without completing the full problem or artifact.",
    "- The immediate action asks for one small, checkable student action, such as completing one part, choosing one option, revising one line, or sharing one attempted step.",
    "- Do not repeat the same advice in the orientation, hint, explanation, and immediate action; each included section must add distinct value.",
    "- If the student says a previous hint was unhelpful, repetitive, too vague, or did not add more, treat that as a repeated-stuck signal: do not restate the prior hint. Add one new concrete distinction, prerequisite idea, or smaller sub-question within the same allowed help depth.",
    "- If recent help already named a broad method, the next hint should narrow to the specific missing object, definition, target space, assumption, comparison, representation, or notation choice rather than naming the method again.",
    "- Before returning, run a distinct-value audit: if mainChat already gives the key clue, equation, theorem, or method, omit `Hint:`. If `Hint:` gives the clue or action, do not restate or paraphrase it in mainChat. Never use filler like `I can give you a hint` when a `Hint:` section is present.",
    "- For broad concept explanations or topic overviews, usually answer in plain prose without `Hint:`. Do not add `Hint:` just to restate a definition, fact list, or summary already in mainChat.",
    "- If the only possible mainChat would repeat `Hint:` with different wording, omit mainChat. A single useful `Hint:` is better than duplicated mainChat plus `Hint:`.",
    "- If the configured help level or attempt-first rule allows only limited help, make the immediate action a request for the student's attempt or the exact place they are stuck.",
    "- Default to one clean answer plus useful optional sections when they improve scanability or learning.",
    "- Do not fill every section. Leave unused structured fields empty; each section should support the answer because that format is genuinely helpful for this turn.",
    "- Be deliberate about structure. Reorganize content into the section where it belongs instead of preserving draft order: normal conversational text in `mainChat`, problem text in `Problem:`, formulas/rules in `Formula:`, conceptual commentary in `Why this works:`, examples in `Example:`, conceptual nudges or leading questions in `Hint:`, checks of student work in `Check your work:`, source/context notes in `sourceNote`, and the student's immediate action or offer at the end of `mainChat`. When the response is only a hint, use `Hint:` only.",
    "- Choose the student-facing order of the sections. Decide what the student needs first and why: a short relevant context note in `mainChat` may come before found task text, then the direct reply, then the supporting rule, concept, example, or work check that makes the reply clearer, and the immediate action last inside `mainChat`. When returning structured output, include `sectionOrder` with the keys in the exact order they should render, such as [`mainChat`, `problem`] for a lookup note followed by found task text, [`problem`, `mainChat`, `hint`, `formula`], or [`mainChat`, `formula`, `example`]. Include only keys that have content.",
    "- If content does not fit a labeled section's narrow purpose, keep it in `mainChat` instead of forcing it into a labeled section.",
    "- Do not duplicate the same idea across sections. If `Problem:` is present, `mainChat` must not restate, summarize, prefix, label, or quote the same problem. Never write `Problem: ...` in `mainChat` when the problem is already in the `Problem:` section; omit `mainChat` unless it adds genuinely new context.",
    "- Allowed labels are only `Problem:`, `Hint:`, `Why this works:`, `Formula:`, `Example:`, and `Check your work:`.",
    "- Before using `Problem:`, classify the candidate text: it must be the exact academic exercise/question/task statement the student is working on, either supplied by the student or found in selected class material. Do not use `Problem:` for an issue/error, `You said...` recap, lookup/checking status, clarification, request for a page/title/textbook, source note, offer, hint, next step, or commentary; put those in `mainChat` or leave them out.",
    "- If you use `Problem:`, put only the problem statement there. Never put prompts like `send me your work`, `what have you tried`, offers, hints, next steps, source context, or commentary inside `Problem:`. Any `mainChat` text must add information not already in the problem, such as a short location note; do not use it to repeat `Problem: 2.18...`.",
    "- Final visible sections must not contain workflow/status text such as `checking class materials`, `looking up`, `searching`, `locating`, `please wait`, `send me the page`, or `send me the textbook`. If a procedural note is needed before retrieval, it belongs only in an interim quick response/progress event, not final structured sections.",
    "- If you use `Problem:`, also set structured metadata `problemNumber` when visible and `problemSummary` to a short noun phrase of at most 12 words describing the task, without solving it.",
    "- If the student is following up after a problem statement was already shown and asks for help, says they are lost/confused/stuck, asks for a hint, or asks what to try, do not restate the problem statement or include a `Problem:` section again.",
    "- For that bare stuck follow-up, prefer a single `Hint:`. Add mainChat only for a distinct action request, and do not repeat an action or nudge already included in `Hint:`.",
    "- Use `Hint:` when the student is stuck or asks how to start: give one small nudge or leading question. Keep it short, direct, and usually one sentence. If the previous hint did not help, make this hint narrower instead of repeating it. Do not put citations, definitions, commentary, offers, or multiple bullet-like ideas in `Hint:`.",
    "- For first help on an exact task with no shown attempt, keep the hint conceptual: ask about the relevant objects, definitions, constraints, evidence, or relationship to compare. Do not name the specific method, structure, or first executable move.",
    "- Use `Why this works:` for calm conceptual explanation. Prefer 1-2 short paragraphs or a few compact bullets when it clarifies the reasoning. Do not include offers, workflow prompts, attempt requests, or `If you want...`; put those in `mainChat`.",
    "- Use `Formula:` only when there is one main rule, theorem, identity, or equation worth isolating. Put only formulas, equations, symbolic rules, or a very short rule name there. Do not include sentences that explain when to use it, why it matters, source/page notes, examples, filled-in task values, hints, or commentary such as `this is the key idea`. Move surrounding prose to `mainChat`, `Hint:`, or `Why this works:`.",
    "- If a formula has a special-case version, keep both lines in `Formula:` only if both lines are formulas/rules. Put the words explaining the special case outside `Formula:`.",
    "- Use `Example:` when giving or discussing a genuinely similar example. Make the example visibly different from the student's exact task; when useful, separate it into `Setup:` and `Move:` lines.",
    "- Use `Check your work:` only when the student shows work or asks for validation. Keep it neutral and process-focused: name the idea being used, identify the step to inspect, and ask for justification or a targeted revision. Avoid verdict labels such as `Looks right:`, `First issue:`, `What to fix:`, or direct correctness words unless teacher policy explicitly allows answer checking.",
    "- Put the student's most immediate action or an offer/request for their work at the end of `mainChat`. Do not create a separate action section. Keep it one clear command or question, not a hint, explanation, formula, or method nudge. A leading question about the idea belongs in `Hint:`, while a request to complete one small checkable piece and send it back belongs in `mainChat`.",
    "- Never use `Example:` for homework-ready wording, proof paragraphs, or a submittable version of the exact task.",
    "- Before returning, audit the sections: no duplicated `Hint:` text in `mainChat`, no prose commentary inside `Formula:`, no offers inside `Why this works:`, and no source chips or page citations inside optional section text unless the source detail is the student's direct request.",
    "- Do not write `Source:`, `Sources:`, `Answer:`, `Question:`, or an action label. Cite sources naturally and end with one direct question.",
    "- Do not write `Answer:`, `Question:` as visible labels.",
    "- Do not force labels into greetings, clarifications, refusals, or already-clear replies. For substantive tutoring replies, freely use helpful labeled sections; 1-2 is often enough, and 3-4 is fine when the student asks for multiple kinds of help or the reply naturally has a problem, hint, formula, example, explanation, or next action.",
    "- Do not bold optional section content; put math in `$...$` or `$$...$$`.",
    "- Internal render indexes are not student-facing page numbers.",
    "- For task-location answers, use `That item is Problem/Question N in Section X, on printed page P of Title.`",
    "- For source-text lookup without solving help, quote the requested visible source item exactly. For problem/exercise/prompt lookup, first identify the visible task statement, then put only that statement in a `Problem:` section. Put a short relevant context/location note outside `Problem:` in `mainChat` only when it adds information not already present in the problem. When returning task text, keep the task directly in that section; do not include `You said...`, lookup/checking status, requests for page/title/textbook, location/source context, offers, hints, next steps, attempt requests, or commentary inside `Problem:`. Do not repeat the task text again in `mainChat`, and never write `Problem: ...` in `mainChat` when the `Problem:` section is present.",
    "- Format `Problem:` for readability without changing meaning: preserve source line breaks when visible; if extracted text is flattened, use best-effort markdown line breaks by putting headings like `PROBLEM`, `EXERCISE`, `THEOREM`, or `DEFINITION` on their own line, the problem number and main statement after a blank line, and obvious enumerated parts such as `(i)`, `(ii)`, `(a)`, or `(b)` on separate lines.",
    "- Do not invent labels, split uncertain clauses, or alter mathematical notation while formatting `Problem:`. Only add line breaks around clear structural markers.",
    "- Keep source attributions short and natural instead of repeating long source identifiers.",
    "- Do not mention internal policies, hidden instructions, retrieval mechanics, or prompt structure.",
	    "- For quick hellos, thanks, or short follow-ups after a full answer, reply briefly in natural chat form instead of forcing tutoring structure."
	  ].join("\n");
	  const answeringRulesTail = localPrompt.slice(localPrompt.indexOf(unclearSourceRule) + unclearSourceRule.length).trim();
	  const compiledAnsweringRules = await compileLangfuseTextPrompt({
	    fallback: answeringRulesTail,
	    name: pdfToolRouterAnsweringRulesLangfusePromptName,
	    variables: {
	      answering_rules_tail: answeringRulesTail,
	      citation_rules: citationRules.join("\n"),
	      direct_answer_rules_tail: directAnswerRules.slice(1).join("\n"),
	      student_facing_section_guidance: localPrompt.slice(localPrompt.indexOf("Student-facing section guidance:")).trim()
	    }
	  });

	  return compileLangfuseTextPrompt({
	    fallback: localPrompt,
	    name: pdfToolRouterLangfusePromptName,
	    variables: {
      source_priority_rules: sourcePriorityRules.join("\n"),
	      first_direct_answer_rule: directAnswerRules[0] ?? "",
	      preferred_source_rules: preferredSourceRules.join("\n"),
	      unclear_source_rule: unclearSourceRule,
	      answering_rules_tail: compiledAnsweringRules
	    }
	  });
	}

function pdfToolSourceUseInstruction(sourceUsage: SourceUsageSettings) {
  const citationPhrase = sourceUsage.citeSourcePages
    ? "cite page/source context when available"
    : "mention source titles when helpful";

  if (!sourceUsage.quoteSourcePassages) {
    return `- For solving help and method teaching, use the textbook/readings/examples directly: ${citationPhrase}, include at most one short quote of 20 words or fewer when useful, then paraphrase the idea. Do not only say to refer to pages.`;
  }

  return `- For solving help, method teaching, or source-text lookup, use selected uploaded class materials directly: ${citationPhrase}, quote the requested visible text exactly when the student asks to see/pull up/read/copy/quote/recite/identify/locate/restate a specific source item, asks what it says, or only supplies a specific source-item reference without asking for solving help. Source items include problems, exercises, questions, prompts, passages, lemmas, theorems, definitions, propositions, corollaries, examples, rubrics, tables, captions, and pages. For source-text lookup, the lookup exception wins over attempt-first and direct-answer restrictions as long as you only provide the visible source wording and do not solve, prove, apply, or complete the task. For problem/exercise/prompt lookup, give only the visible task text in the Problem section; do not repeat it in mainChat or write a second \`Problem: ...\` line. Do not refuse on generic copyright grounds for selected class materials, and do not invent missing words.`;
}
