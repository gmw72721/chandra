import { NextResponse } from "next/server";
import {
  StudentAttachmentError,
  listStudentConversationAttachments,
  maxStudentAttachmentFileBytes,
  uploadStudentConversationAttachment
} from "@/lib/student-attachments-server";
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
    const attachments = await listStudentConversationAttachments({ conversationId, scope });

    return NextResponse.json({ attachments });
  } catch (caughtError) {
    return handleStudentAttachmentError(caughtError, "Conversation attachments failed to load.");
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const url = new URL(request.url);
    const { conversationId } = await params;
    const scope = await authorizeTutorChatRequest(request, url.searchParams.get("courseId") ?? undefined);
    const contentLength = Number(request.headers.get("content-length") ?? 0);

    if (Number.isFinite(contentLength) && contentLength > maxStudentAttachmentFileBytes() + 1024 * 1024) {
      return NextResponse.json({ error: "Homework files must be 25 MB or smaller." }, { status: 413 });
    }

    const formData = await request.formData().catch(() => null);

    if (!formData) {
      return NextResponse.json({ error: "Upload a valid homework file form." }, { status: 400 });
    }

    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a homework file to upload." }, { status: 400 });
    }

    const attachment = await uploadStudentConversationAttachment({
      conversationId,
      file,
      scope
    });

    return NextResponse.json({ attachment });
  } catch (caughtError) {
    return handleStudentAttachmentError(caughtError, "Homework file upload failed.");
  }
}

function handleStudentAttachmentError(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorChatHttpError || caughtError instanceof StudentAttachmentError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  console.error(fallbackMessage, caughtError);
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
