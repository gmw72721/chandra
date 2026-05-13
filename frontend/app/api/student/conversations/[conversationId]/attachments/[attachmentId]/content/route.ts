import { NextResponse } from "next/server";
import {
  StudentAttachmentError,
  downloadStudentConversationAttachment
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
    const { attachment, buffer, contentType } = await downloadStudentConversationAttachment({
      attachmentId,
      conversationId,
      scope
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": `inline; filename="${attachment.fileName.replace(/"/g, "")}"`,
        "Content-Length": String(buffer.byteLength),
        "Content-Type": contentType
      }
    });
  } catch (caughtError) {
    return handleStudentAttachmentContentError(caughtError);
  }
}

function handleStudentAttachmentContentError(caughtError: unknown) {
  if (caughtError instanceof TutorChatHttpError || caughtError instanceof StudentAttachmentError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  console.error("Conversation attachment content failed to load.", caughtError);
  return NextResponse.json({ error: "Conversation attachment content failed to load." }, { status: 500 });
}
