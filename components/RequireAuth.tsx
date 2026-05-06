"use client";

import Link from "next/link";
import { type AccountRole } from "@/lib/auth";
import { useAuth } from "./AuthProvider";

export function RequireAuth({
  children,
  role
}: {
  children: React.ReactNode;
  role?: AccountRole | AccountRole[];
}) {
  const { firebaseReady, isLoading, profile, profileError, user } = useAuth();
  const allowedRoles = Array.isArray(role) ? role : role ? [role] : [];

  if (!firebaseReady) {
    return (
      <section className="auth-state-panel">
        <p className="eyebrow">Firebase setup</p>
        <h1>Connect Firebase to enable accounts.</h1>
        <p>Add the `NEXT_PUBLIC_FIREBASE_*` values to `.env.local`, then restart the dev server.</p>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="auth-state-panel">
        <p className="eyebrow">Loading</p>
        <h1>Checking your account.</h1>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="auth-state-panel">
        <p className="eyebrow">Sign in required</p>
        <h1>Create an account or sign in to continue.</h1>
        <Link className="primary-button" href={`/auth?role=${allowedRoles[0] ?? "student"}`}>
          Go to sign in
        </Link>
      </section>
    );
  }

  if (allowedRoles.length) {
    if (!profile) {
      return (
        <section className="auth-state-panel">
          <p className="eyebrow">Profile missing</p>
          <h1>This account needs a role profile.</h1>
          <p>Sign out and create a student or teacher account to continue.</p>
          {profileError ? <p className="form-error">{profileError}</p> : null}
        </section>
      );
    }

    if (!allowedRoles.includes(profile.role)) {
      return (
        <section className="auth-state-panel">
          <p className="eyebrow">Wrong workspace</p>
          <h1>This page is for {allowedRoles.join(" or ")}s.</h1>
          <p>Your account is currently set up as a {profile.role}.</p>
        </section>
      );
    }
  }

  return <>{children}</>;
}
