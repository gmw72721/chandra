import { NextResponse } from "next/server";
import { checkAbuseLockout, recordAbuseFailure, resetAbuseFailures } from "@/lib/abuse-lockout";
import { resolveClassCodePostgresFirst } from "@/lib/data/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const classCodeLockoutPolicy = {
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

    const body = (await request.json()) as { classCode?: unknown };
    const classCode = normalizeClassCode(String(body.classCode ?? ""));

    if (!classCode) {
      return NextResponse.json({ classId: "" });
    }

    const abuseScope = {
      actorUid: decodedToken.uid,
      identifier: classCode,
      namespace: "classes.resolve",
      request,
      route: "/api/classes/resolve"
    };
    const lockout = await checkAbuseLockout(abuseScope, classCodeLockoutPolicy);

    if (lockout.locked) {
      return NextResponse.json({ error: "Class code lookup failed." }, { status: 429 });
    }

    const resolvedClassId = await resolveClassCodePostgresFirst(classCode);

    if (resolvedClassId) {
      await resetAbuseFailures(abuseScope);
      return NextResponse.json({ classId: resolvedClassId });
    }

    await recordAbuseFailure(abuseScope, classCodeLockoutPolicy);
    return NextResponse.json({ error: "Class code lookup failed." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Class code lookup failed." }, { status: 500 });
  }
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
