"use client";

import { User } from "firebase/auth";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { startUserPresenceHeartbeat, subscribeToAuth, subscribeToUserProfile, type UserProfile } from "@/lib/auth";
import { isFirebaseConfigured } from "@/lib/firebase";

type AuthState = {
  firebaseReady: boolean;
  isLoading: boolean;
  profileError: string;
  user: User | null;
  profile: UserProfile | null;
};

const AuthContext = createContext<AuthState>({
  firebaseReady: false,
  isLoading: true,
  profileError: "",
  user: null,
  profile: null
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [isLoading, setIsLoading] = useState(isFirebaseConfigured);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      return () => {};
    }

    let unsubscribeProfile = () => {};

    const unsubscribeAuth = subscribeToAuth((nextUser) => {
      unsubscribeProfile();
      setUser(nextUser);
      setProfileError("");

      if (!nextUser) {
        setProfile(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      unsubscribeProfile = subscribeToUserProfile(
        nextUser.uid,
        (nextProfile) => {
          setProfile(nextProfile);
          setIsLoading(false);
        },
        (error) => {
          setProfile(null);
          setProfileError(error.message);
          setIsLoading(false);
        }
      );
    });

    return () => {
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
      user,
      profile
    }),
    [isLoading, profile, profileError, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
