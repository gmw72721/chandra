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
  displayName: string;
  role: AccountRole;
  appearance?: TeacherClassAppearance;
  classId?: string;
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
  classId
}: {
  displayName: string;
  email: string;
  password: string;
  role: AccountRole;
  classId?: string;
}) {
  assertFirebaseReady();

  const credential = await createUserWithEmailAndPassword(auth!, email, password);
  await updateProfile(credential.user, { displayName });

  const profile: UserProfile = {
    uid: credential.user.uid,
    email,
    displayName,
    role,
    createdAt: serverTimestamp()
  };

  const cleanClassId =
    role === "student"
      ? await joinStudentClass({
          classCode: classId ?? "",
          displayName,
          email,
          syncProfile: false,
          user: credential.user
        })
      : "";

  if (role === "student" && cleanClassId) {
    profile.classId = cleanClassId;
  }

  await setDoc(doc(db!, "users", credential.user.uid), profile);
  return profile;
}

export async function createRoleProfile({
  displayName,
  role,
  user,
  classId
}: {
  displayName: string;
  role: AccountRole;
  user: User;
  classId?: string;
}) {
  assertFirebaseReady();

  const cleanDisplayName = displayName.trim() || user.displayName || user.email || "Chandra user";
  await updateProfile(user, { displayName: cleanDisplayName });

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email ?? "",
    displayName: cleanDisplayName,
    role,
    createdAt: serverTimestamp()
  };

  const cleanClassId =
    role === "student"
      ? await joinStudentClass({
          classCode: classId ?? "",
          displayName: cleanDisplayName,
          email: user.email ?? "",
          syncProfile: false,
          user
        })
      : "";

  if (role === "student" && cleanClassId) {
    profile.classId = cleanClassId;
  }

  await setDoc(doc(db!, "users", user.uid), profile);
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
  assertFirebaseReady();

  if (auth!.currentUser?.uid !== uid) {
    throw new Error("Sign in before changing your theme.");
  }

  await updateDoc(doc(db!, "users", uid), {
    appearance: normalizeTeacherClassAppearance(appearance),
    themeColor: normalizeTeacherClassThemeColor(themeColor)
  });
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
