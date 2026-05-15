"use client";

import Link from "next/link";
import { useAuth } from "./AuthProvider";

export function LandingActions() {
  const { firebaseReady, isLoading, profile, user } = useAuth();

  if (!firebaseReady) {
    return (
      <div className="button-row">
        <Link className="primary-button" href="/auth?mode=signup">
          Create Account
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return null;
  }

  if (!user) {
    return (
      <div className="button-row">
        <Link className="primary-button" href="/auth?mode=signup">
          Create Account
        </Link>
      </div>
    );
  }

  if (profile?.role === "student") {
    return (
      <div className="button-row">
        <Link className="primary-button" href="/student">
          Open Student Chat
        </Link>
      </div>
    );
  }

  if (profile?.role === "teacher") {
    return (
      <div className="button-row">
        <Link className="primary-button" href="/teacher">
          Open Teacher Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="button-row">
      <Link className="primary-button" href="/auth?mode=signup">
        Create Account
      </Link>
    </div>
  );
}
