import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import {
  writeAuditLogPostgres,
  writeChatErrorReferencePostgres,
  writeSecurityEventPostgres
} from "./data/operational";
import { isPostgresConfigured, shouldFallbackToFirestoreWhenPostgresFails } from "./data/postgres";

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
  if (isPostgresConfigured()) {
    try {
      await writeAuditLogPostgres({
        actorId: String(actor?.uid ?? "").trim(),
        eventType,
        metadata: {
          actorEmail: normalizeEmail(actor?.email),
          ...metadata
        },
        resourceId: normalizeDocumentId(target.id ?? target.resourceId ?? target.inviteId),
        resourceType: String(target.type ?? target.resourceType ?? "").trim(),
        route
      });
      return;
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.error("Postgres audit log write failed; using Firestore fallback.", caughtError);
    }
  }

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
  if (isPostgresConfigured()) {
    try {
      await writeSecurityEventPostgres({
        eventType,
        metadata,
        route,
        severity: severityFromSecurityEvent(eventType)
      });
      return;
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.error("Postgres security log write failed; using Firestore fallback.", caughtError);
    }
  }

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

export async function writeChatErrorReference({
  backendDetail,
  backendStatus,
  classId,
  code,
  conversationId,
  errorId,
  message,
  phase = "",
  provider,
  providerErrorClass,
  providerStatus,
  requestId = "",
  route = "",
  userId = "",
  userRole = ""
}: {
  backendDetail?: string;
  backendStatus?: number;
  classId?: string;
  code: string;
  conversationId?: string;
  errorId: string;
  message?: string;
  phase?: string;
  provider?: string;
  providerErrorClass?: string;
  providerStatus?: number;
  requestId?: string;
  route?: string;
  userId?: string;
  userRole?: string;
}) {
  if (isPostgresConfigured()) {
    try {
      await writeChatErrorReferencePostgres({
        classId: normalizeDocumentId(classId),
        conversationId: normalizeDocumentId(conversationId),
        errorCode: String(code).trim(),
        errorMessage: truncateLogText(message, 2000),
        id: normalizeReferenceId(errorId),
        metadata: {
          backendDetail: truncateLogText(backendDetail, 4000),
          backendStatus: normalizeNumber(backendStatus),
          phase: String(phase).trim(),
          providerErrorClass: String(providerErrorClass ?? "").trim(),
          providerStatus: normalizeNumber(providerStatus),
          requestId: String(requestId).trim(),
          route: String(route).trim(),
          userId: normalizeDocumentId(userId),
          userRole: String(userRole ?? "").trim()
        },
        provider: String(provider ?? "").trim()
      });
      return;
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.error("Postgres chat error reference write failed; using Firestore fallback.", caughtError);
    }
  }

  if (!adminDb) {
    return;
  }

  try {
    await adminDb.collection("chatErrorReferences").doc(normalizeReferenceId(errorId)).set({
      backendDetail: truncateLogText(backendDetail, 4000),
      backendStatus: normalizeNumber(backendStatus),
      classId: normalizeDocumentId(classId),
      code: String(code).trim(),
      conversationId: normalizeDocumentId(conversationId),
      errorId: normalizeReferenceId(errorId),
      message: truncateLogText(message, 2000),
      phase: String(phase).trim(),
      provider: String(provider ?? "").trim(),
      providerErrorClass: String(providerErrorClass ?? "").trim(),
      providerStatus: normalizeNumber(providerStatus),
      requestId: String(requestId).trim(),
      route: String(route).trim(),
      timestamp: FieldValue.serverTimestamp(),
      userId: normalizeDocumentId(userId),
      userRole: String(userRole ?? "").trim()
    });
  } catch (caughtError) {
    console.error("Chat error reference write failed.", caughtError);
  }
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDocumentId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function normalizeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function normalizeReferenceId(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase().slice(0, 32) : "";
}

function truncateLogText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function severityFromSecurityEvent(eventType: string) {
  return eventType.includes("lockout") || eventType.includes("rate_limited")
    ? "warning" as const
    : "info" as const;
}
