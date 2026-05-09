import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor
} from "@/lib/class-theme";

export const runtime = "nodejs";

type AccountSettingsBody = {
  appearance?: unknown;
  displayName?: unknown;
  themeColor?: unknown;
};

type AccountSettingsProfile = {
  appearance?: unknown;
  classId?: unknown;
  displayName?: unknown;
  email?: unknown;
  role?: unknown;
  themeColor?: unknown;
  uid?: unknown;
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
    const currentDisplayName =
      firstString(currentProfile.displayName, decodedToken.name, decodedToken.email) || "Chandra user";
    const displayName = shouldUpdateDisplayName
      ? normalizeDisplayName(body.displayName)
      : currentDisplayName;
    const appearance = bodyHasKey(body, "appearance")
      ? normalizeTeacherClassAppearance(body.appearance)
      : normalizeTeacherClassAppearance(currentProfile.appearance);
    const themeColor = bodyHasKey(body, "themeColor")
      ? normalizeTeacherClassThemeColor(body.themeColor)
      : normalizeTeacherClassThemeColor(currentProfile.themeColor);

    const profileUpdates: Record<string, unknown> = {
      appearance,
      themeColor
    };

    if (shouldUpdateDisplayName) {
      profileUpdates.displayName = displayName;
    }

    if (shouldUpdateDisplayName && displayName !== currentDisplayName) {
      await adminAuth!.updateUser(decodedToken.uid, { displayName });
    }

    await userReference.set(profileUpdates, { merge: true });

    if (shouldUpdateDisplayName && displayName !== currentDisplayName) {
      await syncDisplayNameReferences({
        displayName,
        email: firstString(currentProfile.email, decodedToken.email).toLowerCase(),
        role: currentProfile.role,
        uid: decodedToken.uid
      });
    }

    return NextResponse.json({
      profile: {
        ...currentProfile,
        appearance,
        displayName,
        themeColor,
        uid: decodedToken.uid
      }
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
