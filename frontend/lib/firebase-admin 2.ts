import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { firebaseConfig } from "./firebase-config";

function getServiceAccountCredential() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as {
      clientEmail?: string;
      privateKey?: string;
      projectId?: string;
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };

    return cert({
      clientEmail: serviceAccount.clientEmail ?? serviceAccount.client_email,
      privateKey: (serviceAccount.privateKey ?? serviceAccount.private_key)?.replace(/\\n/g, "\n"),
      projectId: serviceAccount.projectId ?? serviceAccount.project_id
    });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID ?? firebaseConfig.projectId;

  if (clientEmail && privateKey && projectId) {
    return cert({
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
      projectId
    });
  }

  return undefined;
}

function initializeAdminApp(): App | null {
  if (getApps().length) {
    return getApps()[0] ?? null;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID ?? firebaseConfig.projectId;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET ?? firebaseConfig.storageBucket;
  const credential = getServiceAccountCredential();

  if (!projectId || !storageBucket) {
    return null;
  }

  return initializeApp({
    ...(credential ? { credential } : {}),
    projectId,
    storageBucket
  });
}

export const adminApp = initializeAdminApp();
export const adminAuth = adminApp ? getAuth(adminApp) : null;
export const adminDb = adminApp ? getFirestore(adminApp) : null;
export const adminStorage = adminApp ? getStorage(adminApp) : null;

export function assertFirebaseAdminReady() {
  if (!adminApp || !adminAuth || !adminDb || !adminStorage) {
    throw new Error(
      "Firebase Admin is not configured. Add service account env vars and a Firebase Storage bucket."
    );
  }
}

export function assertFirebaseAdminAuthReady() {
  if (!adminApp || !adminAuth || !adminDb) {
    throw new Error("Firebase Admin is not configured. Add service account env vars.");
  }
}
