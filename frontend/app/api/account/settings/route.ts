import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor
} from "@/lib/class-theme";

export const runtime = "nodejs";

const recentAuthMaxAgeSeconds = 5 * 60;

type AccountSettingsBody = {
  appearance?: unknown;
  displayName?: unknown;
  email?: unknown;
  revokeOtherSessions?: unknown;
  themeColor?: unknown;
  username?: unknown;
};

type AccountSettingsProfile = {
  appearance?: unknown;
  classId?: unknown;
  displayName?: unknown;
  email?: unknown;
  role?: unknown;
  themeColor?: unknown;
  uid?: unknown;
  username?: unknown;
};

class AccountSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function PATCH(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before changing account settings." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const body = (await request.json().catch(() => ({}))) as AccountSettingsBody;
    const userReference = adminDb!.collection("users").doc(decodedToken.uid);
    const userSnapshot = await userReference.get();
    const currentProfile = (userSnapshot.data() ?? {}) as AccountSettingsProfile;

    if (!userSnapshot.exists || !isSupportedAccountRole(currentProfile.role)) {
      return NextResponse.json({ error: "Create a student or teacher profile before changing settings." }, { status: 403 });
    }

    const shouldUpdateDisplayName = bodyHasKey(body, "displayName");
    const shouldUpdateEmail = bodyHasKey(body, "email");
    const shouldUpdateUsername = bodyHasKey(body, "username");
    const currentEmail = firstString(currentProfile.email, decodedToken.email).toLowerCase();
    const tokenEmail = firstString(decodedToken.email).toLowerCase();
    const email = shouldUpdateEmail
      ? normalizeEmail(body.email, tokenEmail)
      : currentEmail;
    const currentDisplayName =
      firstString(currentProfile.displayName, decodedToken.name, decodedToken.email) || "Chandra user";
    const currentUsername = normalizeStoredUsername(currentProfile.username, currentEmail);
    const displayName = shouldUpdateDisplayName
      ? normalizeDisplayName(body.displayName)
      : currentDisplayName;
    const username = shouldUpdateUsername
      ? normalizeUsername(body.username, email)
      : currentUsername;
    const appearance = bodyHasKey(body, "appearance")
      ? normalizeTeacherClassAppearance(body.appearance)
      : normalizeTeacherClassAppearance(currentProfile.appearance);
    const themeColor = bodyHasKey(body, "themeColor")
      ? normalizeTeacherClassThemeColor(body.themeColor)
      : normalizeTeacherClassThemeColor(currentProfile.themeColor);

    if (username !== currentUsername) {
      await assertUsernameIsAvailable(username, decodedToken.uid);
    }

    const shouldRevokeRefreshTokens = Boolean(body.revokeOtherSessions) || email !== currentEmail;

    if (shouldRevokeRefreshTokens && !hasRecentAuthentication(decodedToken.auth_time)) {
      return NextResponse.json({ error: "Reauthenticate before changing sensitive account settings." }, { status: 401 });
    }

    const profileUpdates: Record<string, unknown> = {
      appearance,
      email,
      themeColor,
      username
    };

    if (shouldUpdateDisplayName) {
      profileUpdates.displayName = displayName;
    }

    if (shouldUpdateDisplayName && displayName !== currentDisplayName) {
      await adminAuth!.updateUser(decodedToken.uid, { displayName });
    }

    await userReference.set(profileUpdates, { merge: true });

    if (shouldRevokeRefreshTokens) {
      await adminAuth!.revokeRefreshTokens(decodedToken.uid);
    }

    await writeAuditLog({
      actor: {
        email: decodedToken.email,
        uid: decodedToken.uid
      },
      eventType: "account.settings.updated",
      metadata: {
        displayNameChanged: shouldUpdateDisplayName && displayName !== currentDisplayName,
        emailChanged: email !== currentEmail,
        refreshTokensRevoked: shouldRevokeRefreshTokens,
        usernameChanged: username !== currentUsername
      },
      route: "/api/account/settings",
      target: {
        uid: decodedToken.uid
      }
    });

    if (shouldUpdateDisplayName && displayName !== currentDisplayName) {
      await syncDisplayNameReferences({
        displayName,
        email,
        role: currentProfile.role,
        uid: decodedToken.uid
      });
    }

    return NextResponse.json({
      profile: {
        ...currentProfile,
        appearance,
        displayName,
        email,
        themeColor,
        uid: decodedToken.uid,
        username
      },
      sessionRevoked: shouldRevokeRefreshTokens
    });
  } catch (caughtError) {
    if (caughtError instanceof AccountSettingsError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Account settings failed." }, { status: 500 });
  }
}

async function syncDisplayNameReferences({
  displayName,
  email,
  role,
  uid
}: {
  displayName: string;
  email: string;
  role: unknown;
  uid: string;
}) {
  if (role === "teacher") {
    const classesSnapshot = await adminDb!
      .collection("classes")
      .where("teacherId", "==", uid)
      .get();

    await Promise.all(
      classesSnapshot.docs.map((classDoc) =>
        classDoc.ref.set({ teacherName: displayName }, { merge: true })
      )
    );
    return;
  }

  if (role !== "student" || !email) {
    return;
  }

  const rosterSnapshot = await adminDb!
    .collectionGroup("students")
    .where("email", "==", email)
    .get();

  await Promise.all(
    rosterSnapshot.docs.map((studentDoc) =>
      studentDoc.ref.set({ displayName }, { merge: true })
    )
  );
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeDisplayName(value: unknown) {
  const displayName = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

  if (!displayName) {
    throw new AccountSettingsError("Enter a display name.", 400);
  }

  if (displayName.length > 80) {
    throw new AccountSettingsError("Display name must be 80 characters or fewer.", 400);
  }

  return displayName;
}

function normalizeEmail(value: unknown, tokenEmail: string) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!email) {
    throw new AccountSettingsError("Enter an email address.", 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountSettingsError("Enter a valid email address.", 400);
  }

  if (!tokenEmail || email !== tokenEmail) {
    throw new AccountSettingsError("Confirm the new email with Firebase Auth before saving profile settings.", 400);
  }

  return email;
}

function normalizeStoredUsername(value: unknown, fallbackEmail: string) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  return username || fallbackEmail;
}

function normalizeUsername(value: unknown, accountEmail: string) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!username) {
    throw new AccountSettingsError("Enter a username.", 400);
  }

  if (username.length > 120) {
    throw new AccountSettingsError("Username must be 120 characters or fewer.", 400);
  }

  if (username.includes("@") && username !== accountEmail) {
    throw new AccountSettingsError("Use your account email or a username without @.", 400);
  }

  if (!/^[a-z0-9._%+-@]+$/.test(username)) {
    throw new AccountSettingsError("Username can use letters, numbers, dots, underscores, hyphens, plus, percent, and @.", 400);
  }

  return username;
}

async function assertUsernameIsAvailable(username: string, uid: string) {
  if (username.includes("@")) {
    return;
  }

  const usernameSnapshot = await adminDb!
    .collection("users")
    .where("username", "==", username)
    .limit(1)
    .get();
  const usernameOwner = usernameSnapshot.docs[0];

  if (usernameOwner && usernameOwner.id !== uid) {
    throw new AccountSettingsError("That username is already in use.", 409);
  }
}

function isSupportedAccountRole(role: unknown) {
  return role === "student" || role === "teacher";
}

function bodyHasKey(body: AccountSettingsBody, key: keyof AccountSettingsBody) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function hasRecentAuthentication(authTime: unknown) {
  const authTimeSeconds = Number(authTime ?? 0);

  return authTimeSeconds > 0 && Date.now() / 1000 - authTimeSeconds <= recentAuthMaxAgeSeconds;
}
