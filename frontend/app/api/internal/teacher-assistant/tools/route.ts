import { NextResponse } from "next/server";
import { handleTeacherAssistantToolCallback } from "@/lib/teacher-assistant/tool-callback";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await handleTeacherAssistantToolCallback(request);
  return NextResponse.json(result.body, { status: result.status });
}
