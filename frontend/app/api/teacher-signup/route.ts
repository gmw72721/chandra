import { createHash, timingSafeEqual } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type TeacherSignupBody = {
  displayName?: unknown;
  inviteToken?: unknown;
};

class TeacherSignupError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in with the teacher invite link first." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json().catch(() => ({}))) as TeacherSignupBody;
    const inviteToken = String(body.inviteToken ?? "").trim();
    const bootstrapInviteIsValid = isValidBootstrapTeacherInviteToken(inviteToken);
    const inviteReference = bootstrapInviteIsValid
      ? null
      : adminDb!.collection("teacherInvites").doc(hashInviteToken(inviteToken));

    if (!bootstrapInviteIsValid && !inviteToken) {
      return NextResponse.json({ error: "Use a valid teacher invite link to create a teacher account." }, { status: 403 });
    }

    const displayName =
      firstString(body.displayName, decodedToken.name, decodedToken.email) || "Chandra teacher";
    const email = String(decodedToken.email ?? "").trim().toLowerCase();
    const profile = {
      createdAt: FieldValue.serverTimestamp(),
      displayName,
      email,
      role: "teacher",
      uid: decodedToken.uid
    };

    await adminDb!.runTransaction(async (transaction) => {
      const userReference = adminDb!.collection("users").doc(decodedToken.uid);
      const userSnapshot = await transaction.get(userReference);
      const existingRole = userSnapshot.data()?.role;

      if (userSnapshot.exists && existingRole === "teacher") {
        return;
      }

      if (userSnapshot.exists) {
        throw new TeacherSignupError("This account already has a different role.", 409);
      }

      if (inviteReference) {
        const inviteSnapshot = await transaction.get(inviteReference);
        const invite = inviteSnapshot.data();
        const expiresAt = invite?.expiresAt;

        if (
          !inviteSnapshot.exists
          || invite?.usedAt
          || !(expiresAt instanceof Timestamp)
          || expiresAt.toMillis() <= Date.now()
        ) {
          throw new TeacherSignupError("Use a valid teacher invite link to create a teacher account.", 403);
        }

        transaction.update(inviteReference, {
          usedAt: FieldValue.serverTimestamp(),
          usedByEmail: email,
          usedByUid: decodedToken.uid
        });
      }

      transaction.set(userReference, profile);
    });

    return NextResponse.json({
      profile: {
        ...profile,
        createdAt: null
      }
    });
  } catch (caughtError) {
    if (caughtError instanceof TeacherSignupError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Teacher signup failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function isValidBootstrapTeacherInviteToken(inviteToken: string) {
  const expectedToken = String(process.env.TEACHER_SIGNUP_TOKEN ?? "").trim();

  if (!expectedToken || !inviteToken) {
    return false;
  }

  const expectedTokenBuffer = Buffer.from(expectedToken);
  const inviteTokenBuffer = Buffer.from(inviteToken);

  return expectedTokenBuffer.length === inviteTokenBuffer.length
    && timingSafeEqual(expectedTokenBuffer, inviteTokenBuffer);
}

function hashInviteToken(inviteToken: string) {
  return createHash("sha256").update(inviteToken).digest("hex");
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}
