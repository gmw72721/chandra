import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../firebase-admin.ts";

export type PendingTeacherAssistantAction = {
  actorEmail?: string;
  actorUid: string;
  args: Record<string, unknown>;
  argsHash: string;
  classId: string;
  createdAt: string;
  expiresAt: string;
  id: string;
  summary: string;
  toolName: string;
};

const pendingActions = new Map<string, PendingTeacherAssistantAction>();
const pendingActionTtlMs = 10 * 60 * 1000;
const collectionName = "teacherAssistantPendingActions";

export async function createPendingTeacherAssistantAction(input: {
  actorEmail?: string;
  actorUid: string;
  args: Record<string, unknown>;
  classId: string;
  summary: string;
  toolName: string;
}) {
  const now = new Date();
  const record: PendingTeacherAssistantAction = {
    actorEmail: input.actorEmail,
    actorUid: input.actorUid,
    args: input.args,
    argsHash: hashAssistantActionArgs(input.args),
    classId: input.classId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + pendingActionTtlMs).toISOString(),
    id: randomUUID(),
    summary: input.summary,
    toolName: input.toolName
  };

  if (adminDb) {
    await adminDb.collection(collectionName).doc(record.id).set({
      ...record,
      createdAt: FieldValue.serverTimestamp()
    });
  } else {
    pendingActions.set(record.id, record);
  }

  return record;
}

export async function readPendingTeacherAssistantAction(id: string) {
  const pendingActionId = id.trim();

  if (!pendingActionId) {
    return null;
  }

  if (adminDb) {
    const snapshot = await adminDb.collection(collectionName).doc(pendingActionId).get();
    if (!snapshot.exists) {
      return null;
    }

    return snapshot.data() as PendingTeacherAssistantAction;
  }

  return pendingActions.get(pendingActionId) ?? null;
}

export async function consumePendingTeacherAssistantAction(id: string) {
  const pendingActionId = id.trim();

  if (!pendingActionId) {
    return;
  }

  if (adminDb) {
    await adminDb.collection(collectionName).doc(pendingActionId).delete().catch(() => undefined);
    return;
  }

  pendingActions.delete(pendingActionId);
}

export function assertPendingTeacherAssistantActionMatches(input: {
  actorUid: string;
  args: Record<string, unknown>;
  classId: string;
  pendingAction: PendingTeacherAssistantAction;
  toolName: string;
}) {
  if (Date.parse(input.pendingAction.expiresAt) <= Date.now()) {
    throw new Error("This assistant confirmation expired. Ask Chandra to prepare the change again.");
  }

  if (input.pendingAction.actorUid !== input.actorUid) {
    throw new Error("This assistant confirmation belongs to a different teacher session.");
  }

  if (input.pendingAction.classId !== input.classId) {
    throw new Error("This assistant confirmation belongs to a different class.");
  }

  if (input.pendingAction.toolName !== input.toolName) {
    throw new Error("This assistant confirmation does not match the requested tool.");
  }

  if (input.pendingAction.argsHash !== hashAssistantActionArgs(input.args)) {
    throw new Error("This assistant confirmation no longer matches the requested change.");
  }
}

export function hashAssistantActionArgs(args: Record<string, unknown>) {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

export function __clearPendingTeacherAssistantActionsForTests() {
  pendingActions.clear();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
    .join(",")}}`;
}
