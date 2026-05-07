import { NextResponse } from "next/server";
import {
  approveStudentLearningProfile,
  clearDraftStudentLearningProfile,
  clearStudentLearningProfile,
  disableStudentLearningProfile,
  getStudentLearningProfile,
  saveDraftStudentLearningProfile,
  updateOneStudentLearningProfile
} from "@/lib/student-learning-profiles-server";
import { ConversationPersistenceError } from "@/lib/student-conversations-server";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

type LearningProfileRouteParams = {
  classId: string;
  studentId: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<LearningProfileRouteParams> }
) {
  try {
    const { classId, studentId } = await params;
    await authorizeClassTeacher(request, classId);

    const profile = await getStudentLearningProfile({
      classId,
      studentEmail: decodeURIComponent(studentId)
    });

    return NextResponse.json({ profile });
  } catch (caughtError) {
    return learningProfileErrorResponse(caughtError, "Learning profile load failed.");
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<LearningProfileRouteParams> }
) {
  try {
    const { classId, studentId } = await params;
    await authorizeClassTeacher(request, classId);
    const data = (await request.json().catch(() => ({}))) as { force?: unknown; lookbackDays?: unknown };

    const result = await updateOneStudentLearningProfile({
      classId,
      force: data.force === true,
      lookbackDays: Number(data.lookbackDays ?? 7),
      studentEmail: decodeURIComponent(studentId)
    });
    const profile = await getStudentLearningProfile({
      classId,
      studentEmail: decodeURIComponent(studentId)
    });

    return NextResponse.json({ profile, result });
  } catch (caughtError) {
    return learningProfileErrorResponse(caughtError, "Learning profile update failed.");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<LearningProfileRouteParams> }
) {
  try {
    const { classId, studentId } = await params;
    await authorizeClassTeacher(request, classId);

    const data = (await request.json()) as { action?: unknown; profile?: unknown };
    const studentEmail = decodeURIComponent(studentId);
    const action = String(data.action ?? "");

    if (action === "approve") {
      await approveStudentLearningProfile({ classId, profile: data.profile, studentEmail });
    } else if (action === "saveDraft") {
      await saveDraftStudentLearningProfile({ classId, profile: data.profile, studentEmail });
    } else if (action === "disable") {
      await disableStudentLearningProfile({ classId, studentEmail });
    } else if (action === "clearDraft") {
      await clearDraftStudentLearningProfile({ classId, studentEmail });
    } else if (action === "clear") {
      await clearStudentLearningProfile({ classId, studentEmail });
    } else {
      return NextResponse.json({ error: "Choose a valid learning profile action." }, { status: 400 });
    }

    const profile = await getStudentLearningProfile({ classId, studentEmail });
    return NextResponse.json({ profile });
  } catch (caughtError) {
    return learningProfileErrorResponse(caughtError, "Learning profile save failed.");
  }
}

function learningProfileErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  if (caughtError instanceof ConversationPersistenceError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
