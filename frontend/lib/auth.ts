"use client";

import {
  AuthCredential,
  EmailAuthProvider,
  GoogleAuthProvider,
  User,
  type UserCredential,
  createUserWithEmailAndPassword,
  getRedirectResult,
  isSignInWithEmailLink,
  linkWithCredential,
  onAuthStateChanged,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  sendSignInLinkToEmail,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
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
export type AuthProviderKey = "google";

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

export type PendingProviderCredential = {
  credential: AuthCredential;
  email: string;
  provider: AuthProviderKey;
  providerLabel: string;
};

export class ProviderAccountLinkingRequiredError extends Error {
  pendingCredential: PendingProviderCredential;

  constructor(pendingCredential: PendingProviderCredential) {
    super(
      `An email/password account already exists for ${pendingCredential.email}. Enter that account password to link ${pendingCredential.providerLabel}.`
    );
    this.name = "ProviderAccountLinkingRequiredError";
    this.pendingCredential = pendingCredential;
  }
}

const presenceHeartbeatMs = 30000;
const magicLinkEmailStorageKey = "chandra.pendingMagicLinkEmail";

const providerDefinitions = {
  google: {
    label: "Google",
    createProvider: () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      return provider;
    },
    credentialFromError: (error: unknown) =>
      GoogleAuthProvider.credentialFromError(
        error as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]
      )
  }
} satisfies Record<
  AuthProviderKey,
  {
    credentialFromError: (error: unknown) => AuthCredential | null;
    createProvider: () => GoogleAuthProvider;
    label: string;
  }
>;

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
  username
}: {
  displayName: string;
  email: string;
  password: string;
  role: AccountRole;
  classId?: string;
  username?: string;
}) {
  assertFirebaseReady();

  const cleanEmail = email.trim().toLowerCase();
  const cleanClassCode = role === "student" ? requireStudentClassCode(classId) : "";
  const cleanUsername = normalizeAccountUsername(username, cleanEmail);
  assertAccountUsernameIsValid(cleanUsername, cleanEmail);
  await assertUsernameIsAvailable(cleanUsername);

  const credential = await createUserWithEmailAndPassword(auth!, cleanEmail, password);
  await updateProfile(credential.user, { displayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName,
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

  const cleanClassId = await joinStudentClass({
    classCode: cleanClassCode,
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

  return profile;
}

export async function createRoleProfile({
  displayName,
  role,
  user,
  classId,
  username
}: {
  displayName: string;
  role: AccountRole;
  user: User;
  classId?: string;
  username?: string;
}) {
  assertFirebaseReady();

  const cleanDisplayName = displayName.trim() || user.displayName || user.email || "Chandra user";
  const cleanEmail = String(user.email ?? "").trim().toLowerCase();
  const cleanClassCode = role === "student" ? requireStudentClassCode(classId) : "";
  const cleanUsername = normalizeAccountUsername(username, cleanEmail);
  assertAccountUsernameIsValid(cleanUsername, cleanEmail);
  await updateProfile(user, { displayName: cleanDisplayName });

  if (role === "teacher") {
    return createTeacherProfile({
      displayName: cleanDisplayName,
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

  const cleanClassId = await joinStudentClass({
    classCode: cleanClassCode,
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

export async function signInWithProviderAuth(provider: AuthProviderKey) {
  assertFirebaseReady();
  const definition = providerDefinitions[provider];

  try {
    const credential = await signInWithPopup(auth!, definition.createProvider());
    await assertUserHasProviderEmail(credential.user, definition.label);
    return credential;
  } catch (caughtError) {
    const accountLinkingError = accountLinkingErrorFromProviderAuthError(caughtError, provider);

    if (accountLinkingError) {
      throw accountLinkingError;
    }

    if (shouldRetryProviderSignInWithRedirect(caughtError)) {
      await signInWithRedirect(auth!, definition.createProvider());
      return null;
    }

    throw normalizeProviderAuthError(caughtError, definition.label);
  }
}

export async function completeProviderRedirectSignIn(): Promise<UserCredential | null> {
  assertFirebaseReady();

  try {
    const credential = await getRedirectResult(auth!);

    if (!credential) {
      return null;
    }

    await assertUserHasProviderEmail(credential.user, providerDefinitions.google.label);
    return credential;
  } catch (caughtError) {
    const accountLinkingError = accountLinkingErrorFromProviderAuthError(caughtError, "google");

    if (accountLinkingError) {
      throw accountLinkingError;
    }

    throw normalizeProviderAuthError(caughtError, providerDefinitions.google.label);
  }
}

export async function linkProviderToEmailPasswordAccount({
  email,
  password,
  pendingCredential
}: {
  email: string;
  password: string;
  pendingCredential: PendingProviderCredential;
}) {
  assertFirebaseReady();
  const cleanEmail = email.trim().toLowerCase();

  if (!cleanEmail || !password) {
    throw new Error("Enter the password for your existing email/password account.");
  }

  let emailCredential: Awaited<ReturnType<typeof signInWithEmailAndPassword>>;

  try {
    emailCredential = await signInWithEmailAndPassword(auth!, cleanEmail, password);
  } catch {
    throw new Error("Invalid password for the existing email/password account.");
  }

  try {
    return await linkWithCredential(emailCredential.user, pendingCredential.credential);
  } catch (caughtError) {
    throw normalizeProviderAuthError(caughtError, pendingCredential.providerLabel);
  }
}

export function userNeedsBackupPassword(user: User | null) {
  if (!user) {
    return false;
  }

  const providerIds = new Set(user.providerData.map((provider) => provider.providerId));
  return providerIds.has(GoogleAuthProvider.PROVIDER_ID) && !providerIds.has(EmailAuthProvider.PROVIDER_ID);
}

export async function createBackupPasswordForCurrentUser({
  password,
  uid
}: {
  password: string;
  uid: string;
}) {
  assertFirebaseReady();
  const currentUser = auth!.currentUser;

  if (currentUser?.uid !== uid) {
    throw new Error("Sign in with Google before creating a backup password.");
  }

  const cleanPassword = String(password ?? "");

  if (cleanPassword.length < 6) {
    throw new Error("Backup password must be at least 6 characters.");
  }

  try {
    await updatePassword(currentUser, cleanPassword);
    await currentUser.reload();
  } catch (caughtError) {
    if (getAuthErrorCode(caughtError) === "auth/requires-recent-login") {
      throw new Error("Sign in with Google again, then create your backup password.");
    }

    throw normalizeBackupPasswordError(caughtError);
  }
}

export async function refreshGoogleAuthentication() {
  assertFirebaseReady();
  const currentUser = auth!.currentUser;

  if (!currentUser) {
    throw new Error("Sign in with Google before creating a backup password.");
  }

  try {
    await reauthenticateWithPopup(currentUser, providerDefinitions.google.createProvider());
    await currentUser.reload();
  } catch (caughtError) {
    throw normalizeProviderAuthError(caughtError, providerDefinitions.google.label);
  }
}

export function isEmailMagicLink(url: string) {
  if (!auth) {
    return false;
  }

  return isSignInWithEmailLink(auth, url);
}

export function getPendingMagicLinkEmail() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(magicLinkEmailStorageKey) ?? "";
}

export async function sendEmailMagicLink(email: string) {
  assertFirebaseReady();
  const cleanEmail = email.trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("Enter the email address where Firebase should send the magic link.");
  }

  const url = typeof window === "undefined" ? "/auth" : `${window.location.origin}/auth`;

  try {
    await sendSignInLinkToEmail(auth!, cleanEmail, {
      handleCodeInApp: true,
      url
    });
  } catch (caughtError) {
    throw normalizeEmailLinkAuthError(caughtError);
  }

  if (typeof window !== "undefined") {
    window.localStorage.setItem(magicLinkEmailStorageKey, cleanEmail);
  }

  return "Check your email for a Chandra sign-in link. Open it in this browser to finish signing in.";
}

export async function completeEmailMagicLinkSignIn(url: string, email?: string) {
  assertFirebaseReady();

  if (!isSignInWithEmailLink(auth!, url)) {
    throw new Error("This is not a valid Firebase email sign-in link.");
  }

  const cleanEmail = (email || getPendingMagicLinkEmail()).trim().toLowerCase();

  if (!cleanEmail) {
    throw new Error("Enter the email address you used for this magic link to finish signing in.");
  }

  const credential = await signInWithEmailLink(auth!, cleanEmail, url);
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(magicLinkEmailStorageKey);
  }
  await assertUserHasProviderEmail(credential.user, "Email link");
  return credential;
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

export async function deleteCurrentAccountFromCurrentSession({ uid }: { uid: string }) {
  assertFirebaseReady();
  const currentUser = auth!.currentUser;

  if (currentUser?.uid !== uid) {
    throw new Error("Sign in before deleting your account.");
  }

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

async function assertUserHasProviderEmail(user: User, providerLabel: string) {
  if (user.email) {
    return;
  }

  await signOut(auth!);
  throw new Error(
    `${providerLabel} did not return an email address for this account. Chandra accounts require an email address.`
  );
}

function getAuthErrorCode(error: unknown) {
  if (!isRecord(error) || typeof error.code !== "string") {
    return "";
  }

  return error.code;
}

function getAuthErrorEmail(error: unknown) {
  if (!isRecord(error)) {
    return "";
  }

  const customData = error.customData;

  if (!isRecord(customData) || typeof customData.email !== "string") {
    return "";
  }

  return customData.email.trim().toLowerCase();
}

function accountLinkingErrorFromProviderAuthError(error: unknown, provider: AuthProviderKey) {
  if (getAuthErrorCode(error) !== "auth/account-exists-with-different-credential") {
    return null;
  }

  const definition = providerDefinitions[provider];
  const pendingCredential = definition.credentialFromError(error);
  const email = getAuthErrorEmail(error);

  if (!pendingCredential) {
    return new Error(
      `${definition.label} sign-in found an existing account, but Firebase did not return the provider credential needed to link it. Try again.`
    );
  }

  if (!email) {
    return new Error(
      `${definition.label} sign-in found an existing account, but Firebase did not return the account email needed to link it.`
    );
  }

  return new ProviderAccountLinkingRequiredError({
    credential: pendingCredential,
    email,
    provider,
    providerLabel: definition.label
  });
}

function shouldRetryProviderSignInWithRedirect(error: unknown) {
  return new Set([
    "auth/operation-not-supported-in-this-environment",
    "auth/popup-blocked",
    "auth/web-storage-unsupported"
  ]).has(getAuthErrorCode(error));
}

function normalizeProviderAuthError(error: unknown, providerLabel: string) {
  const code = getAuthErrorCode(error);

  if (code === "auth/argument-error" || code === "auth/invalid-oauth-provider") {
    return new Error(
      `${providerLabel} sign-in is not configured correctly in Firebase Authentication. Enable the ${providerLabel} provider, add this app domain to Firebase authorized domains, and verify the provider client ID/secret settings.`
    );
  }

  if (code === "auth/operation-not-allowed") {
    return new Error(`Enable ${providerLabel} sign-in in Firebase Authentication before using this button.`);
  }

  if (code === "auth/unauthorized-domain") {
    return new Error(
      `Add this domain to Firebase Authentication authorized domains before using ${providerLabel} sign-in.`
    );
  }

  if (code === "auth/network-request-failed") {
    return new Error(`Network error while opening ${providerLabel} sign-in. Check your connection and try again.`);
  }

  if (code === "auth/popup-closed-by-user") {
    return new Error(`${providerLabel} sign-in was canceled.`);
  }

  if (code === "auth/cancelled-popup-request") {
    return new Error(`Another ${providerLabel} sign-in popup is already in progress.`);
  }

  if (code === "auth/popup-blocked") {
    return new Error(`Your browser blocked the ${providerLabel} sign-in popup.`);
  }

  if (code === "auth/credential-already-in-use" || code === "auth/provider-already-linked") {
    return new Error(`${providerLabel} is already linked to another Chandra account.`);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`${providerLabel} sign-in failed.`);
}

function normalizeEmailLinkAuthError(error: unknown) {
  const code = getAuthErrorCode(error);

  if (code === "auth/argument-error") {
    return new Error(
      "Email magic-link sign-in is not configured correctly. Enable Email link sign-in in Firebase Authentication and add this app domain to authorized domains."
    );
  }

  if (code === "auth/operation-not-allowed") {
    return new Error("Enable Email link sign-in in Firebase Authentication before sending magic links.");
  }

  if (code === "auth/unauthorized-continue-uri" || code === "auth/unauthorized-domain") {
    return new Error("Add this app domain to Firebase Authentication authorized domains before sending magic links.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error("Magic-link sign-in failed.");
}

function normalizeBackupPasswordError(error: unknown) {
  const code = getAuthErrorCode(error);

  if (code === "auth/weak-password") {
    return new Error("Backup password must be at least 6 characters.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error("Backup password setup failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function requireStudentClassCode(classId: string | undefined) {
  const cleanClassCode = normalizeClassCode(classId ?? "");

  if (!cleanClassCode) {
    throw new Error("Enter your class code to create a student account.");
  }

  return cleanClassCode;
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
    throw new Error("Enter your class code to continue.");
  }

  if (!user) {
    throw new Error("Sign in before joining a class.");
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
  username,
  user
}: {
  displayName: string;
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
