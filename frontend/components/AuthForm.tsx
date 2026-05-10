"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createRoleProfile,
  signInWithEmail,
  signUpWithRole,
  type AccountRole
} from "@/lib/auth";
import { CLASS_CODE_LENGTH, formatClassCodeInput } from "@/lib/class-code";
import { useAuth } from "./AuthProvider";

type AuthMode = "signin" | "signup";

const pendingProfileStorageKey = "chandra.pendingProfile";

type PendingProfile = {
  classId?: string;
  displayName: string;
  email: string;
  role: AccountRole;
  teacherInviteToken?: string;
  username?: string;
};

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teacherInviteToken = searchParams.get("teacherInvite")?.trim() ?? "";
  const canCreateTeacher = Boolean(teacherInviteToken);
  const requestedRole = searchParams.get("role") === "teacher" && canCreateTeacher ? "teacher" : "student";
  const requestedClassId = formatClassCodeInput(searchParams.get("classId") ?? "");
  const [mode, setMode] = useState<AuthMode>("signup");
  const [role, setRole] = useState<AccountRole>(requestedRole);
  const [classId, setClassId] = useState(requestedClassId);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isRepairingProfileRef = useRef(false);
  const { firebaseReady, isLoading, profile, profileError, sessionError, user } = useAuth();

  const destination = useMemo(
    () => (profile?.role === "teacher" ? "/teacher" : "/student"),
    [profile?.role]
  );

  useEffect(() => {
    if (!user || profile || isLoading || isRepairingProfileRef.current) {
      return;
    }

    const pendingProfile = readPendingProfile();

    if (!pendingProfile || pendingProfile.email !== user.email) {
      return;
    }

    isRepairingProfileRef.current = true;
    createRoleProfile({
      classId: pendingProfile.classId,
      displayName: pendingProfile.displayName,
      role: pendingProfile.role,
      teacherInviteToken: teacherInviteToken || pendingProfile.teacherInviteToken,
      username: pendingProfile.username || pendingProfile.email,
      user
    })
      .then((nextProfile) => {
        window.localStorage.removeItem(pendingProfileStorageKey);
        router.push(nextProfile.role === "teacher" ? "/teacher" : "/student");
      })
      .catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : "Profile setup failed.");
      })
      .finally(() => {
        isRepairingProfileRef.current = false;
      });
  }, [isLoading, profile, router, teacherInviteToken, user]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      if (mode === "signup") {
        savePendingProfile({
          classId: role === "student" ? classId.trim() : "",
          displayName: displayName.trim(),
          email: email.trim().toLowerCase(),
          role,
          teacherInviteToken: role === "teacher" ? teacherInviteToken : "",
          username: username.trim().toLowerCase()
        });
        await signUpWithRole({
          displayName: displayName.trim(),
          email: email.trim(),
          password,
          role,
          classId: role === "student" ? classId.trim() : "",
          teacherInviteToken: role === "teacher" ? teacherInviteToken : "",
          username: username.trim()
        });
        window.localStorage.removeItem(pendingProfileStorageKey);
        router.push(role === "teacher" ? "/teacher" : "/student");
      } else {
        await signInWithEmail(email.trim(), password);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Authentication failed.");
    } finally {
      setIsSubmitting(false);
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
                const nextProfile = await createRoleProfile({
                  classId: role === "student" ? classId.trim() : "",
                  displayName: displayName.trim() || user.displayName || user.email || "",
                  role,
                  teacherInviteToken: role === "teacher" ? teacherInviteToken : "",
                  username: user.email ?? "",
                  user
                });
                window.localStorage.removeItem(pendingProfileStorageKey);
                router.push(nextProfile.role === "teacher" ? "/teacher" : "/student");
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
              {canCreateTeacher ? <option value="teacher">Teacher</option> : null}
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

    return (
      <section className="auth-card">
        <h1>{profile?.displayName ?? user.email}</h1>
        <p>You are signed in as a {profile?.role ?? "Chandra"} account.</p>
        <Link className="primary-button" href={destination}>
          Continue
        </Link>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <h1>{mode === "signup" ? "Create your Chandra account" : "Welcome back."}</h1>
      {sessionError ? <p className="form-error">{sessionError}</p> : null}

      <div className="segmented-control" aria-label="Authentication mode">
        <button
          aria-pressed={mode === "signup"}
          type="button"
          onClick={() => setMode("signup")}
        >
          Sign up
        </button>
        <button
          aria-pressed={mode === "signin"}
          type="button"
          onClick={() => setMode("signin")}
        >
          Sign in
        </button>
      </div>

      <form className="auth-form" onSubmit={submitAuth}>
        {mode === "signup" ? (
          <>
            <label className="field-label" htmlFor="role">
              Account type
            </label>
            <select
              id="role"
              value={role}
              onChange={(event) => setRole(event.target.value as AccountRole)}
            >
              <option value="student">Student</option>
              {canCreateTeacher ? <option value="teacher">Teacher</option> : null}
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

        <label className="field-label" htmlFor="email">
          {mode === "signin" ? "Username or email" : "Email"}
        </label>
        <input
          id="email"
          required
          autoCapitalize="none"
          autoComplete={mode === "signin" ? "username" : "email"}
          type={mode === "signin" ? "text" : "email"}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={mode === "signin" ? "ada or you@example.com" : "you@example.com"}
        />

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

        {error ? <p className="form-error">{error}</p> : null}

        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Working" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
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
