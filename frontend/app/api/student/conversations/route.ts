import { NextResponse } from "next/server";
import { ConversationPersistenceError, listStudentConversations } from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = await authorizeTutorChatRequest(request, url.searchParams.get("courseId") ?? undefined);

    if (scope.role !== "student") {
      return NextResponse.json({ error: "Use a student account to open saved conversations." }, { status: 403 });
    }

    const conversations = await listStudentConversations({
      classId: scope.classId,
      studentId: scope.uid
    });

    return NextResponse.json({ conversations });
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError || caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Saved conversations failed to load." }, { status: 500 });
  }
}
