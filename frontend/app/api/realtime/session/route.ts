import { NextResponse } from "next/server";
import { z } from "zod";
import {
  askVoiceTutorRealtimeTool,
  buildRealtimeSessionConfig,
  configuredRealtimeModel,
  realtimeClientSecretUrl
} from "@/lib/voice-tutor-contracts";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

const sessionRequestSchema = z.object({
  conversationId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !value.includes("/"))
    .optional(),
  courseId: z.string().max(200).optional()
});

export async function POST(request: Request) {
  try {
    const rawBody = await readJsonObject(request);
    const parsed = sessionRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      return realtimeErrorResponse("Realtime session request is invalid.", 400);
    }

    const scope = await authorizeTutorChatRequest(request, parsed.data.courseId);
    const apiKey = process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) {
      return realtimeErrorResponse("OPENAI_API_KEY is required to create a Realtime session.", 503);
    }

    const sessionConfig = buildRealtimeSessionConfig({
      conversationId: parsed.data.conversationId,
      courseId: scope.classId,
      model: configuredRealtimeModel()
    });
    const openaiResponse = await fetch(realtimeClientSecretUrl, {
      body: JSON.stringify({
        expires_after: {
          anchor: "created_at",
          seconds: 600
        },
        session: sessionConfig
      }),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });

    if (!openaiResponse.ok) {
      return realtimeErrorResponse(await readOpenAIError(openaiResponse), openaiResponse.status);
    }

    const openaiPayload = await openaiResponse.json();
    const safePayload = safeRealtimeSessionResponse(openaiPayload, sessionConfig, scope.classId);

    if (!safePayload.clientSecret.value) {
      return realtimeErrorResponse("Realtime session response did not include a client secret.", 502);
    }

    return NextResponse.json(safePayload, {
      headers: noStoreHeaders()
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError) {
      return realtimeErrorResponse(caughtError.message, caughtError.status);
    }

    console.error("Realtime session error", caughtError);
    return realtimeErrorResponse("Realtime session setup failed.", 500);
  }
}

async function readJsonObject(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function safeRealtimeSessionResponse(
  openaiPayload: Record<string, unknown>,
  sessionConfig: ReturnType<typeof buildRealtimeSessionConfig>,
  courseId: string
) {
  const clientSecretRecord = recordValue(openaiPayload.client_secret);
  const sessionRecord = recordValue(openaiPayload.session);
  const secretValue = stringValue(clientSecretRecord.value) || stringValue(openaiPayload.value);
  const expiresAt = numberValue(clientSecretRecord.expires_at) ?? numberValue(openaiPayload.expires_at);

  return {
    clientSecret: {
      value: secretValue,
      expiresAt
    },
    courseId,
    realtime: {
      endpoint: "https://api.openai.com/v1/realtime",
      model: stringValue(sessionRecord.model) || sessionConfig.model,
      reasoningEffort: sessionConfig.reasoning.effort,
      tool: {
        name: askVoiceTutorRealtimeTool.name,
        schema: askVoiceTutorRealtimeTool
      },
      truncation: sessionConfig.truncation
    },
    session: {
      id: stringValue(sessionRecord.id) || undefined,
      expiresAt,
      model: stringValue(sessionRecord.model) || sessionConfig.model
    }
  };
}

async function readOpenAIError(response: Response) {
  try {
    const payload = await response.json();
    return String(payload.error?.message ?? payload.error ?? "Realtime session setup failed.");
  } catch {
    return "Realtime session setup failed.";
  }
}

function realtimeErrorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { headers: noStoreHeaders(), status });
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store"
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}
