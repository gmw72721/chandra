"use client";

import { getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getAuth,
  initializeAuth
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config";
export { isFirebaseConfigured };

const app =
  isFirebaseConfigured && typeof window !== "undefined"
    ? !getApps().length
      ? initializeApp(firebaseConfig)
      : getApps()[0]
    : null;

function getClientAuth() {
  if (!app || typeof window === "undefined") {
    return null;
  }

  try {
    return initializeAuth(app, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: browserPopupRedirectResolver
    });
  } catch {
    return getAuth(app);
  }
}

export const auth = getClientAuth();
export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;
