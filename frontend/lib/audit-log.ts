import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

export type AuditLogEvent = {
  actor?: {
    email?: string | null;
    uid?: string | null;
  };
  eventType: string;
  metadata?: Record<string, unknown>;
  route?: string;
  target?: Record<string, unknown>;
};

export async function writeAuditLog({
  actor,
  eventType,
  metadata = {},
  route = "",
  target = {}
}: AuditLogEvent) {
  if (!adminDb) {
    return;
  }

  try {
    await adminDb.collection("auditLogs").add({
      actorEmail: normalizeEmail(actor?.email),
      actorUid: String(actor?.uid ?? "").trim(),
      eventType,
      metadata,
      route,
      target,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (caughtError) {
    console.error("Audit log write failed.", caughtError);
  }
}

export async function writeSecurityLog({
  eventType,
  metadata = {},
  route = ""
}: {
  eventType: string;
  metadata?: Record<string, unknown>;
  route?: string;
}) {
  if (!adminDb) {
    return;
  }

  try {
    await adminDb.collection("securityEvents").add({
      eventType,
      metadata,
      route,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (caughtError) {
    console.error("Security log write failed.", caughtError);
  }
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
