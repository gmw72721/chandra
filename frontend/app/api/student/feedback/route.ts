import { NextResponse } from "next/server";
import {
  authorizeStudentFeedbackRequest,
  createStudentFeedback,
  listStudentFeedback,
  StudentFeedbackPersistenceError
} from "@/lib/student-feedback-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = await authorizeStudentFeedbackRequest(request, url.searchParams.get("courseId") ?? undefined);

    if (scope.role !== "student") {
      return NextResponse.json({ error: "Use a student account to view feedback." }, { status: 403 });
    }

    const feedback = await listStudentFeedback({
      classId: scope.classId,
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      studentId: scope.uid
    });

    return NextResponse.json({ feedback });
  } catch (caughtError) {
    if (caughtError instanceof StudentFeedbackPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Feedback failed to load." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = (await request.json().catch(() => ({}))) as {
      comment?: unknown;
      conversationId?: unknown;
      courseId?: string;
      kind?: unknown;
      messageId?: unknown;
      promptReason?: unknown;
      rating?: unknown;
    };
    const scope = await authorizeStudentFeedbackRequest(request, data.courseId);

    if (scope.role !== "student") {
      return NextResponse.json({ error: "Use a student account to send feedback." }, { status: 403 });
    }

    const feedback = await createStudentFeedback({
      comment: String(data.comment ?? ""),
      conversationId: String(data.conversationId ?? ""),
      kind: data.kind,
      messageId: data.messageId ? String(data.messageId) : null,
      promptReason: data.promptReason,
      rating: data.rating,
      scope
    });

    return NextResponse.json({ feedback });
  } catch (caughtError) {
    if (caughtError instanceof StudentFeedbackPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Feedback failed to send." }, { status: 500 });
  }
}
