import { createHash, randomBytes } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const inviteTtlDays = 30;

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in as a teacher to create an invite." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const profileSnapshot = await adminDb!.collection("users").doc(decodedToken.uid).get();
    const profile = profileSnapshot.data();

    if (!profileSnapshot.exists || profile?.role !== "teacher") {
      return NextResponse.json({ error: "Use a teacher account to create an invite." }, { status: 403 });
    }

    const inviteToken = randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(inviteToken);
    const expiresAtDate = new Date(Date.now() + inviteTtlDays * 24 * 60 * 60 * 1000);
    const inviteUrl = new URL("/auth", request.url);
    inviteUrl.searchParams.set("role", "teacher");
    inviteUrl.searchParams.set("teacherInvite", inviteToken);

    await adminDb!.collection("teacherInvites").doc(tokenHash).set({
      createdAt: FieldValue.serverTimestamp(),
      createdByEmail: String(profile.email ?? decodedToken.email ?? "").trim().toLowerCase(),
      createdByUid: decodedToken.uid,
      expiresAt: Timestamp.fromDate(expiresAtDate),
      tokenHash
    });

    return NextResponse.json({
      expiresAt: expiresAtDate.toISOString(),
      inviteUrl: inviteUrl.toString()
    });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Teacher invite creation failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function hashInviteToken(inviteToken: string) {
  return createHash("sha256").update(inviteToken).digest("hex");
}
