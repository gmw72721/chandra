import { NextResponse } from "next/server";
import { ConversationPersistenceError, listStudentConversationMessages } from "@/lib/student-conversations-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const url = new URL(request.url);
    const { conversationId } = await params;
    const scope = await authorizeTutorChatRequest(request, url.searchParams.get("courseId") ?? undefined, {
      enforceStudentChatAccess: false
    });

    if (scope.role !== "student") {
      return NextResponse.json({ error: "Use a student account to open saved conversations." }, { status: 403 });
    }

    const messages = await listStudentConversationMessages({
      classId: scope.classId,
      conversationId,
      studentId: scope.uid
    });

    return NextResponse.json({ messages });
  } catch (caughtError) {
    if (caughtError instanceof TutorChatHttpError || caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Conversation messages failed to load." }, { status: 500 });
  }
}
