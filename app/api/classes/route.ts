import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import {
  defaultAnswerPolicySettings,
  defaultAssignmentContext,
  defaultClassModelSettings,
  defaultResponseFormatSettings,
  defaultRefusalStyle,
  defaultSourceUsageSettings
} from "@/lib/class-settings";
import { defaultTeacherClassAppearance, defaultTeacherClassThemeColor } from "@/lib/class-theme";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const maxClassCodeAttempts = 10;
const classCodeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const classCodeLength = 6;

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in as a teacher before creating a class." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const profileSnapshot = await adminDb!.collection("users").doc(decodedToken.uid).get();
    const profile = profileSnapshot.data();

    if (!profileSnapshot.exists || profile?.role !== "teacher") {
      return NextResponse.json({ error: "Use a teacher account to create a class." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      section?: unknown;
      teacherName?: unknown;
    };
    const name = String(body.name ?? "").trim();
    const section = String(body.section ?? "").trim();
    const teacherName =
      String(profile.displayName ?? "").trim() ||
      String(body.teacherName ?? "").trim() ||
      decodedToken.name ||
      decodedToken.email ||
      "Chandra teacher";

    if (!name || !section) {
      return NextResponse.json({ error: "Add a class name and section." }, { status: 400 });
    }

    const classCode = await createUniqueClassCode();
    await adminDb!.collection("classes").doc(classCode).set({
      answerPolicy: defaultAnswerPolicySettings,
      behaviorInstructions: [
        "Ask students to explain their thinking before giving hints.",
        "If a student names a specific task without showing work, ask what they have tried before giving task-specific hints.",
        "Do not provide final answers, proof paragraphs, sentence starters, or homework-ready wording unless the student has already shown the main reasoning.",
        "Use course materials to orient hints and explanations without starting the student's exact task for them."
      ].join("\n"),
      behaviorTitle: "Guided problem solving",
      createdAt: FieldValue.serverTimestamp(),
      defaultAssignmentContext,
      joinCode: classCode,
      modelSettings: defaultClassModelSettings,
      name,
      refusalStyle: defaultRefusalStyle,
      responseFormat: defaultResponseFormatSettings,
      section,
      sourceUsage: defaultSourceUsageSettings,
      teacherId: decodedToken.uid,
      teacherName,
      appearance: defaultTeacherClassAppearance,
      themeColor: defaultTeacherClassThemeColor
    });

    return NextResponse.json({ class: { id: classCode, joinCode: classCode } });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Class creation failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

async function createUniqueClassCode() {
  for (let attempt = 0; attempt < maxClassCodeAttempts; attempt += 1) {
    const classCode = generateClassCode();

    if (await isClassCodeAvailable(classCode)) {
      return classCode;
    }
  }

  throw new Error("Could not create a unique class code. Please try again.");
}

async function isClassCodeAvailable(classCode: string) {
  const classSnapshot = await adminDb!.collection("classes").doc(classCode).get();

  if (classSnapshot.exists) {
    return false;
  }

  const joinCodeSnapshot = await adminDb!
    .collection("classes")
    .where("joinCode", "==", classCode)
    .limit(1)
    .get();

  return joinCodeSnapshot.empty;
}

function generateClassCode() {
  const values = new Uint8Array(classCodeLength);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(values, (value) => classCodeAlphabet[value % classCodeAlphabet.length]).join("");
}
