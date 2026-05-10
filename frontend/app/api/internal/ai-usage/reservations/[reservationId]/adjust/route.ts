import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adjustAiTokenReservation, AiUsageLimitError } from "@/lib/ai-usage-limits";

export const runtime = "nodejs";

const requestSchema = z.object({
  estimatedTokens: z.number().int().min(1).max(10_000_000),
  studentId: z.string().min(1).max(200).optional()
});

export async function POST(
  request: Request,
  context: { params: Promise<{ reservationId: string }> }
) {
  const authError = authorizeInternalRequest(request);

  if (authError) {
    return authError;
  }

  const { reservationId } = await context.params;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success || !reservationId) {
    return NextResponse.json({ error: "Invalid AI usage reservation adjustment request." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      aiUsageStatus: await adjustAiTokenReservation({
        estimatedTokens: parsed.data.estimatedTokens,
        reservationId,
        studentId: parsed.data.studentId
      })
    });
  } catch (caughtError) {
    if (caughtError instanceof AiUsageLimitError) {
      return NextResponse.json(
        {
          aiUsageStatus: caughtError.studentStatus,
          error: "AI usage limit reached."
        },
        { status: caughtError.status }
      );
    }

    throw caughtError;
  }
}

function authorizeInternalRequest(request: Request) {
  const expectedSecret = process.env.BACKEND_SHARED_SECRET?.trim() ?? "";

  if (!expectedSecret) {
    return NextResponse.json({ error: "BACKEND_SHARED_SECRET is required." }, { status: 503 });
  }

  const receivedSecret = request.headers.get("x-chandra-internal-secret") ?? "";
  const expectedBuffer = Buffer.from(expectedSecret);
  const receivedBuffer = Buffer.from(receivedSecret);

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return NextResponse.json({ error: "Invalid internal backend secret." }, { status: 403 });
  }

  return null;
}
