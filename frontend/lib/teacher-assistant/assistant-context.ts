import { randomUUID } from "node:crypto";
import type { ClassAccessPermission } from "../class-settings.ts";
import { TutorKnowledgeHttpError } from "../tutor-knowledge-errors.ts";
import { permissionForTool } from "./tool-registry.ts";

export type TeacherAssistantContext = {
  actorEmail?: string;
  actorUid: string;
  allowedToolNames: string[];
  classId: string;
  createdAt: number;
  expiresAt: number;
  id: string;
  sessionId: string;
};

type ClassSnapshotShape = {
  data: Record<string, unknown>;
  exists: boolean;
  id: string;
};

type MintAssistantContextInput = {
  actorEmail?: string;
  actorUid: string;
  allowedToolNames: string[];
  classId: string;
  now?: number;
  sessionId: string;
  ttlMs?: number;
};

const defaultContextTtlMs = 5 * 60 * 1000;
const contexts = new Map<string, TeacherAssistantContext>();
let classSnapshotLoader: ((classId: string) => Promise<ClassSnapshotShape>) | null = null;

export function mintTeacherAssistantContext(input: MintAssistantContextInput) {
  const now = input.now ?? Date.now();
  const context: TeacherAssistantContext = {
    actorEmail: input.actorEmail,
    actorUid: input.actorUid,
    allowedToolNames: [...new Set(input.allowedToolNames)].sort(),
    classId: input.classId,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? defaultContextTtlMs),
    id: randomUUID(),
    sessionId: input.sessionId
  };

  contexts.set(context.id, context);
  pruneExpiredTeacherAssistantContexts(now);
  return context;
}

export function resolveTeacherAssistantContext(id: string, now = Date.now()) {
  const context = contexts.get(id);

  if (!context || context.expiresAt <= now) {
    if (context) {
      contexts.delete(id);
    }
    return null;
  }

  return context;
}

export async function resolveTeacherAssistantContextForTool(input: {
  assistantContextId: string;
  now?: number;
  toolName: string;
}) {
  const context = resolveTeacherAssistantContext(input.assistantContextId, input.now);

  if (!context) {
    throw new TutorKnowledgeHttpError("Assistant context is missing or expired.", 401);
  }

  if (!context.allowedToolNames.includes(input.toolName)) {
    throw new TutorKnowledgeHttpError("Assistant tool is not allowed for this turn.", 403);
  }

  const permission = permissionForTool(input.toolName);
  const snapshot = await loadClassSnapshot(context.classId);

  if (!snapshot.exists) {
    throw new TutorKnowledgeHttpError("Class not found.", 404);
  }

  const access = readStoredActorClassAccess(snapshot.data, context.actorUid);

  if (!access[permission]) {
    throw new TutorKnowledgeHttpError("You do not have permission to use this class feature.", 403);
  }

  return {
    actor: {
      classData: snapshot.data,
      email: context.actorEmail,
      uid: context.actorUid
    },
    classId: context.classId,
    context
  };
}

export function pruneExpiredTeacherAssistantContexts(now = Date.now()) {
  for (const [id, context] of contexts) {
    if (context.expiresAt <= now) {
      contexts.delete(id);
    }
  }
}

function readStoredActorClassAccess(classData: Record<string, unknown>, uid: string) {
  if (classData.teacherId === uid) {
    return fullClassAccessPermissions();
  }

  const coTeacher = readCoTeacher(classData.coTeachers, uid);
  const role = normalizeClassAccessRoleValue(coTeacher?.role);

  if (!coTeacher || role === "owner") {
    return emptyClassAccessPermissions();
  }

  return normalizeClassAccessPermissionsValue(coTeacher.permissions ?? coTeacher, role);
}

function readCoTeacher(coTeachers: unknown, uid: string): Record<string, unknown> | null {
  if (!coTeachers || typeof coTeachers !== "object" || Array.isArray(coTeachers)) {
    return null;
  }

  const coTeacher = (coTeachers as Record<string, unknown>)[uid];

  if (!coTeacher || typeof coTeacher !== "object" || Array.isArray(coTeacher)) {
    return null;
  }

  return coTeacher as Record<string, unknown>;
}

function normalizeClassAccessRoleValue(value: unknown) {
  return value === "owner" || value === "co-teacher" || value === "viewer" || value === "ta" ? value : "viewer";
}

function normalizeClassAccessPermissionsValue(value: unknown, role: string) {
  if (role === "owner" || role === "co-teacher") {
    return fullClassAccessPermissions();
  }

  if (role === "viewer") {
    return readOnlyClassAccessPermissions();
  }

  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const defaults = readOnlyClassAccessPermissions();

  return Object.fromEntries(
    classAccessPermissionKeys.map((permission) => [permission, typeof source[permission] === "boolean" ? source[permission] : defaults[permission]])
  ) as Record<ClassAccessPermission, boolean>;
}

function emptyClassAccessPermissions() {
  return Object.fromEntries(classAccessPermissionKeys.map((permission) => [permission, false])) as Record<
    ClassAccessPermission,
    boolean
  >;
}

function fullClassAccessPermissions() {
  return Object.fromEntries(classAccessPermissionKeys.map((permission) => [permission, true])) as Record<
    ClassAccessPermission,
    boolean
  >;
}

function readOnlyClassAccessPermissions() {
  return {
    ...emptyClassAccessPermissions(),
    viewConversations: true,
    viewMaterials: true,
    viewOverview: true,
    viewRoster: true
  };
}

const classAccessPermissionKeys = [
  "viewOverview",
  "viewRoster",
  "manageRoster",
  "viewConversations",
  "reviewConversations",
  "viewMaterials",
  "manageMaterials",
  "manageStudentSupport",
  "manageLearningProfiles",
  "manageClassSettings",
  "manageClassAccess",
  "exportStudentData",
  "deleteStudentData",
  "teacherPreviewChat"
] as const satisfies readonly ClassAccessPermission[];

async function loadClassSnapshot(classId: string) {
  if (classSnapshotLoader) {
    return classSnapshotLoader(classId);
  }

  const { getClassSnapshotPostgresFirst } = await import("../data/server.ts");
  return getClassSnapshotPostgresFirst(classId);
}

export function __clearTeacherAssistantContextsForTests() {
  contexts.clear();
  classSnapshotLoader = null;
}

export function __setTeacherAssistantClassSnapshotLoaderForTests(
  loader: ((classId: string) => Promise<ClassSnapshotShape>) | null
) {
  classSnapshotLoader = loader;
}
