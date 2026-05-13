import { NextResponse } from "next/server";
import {
  StudentAttachmentError,
  deleteStudentConversationAttachment,
  getStudentConversationAttachment
} from "@/lib/student-attachments-server";
import { authorizeTutorChatRequest, TutorChatHttpError } from "@/lib/tutor-chat-auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string; conversationId: string }> }
) {
  try {
    const url = new URL(request.url);
    const { attachmentId, conversationId } = await params;
    const scope = await authorizeTutorChatRequest(request, url.searchParams.get("courseId") ?? undefined, {
      enforceStudentChatAccess: false
    });
    const attachment = await getStudentConversationAttachment({ attachmentId, conversationId, scope });

    return NextResponse.json({ attachment });
  } catch (caughtError) {
    return handleStudentAttachmentError(caughtError, "Conversation attachment failed to load.");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string; conversationId: string }> }
) {
  try {
    const url = new URL(request.url);
    const { attachmentId, conversationId } = await params;
    const scope = await authorizeTutorChatRequest(request, url.searchParams.get("courseId") ?? undefined);

    await deleteStudentConversationAttachment({ attachmentId, conversationId, scope });
    return NextResponse.json({ ok: true });
  } catch (caughtError) {
    return handleStudentAttachmentError(caughtError, "Conversation attachment could not be removed.");
  }
}

function handleStudentAttachmentError(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorChatHttpError || caughtError instanceof StudentAttachmentError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  console.error(fallbackMessage, caughtError);
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
