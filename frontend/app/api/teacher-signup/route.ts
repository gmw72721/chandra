import { createHash, timingSafeEqual } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { checkAbuseLockout, recordAbuseFailure, resetAbuseFailures } from "@/lib/abuse-lockout";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type TeacherSignupBody = {
  displayName?: unknown;
  inviteToken?: unknown;
  username?: unknown;
};

class TeacherSignupError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const teacherInviteSignupLockoutPolicy = {
  resetWindowMs: 60 * 60 * 1000,
  lockoutSteps: [
    { failures: 5, cooldownMs: 5 * 60 * 1000 },
    { failures: 10, cooldownMs: 30 * 60 * 1000 },
    { failures: 20, cooldownMs: 24 * 60 * 60 * 1000 }
  ]
};

export async function POST(request: Request) {
  let inviteAbuseScope: Parameters<typeof recordAbuseFailure>[0] | null = null;

  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in with the teacher invite link first." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json().catch(() => ({}))) as TeacherSignupBody;
    const inviteToken = String(body.inviteToken ?? "").trim();
    const inviteTokenHash = resolveInviteDocumentId(inviteToken);
    const abuseScope = {
      actorUid: decodedToken.uid,
      identifier: `${inviteTokenHash}:${String(decodedToken.email ?? "").trim().toLowerCase()}`,
      namespace: "teacher_invite.signup",
      request,
      route: "/api/teacher-signup"
    };
    inviteAbuseScope = abuseScope;
    const lockout = await checkAbuseLockout(abuseScope, teacherInviteSignupLockoutPolicy);

    if (lockout.locked) {
      return genericTeacherInviteError();
    }

    const bootstrapInviteIsValid = isValidBootstrapTeacherInviteToken(inviteToken);
    const inviteReference = bootstrapInviteIsValid
      ? null
      : adminDb!.collection("teacherInvites").doc(inviteTokenHash);

    if (!bootstrapInviteIsValid && !inviteToken) {
      await recordAbuseFailure(abuseScope, teacherInviteSignupLockoutPolicy);
      return genericTeacherInviteError();
    }

    const displayName =
      firstString(body.displayName, decodedToken.name, decodedToken.email) || "Chandra teacher";
    const email = String(decodedToken.email ?? "").trim().toLowerCase();
    const username = normalizeUsername(body.username, email);
    await assertUsernameIsAvailable(username, decodedToken.uid);

    const profile = {
      createdAt: FieldValue.serverTimestamp(),
      displayName,
      email,
      role: "teacher",
      uid: decodedToken.uid,
      username
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
          || invite?.revokedAt
          || !(expiresAt instanceof Timestamp)
          || expiresAt.toMillis() <= Date.now()
        ) {
          throw new TeacherSignupError("Teacher signup failed.", 403);
        }

        transaction.update(inviteReference, {
          usedAt: FieldValue.serverTimestamp(),
          usedByEmail: email,
          usedByUid: decodedToken.uid
        });
      }

      transaction.set(userReference, profile);
    });

    await resetAbuseFailures(abuseScope);
    if (inviteReference) {
      await writeAuditLog({
        actor: {
          email,
          uid: decodedToken.uid
        },
        eventType: "teacher_invite.used",
        metadata: {
          inviteId: inviteTokenHash
        },
        route: "/api/teacher-signup",
        target: {
          inviteId: inviteTokenHash
        }
      });
    }

    return NextResponse.json({
      profile: {
        ...profile,
        createdAt: null
      }
    });
  } catch (caughtError) {
    if (caughtError instanceof TeacherSignupError) {
      if (caughtError.status === 403) {
        if (inviteAbuseScope) {
          await recordAbuseFailure(inviteAbuseScope, teacherInviteSignupLockoutPolicy);
        }

        return genericTeacherInviteError();
      }

      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Teacher signup failed." }, { status: 500 });
  }
}

function genericTeacherInviteError() {
  return NextResponse.json({ error: "Teacher signup failed." }, { status: 403 });
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

function resolveInviteDocumentId(inviteToken: string) {
  if (!inviteToken) {
    return "missing";
  }

  return /^[a-f0-9]{64}$/i.test(inviteToken) ? inviteToken.toLowerCase() : hashInviteToken(inviteToken);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeUsername(value: unknown, fallbackEmail: string) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalizedUsername = username || fallbackEmail;

  if (normalizedUsername.includes("@") && normalizedUsername !== fallbackEmail) {
    throw new TeacherSignupError("Use your account email or a username without @.", 400);
  }

  if (normalizedUsername.length > 120) {
    throw new TeacherSignupError("Username must be 120 characters or fewer.", 400);
  }

  if (!/^[a-z0-9._%+-@]+$/.test(normalizedUsername)) {
    throw new TeacherSignupError("Username can use letters, numbers, dots, underscores, hyphens, plus, percent, and @.", 400);
  }

  return normalizedUsername;
}

async function assertUsernameIsAvailable(username: string, uid: string) {
  if (!username || username.includes("@")) {
    return;
  }

  const snapshot = await adminDb!
    .collection("users")
    .where("username", "==", username)
    .limit(1)
    .get();
  const existingUser = snapshot.docs[0];

  if (existingUser && existingUser.id !== uid) {
    throw new TeacherSignupError("That username is already in use.", 409);
  }
}
