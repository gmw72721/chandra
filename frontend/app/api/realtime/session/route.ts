import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  askChandraTutorTool,
  buildRealtimeSessionConfig,
  publicRealtimeSessionConfig,
  realtimeClientSecretTtlSeconds,
  sanitizeRealtimeKnownContext,
  realtimeKnownContextSchema
} from "@/lib/realtime-tutor";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

const safeDocumentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/"));
const maxRealtimeSessionRequestCharacters = 6000;

const realtimeSessionRequestSchema = z
  .object({
    conversationId: safeDocumentIdSchema.optional(),
    courseId: z.string().trim().min(1).max(200).optional(),
    knownContext: realtimeKnownContextSchema.optional()
  })
  .strict();

export async function POST(request: Request) {
  try {
    const body = await readRealtimeSessionRequestBody(request);

    if (body.tooLarge) {
      return realtimeErrorResponse("Realtime session request is too large.", 413);
    }

    if (body.invalidJson) {
      return realtimeErrorResponse("Invalid Realtime session request.", 400);
    }

    const parsed = realtimeSessionRequestSchema.safeParse(body.value);

    if (!parsed.success) {
      return realtimeErrorResponse("Invalid Realtime session request.", 400);
    }

    const scope = await authorizeTutorChatRequest(request, parsed.data.courseId);
    const knownContext = sanitizeRealtimeKnownContext(parsed.data.knownContext);
    const sessionConfig = buildRealtimeSessionConfig({
      conversationId: parsed.data.conversationId,
      courseId: scope.classId,
      knownContext
    });
    const clientSecret = await createRealtimeClientSecret({
      safetyIdentifier: realtimeSafetyIdentifier(scope),
      sessionConfig
    });

    return NextResponse.json({
      clientSecret: {
        expiresAt: clientSecret.expires_at ?? clientSecret.expiresAt,
        value: clientSecret.value
      },
      conversationId: parsed.data.conversationId,
      courseId: scope.classId,
      knownContext,
      model: sessionConfig.model,
      realtimeApi: {
        clientSecretEndpoint: "/v1/realtime/client_secrets",
        webrtcEndpoint: "https://api.openai.com/v1/realtime/calls"
      },
      session: publicRealtimeSessionConfig(sessionConfig),
      tutorTool: {
        endpoint: "/api/realtime/tutor-tool",
        name: askChandraTutorTool.name,
        schema: askChandraTutorTool
      }
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError) {
      return realtimeErrorResponse(caughtError.message, caughtError.status);
    }

    if (caughtError instanceof RealtimeSessionError) {
      return realtimeErrorResponse(caughtError.message, caughtError.status);
    }

    console.error("Realtime session failed", caughtError);
    return realtimeErrorResponse("Could not create a Realtime session.", 500);
  }
}

async function createRealtimeClientSecret({
  safetyIdentifier,
  sessionConfig
}: {
  safetyIdentifier: string;
  sessionConfig: ReturnType<typeof buildRealtimeSessionConfig>;
}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    console.error("OpenAI Realtime client secret creation skipped because the server API key is missing.");
    throw new RealtimeSessionError("Realtime voice sessions are not configured.", 503);
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: realtimeClientSecretTtlSeconds()
      },
      session: sessionConfig
    }),
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new RealtimeSessionError(await readOpenAiError(response), response.status);
  }

  const payload = await response.json();
  const clientSecret = payload.client_secret ?? payload.clientSecret ?? payload.session?.client_secret ?? payload;

  if (typeof clientSecret?.value !== "string" || !clientSecret.value) {
    throw new RealtimeSessionError("OpenAI did not return a Realtime client secret.", 502);
  }

  return clientSecret as { expires_at?: number; expiresAt?: number; value: string };
}

async function readRealtimeSessionRequestBody(request: Request) {
  const rawBody = await request.text();

  if (rawBody.length > maxRealtimeSessionRequestCharacters) {
    return { invalidJson: false, tooLarge: true, value: undefined };
  }

  try {
    return { invalidJson: false, tooLarge: false, value: rawBody ? JSON.parse(rawBody) : {} };
  } catch {
    return { invalidJson: true, tooLarge: false, value: undefined };
  }
}

function realtimeSafetyIdentifier(scope: Awaited<ReturnType<typeof authorizeTutorChatRequest>>) {
  const secret =
    process.env.OPENAI_SAFETY_IDENTIFIER_SECRET?.trim() ||
    process.env.BACKEND_SHARED_SECRET?.trim() ||
    "local-realtime-safety-identifier";

  return createHmac("sha256", secret)
    .update(`${scope.classId}:${scope.uid}:${scope.role}`)
    .digest("hex")
    .slice(0, 64);
}

async function readOpenAiError(response: Response) {
  try {
    const payload = await response.json();
    return String(payload.error?.message ?? payload.detail ?? "OpenAI Realtime session request failed.");
  } catch {
    return "OpenAI Realtime session request failed.";
  }
}

function realtimeErrorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

class RealtimeSessionError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
