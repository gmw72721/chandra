import { z } from "zod";
import { TutorKnowledgeHttpError } from "../tutor-knowledge-errors.ts";
import { resolveTeacherAssistantContextForTool } from "./assistant-context.ts";
import { executeTeacherAssistantToolWithActor } from "./tool-registry.ts";

const toolCallbackSchema = z.object({
  args: z.record(z.unknown()).optional(),
  assistantContextId: z.string().min(1),
  toolName: z.string().min(1)
});

export async function handleTeacherAssistantToolCallback(request: Request) {
  const configuredSecret = process.env.CHANDRA_ASSISTANT_TOOL_SHARED_SECRET?.trim();
  const providedSecret = request.headers.get("x-chandra-assistant-tool-secret")?.trim();

  if (!configuredSecret || providedSecret !== configuredSecret) {
    return {
      body: { error: "Assistant tool callback is not authorized." },
      status: 401
    };
  }

  try {
    const body = toolCallbackSchema.parse(await request.json().catch(() => ({})));
    const context = await resolveTeacherAssistantContextForTool({
      assistantContextId: body.assistantContextId,
      toolName: body.toolName
    });
    const result = await executeTeacherAssistantToolWithActor({
      actor: context.actor,
      args: sanitizeArgs(body.args ?? {}),
      classId: context.classId,
      toolName: body.toolName
    });

    return {
      body: sanitizeToolResult(result),
      status: 200
    };
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return {
        body: { error: caughtError.message },
        status: caughtError.status
      };
    }

    const message = caughtError instanceof Error ? caughtError.message : "Assistant tool callback failed.";
    return {
      body: { error: message },
      status: 400
    };
  }
}

function sanitizeArgs(args: Record<string, unknown>) {
  return { ...args };
}

function sanitizeToolResult(result: Awaited<ReturnType<typeof executeTeacherAssistantToolWithActor>>) {
  return {
    ...(result.action ? { action: result.action } : {}),
    ...(result.content ? { content: result.content } : {}),
    ...(result.data ? { data: result.data } : {}),
    status: result.status,
    summary: result.summary,
    toolName: result.toolName
  };
}
