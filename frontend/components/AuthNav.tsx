"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOutCurrentUser } from "@/lib/auth";
import { useAuth } from "./AuthProvider";

type AuthNavProps = {
  showCreateAccount?: boolean;
};

export function AuthNav({ showCreateAccount = false }: AuthNavProps) {
  const router = useRouter();
  const { firebaseReady, isLoading, profile, user } = useAuth();

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth?mode=signin");
  }

  if (!firebaseReady) {
    return (
      <div className="nav-actions">
        <Link href="/auth?mode=signup">Set up auth</Link>
      </div>
    );
  }

  if (isLoading) {
    return <div className="nav-actions muted-nav">Loading</div>;
  }

  if (!user) {
    return (
      <div className="nav-actions">
        <Link href="/auth?mode=signin">Sign in</Link>
        {showCreateAccount ? <Link href="/auth?mode=signup">Create account</Link> : null}
      </div>
    );
  }

  return (
    <div className="nav-actions">
      <span className="account-pill">{profile?.displayName ?? user.email}</span>
      <button className="nav-button" type="button" onClick={handleSignOut}>
        Sign out
      </button>
    </div>
  );
}
