import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type JoinClassBody = {
  classCode?: unknown;
  displayName?: unknown;
  email?: unknown;
  syncProfile?: unknown;
};

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before joining a class." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json()) as JoinClassBody;
    const classCode = normalizeClassCode(String(body.classCode ?? ""));
    const userReference = adminDb!.collection("users").doc(decodedToken.uid);
    const userSnapshot = await userReference.get();
    const userData = userSnapshot.data() ?? {};

    if (userData.role === "teacher") {
      return NextResponse.json({ error: "Use a student account to join a class." }, { status: 403 });
    }

    const email = normalizeEmail(
      firstString(userData.email, decodedToken.email, decodedToken.firebase?.identities?.email?.[0], body.email)
    );
    const displayName =
      firstString(userData.displayName, body.displayName, decodedToken.name, email) || "Chandra student";

    if (!classCode) {
      await updateStudentEnrollment({
        displayName,
        email,
        nextClassId: "",
        syncProfile: body.syncProfile === true,
        uid: decodedToken.uid
      });

      return NextResponse.json({ classId: "" });
    }

    const classId = await resolveClassId(classCode);

    if (!classId) {
      return NextResponse.json({ error: "Class code was not found." }, { status: 404 });
    }

    await updateStudentEnrollment({
      displayName,
      email,
      nextClassId: classId,
      syncProfile: body.syncProfile === true || userSnapshot.exists,
      uid: decodedToken.uid
    });

    return NextResponse.json({ classId });
  } catch {
    return NextResponse.json({ error: "Class join failed." }, { status: 500 });
  }
}

async function resolveClassId(classCode: string) {
  const directClassSnapshot = await adminDb!.collection("classes").doc(classCode).get();

  if (directClassSnapshot.exists) {
    return directClassSnapshot.id;
  }

  const joinCodeSnapshot = await adminDb!
    .collection("classes")
    .where("joinCode", "==", classCode)
    .limit(1)
    .get();

  return joinCodeSnapshot.docs[0]?.id ?? "";
}

async function updateStudentEnrollment({
  displayName,
  email,
  nextClassId,
  syncProfile,
  uid
}: {
  displayName: string;
  email: string;
  nextClassId: string;
  syncProfile: boolean;
  uid: string;
}) {
  const batch = adminDb!.batch();
  const rosterStudentId = encodeURIComponent(email || uid);
  const userReference = adminDb!.collection("users").doc(uid);

  if (nextClassId) {
    batch.set(adminDb!.collection("classes").doc(nextClassId).collection("students").doc(rosterStudentId), {
      addedAt: FieldValue.serverTimestamp(),
      displayName,
      email,
      uid
    });
  }

  if (syncProfile) {
    batch.set(
      userReference,
      nextClassId
        ? {
            classIds: FieldValue.arrayUnion(nextClassId),
            classId: nextClassId,
            displayName,
            email,
            role: "student",
            uid
          }
        : {
            classId: FieldValue.delete()
          },
      { merge: true }
    );
  }

  await batch.commit();
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeClassCode(classCode: string) {
  const cleanClassCode = classCode.trim();

  if (cleanClassCode.length === 6 && /^[a-z]+$/i.test(cleanClassCode)) {
    return cleanClassCode.toUpperCase();
  }

  return cleanClassCode;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}
