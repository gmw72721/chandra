import { NextResponse } from "next/server";
import { adminAuth, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import { getAccountProfile, upsertAccountProfile } from "@/lib/data/server";

export const runtime = "nodejs";

type ProfileBody = {
  classId?: unknown;
  classIds?: unknown;
  displayName?: unknown;
  email?: unknown;
  role?: unknown;
  username?: unknown;
};

export async function GET(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ profile: null }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const profile = await getAccountProfile(decodedToken.uid);

    return NextResponse.json({ profile });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Profile load failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before creating a profile." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json().catch(() => ({}))) as ProfileBody;
    const role = body.role === "student" || body.role === "teacher" ? body.role : null;
    const email = String(body.email ?? decodedToken.email ?? "").trim().toLowerCase();
    const displayName = String(body.displayName ?? decodedToken.name ?? email).trim() || "Chandra user";
    const username = String(body.username ?? email).trim().toLowerCase() || email;

    if (!role || !email) {
      return NextResponse.json({ error: "Choose a role and sign in with an email." }, { status: 400 });
    }

    const classIds = Array.isArray(body.classIds)
      ? body.classIds.map(String).map((classId) => classId.trim()).filter(Boolean)
      : [];
    const classId = String(body.classId ?? "").trim();
    const profile = await upsertAccountProfile({
      id: decodedToken.uid,
      firebaseUid: decodedToken.uid,
      email,
      role,
      displayName,
      legacyClassId: classId || null,
      legacyClassIds: classIds,
      profile: {
        classId,
        classIds,
        displayName,
        email,
        role,
        uid: decodedToken.uid,
        username
      },
      username
    });

    return NextResponse.json({ profile });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Profile creation failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
