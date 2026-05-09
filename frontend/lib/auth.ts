"use client";

import {
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc
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
  displayName: string;
  role: AccountRole;
  appearance?: TeacherClassAppearance;
  classId?: string;
  classIds?: string[];
  themeColor?: TeacherClassThemeColor;
  createdAt?: unknown;
};

const presenceHeartbeatMs = 30000;

export function subscribeToAuth(callback: (user: User | null) => void) {
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, callback);
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

  return onSnapshot(
    doc(db, "users", uid),
    (snapshot) => {
      callback(snapshot.exists() ? (snapshot.data() as UserProfile) : null);
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
  teacherInviteToken
}: {
  displayName: string;
  email: string;
  password: string;
  role: AccountRole;
  classId?: string;
  teacherInviteToken?: string;
}) {
  assertFirebaseReady();

  const credential = await createUserWithEmailAndPassword(auth!, email, password);
  await updateProfile(credential.user, { displayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName,
      teacherInviteToken,
      user: credential.user
    });
  }

  const profile: UserProfile = {
    uid: credential.user.uid,
    email,
    displayName,
    role,
    createdAt: serverTimestamp()
  };

  await setDoc(doc(db!, "users", credential.user.uid), profile);

  if (role === "student" && classId?.trim()) {
    const cleanClassId = await joinStudentClass({
      classCode: classId,
      displayName,
      email,
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
  teacherInviteToken
}: {
  displayName: string;
  role: AccountRole;
  user: User;
  classId?: string;
  teacherInviteToken?: string;
}) {
  assertFirebaseReady();

  const cleanDisplayName = displayName.trim() || user.displayName || user.email || "Chandra user";
  await updateProfile(user, { displayName: cleanDisplayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName: cleanDisplayName,
      teacherInviteToken,
      user
    });
  }

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email ?? "",
    displayName: cleanDisplayName,
    role,
    createdAt: serverTimestamp()
  };

  await setDoc(doc(db!, "users", user.uid), profile);

  if (role === "student" && classId?.trim()) {
    const cleanClassId = await joinStudentClass({
      classCode: classId,
      displayName: cleanDisplayName,
      email: user.email ?? "",
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

export async function signInWithEmail(email: string, password: string) {
  assertFirebaseReady();
  return signInWithEmailAndPassword(auth!, email, password);
}

export async function signOutCurrentUser() {
  assertFirebaseReady();
  if (auth!.currentUser) {
    await safelyWriteUserPresence(auth!.currentUser, null, false);
  }
  return signOut(auth!);
}

export function startUserPresenceHeartbeat(user: User, profile: UserProfile) {
  if (!db) {
    return () => {};
  }

  let stopped = false;
  const writeOnline = () => {
    if (!stopped) {
      void safelyWriteUserPresence(user, profile, true);
    }
  };
  const handleVisibilityChange = () => {
    void safelyWriteUserPresence(user, profile, document.visibilityState === "visible");
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
  if (!db) {
    return null;
  }

  const snapshot = await getDoc(doc(db, "users", uid));
  return snapshot.exists() ? (snapshot.data() as UserProfile) : null;
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
  displayName,
  themeColor,
  uid
}: {
  appearance?: TeacherClassAppearance;
  displayName?: string;
  themeColor?: TeacherClassThemeColor;
  uid: string;
}) {
  assertFirebaseReady();

  if (auth!.currentUser?.uid !== uid) {
    throw new Error("Sign in before changing account settings.");
  }

  const token = await auth!.currentUser.getIdToken();
  const response = await fetch("/api/account/settings", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...(appearance ? { appearance: normalizeTeacherClassAppearance(appearance) } : {}),
      ...(typeof displayName === "string" ? { displayName } : {}),
      ...(themeColor ? { themeColor: normalizeTeacherClassThemeColor(themeColor) } : {})
    })
  });
  const data = (await response.json()) as { profile?: UserProfile; error?: string };

  if (!response.ok || !data.profile) {
    throw new Error(data.error ?? "Account settings failed.");
  }

  if (typeof displayName === "string") {
    await updateProfile(auth!.currentUser, { displayName: data.profile.displayName });
  }

  return data.profile;
}

function assertFirebaseReady() {
  if (!isFirebaseConfigured || !auth || !db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values to .env.local.");
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
  user
}: {
  displayName: string;
  teacherInviteToken?: string;
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
      inviteToken: teacherInviteToken ?? ""
    })
  });
  const data = (await response.json()) as { profile?: UserProfile; error?: string };

  if (!response.ok || !data.profile) {
    throw new Error(data.error ?? "Teacher signup failed.");
  }

  return data.profile;
}
