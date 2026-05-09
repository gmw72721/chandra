"use client";

import { User } from "firebase/auth";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { startUserPresenceHeartbeat, subscribeToAuth, subscribeToUserProfile, type UserProfile } from "@/lib/auth";
import { isFirebaseConfigured } from "@/lib/firebase";

type AuthState = {
  firebaseReady: boolean;
  isLoading: boolean;
  profileError: string;
  sessionError: string;
  user: User | null;
  profile: UserProfile | null;
};

const AuthContext = createContext<AuthState>({
  firebaseReady: false,
  isLoading: true,
  profileError: "",
  sessionError: "",
  user: null,
  profile: null
});

const authCheckTimeoutMs = 10000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [isLoading, setIsLoading] = useState(isFirebaseConfigured);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      return () => {};
    }

    let authResolved = false;
    let profileTimerId: number | undefined;
    let unsubscribeProfile = () => {};
    const authTimerId = window.setTimeout(() => {
      if (authResolved) {
        return;
      }

      setSessionError("Session check timed out. Refresh the page or sign in again.");
      setIsLoading(false);
    }, authCheckTimeoutMs);

    const clearProfileTimer = () => {
      if (profileTimerId) {
        window.clearTimeout(profileTimerId);
        profileTimerId = undefined;
      }
    };

    const unsubscribeAuth = subscribeToAuth(
      (nextUser) => {
        authResolved = true;
        window.clearTimeout(authTimerId);
        clearProfileTimer();
        unsubscribeProfile();
        setUser(nextUser);
        setProfileError("");
        setSessionError("");

        if (!nextUser) {
          setProfile(null);
          setIsLoading(false);
          return;
        }

        setIsLoading(true);
        profileTimerId = window.setTimeout(() => {
          setProfileError("Profile check timed out. Refresh the page or sign in again.");
          setIsLoading(false);
        }, authCheckTimeoutMs);

        unsubscribeProfile = subscribeToUserProfile(
          nextUser.uid,
          (nextProfile) => {
            clearProfileTimer();
            setProfile(nextProfile);
            setIsLoading(false);
          },
          (error) => {
            clearProfileTimer();
            setProfile(null);
            setProfileError(error.message);
            setIsLoading(false);
          }
        );
      },
      (error) => {
        authResolved = true;
        window.clearTimeout(authTimerId);
        clearProfileTimer();
        unsubscribeProfile();
        setUser(null);
        setProfile(null);
        setSessionError(error.message);
        setIsLoading(false);
      }
    );

    return () => {
      window.clearTimeout(authTimerId);
      clearProfileTimer();
      unsubscribeProfile();
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    if (!user || !profile) {
      return () => {};
    }

    return startUserPresenceHeartbeat(user, profile);
  }, [profile, user]);

  const value = useMemo(
    () => ({
      firebaseReady: isFirebaseConfigured,
      isLoading,
      profileError,
      sessionError,
      user,
      profile
    }),
    [isLoading, profile, profileError, sessionError, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
