import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  StudentFeedbackPersistenceError,
  updateTeacherStudentFeedback
} from "@/lib/student-feedback-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";
import type { StudentFeedbackStatus } from "@/lib/types";

export const runtime = "nodejs";

const teacherFeedbackStatuses = new Set<StudentFeedbackStatus>(["reviewed", "resolved"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string; feedbackId: string }> }
) {
  try {
    const { classId, feedbackId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const data = (await request.json().catch(() => ({}))) as {
      status?: unknown;
      teacherNote?: unknown;
      usageAllowancePercent?: unknown;
    };
    const status = String(data.status ?? "") as StudentFeedbackStatus;

    if (!teacherFeedbackStatuses.has(status)) {
      return NextResponse.json({ error: "Feedback status is invalid." }, { status: 400 });
    }

    const feedback = await updateTeacherStudentFeedback({
      classId,
      feedbackId,
      status,
      teacherId: uid,
      teacherNote: String(data.teacherNote ?? ""),
      usageAllowancePercent: data.usageAllowancePercent === undefined ? undefined : Number(data.usageAllowancePercent)
    });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "student.feedback.updated",
      metadata: {
        status,
        usageAllowancePercent: feedback.usageAllowancePercent
      },
      route: "/api/classes/[classId]/feedback/[feedbackId]",
      target: {
        classId,
        conversationId: feedback.conversationId,
        feedbackId
      }
    });

    return NextResponse.json({ feedback });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError || caughtError instanceof StudentFeedbackPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Feedback update failed." }, { status: 500 });
  }
}
