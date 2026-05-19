"use client";

import type { User } from "firebase/auth";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderAccountLinkingRequiredError,
  completeProviderRedirectSignIn,
  completeEmailMagicLinkSignIn,
  createBackupPasswordForCurrentUser,
  createRoleProfile,
  deleteCurrentAccountFromCurrentSession,
  getPendingMagicLinkEmail,
  isEmailMagicLink,
  linkProviderToEmailPasswordAccount,
  requestPasswordReset,
  refreshGoogleAuthentication,
  sendEmailMagicLink,
  signInWithEmail,
  signInWithProviderAuth,
  signUpWithRole,
  updateStudentClass,
  userNeedsBackupPassword,
  type AccountRole,
  type AuthProviderKey,
  type PendingProviderCredential
} from "@/lib/auth";
import { CLASS_CODE_LENGTH, formatClassCodeInput } from "@/lib/class-code";
import { useAuth } from "./AuthProvider";

type AuthMode = "signin" | "signup" | "reset";

const pendingProfileStorageKey = "chandra.pendingProfile";

type PendingProfile = {
  classId?: string;
  displayName: string;
  email?: string;
  role: AccountRole;
  username?: string;
};

const providerOptions: Array<{ key: AuthProviderKey; label: string }> = [
  { key: "google", label: "Google" }
];

function parseAuthMode(value: string | null): AuthMode {
  return value === "signin" || value === "reset" ? value : "signup";
}
interface AuthFormProps {
  onAuthSuccess?: (destination: string) => void;
}

export function AuthForm({ onAuthSuccess }: AuthFormProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedRole = searchParams.get("role") === "teacher" ? "teacher" : "student";
  const requestedClassId = formatClassCodeInput(searchParams.get("classId") ?? "");
  const [mode, setMode] = useState<AuthMode>(() => parseAuthMode(searchParams.get("mode")));
  const [role, setRole] = useState<AccountRole>(requestedRole);
  const [classId, setClassId] = useState(requestedClassId);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showEmailSignup, setShowEmailSignup] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [emailLinkUrl] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return isEmailMagicLink(window.location.href) ? window.location.href : "";
  });
  const [linkingRequest, setLinkingRequest] = useState<PendingProviderCredential | null>(null);
  const [linkingPassword, setLinkingPassword] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [backupPasswordConfirmation, setBackupPasswordConfirmation] = useState("");
  const [savedBackupPasswordUid, setSavedBackupPasswordUid] = useState("");
  const hasCheckedEmailLinkRef = useRef(false);
  const hasCheckedProviderRedirectRef = useRef(false);
  const isRepairingProfileRef = useRef(false);
  const { firebaseReady, isLoading, profile, profileError, sessionError, user } = useAuth();

  const destination = useMemo(
    () => (profile?.role === "teacher" ? "/teacher" : "/student"),
    [profile?.role]
  );

  const hydrateSignupFieldsFromPendingProfile = useCallback((pendingProfile: PendingProfile, userEmail: string) => {
    setRole(pendingProfile.role);
    setClassId(formatClassCodeInput(pendingProfile.classId ?? ""));
    setDisplayName(pendingProfile.displayName || user?.displayName || userEmail);
    setEmail(pendingProfile.email || userEmail);
    setUsername(pendingProfile.username || userEmail);
  }, [user?.displayName]);

  const finishPendingRoleProfileSetup = useCallback(async (nextUser: User) => {
    const pendingProfile = readPendingProfile();
    const userEmail = String(nextUser.email ?? "").trim().toLowerCase();

    if (!pendingProfile) {
      return;
    }

    if (pendingProfile.email && pendingProfile.email !== userEmail) {
      throw new Error("Google returned a different email than the one saved for signup. Start signup again.");
    }

    const nextProfile = await createRoleProfile({
      classId: pendingProfile.classId,
      displayName: pendingProfile.displayName || nextUser.displayName || userEmail,
      role: pendingProfile.role,
      username: pendingProfile.username || userEmail,
      user: nextUser
    });
    window.localStorage.removeItem(pendingProfileStorageKey);

    if (userNeedsBackupPassword(nextUser)) {
      setNotice("You have successfully signed in. Create a backup password just in case.");
      return;
    }

    const dest = nextProfile.role === "teacher" ? "/teacher" : "/student";
    if (onAuthSuccess) {
      onAuthSuccess(dest);
    } else {
      router.push(dest);
    }
  }, [router, onAuthSuccess]);

  useEffect(() => {
    if (!firebaseReady || !emailLinkUrl || hasCheckedEmailLinkRef.current) {
      return;
    }

    hasCheckedEmailLinkRef.current = true;
    const pendingEmail = getPendingMagicLinkEmail();

    if (!pendingEmail) {
      queueMicrotask(() => {
        setMode("signin");
        setNotice("Enter the email address you used for this magic link, then complete sign-in.");
      });
      return;
    }

    completeEmailMagicLinkSignIn(emailLinkUrl, pendingEmail)
      .then(() => {
        router.replace("/auth");
      })
      .catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : "Magic-link sign-in failed.");
      });
  }, [emailLinkUrl, firebaseReady, router]);

  useEffect(() => {
    if (!firebaseReady || hasCheckedProviderRedirectRef.current) {
      return;
    }

    hasCheckedProviderRedirectRef.current = true;
    completeProviderRedirectSignIn()
      .then(async (credential) => {
        if (!credential) {
          return;
        }

        updatePendingProfileFromProvider(credential.user);
        await finishPendingRoleProfileSetup(credential.user);

        if (userNeedsBackupPassword(credential.user)) {
          setNotice("You have successfully signed in. Create a backup password just in case.");
        }
      })
      .catch((caughtError) => {
        if (caughtError instanceof ProviderAccountLinkingRequiredError) {
          setLinkingRequest(caughtError.pendingCredential);
          setLinkingPassword("");
          setNotice("");
          return;
        }

        setError(caughtError instanceof Error ? caughtError.message : "Provider sign-in failed.");
      });
  }, [firebaseReady, finishPendingRoleProfileSetup]);

  useEffect(() => {
    if (!user || profile || isLoading || isRepairingProfileRef.current) {
      return;
    }

    const pendingProfile = readPendingProfile();
    const userEmail = String(user.email ?? "").trim().toLowerCase();

    if (!pendingProfile || (pendingProfile.email && pendingProfile.email !== userEmail)) {
      return;
    }

    queueMicrotask(() => hydrateSignupFieldsFromPendingProfile(pendingProfile, userEmail));
    isRepairingProfileRef.current = true;
    createRoleProfile({
      classId: pendingProfile.classId,
      displayName: pendingProfile.displayName,
      role: pendingProfile.role,
      username: pendingProfile.username || userEmail,
      user
    })
      .then((nextProfile) => {
        window.localStorage.removeItem(pendingProfileStorageKey);
        if (userNeedsBackupPassword(user)) {
          setNotice("You have successfully signed in. Create a backup password just in case.");
          return;
        }

        const dest = nextProfile.role === "teacher" ? "/teacher" : "/student";
        if (onAuthSuccess) {
          onAuthSuccess(dest);
        } else {
          router.push(dest);
        }
      })
      .catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : "Profile setup failed.");
      })
      .finally(() => {
        isRepairingProfileRef.current = false;
      });
  }, [hydrateSignupFieldsFromPendingProfile, isLoading, profile, router, user, onAuthSuccess]);

  useEffect(() => {
    if (!user || profile || isLoading) {
      return;
    }

    const pendingProfile = readPendingProfile();
    const userEmail = String(user.email ?? "").trim().toLowerCase();

    if (!pendingProfile || (pendingProfile.email && pendingProfile.email !== userEmail)) {
      return;
    }

    queueMicrotask(() => hydrateSignupFieldsFromPendingProfile(pendingProfile, userEmail));
  }, [hydrateSignupFieldsFromPendingProfile, isLoading, profile, user]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      if (mode === "signup") {
        if (!showEmailSignup) {
          assertSignupProfileFieldsArePresent();
          setShowEmailSignup(true);
          return;
        }

        assertSignupProfileFieldsArePresent();
        savePendingProfile(buildPendingProfile());
        await signUpWithRole({
          displayName: displayName.trim(),
          email: email.trim(),
          password,
          role,
          classId: role === "student" ? classId.trim() : "",
          username: username.trim()
        });
        const dest = role === "teacher" ? "/teacher" : "/student";
        if (onAuthSuccess) {
          onAuthSuccess(dest);
        } else {
          router.push(dest);
        }
      } else if (mode === "signin") {
        clearPendingProfile();
        await signInWithEmail(email.trim(), password);
      } else {
        clearPendingProfile();
        const message = await requestPasswordReset(email.trim());
        setNotice(message);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Authentication failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function chooseMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
    setNotice("");
    setShowEmailSignup(false);
  }

  async function submitProviderSignIn(provider: AuthProviderKey) {
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      if (mode === "signup") {
        assertSignupProfileFieldsArePresent();
        savePendingProfile(buildPendingProfile());
      } else {
        clearPendingProfile();
      }

      const credential = await signInWithProviderAuth(provider);

      if (!credential) {
        setNotice("Redirecting to Google sign-in.");
        return;
      }

      if (mode === "signup") {
        updatePendingProfileFromProvider(credential.user);
        await finishPendingRoleProfileSetup(credential.user);
        return;
      }

      if (userNeedsBackupPassword(credential.user)) {
        setNotice("You have successfully signed in. Create a backup password just in case.");
      }
    } catch (caughtError) {
      if (caughtError instanceof ProviderAccountLinkingRequiredError) {
        setLinkingRequest(caughtError.pendingCredential);
        setLinkingPassword("");
        setNotice("");
        return;
      }

      setError(caughtError instanceof Error ? caughtError.message : "Provider sign-in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitMagicLink() {
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      if (emailLinkUrl) {
        await completeEmailMagicLinkSignIn(emailLinkUrl, email.trim());
        router.replace("/auth");
        return;
      }

      if (mode === "signup") {
        assertSignupProfileFieldsArePresent();
        savePendingProfile(buildPendingProfile());
      } else {
        clearPendingProfile();
      }

      const message = await sendEmailMagicLink(email.trim());
      setNotice(message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Magic-link sign-in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitProviderLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!linkingRequest) {
      return;
    }

    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      await linkProviderToEmailPasswordAccount({
        email: linkingRequest.email,
        password: linkingPassword,
        pendingCredential: linkingRequest
      });
      setLinkingRequest(null);
      setLinkingPassword("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Account linking failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitBackupPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      return;
    }

    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      if (backupPassword !== backupPasswordConfirmation) {
        throw new Error("Backup passwords do not match.");
      }

      await createBackupPasswordForCurrentUser({
        password: backupPassword,
        uid: user.uid
      });
      setBackupPassword("");
      setBackupPasswordConfirmation("");
      setSavedBackupPasswordUid(user.uid);
      setNotice("Backup password saved. You can now sign in with Google or with email and password.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Backup password setup failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function reauthenticateGoogleForBackupPassword() {
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      await refreshGoogleAuthentication();
      setNotice("Google sign-in refreshed. Create your backup password now.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Google sign-in refresh failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function buildPendingProfile(): PendingProfile {
    return {
      classId: role === "student" ? classId.trim() : "",
      displayName: displayName.trim(),
      email: email.trim().toLowerCase() || undefined,
      role,
      username: username.trim().toLowerCase()
    };
  }

  function assertSignupProfileFieldsArePresent() {
    if (mode === "signup" && role === "student" && !classId.trim()) {
      throw new Error("Enter your class code to create a student account.");
    }

    if (mode === "signup" && !displayName.trim()) {
      throw new Error("Enter your name to create an account.");
    }
  }

  async function submitMissingStudentClassCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      return;
    }

    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      await updateStudentClass({ classId: classId.trim(), uid: user.uid });
      if (onAuthSuccess) {
        onAuthSuccess("/student");
      } else {
        router.push("/student");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Class join failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteIncompleteStudentAccount() {
    if (!user) {
      return;
    }

    const confirmed = window.confirm("Delete this student account permanently? This cannot be undone.");

    if (!confirmed) {
      return;
    }

    setError("");
    setNotice("");
    setIsDeletingAccount(true);

    try {
      await deleteCurrentAccountFromCurrentSession({ uid: user.uid });
      router.push("/auth?mode=signup&role=student");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Account deletion failed.");
    } finally {
      setIsDeletingAccount(false);
    }
  }

  if (!firebaseReady) {
    return (
      <section className="auth-card">
        <h1>Add your Firebase web app config.</h1>
        <p>
          Create a Firebase project, enable Email/Password authentication, add Firestore, then
          place the `NEXT_PUBLIC_FIREBASE_*` values in `.env.local`.
        </p>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="auth-card">
        <h1>Checking your session.</h1>
      </section>
    );
  }

  if (linkingRequest) {
    return (
      <section className="auth-card">
        <h1>Link {linkingRequest.providerLabel}.</h1>
        <p>
          An email/password account already exists for {linkingRequest.email}. Enter that
          account password to link {linkingRequest.providerLabel} to the same Chandra account.
        </p>

        <form className="auth-form" onSubmit={submitProviderLink}>
          <label className="field-label" htmlFor="link-email">
            Existing account
          </label>
          <input id="link-email" value={linkingRequest.email} readOnly />

          <label className="field-label" htmlFor="link-password">
            Existing password
          </label>
          <input
            id="link-password"
            required
            autoComplete="current-password"
            type="password"
            value={linkingPassword}
            onChange={(event) => setLinkingPassword(event.target.value)}
            placeholder="Your existing password"
          />

          {error ? <p className="form-error">{error}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Linking" : `Link ${linkingRequest.providerLabel}`}
          </button>

          <button
            className="auth-secondary-button"
            disabled={isSubmitting}
            type="button"
            onClick={() => {
              setLinkingRequest(null);
              setLinkingPassword("");
              setError("");
            }}
          >
            Use another sign-in method
          </button>
        </form>
      </section>
    );
  }

  if (user) {
    if (!profile) {
      return (
        <section className="auth-card">
          <h1>Choose your workspace.</h1>
          <p>
            Firebase signed you in, but this account does not have a role profile yet.
          </p>
          {profileError ? <p className="form-error">{profileError}</p> : null}

          <form
            className="auth-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setError("");
              setIsSubmitting(true);

              try {
                if (role === "student" && !classId.trim()) {
                  throw new Error("Enter your class code to create a student account.");
                }

                const nextProfile = await createRoleProfile({
                  classId: role === "student" ? classId.trim() : "",
                  displayName: displayName.trim() || user.displayName || user.email || "",
                  role,
                  username: user.email ?? "",
                  user
                });
                const dest = nextProfile.role === "teacher" ? "/teacher" : "/student";
                if (onAuthSuccess) {
                  onAuthSuccess(dest);
                } else {
                  router.push(dest);
                }
              } catch (caughtError) {
                setError(caughtError instanceof Error ? caughtError.message : "Profile setup failed.");
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            <label className="field-label" htmlFor="repair-role">
              Account type
            </label>
            <select
              id="repair-role"
              value={role}
              onChange={(event) => setRole(event.target.value as AccountRole)}
            >
              <option value="student">Student</option>
              <option value="teacher">Teacher</option>
            </select>

            {role === "student" ? (
              <>
                <label className="field-label" htmlFor="repair-class-id">
                  Class code
                </label>
                <input
                  id="repair-class-id"
                  value={classId}
                  maxLength={CLASS_CODE_LENGTH}
                  onChange={(event) => setClassId(formatClassCodeInput(event.target.value))}
                  placeholder="ABCDEF"
                />
              </>
            ) : null}

            <label className="field-label" htmlFor="repair-name">
              Name
            </label>
            <input
              id="repair-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={user.displayName || "Ada Lovelace"}
            />

            {error ? <p className="form-error">{error}</p> : null}

            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Working" : "Save profile"}
            </button>
          </form>
        </section>
      );
    }

    if (profile.role === "student" && !hasStudentClassEnrollment(profile)) {
      return (
        <section className="auth-card">
          <h1>Enter class code to continue.</h1>
          <p>
            This student account is not connected to a class yet. Enter your teacher&apos;s class code
            to continue, or delete this account.
          </p>

          <form className="auth-form" onSubmit={submitMissingStudentClassCode}>
            <label className="field-label" htmlFor="missing-class-id">
              Class code
            </label>
            <input
              id="missing-class-id"
              required
              value={classId}
              maxLength={CLASS_CODE_LENGTH}
              onChange={(event) => setClassId(formatClassCodeInput(event.target.value))}
              placeholder="ABCDEF"
            />

            {error ? <p className="form-error">{error}</p> : null}
            {notice ? <p className="form-notice">{notice}</p> : null}

            <button className="primary-button" disabled={isSubmitting || isDeletingAccount} type="submit">
              {isSubmitting ? "Joining class" : "Continue"}
            </button>
            <button
              className="auth-danger-button"
              disabled={isSubmitting || isDeletingAccount}
              type="button"
              onClick={() => void deleteIncompleteStudentAccount()}
            >
              {isDeletingAccount ? "Deleting account" : "Delete account"}
            </button>
          </form>
        </section>
      );
    }

    if (savedBackupPasswordUid !== user.uid && userNeedsBackupPassword(user)) {
      return (
        <section className="auth-card">
          <h1>You have successfully signed in.</h1>
          <p>Create a backup password just in case. After this, you can sign in with Google or with your email and password.</p>

          <form className="auth-form" onSubmit={submitBackupPassword}>
            <label className="field-label" htmlFor="backup-email">
              Email
            </label>
            <input id="backup-email" value={user.email ?? profile.email} readOnly />

            <label className="field-label" htmlFor="backup-password">
              Backup password
            </label>
            <input
              id="backup-password"
              required
              minLength={6}
              autoComplete="new-password"
              type="password"
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.target.value)}
              placeholder="At least 6 characters"
            />

            <label className="field-label" htmlFor="backup-password-confirmation">
              Confirm backup password
            </label>
            <input
              id="backup-password-confirmation"
              required
              minLength={6}
              autoComplete="new-password"
              type="password"
              value={backupPasswordConfirmation}
              onChange={(event) => setBackupPasswordConfirmation(event.target.value)}
              placeholder="Repeat backup password"
            />

            {error ? <p className="form-error">{error}</p> : null}
            {notice ? <p className="form-notice">{notice}</p> : null}

            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Saving password" : "Save backup password"}
            </button>
            <button
              className="auth-secondary-button"
              disabled={isSubmitting}
              type="button"
              onClick={() => void reauthenticateGoogleForBackupPassword()}
            >
              Sign in with Google again
            </button>
          </form>
        </section>
      );
    }

    return (
      <section className="auth-card">
        <h1>{profile?.displayName ?? user.email}</h1>
        <p>You are signed in as a {profile?.role ?? "Chandra"} account.</p>
        {notice ? <p className="form-notice">{notice}</p> : null}
        <Link 
          className="primary-button" 
          href={destination}
          onClick={(e) => {
            if (onAuthSuccess) {
              e.preventDefault();
              onAuthSuccess(destination);
            }
          }}
        >
          Continue
        </Link>
      </section>
    );
  }

  function renderProviderAuthGroup({ showDivider = true }: { showDivider?: boolean } = {}) {
    return (
      <div className="auth-method-group" aria-label="Google authentication">
        {providerOptions.map((provider) => (
          <button
            className={`auth-provider-button ${provider.key}`}
            disabled={isSubmitting}
            key={provider.key}
            type="button"
            onClick={() => submitProviderSignIn(provider.key)}
          >
            <ProviderIcon provider={provider.key} />
            <span>{mode === "signup" ? "Continue" : "Sign in"} with {provider.label}</span>
          </button>
        ))}
        {showDivider ? (
          <div className="auth-divider">
            <span>{mode === "signup" ? "or create a password" : "or use email"}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="auth-card">
      <h1>
        {mode === "signup"
          ? "Create your Chandra account"
          : mode === "reset"
            ? "Reset your password"
            : "Welcome back."}
      </h1>
      {sessionError ? <p className="form-error">{sessionError}</p> : null}

      <div className="segmented-control" aria-label="Authentication mode">
        <button
          aria-pressed={mode === "signup"}
          type="button"
          onClick={() => chooseMode("signup")}
        >
          Sign up
        </button>
        <button
          aria-pressed={mode === "signin"}
          type="button"
          onClick={() => chooseMode("signin")}
        >
          Sign in
        </button>
      </div>

      {mode === "signin" ? renderProviderAuthGroup() : null}

      <form className="auth-form" onSubmit={submitAuth}>
        {mode === "signup" ? (
          <>
            <p className="auth-form-heading auth-form-heading-left">
              Account details
            </p>

            <label className="field-label" htmlFor="role">
              Account type
            </label>
            <select
              id="role"
              value={role}
              onChange={(event) => setRole(event.target.value as AccountRole)}
            >
              <option value="student">Student</option>
              <option value="teacher">Teacher</option>
            </select>

            {role === "student" ? (
              <>
                <label className="field-label" htmlFor="class-id">
                  Class code
                </label>
                <input
                  id="class-id"
                  value={classId}
                  maxLength={CLASS_CODE_LENGTH}
                  onChange={(event) => setClassId(formatClassCodeInput(event.target.value))}
                  placeholder="ABCDEF"
                />
              </>
            ) : null}

            <label className="field-label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Ada Lovelace"
            />
          </>
        ) : null}

        {mode === "signup" ? (
          <div className="auth-signup-methods">
            <p className="auth-form-heading auth-form-heading-left">
              Sign-in method
            </p>
            {renderProviderAuthGroup({ showDivider: showEmailSignup })}
            {!showEmailSignup ? (
              <button
                className="auth-secondary-button"
                disabled={isSubmitting}
                type="button"
                onClick={() => {
                  setError("");
                  setNotice("");
                  try {
                    assertSignupProfileFieldsArePresent();
                    setShowEmailSignup(true);
                  } catch (caughtError) {
                    setError(caughtError instanceof Error ? caughtError.message : "Complete the account details first.");
                  }
                }}
              >
                Use email instead
              </button>
            ) : null}
          </div>
        ) : null}

        {mode !== "reset" && (mode !== "signup" || showEmailSignup) ? (
          <p className="auth-form-heading">
            {mode === "signup" ? "Create an account with email and password" : "Sign in with email and password"}
          </p>
        ) : null}

        {mode === "signup" && showEmailSignup ? (
          <>
            <label className="field-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              required
              autoCapitalize="none"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="ada"
            />
          </>
        ) : null}

        {mode !== "signup" || showEmailSignup ? (
          <>
            <label className="field-label" htmlFor="email">
              {mode === "signin" || mode === "reset" ? "Username or email" : "Email"}
            </label>
            <input
              id="email"
              required
              autoCapitalize="none"
              autoComplete={mode === "signin" || mode === "reset" ? "username" : "email"}
              type={mode === "signin" || mode === "reset" ? "text" : "email"}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={mode === "signin" || mode === "reset" ? "ada or you@example.com" : "you@example.com"}
            />
          </>
        ) : null}

        {mode !== "reset" && (mode !== "signup" || showEmailSignup) ? (
          <>
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              required
              minLength={6}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 6 characters"
            />
          </>
        ) : null}

        {mode !== "reset" && (mode !== "signup" || showEmailSignup) ? (
          <div className="auth-magic-link-panel">
            <p>Prefer not to use a password?</p>
            <button
              className="auth-secondary-button"
              disabled={isSubmitting}
              type="button"
              onClick={submitMagicLink}
            >
              {emailLinkUrl
                ? "Complete email-link sign-in"
                : mode === "signup"
                  ? "Sign up with email link"
                  : "Sign in with email link"}
            </button>
          </div>
        ) : null}

        {mode === "signin" ? (
          <div className="auth-inline-action">
            <span>Forgot your password?</span>
            <button type="button" onClick={() => chooseMode("reset")}>
              Reset it
            </button>
          </div>
        ) : null}

        {mode === "reset" ? (
          <div className="auth-inline-action">
            <span>Know your password?</span>
            <button type="button" onClick={() => chooseMode("signin")}>
              Sign in
            </button>
          </div>
        ) : null}

        {error ? <p className="form-error">{error}</p> : null}
        {notice ? <p className="form-notice">{notice}</p> : null}

        {mode !== "signup" || showEmailSignup ? (
          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting
              ? "Working"
              : mode === "signup"
                ? "Create account"
                : mode === "reset"
                  ? "Send reset link"
                  : "Sign in"}
          </button>
        ) : null}
      </form>
    </section>
  );
}

function readPendingProfile() {
  if (typeof window === "undefined") {
    return null;
  }

  const savedProfile = window.localStorage.getItem(pendingProfileStorageKey);

  if (!savedProfile) {
    return null;
  }

  try {
    return JSON.parse(savedProfile) as PendingProfile;
  } catch {
    window.localStorage.removeItem(pendingProfileStorageKey);
    return null;
  }
}

function savePendingProfile(profile: PendingProfile) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(pendingProfileStorageKey, JSON.stringify(profile));
}

function updatePendingProfileFromProvider(user: { displayName: string | null; email: string | null }) {
  const pendingProfile = readPendingProfile();

  if (!pendingProfile) {
    return;
  }

  const providerEmail = String(user.email ?? "").trim().toLowerCase();
  const providerName = String(user.displayName ?? "").trim();

  savePendingProfile({
    ...pendingProfile,
    displayName: pendingProfile.displayName || providerName,
    email: pendingProfile.email || providerEmail || undefined,
    username: pendingProfile.username || normalizeUsernameFromProvider(providerEmail, providerName)
  });
}

function normalizeUsernameFromProvider(email: string, displayName: string) {
  if (email) {
    return email;
  }

  return displayName.trim().toLowerCase().replace(/[^a-z0-9._%+-]+/g, ".");
}

function clearPendingProfile() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(pendingProfileStorageKey);
}

function hasStudentClassEnrollment(profile: { classId?: string; classIds?: string[] }) {
  return Boolean(
    profile.classId?.trim() ||
      (Array.isArray(profile.classIds) && profile.classIds.some((classId) => classId.trim()))
  );
}

function ProviderIcon({ provider }: { provider: AuthProviderKey }) {
  return (
    <svg className="auth-provider-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21.6 12.23c0-.74-.07-1.45-.19-2.14H12v4.05h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.32 2.98-7.44Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.97-.9 6.62-2.43l-3.24-2.51c-.9.6-2.04.95-3.38.95-2.6 0-4.82-1.76-5.61-4.13H3.05v2.6A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.39 13.88A6.01 6.01 0 0 1 6.07 12c0-.65.11-1.28.32-1.88v-2.6H3.05A10 10 0 0 0 2 12c0 1.61.39 3.14 1.05 4.48l3.34-2.6Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.99c1.47 0 2.79.51 3.83 1.5l2.86-2.86C16.96 3.01 14.7 2 12 2a10 10 0 0 0-8.95 5.52l3.34 2.6C7.18 7.75 9.4 5.99 12 5.99Z"
        fill="#EA4335"
      />
    </svg>
  );
}
