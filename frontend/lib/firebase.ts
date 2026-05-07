"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config";
export { isFirebaseConfigured };

const app = isFirebaseConfigured && !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
