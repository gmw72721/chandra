import { NextResponse } from "next/server";
import { getStudentAiUsageStatus } from "@/lib/ai-usage-limits";
import { getTeacherClassTutorConfig } from "@/lib/prompts";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = await authorizeTutorChatRequest(request, searchParams.get("courseId") ?? undefined, {
      enforceStudentChatAccess: false
    });

    if (scope.role !== "student") {
      return NextResponse.json({ error: "Use a student account to view AI usage." }, { status: 403 });
    }

    const teacherClass = await getTeacherClassTutorConfig(scope.classId);

    return NextResponse.json({
      aiUsageStatus: await getStudentAiUsageStatus(scope.uid, scope.classId, teacherClass?.modelSettings.tokenLimits)
    });
  } catch (caughtError) {
    const status = caughtError instanceof TutorChatHttpError ? caughtError.status : 500;
    const message = caughtError instanceof Error ? caughtError.message : "AI usage failed to load.";

    return NextResponse.json({ error: message }, { status });
  }
}
