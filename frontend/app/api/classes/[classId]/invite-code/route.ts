import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

const maxClassCodeAttempts = 10;
const classCodeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const classCodeLength = 6;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);
    const joinCode = await createUniqueClassCode();

    await adminDb!.collection("classes").doc(classId).update({
      joinCode
    });

    return NextResponse.json({ joinCode });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Class invite code reset failed." }, { status: 500 });
  }
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
