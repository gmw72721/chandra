import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { assertAccountUsernameAvailable, getAccountProfile, tryPostgresData, upsertAccountProfile } from "@/lib/data/server";
import { updateClassSettings, updateCoTeacherProfile, updateStudentEnrollmentIdentity } from "@/lib/data/classes";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  normalizeTeacherClassThemeMood
} from "@/lib/class-theme";

export const runtime = "nodejs";

const recentAuthMaxAgeSeconds = 5 * 60;

type AccountSettingsBody = {
  appearance?: unknown;
  displayName?: unknown;
  email?: unknown;
  revokeOtherSessions?: unknown;
  themeColor?: unknown;
  themeMood?: unknown;
  username?: unknown;
};

type AccountSettingsProfile = {
  appearance?: unknown;
  classId?: unknown;
  classIds?: unknown;
  displayName?: unknown;
  email?: unknown;
  role?: unknown;
  themeColor?: unknown;
  themeMood?: unknown;
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
    const currentProfile = (await getAccountProfile(decodedToken.uid) ?? {}) as AccountSettingsProfile;

    if (!isSupportedAccountRole(currentProfile.role)) {
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
    const themeMood = bodyHasKey(body, "themeMood")
      ? normalizeTeacherClassThemeMood(body.themeMood)
      : normalizeTeacherClassThemeMood(currentProfile.themeMood);

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
      themeMood,
      username
    };

    if (shouldUpdateDisplayName) {
      profileUpdates.displayName = displayName;
    }

    if (shouldUpdateDisplayName && displayName !== currentDisplayName) {
      await adminAuth!.updateUser(decodedToken.uid, { displayName });
    }

    await upsertAccountProfile({
      id: decodedToken.uid,
      firebaseUid: decodedToken.uid,
      email,
      role: currentProfile.role,
      displayName,
      legacyClassId: String(currentProfile.classId ?? "").trim() || null,
      legacyClassIds: Array.isArray(currentProfile.classIds) ? currentProfile.classIds.map(String) : [],
      profile: {
        ...currentProfile,
        ...profileUpdates,
        displayName,
        uid: decodedToken.uid
      },
      username
    });

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

    if (email !== currentEmail) {
      await syncEmailReferences({
        currentEmail,
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
        themeMood,
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

async function syncEmailReferences({
  currentEmail,
  displayName,
  email,
  role,
  uid
}: {
  currentEmail: string;
  displayName: string;
  email: string;
  role: unknown;
  uid: string;
}) {
  if (role === "teacher") {
    await tryPostgresData("account.email.co_teachers.sync", () =>
      updateCoTeacherProfile({ displayName, email, teacherId: uid })
    );

    const coTeacherSnapshot = await adminDb!
      .collection("classes")
      .where("coTeacherIds", "array-contains", uid)
      .get();

    await Promise.all(
      coTeacherSnapshot.docs.map((classDoc) => {
        const classData = classDoc.data();
        const existingCoTeachers = isPlainRecord(classData.coTeachers) ? classData.coTeachers : {};
        const existingCoTeacher = isPlainRecord(existingCoTeachers[uid]) ? existingCoTeachers[uid] : {};
        const coTeachers = {
          ...existingCoTeachers,
          [uid]: {
            ...existingCoTeacher,
            displayName,
            email,
            uid
          }
        };

        return classDoc.ref.set({ coTeachers }, { merge: true });
      })
    );
    return;
  }

  if (role !== "student") {
    return;
  }

  await tryPostgresData("account.email.enrollments.sync", () =>
    updateStudentEnrollmentIdentity({ displayName, newEmail: email, oldEmail: currentEmail, studentId: uid })
  );

  const rosterSnapshots = await Promise.all([
    adminDb!.collectionGroup("students").where("uid", "==", uid).get(),
    currentEmail
      ? adminDb!.collectionGroup("students").where("email", "==", currentEmail).get()
      : Promise.resolve(null)
  ]);
  const rosterDocs = uniqueSnapshotDocs(rosterSnapshots.filter(Boolean));

  await Promise.all(
    rosterDocs.map(async (studentDoc) => {
      const nextStudentRef = studentDoc.ref.parent.doc(encodeURIComponent(email));
      const studentData = studentDoc.data();
      const nextStudentData = {
        ...studentData,
        displayName,
        email,
        uid
      };

      if (nextStudentRef.path === studentDoc.ref.path) {
        await studentDoc.ref.set(nextStudentData, { merge: true });
        return;
      }

      await nextStudentRef.set(nextStudentData, { merge: true });
      await studentDoc.ref.delete();
    })
  );

  await updateStudentCollectionGroupEmail("conversations", currentEmail, email, uid, { studentName: displayName });
  await updateStudentCollectionGroupEmail("studentFeedback", currentEmail, email, uid);
  await syncStudentKeyedCollectionEmail("studentLearningProfiles", { currentEmail, displayName, email, uid });
  await syncStudentKeyedCollectionEmail("studentSupport", { currentEmail, displayName, email, uid });
  await adminDb!.collection("userPresence").doc(uid).set({ email }, { merge: true });
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
    await tryPostgresData("account.display_name.co_teachers.sync", () =>
      updateCoTeacherProfile({ displayName, email, teacherId: uid })
    );

    await tryPostgresData("account.display_name.classes.sync", async () => {
      const classesSnapshot = await adminDb!
        .collection("classes")
        .where("teacherId", "==", uid)
        .get();

      await Promise.all(
        classesSnapshot.docs.map((classDoc) =>
          updateClassSettings({ classId: classDoc.id, teacherName: displayName })
        )
      );
    });

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

async function updateStudentCollectionGroupEmail(
  collectionId: string,
  currentEmail: string,
  email: string,
  uid: string,
  extraUpdates: Record<string, unknown> = {}
) {
  const snapshots = await Promise.all([
    adminDb!.collectionGroup(collectionId).where("studentId", "==", uid).get(),
    currentEmail
      ? adminDb!.collectionGroup(collectionId).where("studentEmail", "==", currentEmail).get()
      : Promise.resolve(null)
  ]);
  const docs = uniqueSnapshotDocs(snapshots.filter(Boolean));

  await Promise.all(
    docs.map((docSnapshot) =>
      docSnapshot.ref.set(
        {
          ...extraUpdates,
          studentEmail: email,
          studentId: uid
        },
        { merge: true }
      )
    )
  );
}

async function syncStudentKeyedCollectionEmail(
  collectionId: string,
  {
    currentEmail,
    displayName,
    email,
    uid
  }: {
    currentEmail: string;
    displayName: string;
    email: string;
    uid: string;
  }
) {
  const snapshots = await Promise.all([
    adminDb!.collectionGroup(collectionId).where("studentId", "==", uid).get(),
    currentEmail
      ? adminDb!.collectionGroup(collectionId).where("studentEmail", "==", currentEmail).get()
      : Promise.resolve(null)
  ]);
  const docs = uniqueSnapshotDocs(snapshots.filter(Boolean));

  await Promise.all(
    docs.map(async (docSnapshot) => {
      const nextDocRef = docSnapshot.ref.parent.doc(encodeURIComponent(email));
      const docData = docSnapshot.data();
      const nextDocData = {
        ...docData,
        displayName,
        studentEmail: email,
        studentId: uid
      };

      if (nextDocRef.path === docSnapshot.ref.path) {
        await docSnapshot.ref.set(nextDocData, { merge: true });
        return;
      }

      await nextDocRef.set(nextDocData, { merge: true });
      await docSnapshot.ref.delete();
    })
  );
}

function uniqueSnapshotDocs(snapshots: Array<FirebaseFirestore.QuerySnapshot | null>) {
  const docsByPath = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();

  for (const snapshot of snapshots) {
    if (!snapshot) {
      continue;
    }

    for (const docSnapshot of snapshot.docs) {
      docsByPath.set(docSnapshot.ref.path, docSnapshot);
    }
  }

  return Array.from(docsByPath.values());
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
  const available = await assertAccountUsernameAvailable(username, uid);

  if (!available) {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
