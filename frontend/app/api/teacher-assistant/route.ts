import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { mintTeacherAssistantContext } from "@/lib/teacher-assistant/assistant-context";
import { createTeacherAssistantProvider } from "@/lib/teacher-assistant/provider";
import {
  executeTeacherAssistantTool,
  getTeacherAssistantAllowedToolNames,
  resolveTeacherAssistantConfirmation
} from "@/lib/teacher-assistant/tool-registry";
import type {
  TeacherAssistantAction,
  TeacherAssistantConfirmationRequest,
  TeacherAssistantMessage,
  TeacherAssistantResponse
} from "@/lib/teacher-assistant/types";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      classId?: unknown;
      confirmation?: TeacherAssistantConfirmationRequest;
      message?: unknown;
      sessionId?: unknown;
    };
    const classId = String(body.classId ?? "").trim();
    const sessionId = String(body.sessionId ?? "").trim() || randomUUID();

    if (body.confirmation) {
      const result = await resolveTeacherAssistantConfirmation({
        confirmation: body.confirmation,
        request
      });
      const response = responseFromToolResult(sessionId, result.summary, result.action ? [result.action] : []);
      return NextResponse.json(response);
    }

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before using the teacher assistant." }, { status: 400 });
    }

    const authorization = await authorizeClassAccess(request, classId, "viewOverview");
    const message = String(body.message ?? "").trim();
    const assistantContext = await mintTeacherAssistantContext({
      actorEmail: authorization.email,
      actorUid: authorization.uid,
      allowedToolNames: getTeacherAssistantAllowedToolNames(authorization.permissions),
      classId,
      sessionId
    });
    const provider = createTeacherAssistantProvider();
    const messages: TeacherAssistantMessage[] = [];
    const actions: TeacherAssistantAction[] = [];

    for await (const event of provider.send({
      assistantContextId: assistantContext.id,
      actorEmail: authorization.email,
      actorUid: authorization.uid,
      classId,
      sanitizedContext: {
        allowedToolNames: assistantContext.allowedToolNames,
        classId,
        expiresAt: assistantContext.expiresAt,
        sessionId
      },
      message,
      runTool: (toolName, args) =>
        executeTeacherAssistantTool({
          args,
          classId,
          request,
          toolName
        }),
      sessionId
    })) {
      if (event.type === "message") {
        messages.push({ content: event.content, role: "assistant" });
      } else {
        actions.push(event.action);
      }
    }

    return NextResponse.json({
      actions,
      messages,
      sessionId
    } satisfies TeacherAssistantResponse);
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    const message = caughtError instanceof Error ? caughtError.message : "Teacher assistant request failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function responseFromToolResult(
  sessionId: string,
  message: string,
  actions: TeacherAssistantAction[]
): TeacherAssistantResponse {
  return {
    actions,
    messages: [
      {
        content: message,
        role: "assistant"
      }
    ],
    sessionId
  };
}
