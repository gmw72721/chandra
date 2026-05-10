import { NextResponse } from "next/server";
import { adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type ResolveLoginBody = {
  identifier?: unknown;
};

export async function POST(request: Request) {
  try {
    assertFirebaseAdminAuthReady();

    const body = (await request.json().catch(() => ({}))) as ResolveLoginBody;
    const identifier = normalizeLoginIdentifier(body.identifier);

    if (!identifier) {
      return NextResponse.json({ error: "Enter a username or email." }, { status: 400 });
    }

    const usernameSnapshot = await adminDb!
      .collection("users")
      .where("username", "==", identifier)
      .limit(1)
      .get();
    const usernameProfile = usernameSnapshot.docs[0]?.data();
    const usernameEmail = normalizeEmail(usernameProfile?.email);

    if (usernameEmail) {
      return NextResponse.json({ email: usernameEmail });
    }

    const emailSnapshot = await adminDb!
      .collection("users")
      .where("email", "==", identifier)
      .limit(1)
      .get();
    const emailProfile = emailSnapshot.docs[0]?.data();
    const fallbackEmail = normalizeEmail(emailProfile?.email);

    if (fallbackEmail) {
      return NextResponse.json({ email: fallbackEmail });
    }

    return NextResponse.json({ error: "No account matches that username." }, { status: 404 });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Username lookup failed." }, { status: 500 });
  }
}

function normalizeLoginIdentifier(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
