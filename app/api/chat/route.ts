import { NextResponse } from "next/server";
import { z } from "zod";
import { defaultOpenRouterModelId } from "@/lib/model-options";
import { buildTutorSystemPrompt, toProviderMessages } from "@/lib/prompts";
import {
  ConversationPersistenceError,
  prepareStudentConversationPersistence,
  saveAssistantMessage,
  type StudentConversationPersistence
} from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";
import type { TutorApiResponse } from "@/lib/types";

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
      return NextResponse.json({ error: "Invalid chat request" }, { status: 400 });
    }

    if (parsed.data.modelId === "demo-guided") {
      return NextResponse.json({ error: "Choose a tool-capable OpenRouter model for tutor chat." }, { status: 400 });
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
      return NextResponse.json({ error: detail || "LangGraph tutor chat failed." }, { status: response.status });
    }

    const tutorResponse = normalizeTutorResponse(await response.json());

    if (preparedRequest.persistence) {
      await saveAssistantMessage({
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
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Tutor chat failed." }, { status: 500 });
  }
}

type ParsedChatRequest = z.infer<typeof chatRequestSchema>;

async function buildBackendChatRequest(request: Request, data: ParsedChatRequest) {
  const scope = await authorizeTutorChatRequest(request, data.courseId);
  const courseId = scope.classId;
  const model = data.modelId || process.env.DEFAULT_STUDENT_MODEL || process.env.DEFAULT_MODEL || defaultOpenRouterModelId;
  const systemPrompt = [
    await buildTutorSystemPrompt({
      courseId,
      retrievalHits: []
    }),
    buildPdfToolChoosingTutorSystemPrompt()
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
          send({
            message: detail || "The tutor backend returned an empty error. Check the FastAPI terminal and try again.",
            stage: "error",
            type: "error"
          });
          return;
        }

        const reader = response.body?.getReader();

        if (!reader) {
          send({
            message: "The tutor service did not return a stream.",
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
                await saveAssistantMessage({
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
            } else {
              send(event);
            }
          }
        }
      } catch (caughtError) {
        send({
          message: describeTutorServiceError(caughtError),
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
  return (process.env.BACKEND_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000").replace(
    /\/$/,
    ""
  );
}

function describeTutorServiceError(caughtError: unknown) {
  if (isBackendFetchFailure(caughtError)) {
    return [
      "I could not reach Chandra's tutor backend.",
      "Start it with `npm run dev:api`, then try again. If it is already running, check `BACKEND_API_BASE_URL`."
    ].join(" ");
  }

  return caughtError instanceof Error
    ? caughtError.message
    : "I could not reach the tutor service. Try again in a moment.";
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

function buildPdfToolChoosingTutorSystemPrompt() {
  return [
    "LangGraph PDF retrieval:",
    "Tool: search_pdf_pages({ query, student_reason }) searches indexed class PDF page windows: homework/problem sets, worksheets, assignments, textbook/readings, notes, and examples. It returns the top 5 matching windows with metadata; LangGraph then opens the selected pages for the final answer.",
    "",
    "Use search_pdf_pages before answering when class PDFs could help solve, explain, or locate the student's question:",
    "- If the student asks to find, identify, or locate a specific problem, search the problem PDF first: homework/problem sets, worksheets, assignments, or practice-problem PDFs. Do not search textbook/readings unless no problem-set match is found.",
    "- If the student asks how to solve a math problem, search the exact problem/source first when identifiable, then textbook/readings only if method support would help.",
    "- If the student asks for the answer, final answer, or asks you to just give the answer, do not solve their exact problem. Search for textbook/readings/examples only if needed to offer a similar example walkthrough.",
    "- Do not use the tool for relationships, family conflict, emotional support, unrelated coding, or other non-course topics. Briefly redirect those to course material.",
    "- An uploaded or class-specific worksheet, assignment, PDF, notes, lecture, textbook, rubric, example, diagram, table, or equation.",
    "- A page, section, problem number, title, source-backed answer, or follow-up such as 'part b', 'that example', or 'the next one'.",
    "",
    "Do not use the tool for greetings, general tutoring, study planning, off-topic support, unrelated coding, or trivial self-contained questions. For a fully pasted problem, use the tool when textbook/readings would materially improve the explanation or hint.",
    "",
    "Query rules:",
    "- Usually make one focused query from the student's exact wording plus the likely source type, any known title, page, section, problem number, topic/method, and recent source context.",
    "- For find/identify/locate requests, include source-type terms like problem PDF, homework, problem set, worksheet, assignment, or practice problems. Do not include textbook unless the student asked for the textbook or no problem-set search has matched.",
    "- When the student gives both a specific problem/source and needs conceptual solving help, you may call search_pdf_pages 2 or 3 times in the same turn with distinct complementary queries.",
    "- If the student only asks where a problem is, find the problem/source page in a problem set/assignment and stop. Do not search for textbook or method pages.",
    "- For a problem-solving request tied to a specific exercise, do not stop at finding the exercise page. Search for both the exact problem/source and textbook/reading/example support for the method before answering.",
    "- For follow-up questions, use previously cited source context in the transcript. Do not repeat the exact problem/source search when a prior assistant message already cited the matching problem/page.",
    "- If prior selected pages already include relevant textbook/reading/notes/worked-example support, use those pages and do not search again.",
    "- If a follow-up needs more class material after the problem page is already known, search only for the missing method/textbook/example support.",
    "- Good parallel searches cover different purposes: exact problem/page/source, relevant textbook method/formula/definition, and a nearby textbook or worked example.",
    "- Every search_pdf_pages call must include student_reason: exactly five words explaining why that specific query helps the student.",
    "- Good student_reason examples: Checking exact problem and page; Finding method and example pages; Searching class PDFs for support.",
    "- Do not make multiple searches if one focused query is likely enough.",
    "- Never make more than 3 search_pdf_pages calls in one turn.",
    "- For solving-help questions, prefer queries that target the reading or method, such as topic + formula/example/definition, not only the exact pasted problem.",
    "- Preserve names, numbers, symbols, and equation text exactly.",
    "- Search again only if the selected pages are insufficient or mismatched, using a genuinely new and sharper query.",
    "- Never repeat a previous query or a minor wording variant.",
    "",
    "Answering rules:",
    "- If retrieval is needed, call search_pdf_pages and wait for selected pages before answering.",
    "- If retrieval is not needed, answer directly.",
    "- After retrieval, answer only from selected pages. If they do not contain the answer and no sharper query is available, ask for the exact title, page, problem, or pasted text.",
    "- If the student asks for the answer/final answer, say you cannot give the final answer. Do not continue solving their exact problem after that refusal.",
    "- For direct-answer requests, offer to walk through a similar textbook/readings/example problem or check the student's attempted step. Use the textbook example, not the student's exact problem, for the walkthrough.",
    "- If selected pages only locate the problem but do not include textbook/readings/examples that explain the method, search again instead of giving solving help.",
    "- For solving help, use the textbook/readings/examples directly: cite the page, include one short quote of 20 words or fewer when it supports the hint, then paraphrase the idea. Do not only say to refer to pages.",
    "- Help the student find the next move with a targeted question or small hint. Do not state the next move outright or solve the whole problem immediately.",
    "- When the opened PDF page visibly shows a printed document page number, use that printed page in the answer.",
    "- Internal PDF render indexes are not student-facing page numbers.",
    "- For problem-location answers, use this shape: `$integral$ is Problem N in Section X, on printed page P of Title.`",
    "- Do not restate an integral the student already supplied more than once.",
    "Guide learning without simply completing graded work for the student.",
    "Use `$...$` or `$$...$$` for math expressions."
  ].join("\n");
}
