import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { checkAbuseLockout, recordAbuseFailure, resetAbuseFailures } from "@/lib/abuse-lockout";
import {
  enrollStudentPostgresFirst,
  getAccountProfile,
  resolveClassCodePostgresFirst,
  upsertAccountProfile
} from "@/lib/data/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type JoinClassBody = {
  classCode?: unknown;
  displayName?: unknown;
  email?: unknown;
  syncProfile?: unknown;
};

const classJoinLockoutPolicy = {
  resetWindowMs: 60 * 60 * 1000,
  lockoutSteps: [
    { failures: 5, cooldownMs: 5 * 60 * 1000 },
    { failures: 10, cooldownMs: 30 * 60 * 1000 },
    { failures: 20, cooldownMs: 24 * 60 * 60 * 1000 }
  ]
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
    const userSnapshot = await adminDb!.collection("users").doc(decodedToken.uid).get();
    const postgresProfile = await getAccountProfile(decodedToken.uid);
    const userData = postgresProfile ?? userSnapshot.data() ?? {};

    if (userData.role === "teacher") {
      return NextResponse.json({ error: "Use a student account to join a class." }, { status: 403 });
    }

    const email = normalizeEmail(
      firstString(userData.email, decodedToken.email, decodedToken.firebase?.identities?.email?.[0], body.email)
    );
    const displayName =
      firstString(userData.displayName, body.displayName, decodedToken.name, email) || "Chandra student";

    if (!classCode) {
      return NextResponse.json({ error: "Enter your class code to continue." }, { status: 400 });
    }

    const abuseScope = {
      actorUid: decodedToken.uid,
      identifier: `${classCode}:${email || decodedToken.uid}`,
      namespace: "classes.join",
      request,
      route: "/api/classes/join"
    };
    const lockout = await checkAbuseLockout(abuseScope, classJoinLockoutPolicy);

    if (lockout.locked) {
      return NextResponse.json({ error: "Class join failed." }, { status: 429 });
    }

    const classId = await resolveClassId(classCode);

    if (!classId) {
      await recordAbuseFailure(abuseScope, classJoinLockoutPolicy);
      return NextResponse.json({ error: "Class join failed." }, { status: 404 });
    }

    await resetAbuseFailures(abuseScope);
    await updateStudentEnrollment({
      displayName,
      email,
      nextClassId: classId,
      syncProfile: body.syncProfile === true || userSnapshot.exists || Boolean(postgresProfile),
      uid: decodedToken.uid
    });

    return NextResponse.json({ classId });
  } catch {
    return NextResponse.json({ error: "Class join failed." }, { status: 500 });
  }
}

async function resolveClassId(classCode: string) {
  return resolveClassCodePostgresFirst(classCode);
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
    await enrollStudentPostgresFirst({
      classId: nextClassId,
      displayName,
      studentEmail: email,
      studentId: uid
    });
    batch.set(adminDb!.collection("classes").doc(nextClassId).collection("students").doc(rosterStudentId), {
      addedAt: FieldValue.serverTimestamp(),
      displayName,
      email,
      uid
    });
  }

  if (syncProfile) {
    await upsertAccountProfile({
      id: uid,
      firebaseUid: uid,
      email,
      role: "student",
      displayName,
      legacyClassId: nextClassId || null,
      legacyClassIds: nextClassId ? [nextClassId] : [],
      profile: nextClassId
        ? {
            classId: nextClassId,
            classIds: [nextClassId],
            displayName,
            email,
            role: "student",
            uid
          }
        : {
            displayName,
            email,
            role: "student",
            uid
          },
      username: email
    }, { mirrorFirestore: false });
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
