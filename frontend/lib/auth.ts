"use client";

import {
  EmailAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
  updatePassword,
  updateProfile
} from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc
} from "firebase/firestore";
import { normalizeClassCode } from "./class-code";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  type TeacherClassAppearance,
  type TeacherClassThemeColor
} from "./class-theme";
import { auth, db, isFirebaseConfigured } from "./firebase";

export type AccountRole = "student" | "teacher";

export type UserProfile = {
  uid: string;
  email: string;
  username: string;
  displayName: string;
  role: AccountRole;
  appearance?: TeacherClassAppearance;
  classId?: string;
  classIds?: string[];
  themeColor?: TeacherClassThemeColor;
  createdAt?: unknown;
};

const presenceHeartbeatMs = 30000;

export function subscribeToAuth(callback: (user: User | null) => void, onError?: (error: Error) => void) {
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, callback, onError);
}

export function subscribeToUserProfile(
  uid: string,
  callback: (profile: UserProfile | null) => void,
  onError?: (error: Error) => void
) {
  if (!db) {
    callback(null);
    return () => {};
  }

  let hasServerProfile = false;

  void loadAccountProfileFromApi(uid)
    .then((profile) => {
      if (profile) {
        hasServerProfile = true;
        callback(profile);
      }
    })
    .catch((error) => {
      onError?.(error instanceof Error ? error : new Error("Profile load failed."));
    });

  return onSnapshot(
    doc(db, "users", uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        if (!hasServerProfile) {
          callback(null);
        }
        return;
      }

      const data = snapshot.data();
      const profile = normalizeUserProfile(data);
      callback(profile);
      void backfillMissingUsername(uid, data, profile);
    },
    (error) => {
      onError?.(error);
    }
  );
}

export async function signUpWithRole({
  displayName,
  email,
  password,
  role,
  classId,
  teacherInviteToken,
  username
}: {
  displayName: string;
  email: string;
  password: string;
  role: AccountRole;
  classId?: string;
  teacherInviteToken?: string;
  username?: string;
}) {
  assertFirebaseReady();

  const cleanEmail = email.trim().toLowerCase();
  const cleanUsername = normalizeAccountUsername(username, cleanEmail);
  assertAccountUsernameIsValid(cleanUsername, cleanEmail);
  await assertUsernameIsAvailable(cleanUsername);

  const credential = await createUserWithEmailAndPassword(auth!, cleanEmail, password);
  await updateProfile(credential.user, { displayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName,
      teacherInviteToken,
      username: cleanUsername,
      user: credential.user
    });
  }

  const profile: UserProfile = {
    uid: credential.user.uid,
    email: cleanEmail,
    username: cleanUsername,
    displayName,
    role,
    createdAt: serverTimestamp()
  };

  await createAccountProfile(profile, credential.user);

  if (role === "student" && classId?.trim()) {
    const cleanClassId = await joinStudentClass({
      classCode: classId,
      displayName,
      email: cleanEmail,
      syncProfile: true,
      user: credential.user
    });

    if (cleanClassId) {
      return {
        ...profile,
        classId: cleanClassId,
        classIds: [cleanClassId]
      };
    }
  }

  return profile;
}

export async function createRoleProfile({
  displayName,
  role,
  user,
  classId,
  teacherInviteToken,
  username
}: {
  displayName: string;
  role: AccountRole;
  user: User;
  classId?: string;
  teacherInviteToken?: string;
  username?: string;
}) {
  assertFirebaseReady();

  const cleanDisplayName = displayName.trim() || user.displayName || user.email || "Chandra user";
  const cleanEmail = String(user.email ?? "").trim().toLowerCase();
  const cleanUsername = normalizeAccountUsername(username, cleanEmail);
  assertAccountUsernameIsValid(cleanUsername, cleanEmail);
  await updateProfile(user, { displayName: cleanDisplayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName: cleanDisplayName,
      teacherInviteToken,
      username: cleanUsername,
      user
    });
  }

  const profile: UserProfile = {
    uid: user.uid,
    email: cleanEmail,
    username: cleanUsername,
    displayName: cleanDisplayName,
    role,
    createdAt: serverTimestamp()
  };

  await createAccountProfile(profile, user);

  if (role === "student" && classId?.trim()) {
    const cleanClassId = await joinStudentClass({
      classCode: classId,
      displayName: cleanDisplayName,
      email: cleanEmail,
      syncProfile: true,
      user
    });

    if (cleanClassId) {
      return {
        ...profile,
        classId: cleanClassId,
        classIds: [cleanClassId]
      };
    }
  }

  return profile;
}

export async function signInWithEmail(emailOrUsername: string, password: string) {
  assertFirebaseReady();
  const email = await resolveLoginEmail(emailOrUsername);

  try {
    return await signInWithEmailAndPassword(auth!, email, password);
  } catch {
    throw new Error("Invalid username/email or password.");
  }
}

export async function requestPasswordReset(emailOrUsername: string) {
  assertFirebaseReady();
  const email = await resolveLoginEmail(emailOrUsername);

  if (email && email.includes("@")) {
    await sendPasswordResetEmail(auth!, email).catch(() => undefined);
  }

  return "If an account matches that email or username, Firebase will send a password reset link.";
}

export async function signOutCurrentUser() {
  assertFirebaseReady();
  if (auth!.currentUser) {
    await safelyWriteUserPresence(auth!.currentUser, null, false);
  }
  return signOut(auth!);
}

export async function signOutAllSessions() {
  assertFirebaseReady();
  const currentUser = auth!.currentUser;

  if (!currentUser) {
    throw new Error("Sign in before revoking sessions.");
  }

  const token = await currentUser.getIdToken(true);
  const response = await fetch("/api/account/sessions/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Session revocation failed.");
  }

  await safelyWriteUserPresence(currentUser, null, false);
  return signOut(auth!);
}

export async function deleteCurrentAccount({
  currentPassword,
  uid
}: {
  currentPassword: string;
  uid: string;
}) {
  assertFirebaseReady();
  const currentUser = auth!.currentUser;

  if (currentUser?.uid !== uid) {
    throw new Error("Sign in before deleting your account.");
  }

  const currentEmail = String(currentUser.email ?? "").trim().toLowerCase();
  const cleanCurrentPassword = String(currentPassword ?? "");

  if (!currentEmail || !cleanCurrentPassword) {
    throw new Error("Enter your current password before deleting your account.");
  }

  await reauthenticateWithCredential(
    currentUser,
    EmailAuthProvider.credential(currentEmail, cleanCurrentPassword)
  );

  const token = await currentUser.getIdToken(true);
  const response = await fetch("/api/account/delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json().catch(() => ({}))) as { deleted?: boolean; error?: string };

  if (!response.ok || !data.deleted) {
    throw new Error(data.error ?? "Account deletion failed.");
  }

  return data.deleted;
}

export function startUserPresenceHeartbeat(user: User, profile: UserProfile) {
  if (!db) {
    return () => {};
  }

  let stopped = false;
  const writeOnline = () => {
    if (!stopped && document.visibilityState === "visible") {
      void safelyWriteUserPresence(user, profile, true);
    }
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      writeOnline();
      return;
    }

    void safelyWriteUserPresence(user, profile, false);
  };

  writeOnline();
  const intervalId = window.setInterval(writeOnline, presenceHeartbeatMs);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    stopped = true;
    window.clearInterval(intervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    void safelyWriteUserPresence(user, profile, false);
  };
}

export async function getUserProfile(uid: string) {
  const apiProfile = await loadAccountProfileFromApi(uid).catch(() => null);

  if (apiProfile) {
    return apiProfile;
  }

  if (!db) {
    return null;
  }

  const snapshot = await getDoc(doc(db, "users", uid));
  return snapshot.exists() ? normalizeUserProfile(snapshot.data()) : null;
}

export async function updateStudentClass({
  classId,
  uid
}: {
  classId: string;
  uid: string;
}) {
  assertFirebaseReady();

  if (auth!.currentUser?.uid !== uid) {
    throw new Error("Sign in before joining a class.");
  }

  await joinStudentClass({
    classCode: classId,
    displayName: auth!.currentUser.displayName ?? "",
    email: auth!.currentUser.email ?? "",
    syncProfile: true,
    user: auth!.currentUser
  });
}

export async function updateUserThemePreference({
  appearance,
  themeColor,
  uid
}: {
  appearance: TeacherClassAppearance;
  themeColor: TeacherClassThemeColor;
  uid: string;
}) {
  return updateUserAccountSettings({
    appearance,
    themeColor,
    uid
  });
}

export async function updateUserAccountSettings({
  appearance,
  currentPassword,
  displayName,
  email,
  newPassword,
  username,
  themeColor,
  uid
}: {
  appearance?: TeacherClassAppearance;
  currentPassword?: string;
  displayName?: string;
  email?: string;
  newPassword?: string;
  username?: string;
  themeColor?: TeacherClassThemeColor;
  uid: string;
}) {
  assertFirebaseReady();

  const currentUser = auth!.currentUser;

  if (currentUser?.uid !== uid) {
    throw new Error("Sign in before changing account settings.");
  }

  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const currentEmail = String(currentUser.email ?? "").trim().toLowerCase();
  const cleanNewPassword = typeof newPassword === "string" ? newPassword : "";
  const shouldUpdateEmail = Boolean(cleanEmail && cleanEmail !== currentEmail);
  const shouldUpdatePassword = Boolean(cleanNewPassword);

  if (shouldUpdateEmail || shouldUpdatePassword) {
    const cleanCurrentPassword = String(currentPassword ?? "");

    if (!currentEmail || !cleanCurrentPassword) {
      throw new Error("Enter your current password before changing email or password.");
    }

    await reauthenticateWithCredential(
      currentUser,
      EmailAuthProvider.credential(currentEmail, cleanCurrentPassword)
    );

    if (shouldUpdatePassword) {
      await updatePassword(currentUser, cleanNewPassword);
    }

    if (shouldUpdateEmail) {
      await updateEmail(currentUser, cleanEmail);
    }
  }

  const token = await currentUser.getIdToken(true);
  const response = await fetch("/api/account/settings", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...(appearance ? { appearance: normalizeTeacherClassAppearance(appearance) } : {}),
      ...(typeof displayName === "string" ? { displayName } : {}),
      ...(cleanEmail ? { email: cleanEmail } : {}),
      ...(shouldUpdateEmail || shouldUpdatePassword ? { revokeOtherSessions: true } : {}),
      ...(typeof username === "string" ? { username } : {}),
      ...(themeColor ? { themeColor: normalizeTeacherClassThemeColor(themeColor) } : {})
    })
  });
  const data = (await response.json()) as { profile?: UserProfile; error?: string; sessionRevoked?: boolean };

  if (!response.ok || !data.profile) {
    throw new Error(data.error ?? "Account settings failed.");
  }

  if (typeof displayName === "string") {
    await updateProfile(currentUser, { displayName: data.profile.displayName });
  }

  return data.profile;
}

function assertFirebaseReady() {
  if (!isFirebaseConfigured || !auth || !db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values to .env.local.");
  }
}

export function normalizeAccountUsername(value: unknown, fallbackEmail = "") {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  return username || fallbackEmail.trim().toLowerCase();
}

function assertAccountUsernameIsValid(username: string, accountEmail: string) {
  if (!username) {
    throw new Error("Enter a username.");
  }

  if (username.length > 120) {
    throw new Error("Username must be 120 characters or fewer.");
  }

  if (username.includes("@") && username !== accountEmail) {
    throw new Error("Use your account email or a username without @.");
  }

  if (!/^[a-z0-9._%+-@]+$/.test(username)) {
    throw new Error("Username can use letters, numbers, dots, underscores, hyphens, plus, percent, and @.");
  }
}

function normalizeUserProfile(data: Record<string, unknown>): UserProfile {
  const email = String(data.email ?? "").trim().toLowerCase();

  return {
    ...(data as UserProfile),
    email,
    username: normalizeAccountUsername(data.username, email)
  };
}

async function resolveLoginEmail(emailOrUsername: string) {
  const identifier = emailOrUsername.trim().toLowerCase();

  if (!identifier) {
    return identifier;
  }

  const response = await fetch("/api/auth/resolve-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ identifier })
  });
  const data = (await response.json().catch(() => ({}))) as { email?: string; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Invalid username/email or password.");
  }

  return data.email || identifier;
}

async function assertUsernameIsAvailable(username: string) {
  if (!username || username.includes("@")) {
    return;
  }

  const response = await fetch("/api/auth/resolve-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ identifier: username })
  });

  const data = (await response.json().catch(() => ({}))) as { email?: string; error?: string };

  if (response.ok && "email" in data && !data.email) {
    return;
  }

  if (response.ok) {
    throw new Error("That username is already in use.");
  }

  if (response.status !== 500) {
    throw new Error(data.error ?? "Username check failed.");
  }
}

async function backfillMissingUsername(uid: string, data: Record<string, unknown>, profile: UserProfile) {
  if (!db || typeof data.username === "string" || !profile.email) {
    return;
  }

  try {
    await updateDoc(doc(db, "users", uid), { username: profile.email });
  } catch {
    // Server-side account settings also backfill username; ignore client rule or network failures here.
  }
}

async function writeUserPresence(user: User, profile: UserProfile | null, online: boolean) {
  if (!db) {
    return;
  }

  await setDoc(doc(db, "userPresence", user.uid), {
    classId: profile?.classId ?? "",
    displayName: profile?.displayName ?? user.displayName ?? "",
    email: String(profile?.email ?? user.email ?? "").trim().toLowerCase(),
    lastSeenAt: serverTimestamp(),
    online,
    role: profile?.role ?? "",
    uid: user.uid,
    updatedAt: serverTimestamp()
  });
}

async function safelyWriteUserPresence(user: User, profile: UserProfile | null, online: boolean) {
  try {
    await writeUserPresence(user, profile, online);
  } catch (caughtError) {
    console.warn("User presence update failed.", caughtError);
  }
}

async function joinStudentClass({
  classCode,
  displayName,
  email,
  syncProfile,
  user
}: {
  classCode: string;
  displayName: string;
  email: string;
  syncProfile: boolean;
  user?: User | null;
}) {
  const cleanClassCode = normalizeClassCode(classCode);

  if (!cleanClassCode) {
    if (!syncProfile) {
      return "";
    }

    if (!user) {
      throw new Error("Sign in before joining a class.");
    }
  }

  if (!user) {
    throw new Error("Sign in before joining a class.");
  }

  if (!cleanClassCode && !syncProfile) {
    return "";
  }

  const token = await user.getIdToken();
  const response = await fetch("/api/classes/join", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      classCode: cleanClassCode,
      displayName,
      email,
      syncProfile
    })
  });
  const data = (await response.json()) as { classId?: string; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Class join failed.");
  }

  return data.classId ?? "";
}

async function createTeacherProfile({
  displayName,
  teacherInviteToken,
  username,
  user
}: {
  displayName: string;
  teacherInviteToken?: string;
  username: string;
  user: User;
}) {
  const token = await user.getIdToken();
  const response = await fetch("/api/teacher-signup", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName,
      inviteToken: teacherInviteToken ?? "",
      username
    })
  });
  const data = (await response.json()) as { profile?: UserProfile; error?: string };

  if (!response.ok || !data.profile) {
    throw new Error(data.error ?? "Teacher signup failed.");
  }

  return data.profile;
}

async function createAccountProfile(profile: UserProfile, user: User) {
  const token = await user.getIdToken();
  const response = await fetch("/api/account/profile", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(profile)
  });
  const data = (await response.json().catch(() => ({}))) as { profile?: UserProfile; error?: string };

  if (!response.ok || !data.profile) {
    throw new Error(data.error ?? "Profile creation failed.");
  }

  return data.profile;
}

async function loadAccountProfileFromApi(uid: string) {
  const currentUser = auth?.currentUser;

  if (!currentUser || currentUser.uid !== uid) {
    return null;
  }

  const token = await currentUser.getIdToken();
  const response = await fetch("/api/account/profile", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json().catch(() => ({}))) as { profile?: UserProfile | null };

  if (!response.ok) {
    return null;
  }

  return data.profile ?? null;
}
