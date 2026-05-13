import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { assertAccountUsernameAvailable, upsertAccountProfile } from "@/lib/data/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type TeacherSignupBody = {
  displayName?: unknown;
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

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before creating a teacher profile." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json().catch(() => ({}))) as TeacherSignupBody;

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

      transaction.set(userReference, profile);
    });

    await upsertAccountProfile({
      id: decodedToken.uid,
      firebaseUid: decodedToken.uid,
      email,
      role: "teacher",
      displayName,
      profile,
      username
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
  const available = await assertAccountUsernameAvailable(username, uid);

  if (!available) {
    throw new TeacherSignupError("That username is already in use.", 409);
  }
}
