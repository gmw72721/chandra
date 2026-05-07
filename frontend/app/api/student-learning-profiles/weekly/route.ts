import { NextResponse } from "next/server";
import { updateWeeklyStudentLearningProfiles } from "@/lib/student-learning-profiles-server";
import { ConversationPersistenceError } from "@/lib/student-conversations-server";
import { TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    authorizeScheduledLearningProfileUpdate(request);

    const data = (await request.json().catch(() => ({}))) as { classId?: unknown };
    const results = await updateWeeklyStudentLearningProfiles({
      classId: typeof data.classId === "string" ? data.classId : undefined
    });

    return NextResponse.json({
      results,
      updated: results.filter((result) => result.draftCreated).length
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof ConversationPersistenceError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Scheduled learning profile update failed." }, { status: 500 });
  }
}

function authorizeScheduledLearningProfileUpdate(request: Request) {
  const configuredSecret = process.env.LEARNING_PROFILE_UPDATE_SECRET || process.env.CRON_SECRET;

  if (!configuredSecret) {
    throw new TutorKnowledgeHttpError("Scheduled learning profile updates require LEARNING_PROFILE_UPDATE_SECRET.", 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (token !== configuredSecret) {
    throw new TutorKnowledgeHttpError("Scheduled learning profile update is not authorized.", 401);
  }
}
