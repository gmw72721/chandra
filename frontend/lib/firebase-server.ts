import { getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config";

const app = isFirebaseConfigured && !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];

export const serverDb = app ? getFirestore(app) : null;
