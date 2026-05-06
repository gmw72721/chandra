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
import { defaultOpenRouterModelId } from "@/lib/model-options";
import { buildTutorSystemPrompt, getTeacherClassTutorConfig, toProviderMessages } from "@/lib/prompts";
import { getActiveStudentLearningProfileDigest } from "@/lib/student-learning-profiles-server";
import {
  ConversationPersistenceError,
  prepareStudentConversationPersistence,
  saveAssistantMessage,
  type StudentConversationPersistence
} from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";
import type { TutorApiResponse } from "@/lib/types";

const STUDENT_TUTOR_BACKEND_UNAVAILABLE_MESSAGE =
  "Chandra is having trouble connecting. Try again in a moment.";
const STUDENT_TUTOR_RESPONSE_FAILED_MESSAGE =
  "Chandra is having trouble responding right now. Try again in a moment.";

const safeDocumentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/"));

const chatRequestSchema = z.object({
  conversationId: safeDocumentIdSchema.optional(),
  courseId: z.string().optional(),
  modelId: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({
      id: safeDocumentIdSchema,
      role: z.enum(["student", "teacher", "assistant", "system"]),
      content: z.string(),
      createdAt: z.string(),
      langGraphTrace: z
        .object({
          finishReason: z.string().optional(),
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
        .optional()
    })
  )
});

export async function POST(request: Request) {
  try {
    const parsed = chatRequestSchema.safeParse(await request.json());

    if (!parsed.success) {
      const chatError = reportStudentChatError({
        caughtError: parsed.error,
        code: "CHAT_REQUEST_INVALID"
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: 400 });
    }

    const preparedRequest = await buildBackendChatRequest(request, parsed.data);

    if (parsed.data.stream) {
      return streamTutorResponse(preparedRequest);
    }

    const response = await fetch(`${langGraphBackendBaseUrl()}/api/langgraph/chat`, {
      body: JSON.stringify(preparedRequest.backendRequest),
      headers: backendHeaders(),
      method: "POST"
    });

    if (!response.ok) {
      const detail = await readBackendError(response);
      const chatError = reportStudentChatError({
        backendDetail: detail,
        backendStatus: response.status,
        code: classifyBackendResponseError(response.status, detail)
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: response.status });
    }

    const tutorResponse = normalizeTutorResponse(await response.json());

    if (preparedRequest.persistence) {
      await saveAssistantMessageWithoutBlockingTutorResponse({
        assistantMessageId: preparedRequest.persistence.assistantMessageId,
        conversationId: preparedRequest.persistence.conversationId,
        modelId: preparedRequest.persistence.modelId,
        response: tutorResponse,
        scope: preparedRequest.scope
      });
    }

    return NextResponse.json(withConversationMetadata(tutorResponse, preparedRequest.persistence));
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError) {
      const chatError = reportStudentChatError({
        caughtError,
        code: classifyTutorChatHttpError(caughtError)
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      const chatError = reportStudentChatError({
        caughtError,
        code: classifyConversationPersistenceError(caughtError)
      });
      return NextResponse.json(studentChatErrorPayload(chatError), { status: caughtError.status });
    }

    const chatError = reportStudentChatError({
      caughtError,
      code: classifyUnexpectedChatError(caughtError)
    });
    return NextResponse.json(studentChatErrorPayload(chatError), { status: 500 });
  }
}

type ParsedChatRequest = z.infer<typeof chatRequestSchema>;

async function buildBackendChatRequest(request: Request, data: ParsedChatRequest) {
  const scope = await authorizeTutorChatRequest(request, data.courseId);
  const courseId = scope.classId;
  const teacherClass = await getTeacherClassTutorConfig(courseId);
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
  const studentLearningProfileDigest =
    scope.role === "student"
      ? await getActiveStudentLearningProfileDigest({
          classId: courseId,
          studentId: scope.uid
        })
      : "";

  if (model === "demo-guided") {
    throw new TutorChatHttpError("Choose a real OpenRouter model for tutor chat.", 400);
  }

  const systemPrompt = [
    await buildTutorSystemPrompt({
      courseId,
      retrievalHits: [],
      studentLearningProfileDigest,
      teacherClass
    }),
    buildPdfToolChoosingTutorSystemPrompt(teacherClass?.sourceUsage, teacherClass?.answerPolicy)
  ].join("\n\n");

  const persistence = await prepareStudentConversationPersistence({
    conversationId: data.conversationId,
    messages: data.messages,
    modelId: model,
    scope
  });

  return {
    backendRequest: {
      classId: courseId,
      professorId: scope.professorId,
      professorName: scope.professorName,
      modelId: model,
      temperature,
      maxTokens,
      reasoningEffort,
      answerPolicy: teacherClass?.answerPolicy,
      sourceUsage: teacherClass?.sourceUsage,
      messages: toProviderMessages(systemPrompt, data.messages)
    },
    persistence,
    scope
  };
}

type PreparedBackendChatRequest = Awaited<ReturnType<typeof buildBackendChatRequest>>;

function streamTutorResponse(preparedRequest: PreparedBackendChatRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        send({
          message: "Reading your question.",
          stage: "reading_question",
          type: "step"
        });

        const response = await fetch(`${langGraphBackendBaseUrl()}/api/langgraph/chat/stream`, {
          body: JSON.stringify(preparedRequest.backendRequest),
          headers: backendHeaders(),
          method: "POST"
        });

        if (!response.ok) {
          const detail = await readBackendError(response);
          const chatError = reportStudentChatError({
            backendDetail: detail,
            backendStatus: response.status,
            code: classifyBackendResponseError(response.status, detail)
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
            code: "TUTOR_BACKEND_STREAM_MISSING"
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
              const tutorResponse = normalizeTutorResponse(event.payload as Partial<TutorApiResponse>);

              if (preparedRequest.persistence) {
                await saveAssistantMessageWithoutBlockingTutorResponse({
                  assistantMessageId: preparedRequest.persistence.assistantMessageId,
                  conversationId: preparedRequest.persistence.conversationId,
                  modelId: preparedRequest.persistence.modelId,
                  response: tutorResponse,
                  scope: preparedRequest.scope
                });
              }

              send({
                message: "Writing a helpful next step from the pages I found.",
                stage: "writing_answer",
                type: "step"
              });
              send({
                payload: withConversationMetadata(tutorResponse, preparedRequest.persistence),
                type: "final"
              });
            } else if (event.type === "error") {
              const backendDetail = typeof event.message === "string" ? event.message : "";
              const chatError = reportStudentChatError({
                backendDetail,
                code: classifyBackendStreamError(backendDetail)
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
        const chatError = reportStudentChatError({
          caughtError,
          code: classifyUnexpectedChatError(caughtError)
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
  return (process.env.BACKEND_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}

type StudentChatErrorCode =
  | "CHAT_CLASS_NOT_FOUND"
  | "CHAT_CLASS_REQUIRED"
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
  caughtError,
  code
}: {
  backendDetail?: string;
  backendStatus?: number;
  caughtError?: unknown;
  code: StudentChatErrorCode;
}): ReportedStudentChatError {
  const errorId = randomUUID().slice(0, 8).toUpperCase();
  const studentMessage = studentMessageForChatError(code);

  console.error("Student chat error", JSON.stringify({
    backendBaseUrl: langGraphBackendBaseUrl(),
    backendDetail,
    backendStatus,
    code,
    errorId,
    message: errorMessageForLog(caughtError)
  }));

  return {
    code,
    errorId,
    studentMessage
  };
}

function studentChatErrorPayload(error: ReportedStudentChatError) {
  return {
    error: studentChatErrorMessage(error),
    errorCode: error.code,
    errorId: error.errorId
  };
}

function studentChatErrorMessage(error: ReportedStudentChatError) {
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
    case "CHAT_TEACHER_SETUP_REQUIRED":
      return "This class needs a setup fix before chat can start. Ask your teacher for help.";
    case "CHAT_TEACHER_PREVIEW_CLASS_REQUIRED":
      return "Choose a class before previewing student chat.";
    case "CHAT_TEACHER_PREVIEW_FORBIDDEN":
      return "Only this class's teacher can preview this chat.";
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

  if (message.includes("only the class teacher")) {
    return "CHAT_TEACHER_PREVIEW_FORBIDDEN";
  }

  if (message.includes("saved class was not found")) {
    return "CHAT_CLASS_NOT_FOUND";
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

  if (normalizedDetail.includes("not installed") || normalizedDetail.includes("pip install")) {
    return "TUTOR_BACKEND_SETUP_INCOMPLETE";
  }

  if (status === 408 || status === 504 || normalizedDetail.includes("timeout") || normalizedDetail.includes("timed out")) {
    return "TUTOR_BACKEND_TIMEOUT";
  }

  if (status === 429 || normalizedDetail.includes("rate limit")) {
    return "TUTOR_BACKEND_RATE_LIMITED";
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

  if (normalizedDetail.includes("rate limit")) {
    return "TUTOR_BACKEND_RATE_LIMITED";
  }

  if (normalizedDetail.includes("not installed") || normalizedDetail.includes("pip install")) {
    return "TUTOR_BACKEND_SETUP_INCOMPLETE";
  }

  return "TUTOR_BACKEND_STREAM_FAILED";
}

function classifyUnexpectedChatError(caughtError: unknown): StudentChatErrorCode {
  if (isBackendFetchFailure(caughtError)) {
    return "TUTOR_BACKEND_UNREACHABLE";
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

function backendHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (process.env.BACKEND_SHARED_SECRET) {
    headers["X-Chandra-Internal-Secret"] = process.env.BACKEND_SHARED_SECRET;
  }

  return headers;
}

async function readBackendError(response: Response) {
  try {
    const payload = await response.json();
    return String(payload.detail ?? payload.error ?? "");
  } catch {
    return "";
  }
}

function normalizeTutorResponse(payload: Partial<TutorApiResponse>): TutorApiResponse {
  const message = String(payload.message ?? payload.content ?? "");

  return {
    assistantMessageId: payload.assistantMessageId,
    content: message,
    conversationId: payload.conversationId,
    langGraphTrace: payload.langGraphTrace,
    message,
    retrievalConfidence:
      payload.retrievalConfidence === "high" || payload.retrievalConfidence === "medium"
        ? payload.retrievalConfidence
        : "low",
    sources: Array.isArray(payload.sources) ? payload.sources : []
  };
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
      code:
        caughtError instanceof ConversationPersistenceError
          ? classifyConversationPersistenceError(caughtError)
          : "CHAT_CONVERSATION_ID_INVALID"
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
        "- If the student asks to find, identify, or locate a specific problem, search the problem PDF first: homework/problem sets, worksheets, assignments, or practice-problem PDFs. Do not search textbook/readings unless no problem-set match is found.",
        "- If the student asks about a concrete math problem, including a fully pasted problem, search for the exact problem/source first when class materials are available. Check problem PDFs, worksheets, assignments, practice problems, and textbook sections before helping.",
        "- After checking the exact problem/source, search textbook/readings only if method support would help.",
        "- For conceptual method questions such as when to use a technique, how to recognize a pattern, why a rule works, or requests for examples, search textbook/readings/examples so the explanation can use the class wording."
      ]
    : [
        "- Search class PDFs when the student asks about a specific uploaded worksheet, assignment, page, problem number, note, lecture, textbook section, rubric, example, diagram, table, equation, or previous source-backed answer.",
        "- For self-contained conceptual questions, answer directly without search unless class materials would materially improve the help."
      ];
  const preferredSourceRules = [
    `- Preferred source type for retrieval: ${sourceUsage.preferredSourceType}.`,
    ...(sourceUsage.preferredSourceType === "Textbook first"
      ? ["- For solving help, prefer textbook/readings/examples before worksheets unless the student asks for a specific worksheet problem."]
      : []),
    ...(sourceUsage.preferredSourceType === "Worked examples"
      ? ["- Prefer worked-example and example PDFs when the student needs explanation or practice."]
      : []),
    ...(sourceUsage.preferredSourceType === "Homework and textbook"
      ? ["- Prefer homework/problem-set pages for exact problem lookup and textbook/readings for method support."]
      : []),
    ...(sourceUsage.preferredSourceType === "Uploaded class materials"
      ? ["- Prefer uploaded class-specific materials whenever retrieval is useful."]
      : [])
  ];
  const directAnswerRules = answerPolicy.refuseAnswerOnlyRequests
    ? [
        "- If the student asks for the answer, final answer, or asks you to just give the answer, do not solve their exact problem. Search for textbook/readings/examples only if needed to offer a similar example walkthrough.",
        "- If the student asks for the answer/final answer, say you cannot give the final answer. Do not continue solving their exact problem after that refusal.",
        "- For direct-answer requests, offer to walk through a similar textbook/readings/example problem or check the student's attempted step. Use the textbook example, not the student's exact problem, for the walkthrough."
      ]
    : [
        "- If the student asks for an answer, avoid answer-only output. Explain the reasoning and check understanding.",
        "- Do not use retrieval solely to complete a graded worksheet wholesale."
      ];
  const citationRules = sourceUsage.citeSourcePages
    ? [
        "- For solving help and method teaching, use the textbook/readings/examples directly: cite the page, include one short quote of 20 words or fewer when a relevant quote is available, then paraphrase the idea. Do not only say to refer to pages.",
        "- When the opened PDF page visibly shows a printed document page number, use that printed page in the answer."
      ]
    : [
        "- For solving help, use the selected pages directly. Mention source titles when helpful, but page citations are optional unless needed for clarity."
      ];
  const unclearSourceRule = sourceUsage.askClarificationIfSourceUnclear
    ? "- After retrieval, answer only from selected pages. If they do not contain the answer and no sharper query is available, ask for the exact title, page, problem, or pasted text."
    : "- After retrieval, if selected pages are weak, say what is uncertain and give cautious general help without inventing source details.";

  return [
    "LangGraph PDF retrieval:",
    "Tool: search_pdf_pages({ query, student_reason }) searches indexed class PDF page windows: homework/problem sets, worksheets, assignments, textbook/readings, notes, and examples. It returns the top 5 matching windows with metadata; LangGraph then opens the selected pages for the final answer.",
    "",
    "Use search_pdf_pages before answering when class PDFs could help solve, explain, or locate the student's question:",
    ...sourcePriorityRules,
    ...directAnswerRules.slice(0, 1),
    ...preferredSourceRules,
    "- Do not use the tool for relationships, family conflict, emotional support, unrelated coding, or other non-course topics. Briefly redirect those to course material.",
    "- An uploaded or class-specific worksheet, assignment, PDF, notes, lecture, textbook, rubric, example, diagram, table, or equation.",
    "- A page, section, problem number, title, source-backed answer, or follow-up such as 'part b', 'that example', or 'the next one'.",
    "",
    "Do not use the tool for greetings, study planning, off-topic support, unrelated coding, or trivial self-contained questions. For concrete math problems, including fully pasted problems, use the tool first to check whether the exact problem appears in class materials. For method-teaching questions, use the tool when textbook/readings/examples would materially improve the explanation, quote, example, or hint.",
    "",
    "Query rules:",
    "- Usually make one concise focused query from the student's exact wording plus the likely source type, any known title, page, section, problem number, topic/method, and recent source context.",
    "- For find/identify/locate requests, start the query with a locator verb such as find, where, locate, identify, or which, then include source-type terms like problem PDF, homework, problem set, worksheet, assignment, or practice problems. Do not include textbook unless the student asked for the textbook or no problem-set search has matched.",
    "- When the student gives both a specific problem/source and needs conceptual solving help, you may call search_pdf_pages 2 or 3 times in the same turn with distinct complementary queries.",
    "- If the student only asks where a problem is, find the problem/source page in a problem set/assignment and stop. Do not search for textbook or method pages.",
    "- For a problem-solving request tied to a specific class source, do not stop at finding the exercise page. Search for both the exact problem/source and textbook/reading/example support for the method before answering.",
    "- For follow-up questions, use previously cited source context in the transcript. Do not repeat the exact problem/source search when a prior assistant message already cited the matching problem/page.",
    "- If prior selected pages already include relevant textbook/reading/notes/worked-example support, use those pages and do not search again.",
    "- If a follow-up needs more class material after the problem page is already known, search only for the missing method/textbook/example support.",
    "- Good parallel searches cover different purposes: exact problem/page/source, relevant textbook method/formula/definition, and a nearby textbook or worked example.",
    "- Every search_pdf_pages call must include student_reason: exactly five words explaining why that specific query helps the student.",
    "- Good student_reason examples: Checking exact problem and page; Finding method and example pages; Searching class PDFs for support.",
    "- Do not make multiple searches if one focused query is likely enough.",
    "- Never make more than 3 search_pdf_pages calls in one turn.",
    "- For solving-help questions, prefer queries that target the reading or method, such as topic + formula/example/definition. Keep homework/worksheet/problem PDF terms out of textbook/method searches unless the source itself is a worked example.",
    "- Preserve names, numbers, symbols, and equation text exactly.",
    "- Search again only if the selected pages are insufficient or mismatched, using a genuinely new and sharper query.",
    "- Never repeat a previous query or a minor wording variant.",
    "",
    "Answering rules:",
    "- If retrieval is needed, call search_pdf_pages and wait for selected pages before answering.",
    "- If retrieval is not needed, answer directly.",
    unclearSourceRule,
    ...directAnswerRules.slice(1),
    "- If selected pages only locate the problem but do not include textbook/readings/examples that explain the method, search again instead of giving solving help.",
    ...citationRules,
    "- Help the student find the next move with a targeted question or small hint. Do not state the next move outright or solve the whole problem immediately.",
    "- Internal PDF render indexes are not student-facing page numbers.",
    "- For problem-location answers, use this shape: `$integral$ is Problem N in Section X, on printed page P of Title.`",
    "- Do not restate an integral the student already supplied more than once.",
    "Guide learning without simply completing graded work for the student.",
    "Use `$...$` or `$$...$$` for math expressions."
  ].join("\n");
}
