import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  ConversationPersistenceError,
  updateTeacherConversationReview
} from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";
import type { ConversationReviewStatus } from "@/lib/types";

export const runtime = "nodejs";

const reviewStatuses = new Set<ConversationReviewStatus>([
  "new",
  "reviewed",
  "needs_follow_up",
  "misunderstanding_spotted",
  "good_learning_moment",
  "ai_answer_needs_review"
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string; conversationId: string }> }
) {
  try {
    const { classId, conversationId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const data = (await request.json()) as {
      flags?: unknown;
      privateNote?: unknown;
      status?: unknown;
    };
    const status = String(data.status ?? "new") as ConversationReviewStatus;

    if (!reviewStatuses.has(status)) {
      return NextResponse.json({ error: "Conversation review status is invalid." }, { status: 400 });
    }

    const review = await updateTeacherConversationReview({
      classId,
      conversationId,
      flags: Array.isArray(data.flags) ? data.flags.map(String) : [],
      privateNote: String(data.privateNote ?? "").slice(0, 1000),
      status,
      teacherId: uid
    });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "conversation.review.updated",
      metadata: {
        flags: Array.isArray(data.flags) ? data.flags.map(String) : [],
        status
      },
      route: "/api/classes/[classId]/conversations/[conversationId]/review",
      target: {
        classId,
        conversationId
      }
    });

    return NextResponse.json({ review });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Conversation review save failed." }, { status: 500 });
  }
}
