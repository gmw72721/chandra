import { FieldValue } from "firebase-admin/firestore";
import {
  accountToProfile,
  firestoreProfileToUpsertAccountInput,
  getAccountByEmail,
  getAccountById,
  getAccountByLoginIdentifier,
  getAccountByUsername,
  upsertAccount,
  type AccountProfileShape,
  type UpsertAccountInput
} from "./accounts.ts";
import {
  enrollStudentInClass,
  getClassById,
  listClassEnrollments,
  listCoTeachers,
  listStudentEnrollmentClassIds,
  resolveClassIdByCode,
  upsertClass,
  type ClassRecord,
  type UpsertClassInput
} from "./classes.ts";
import { isPostgresConfigured, shouldFallbackToFirestoreWhenPostgresFails } from "./postgres.ts";
import { adminDb } from "../firebase-admin.ts";

const postgresUnavailableRetryMs = 10_000;
let postgresUnavailableUntil = 0;
const postgresFallbackLogTimestamps = new Map<string, number>();

export type ClassDataSnapshot = {
  data: Record<string, unknown>;
  exists: boolean;
  id: string;
  source: "postgres" | "firestore" | "missing";
};

export async function tryPostgresData<Result>(
  label: string,
  callback: () => Promise<Result>
): Promise<Result | null> {
  if (!isPostgresConfigured()) {
    return null;
  }

  if (Date.now() < postgresUnavailableUntil) {
    return null;
  }

  try {
    return await callback();
  } catch (caughtError) {
    if (!shouldFallbackToFirestoreWhenPostgresFails()) {
      throw caughtError;
    }

    if (isPostgresConnectionUnavailable(caughtError)) {
      postgresUnavailableUntil = Date.now() + postgresUnavailableRetryMs;
    }
    logPostgresFallback(label, caughtError);
    return null;
  }
}

function logPostgresFallback(label: string, caughtError: unknown) {
  const now = Date.now();
  const logKey = `${label}:${postgresFallbackErrorCode(caughtError)}`;
  const previousLogAt = postgresFallbackLogTimestamps.get(logKey) ?? 0;

  if (now - previousLogAt < postgresUnavailableRetryMs) {
    return;
  }

  postgresFallbackLogTimestamps.set(logKey, now);
  console.warn(
    `${label} Postgres path failed; using Firestore fallback. ${postgresFallbackErrorSummary(caughtError)}`
  );
}

function postgresFallbackErrorSummary(caughtError: unknown) {
  if (!caughtError || typeof caughtError !== "object") {
    return String(caughtError);
  }

  const error = caughtError as {
    address?: unknown;
    code?: unknown;
    message?: unknown;
    port?: unknown;
    syscall?: unknown;
  };
  const code = typeof error.code === "string" ? error.code : "UNKNOWN";
  const syscall = typeof error.syscall === "string" ? error.syscall : "";
  const address = typeof error.address === "string" ? error.address : "";
  const port = typeof error.port === "number" || typeof error.port === "string" ? String(error.port) : "";
  const location = address && port ? ` ${address}:${port}` : "";
  const detail = typeof error.message === "string" && !location ? ` ${error.message}` : "";

  return `(${[code, syscall].filter(Boolean).join(" ")}${location}${detail})`;
}

function postgresFallbackErrorCode(caughtError: unknown) {
  if (!caughtError || typeof caughtError !== "object") {
    return "unknown";
  }

  return String((caughtError as { code?: unknown }).code ?? "unknown");
}

function isPostgresConnectionUnavailable(caughtError: unknown) {
  if (!caughtError || typeof caughtError !== "object") {
    return false;
  }

  const code = (caughtError as { code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH";
}

export async function getAccountProfile(uid: string): Promise<AccountProfileShape | null> {
  const postgresProfile = await tryPostgresData("account.profile.read", async () => {
    const account = await getAccountById(uid);
    return account ? accountToProfile(account) : null;
  });

  if (postgresProfile) {
    return postgresProfile;
  }

  const snapshot = await adminDb!.collection("users").doc(uid).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() ?? {};
  const backfillInput = firestoreProfileToUpsertAccountInput(uid, data);

  if (backfillInput) {
    void tryPostgresData("account.profile.backfill", () => upsertAccount(backfillInput));
  }

  return firestoreProfileToShape(uid, data);
}

export async function upsertAccountProfile(
  input: UpsertAccountInput,
  options: { mirrorFirestore?: boolean } = {}
) {
  const postgresProfile = await tryPostgresData("account.profile.write", async () => {
    const account = await upsertAccount(input);
    return accountToProfile(account);
  });

  const profile = postgresProfile ?? accountToProfile({
    id: input.id,
    firebaseUid: input.firebaseUid ?? input.id,
    email: input.email,
    displayName: input.displayName ?? input.email,
    username: input.username ?? input.email,
    role: input.role,
    status: input.status ?? "active",
    legacyClassId: input.legacyClassId ?? null,
    legacyClassIds: input.legacyClassIds ?? [],
    profile: input.profile ?? {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null
  });

  if (options.mirrorFirestore !== false && profile) {
    await adminDb!.collection("users").doc(input.id).set(
      {
        ...profile,
        createdAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  return profile;
}

export async function assertAccountUsernameAvailable(username: string, uid: string) {
  if (username.includes("@")) {
    return;
  }

  const postgresOwner = await tryPostgresData("account.username.lookup", async () => getAccountByUsername(username));

  if (postgresOwner && postgresOwner.id !== uid) {
    return false;
  }

  const usernameSnapshot = await adminDb!
    .collection("users")
    .where("username", "==", username)
    .limit(1)
    .get();
  const usernameOwner = usernameSnapshot.docs[0];

  return !usernameOwner || usernameOwner.id === uid;
}

export async function resolveLoginEmailPostgresFirst(identifier: string) {
  const postgresAccount = await tryPostgresData("account.login.resolve", async () =>
    getAccountByLoginIdentifier(identifier)
  );
  const postgresEmail = postgresAccount?.email.trim().toLowerCase() ?? "";

  if (postgresEmail) {
    return postgresEmail;
  }

  return "";
}

export async function getClassSnapshotPostgresFirst(classId: string): Promise<ClassDataSnapshot> {
  const postgresClass = await tryPostgresData("class.read", async () => {
    const record = await getClassById(classId);

    if (!record) {
      return null;
    }

    const coTeachers = await listCoTeachers(classId);
    return classRecordToData(record, coTeachers);
  });

  if (postgresClass) {
    return {
      data: postgresClass,
      exists: true,
      id: classId,
      source: "postgres"
    };
  }

  const snapshot = await adminDb!.collection("classes").doc(classId).get();

  if (!snapshot.exists) {
    return { data: {}, exists: false, id: classId, source: "missing" };
  }

  return {
    data: snapshot.data() ?? {},
    exists: true,
    id: snapshot.id,
    source: "firestore"
  };
}

export async function resolveClassCodePostgresFirst(classCode: string) {
  const postgresClassId = await tryPostgresData("class.code.resolve", async () => resolveClassIdByCode(classCode));

  if (postgresClassId) {
    return postgresClassId;
  }

  const directClassSnapshot = await adminDb!.collection("classes").doc(classCode).get();

  if (directClassSnapshot.exists) {
    return directClassSnapshot.id;
  }

  const joinCodeSnapshot = await adminDb!
    .collection("classes")
    .where("joinCode", "==", classCode)
    .limit(1)
    .get();

  return joinCodeSnapshot.docs[0]?.id ?? "";
}

export async function upsertClassPostgresFirst(input: UpsertClassInput, firestoreData: Record<string, unknown>) {
  await tryPostgresData("class.write", () => upsertClass(input));
  await adminDb!.collection("classes").doc(input.id).set(firestoreData, { merge: true });
}

export async function enrollStudentPostgresFirst(input: {
  classId: string;
  displayName: string;
  studentEmail: string;
  studentId?: string | null;
}) {
  await tryPostgresData("class.enrollment.write", () => enrollStudentInClass(input));
}

export async function listClassEnrollmentsPostgresFirst(classId: string) {
  const postgresEnrollments = await tryPostgresData("class.enrollment.read", () => listClassEnrollments(classId));

  if (postgresEnrollments?.length) {
    return postgresEnrollments.map((enrollment) => ({
      id: encodeURIComponent(enrollment.studentEmail || enrollment.studentId || String(enrollment.id)),
      chatBlocked: enrollment.chatBlocked,
      displayName: enrollment.displayName,
      email: enrollment.studentEmail,
      uid: enrollment.studentId ?? ""
    }));
  }

  const rosterSnapshot = await adminDb!.collection("classes").doc(classId).collection("students").get();
  return rosterSnapshot.docs.map((studentDoc) => ({ id: studentDoc.id, ...studentDoc.data() }));
}

export async function listStudentClassIdsPostgresFirst({
  email,
  studentId
}: {
  email?: string;
  studentId?: string;
}) {
  const postgresClassIds = await tryPostgresData("student.class_ids.read", () =>
    listStudentEnrollmentClassIds({ email, studentId })
  );

  return postgresClassIds ?? new Set<string>();
}

function classRecordToData(
  record: ClassRecord,
  coTeachers: Array<{
    displayName: string;
    email: string;
    permissions: Record<string, boolean>;
    role: string;
    uid: string;
  }>
) {
  const coTeacherMap = Object.fromEntries(coTeachers.map((coTeacher) => [coTeacher.uid, coTeacher]));

  return {
    answerPolicy: record.settings.answerPolicy,
    appearance: record.appearance,
    coTeacherIds: coTeachers.map((coTeacher) => coTeacher.uid),
    coTeachers: coTeacherMap,
    joinCode: record.joinCode,
    modelSettings: record.settings.modelSettings,
    name: record.name,
    notificationSettings: record.settings.notificationSettings,
    privacySettings: record.settings.privacySettings,
    responseFormat: record.settings.responseFormat,
    section: record.section,
    sourceDefaults: record.settings.sourceDefaults,
    sourceUsage: record.settings.sourceUsage,
    studentChatEnabled: record.studentChatEnabled,
    teacherId: record.teacherId,
    teacherName: record.teacherName,
    themeColor: record.themeColor,
    tutorAccess: record.settings.tutorAccess
  };
}

function firestoreProfileToShape(uid: string, data: Record<string, unknown>): AccountProfileShape | null {
  if (data.role !== "student" && data.role !== "teacher") {
    return null;
  }

  const email = String(data.email ?? "").trim().toLowerCase();

  return {
    ...(data as Partial<AccountProfileShape>),
    uid,
    email,
    username: String(data.username ?? email).trim().toLowerCase() || email,
    displayName: String(data.displayName ?? email).trim() || "Chandra user",
    role: data.role
  };
}
