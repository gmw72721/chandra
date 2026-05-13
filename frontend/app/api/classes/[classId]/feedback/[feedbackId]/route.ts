import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  StudentFeedbackPersistenceError,
  updateTeacherStudentFeedback
} from "@/lib/student-feedback-server";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";
import type { StudentFeedbackStatus } from "@/lib/types";

export const runtime = "nodejs";

const teacherFeedbackStatuses = new Set<StudentFeedbackStatus>(["reviewed", "resolved"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string; feedbackId: string }> }
) {
  try {
    const { classId, feedbackId } = await params;
    const { email: actorEmail, uid } = await authorizeClassAccess(request, classId, "reviewConversations");
    const data = (await request.json().catch(() => ({}))) as {
      sendStudentVisibleResponse?: unknown;
      studentVisibleResponse?: unknown;
      status?: unknown;
      teacherNote?: unknown;
      usageAllowancePercent?: unknown;
    };
    const status = data.status === undefined ? undefined : (String(data.status ?? "") as StudentFeedbackStatus);

    if (status !== undefined && !teacherFeedbackStatuses.has(status)) {
      return NextResponse.json({ error: "Feedback status is invalid." }, { status: 400 });
    }

    const feedback = await updateTeacherStudentFeedback({
      classId,
      feedbackId,
      sendStudentVisibleResponse: data.sendStudentVisibleResponse === true,
      studentVisibleResponse: data.studentVisibleResponse === undefined ? undefined : String(data.studentVisibleResponse ?? ""),
      status,
      teacherId: uid,
      teacherNote: String(data.teacherNote ?? ""),
      usageAllowancePercent: data.usageAllowancePercent === undefined ? undefined : Number(data.usageAllowancePercent)
    });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "student.feedback.updated",
      metadata: {
        responseSent: data.sendStudentVisibleResponse === true,
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
