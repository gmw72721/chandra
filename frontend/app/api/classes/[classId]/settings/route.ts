import { NextResponse } from "next/server";
import { normalizeClassModelSettings, normalizeResponseFormatSettings } from "@/lib/class-settings";
import { updateClassSettings } from "@/lib/data/classes";
import { tryPostgresData } from "@/lib/data/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    await authorizeClassAccess(request, classId, "manageClassSettings");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const modelSettings = objectOrUndefined(body.modelSettings);
    const responseFormat = objectOrUndefined(body.responseFormat);
    const firestoreUpdates = {
      ...body,
      ...(modelSettings ? { modelSettings: normalizeClassModelSettings(modelSettings) } : {}),
      ...(responseFormat ? { responseFormat: normalizeResponseFormatSettings(responseFormat) } : {}),
      updatedAt: new Date()
    };

    await tryPostgresData("class.settings.write", () =>
      updateClassSettings({
        answerPolicy: objectOrUndefined(body.answerPolicy),
        appearance: stringOrUndefined(body.appearance),
        behaviorInstructions: stringOrUndefined(body.behaviorInstructions),
        behaviorTitle: stringOrUndefined(body.behaviorTitle),
        classId,
        defaultAssignmentContext: stringOrUndefined(body.defaultAssignmentContext),
        modelSettings: modelSettings ? normalizeClassModelSettings(modelSettings) : undefined,
        name: stringOrUndefined(body.name),
        notificationSettings: objectOrUndefined(body.notificationSettings),
        openingMessage: stringOrUndefined(body.openingMessage),
        privacySettings: objectOrUndefined(body.privacySettings),
        refusalStyle: stringOrUndefined(body.refusalStyle),
        responseFormat: responseFormat ? normalizeResponseFormatSettings(responseFormat) : undefined,
        section: stringOrUndefined(body.section),
        sourceDefaults: objectOrUndefined(body.sourceDefaults),
        sourceUsage: objectOrUndefined(body.sourceUsage),
        studentChatEnabled: typeof body.studentChatEnabled === "boolean" ? body.studentChatEnabled : undefined,
        studentFacingInstructions: stringOrUndefined(body.studentFacingInstructions),
        themeColor: stringOrUndefined(body.themeColor),
        themeMood: stringOrUndefined(body.themeMood),
        tutorAccess: objectOrUndefined(body.tutorAccess)
      })
    );
    await adminDb!.collection("classes").doc(classId).set(firestoreUpdates, { merge: true });

    return NextResponse.json({ ok: true });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class settings update failed." }, { status: 500 });
  }
}

function objectOrUndefined(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
