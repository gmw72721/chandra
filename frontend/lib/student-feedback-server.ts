import { FieldValue, type Query } from "firebase-admin/firestore";
import { grantStudentAiUsageAllowance } from "./ai-usage-limits";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import { checkFirestoreRateLimit } from "./firestore-rate-limit";
import { getAccountProfile, getClassSnapshotPostgresFirst, tryPostgresData } from "./data/server";
import { getConversationById, listConversationMessages } from "./data/conversations";
import { listFeedback, upsertStudentFeedback } from "./data/student-records";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import type {
  StudentFeedback,
  StudentFeedbackKind,
  StudentFeedbackPromptReason,
  StudentFeedbackRating,
  StudentFeedbackStatus,
  StudentFeedbackSummary
} from "./types";

const maxDocumentIdLength = 200;
const maxFeedbackCommentLength = 1000;
const maxTeacherFeedbackNoteLength = 1000;
const feedbackStatuses = new Set<StudentFeedbackStatus>(["new", "reviewed", "resolved"]);
const feedbackKinds = new Set<StudentFeedbackKind>(["general", "prompted", "usage_request"]);
const feedbackPromptReasons = new Set<StudentFeedbackPromptReason>([
  "assistant_count",
  "confusion_signal",
  "low_confidence",
  "source_heavy"
]);
const feedbackRatings = new Set<StudentFeedbackRating>([
  "helpful",
  "not_helpful",
  "confusing",
  "incorrect",
  "other"
]);

export class StudentFeedbackPersistenceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function authorizeStudentFeedbackRequest(
  request: Request,
  requestedCourseId?: string
): Promise<AuthorizedTutorChatScope> {
  const token = getBearerToken(request);

  if (!token) {
    throw new StudentFeedbackPersistenceError("Sign in before sending feedback.", 401);
  }

  assertFirebaseAdminAuthReady();

  const decodedToken = await adminAuth!.verifyIdToken(token);
  const profile = await getAccountProfile(decodedToken.uid);

  if (!profile) {
    throw new StudentFeedbackPersistenceError("Create a student profile before sending feedback.", 403);
  }

  if (profile.role !== "student") {
    throw new StudentFeedbackPersistenceError("Use a student account to send feedback.", 403);
  }

  const classId = resolveStudentFeedbackClassId({
    requestedCourseId,
    savedClassId: String(profile.classId ?? ""),
    savedClassIds: Array.isArray(profile.classIds) ? profile.classIds.map(String) : []
  });
  const classSnapshot = await getClassSnapshotPostgresFirst(classId);

  if (!classSnapshot.exists) {
    throw new StudentFeedbackPersistenceError("Your saved class was not found.", 404);
  }

  const classData = classSnapshot.data;
  const professorId = String(classData.teacherId ?? classData.professorId ?? "").trim();

  if (!professorId) {
    throw new StudentFeedbackPersistenceError("This class is missing teacher ownership metadata.", 403);
  }

  return {
    classId,
    professorId,
    professorName: String(classData.teacherName ?? classData.professorName ?? "").trim() || undefined,
    role: "student",
    uid: decodedToken.uid
  };
}

export async function createStudentFeedback({
  comment,
  conversationId,
  kind,
  messageId,
  promptReason,
  rating,
  scope
}: {
  comment: string;
  conversationId: string;
  kind?: unknown;
  messageId?: string | null;
  promptReason?: unknown;
  rating?: unknown;
  scope: AuthorizedTutorChatScope;
}): Promise<StudentFeedback> {
  if (scope.role !== "student") {
    throw new StudentFeedbackPersistenceError("Use a student account to send feedback.", 403);
  }

  assertSafeDocumentId(conversationId, "Conversation id");
  assertOptionalSafeDocumentId(messageId, "Message id");
  assertFirebaseAdminAuthReady();

  const normalizedComment = comment.replace(/\s+/g, " ").trim().slice(0, maxFeedbackCommentLength);

  if (!normalizedComment) {
    throw new StudentFeedbackPersistenceError("Add a short note before sending feedback.", 400);
  }

  await assertStudentFeedbackRateLimit(scope);

  const [postgresConversation, profileSnapshot] = await Promise.all([
    getConversationById(conversationId),
    adminDb!.collection("users").doc(scope.uid).get()
  ]);

  if (!postgresConversation) {
    throw new StudentFeedbackPersistenceError("Conversation was not found.", 404);
  }

  const conversation = {
    classId: postgresConversation.classId,
    studentEmail: postgresConversation.studentEmail,
    studentId: postgresConversation.studentId,
    studentName: postgresConversation.studentName
  };

  if (conversation.classId !== scope.classId || conversation.studentId !== scope.uid) {
    throw new StudentFeedbackPersistenceError("You can only send feedback for your own class conversations.", 403);
  }

  if (messageId) {
    const postgresMessages = await listConversationMessages(conversationId);

    if (!postgresMessages.some((message) => message.id === messageId)) {
      throw new StudentFeedbackPersistenceError("Feedback message context was not found.", 404);
    }
  }

  const profile = profileSnapshot.data() ?? {};
  const classReference = adminDb!.collection("classes").doc(scope.classId);
  const feedbackReference = classReference.collection("studentFeedback").doc();
  const normalizedKind = normalizeFeedbackKind(kind);
  const normalizedPromptReason = normalizeFeedbackPromptReason(promptReason);
  const normalizedRating = normalizeFeedbackRating(rating);
  const feedbackData = compactFirestoreData({
    classId: scope.classId,
    comment: normalizedComment,
    conversationId,
    createdAt: FieldValue.serverTimestamp(),
    id: feedbackReference.id,
    kind: normalizedKind,
    messageId: messageId || null,
    promptReason: normalizedKind === "prompted" ? normalizedPromptReason : undefined,
    rating: normalizedRating,
    status: "new",
    studentEmail: String(profile.email ?? conversation.studentEmail ?? "").trim().toLowerCase(),
    studentId: scope.uid,
    studentName: String(profile.displayName ?? conversation.studentName ?? "Student").trim() || "Student",
    teacherNote: "",
    updatedAt: FieldValue.serverTimestamp()
  });

  await feedbackReference.set(feedbackData);
  await tryPostgresData("feedback.write", () =>
    upsertStudentFeedback({
      classId: scope.classId,
      comment: normalizedComment,
      conversationId,
      id: feedbackReference.id,
      kind: normalizedKind,
      messageId: messageId || null,
      promptReason: normalizedKind === "prompted" ? normalizedPromptReason : null,
      rating: normalizedRating,
      studentEmail: String(profile.email ?? conversation.studentEmail ?? "").trim().toLowerCase(),
      studentId: scope.uid,
      studentName: String(profile.displayName ?? conversation.studentName ?? "Student").trim() || "Student"
    })
  );

  const savedFeedbackSnapshot = await feedbackReference.get();
  return feedbackDocToStudentFeedback(savedFeedbackSnapshot.id, savedFeedbackSnapshot.data() ?? feedbackData);
}

export async function listStudentFeedback({
  classId,
  conversationId,
  studentId
}: {
  classId: string;
  conversationId?: string;
  studentId: string;
}): Promise<StudentFeedback[]> {
  assertOptionalSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminAuthReady();
  const postgresFeedback = await tryPostgresData("feedback.student.read", () =>
    listFeedback({ classId, conversationId, studentId })
  );

  if (postgresFeedback?.length) {
    return postgresFeedback.map(feedbackRecordToStudentFeedback).map(sanitizeStudentVisibleFeedback);
  }

  let feedbackQuery: Query = adminDb!
    .collection("classes")
    .doc(classId)
    .collection("studentFeedback")
    .where("studentId", "==", studentId);

  if (conversationId) {
    feedbackQuery = feedbackQuery.where("conversationId", "==", conversationId);
  }

  const snapshot = await feedbackQuery.get();

  return snapshot.docs
    .map((feedbackDoc) => sanitizeStudentVisibleFeedback(feedbackDocToStudentFeedback(feedbackDoc.id, feedbackDoc.data())))
    .sort((first, second) => timestampMillis(second.createdAt) - timestampMillis(first.createdAt));
}

export async function listTeacherClassFeedback({
  classId,
  conversationId,
  status
}: {
  classId: string;
  conversationId?: string;
  status?: string;
}): Promise<StudentFeedback[]> {
  assertOptionalSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminAuthReady();
  const postgresFeedback = await tryPostgresData("feedback.teacher.read", () =>
    listFeedback({ classId, conversationId, status: status && feedbackStatuses.has(status as StudentFeedbackStatus) ? status : undefined })
  );

  if (postgresFeedback?.length) {
    return postgresFeedback.map(feedbackRecordToStudentFeedback);
  }

  let feedbackQuery: Query = adminDb!.collection("classes").doc(classId).collection("studentFeedback");

  if (conversationId) {
    feedbackQuery = feedbackQuery.where("conversationId", "==", conversationId);
  }

  if (status && feedbackStatuses.has(status as StudentFeedbackStatus)) {
    feedbackQuery = feedbackQuery.where("status", "==", status);
  }

  const snapshot = await feedbackQuery.get();

  return snapshot.docs
    .map((feedbackDoc) => feedbackDocToStudentFeedback(feedbackDoc.id, feedbackDoc.data()))
    .sort((first, second) => timestampMillis(second.createdAt) - timestampMillis(first.createdAt));
}

export async function getTeacherFeedbackByConversationId(classId: string) {
  const feedback = await listTeacherClassFeedback({ classId });
  const feedbackByConversationId = new Map<string, StudentFeedback[]>();

  feedback.forEach((item) => {
    const items = feedbackByConversationId.get(item.conversationId) ?? [];
    items.push(item);
    feedbackByConversationId.set(item.conversationId, items);
  });

  return feedbackByConversationId;
}

export async function updateTeacherStudentFeedback({
  classId,
  feedbackId,
  status,
  sendStudentVisibleResponse = false,
  studentVisibleResponse,
  teacherId,
  teacherNote,
  usageAllowancePercent
}: {
  classId: string;
  feedbackId: string;
  status?: StudentFeedbackStatus;
  sendStudentVisibleResponse?: boolean;
  studentVisibleResponse?: string;
  teacherId: string;
  teacherNote?: string;
  usageAllowancePercent?: number;
}): Promise<StudentFeedback> {
  assertSafeDocumentId(feedbackId, "Feedback id");
  assertFirebaseAdminAuthReady();

  if (status !== undefined && (!feedbackStatuses.has(status) || status === "new")) {
    throw new StudentFeedbackPersistenceError("Feedback status is invalid.", 400);
  }

  const feedbackReference = adminDb!.collection("classes").doc(classId).collection("studentFeedback").doc(feedbackId);
  const feedbackSnapshot = await feedbackReference.get();

  if (!feedbackSnapshot.exists) {
    throw new StudentFeedbackPersistenceError("Feedback was not found.", 404);
  }

  const feedback = feedbackSnapshot.data() ?? {};

  if (feedback.classId !== classId) {
    throw new StudentFeedbackPersistenceError("Feedback does not belong to this class.", 403);
  }

  const nextStatus = status ?? normalizeFeedbackStatus(feedback.status);
  const normalizedStudentVisibleResponse = String(
    studentVisibleResponse ?? feedback.studentVisibleResponse ?? feedback.studentVisibleResponseDraft ?? ""
  ).slice(0, maxTeacherFeedbackNoteLength);
  if (sendStudentVisibleResponse && !normalizedStudentVisibleResponse.trim()) {
    throw new StudentFeedbackPersistenceError("Add a response before sending it to the student.", 400);
  }
  const existingStudentVisibleResponseSentAt = serializeFirestoreValue(feedback.studentVisibleResponseSentAt);
  const studentVisibleResponseSentAt = sendStudentVisibleResponse
    ? new Date().toISOString()
    : typeof existingStudentVisibleResponseSentAt === "string"
      ? existingStudentVisibleResponseSentAt
      : "";
  const normalizedUsageAllowancePercent = normalizeUsageAllowancePercent(usageAllowancePercent);
  const shouldGrantUsageAllowance =
    feedback.kind === "usage_request" && nextStatus === "resolved" && normalizedUsageAllowancePercent > 0;
  const usageAllowance = shouldGrantUsageAllowance
    ? await grantStudentAiUsageAllowance({
        classId,
        feedbackId,
        percent: normalizedUsageAllowancePercent,
        studentId: String(feedback.studentId ?? ""),
        teacherId
      })
    : null;

  const updateData = compactFirestoreData({
    reviewedAt: status ? FieldValue.serverTimestamp() : undefined,
    reviewedBy: teacherId,
    resolvedAt: nextStatus === "resolved" ? FieldValue.serverTimestamp() : undefined,
    status: nextStatus,
    studentVisibleResponse: normalizedStudentVisibleResponse,
    studentVisibleResponseSentAt: sendStudentVisibleResponse ? FieldValue.serverTimestamp() : undefined,
    teacherNote: String(teacherNote ?? feedback.teacherNote ?? "").slice(0, maxTeacherFeedbackNoteLength),
    usageAllowanceDayBucket: usageAllowance?.dayBucket,
    usageAllowancePercent: usageAllowance?.percent,
    updatedAt: FieldValue.serverTimestamp()
  });

  await feedbackReference.set(updateData, { merge: true });
  await tryPostgresData("feedback.teacher_update.write", () =>
    upsertStudentFeedback({
      classId,
      comment: String(feedback.comment ?? ""),
      conversationId: String(feedback.conversationId ?? ""),
      id: feedbackId,
      kind: normalizeFeedbackKind(feedback.kind),
      messageId: stringOrNull(feedback.messageId),
      promptReason: normalizeFeedbackPromptReason(feedback.promptReason),
      rating: normalizeFeedbackRating(feedback.rating),
      status: nextStatus,
      studentEmail: String(feedback.studentEmail ?? "").trim().toLowerCase(),
      studentId: String(feedback.studentId ?? ""),
      studentName: String(feedback.studentName ?? "Student"),
      studentVisibleResponse: normalizedStudentVisibleResponse,
      studentVisibleResponseSentAt,
      teacherNote: String(teacherNote ?? feedback.teacherNote ?? "").slice(0, maxTeacherFeedbackNoteLength),
      metadata: {
        reviewedAt: status ? new Date().toISOString() : undefined,
        reviewedBy: teacherId,
        studentVisibleResponse: normalizedStudentVisibleResponse,
        studentVisibleResponseSentAt,
        usageAllowanceDayBucket: usageAllowance?.dayBucket,
        usageAllowancePercent: usageAllowance?.percent
      }
    })
  );

  const savedFeedbackSnapshot = await feedbackReference.get();
  return feedbackDocToStudentFeedback(savedFeedbackSnapshot.id, savedFeedbackSnapshot.data() ?? {});
}

export function summarizeFeedback(feedback: StudentFeedback[]): StudentFeedbackSummary {
  const sortedFeedback = [...feedback].sort(
    (first, second) => timestampMillis(second.createdAt) - timestampMillis(first.createdAt)
  );
  const latest = sortedFeedback[0];

  return {
    latestCreatedAt: latest?.createdAt ?? "",
    latestRating: latest?.rating,
    latestStatus: latest?.status,
    openCount: feedback.filter((item) => item.status !== "resolved").length,
    totalCount: feedback.length
  };
}

function feedbackDocToStudentFeedback(id: string, data: Record<string, unknown>): StudentFeedback {
  return {
    classId: String(data.classId ?? ""),
    comment: String(data.comment ?? "").slice(0, maxFeedbackCommentLength),
    conversationId: String(data.conversationId ?? ""),
    createdAt: serializeFirestoreValue(data.createdAt),
    id: String(data.id ?? id),
    kind: normalizeFeedbackKind(data.kind),
    messageId: stringOrNull(data.messageId),
    promptReason: normalizeFeedbackPromptReason(data.promptReason),
    rating: normalizeFeedbackRating(data.rating),
    resolvedAt: serializeFirestoreValue(data.resolvedAt),
    reviewedAt: serializeFirestoreValue(data.reviewedAt),
    reviewedBy: stringOrNull(data.reviewedBy),
    status: normalizeFeedbackStatus(data.status),
    studentVisibleResponse: String(data.studentVisibleResponse ?? data.studentVisibleResponseDraft ?? "").slice(0, maxTeacherFeedbackNoteLength),
    studentVisibleResponseSentAt: serializeFirestoreValue(data.studentVisibleResponseSentAt),
    studentEmail: String(data.studentEmail ?? "").trim().toLowerCase(),
    studentId: String(data.studentId ?? ""),
    studentName: String(data.studentName ?? "Student"),
    teacherNote: String(data.teacherNote ?? "").slice(0, maxTeacherFeedbackNoteLength),
    usageAllowanceDayBucket: String(data.usageAllowanceDayBucket ?? ""),
    usageAllowancePercent: normalizeUsageAllowancePercent(data.usageAllowancePercent),
    updatedAt: serializeFirestoreValue(data.updatedAt)
  };
}

function feedbackRecordToStudentFeedback(record: Awaited<ReturnType<typeof listFeedback>>[number]): StudentFeedback {
  return {
    classId: record.classId,
    comment: record.comment,
    conversationId: record.conversationId ?? "",
    createdAt: record.createdAt.toISOString(),
    id: record.id,
    kind: normalizeFeedbackKind(record.kind),
    messageId: stringOrNull(record.messageId),
    promptReason: normalizeFeedbackPromptReason(record.promptReason),
    rating: normalizeFeedbackRating(record.rating),
    resolvedAt: serializeFirestoreValue(record.metadata.resolvedAt),
    reviewedAt: serializeFirestoreValue(record.metadata.reviewedAt),
    reviewedBy: stringOrNull(record.metadata.reviewedBy),
    status: normalizeFeedbackStatus(record.status),
    studentVisibleResponse: String(record.metadata.studentVisibleResponse ?? record.metadata.studentVisibleResponseDraft ?? "").slice(0, maxTeacherFeedbackNoteLength),
    studentVisibleResponseSentAt: serializeFirestoreValue(record.metadata.studentVisibleResponseSentAt),
    studentEmail: record.studentEmail,
    studentId: record.studentId ?? "",
    studentName: record.studentName,
    teacherNote: record.teacherNote,
    usageAllowanceDayBucket: String(record.metadata.usageAllowanceDayBucket ?? ""),
    usageAllowancePercent: normalizeUsageAllowancePercent(record.metadata.usageAllowancePercent),
    updatedAt: record.updatedAt.toISOString()
  };
}

function sanitizeStudentVisibleFeedback(feedback: StudentFeedback): StudentFeedback {
  const isResponseSent = Boolean(feedback.studentVisibleResponseSentAt && feedback.studentVisibleResponse);
  const {
    reviewedBy: _reviewedBy,
    teacherNote: _teacherNote,
    ...visibleFeedback
  } = feedback;

  return isResponseSent
    ? visibleFeedback
    : {
        ...visibleFeedback,
        studentVisibleResponse: "",
        studentVisibleResponseSentAt: ""
      };
}

async function assertStudentFeedbackRateLimit(scope: AuthorizedTutorChatScope) {
  const shortWindow = await checkFirestoreRateLimit({
    key: `${scope.classId}:${scope.uid}`,
    limit: 1,
    namespace: "student-feedback-short",
    windowMs: 30 * 1000
  });

  if (!shortWindow.allowed) {
    throw new StudentFeedbackPersistenceError("Wait a moment before sending more feedback.", 429);
  }

  const dailyWindow = await checkFirestoreRateLimit({
    key: `${scope.classId}:${scope.uid}`,
    limit: 10,
    namespace: "student-feedback-day",
    windowMs: 24 * 60 * 60 * 1000
  });

  if (!dailyWindow.allowed) {
    throw new StudentFeedbackPersistenceError("You have sent the daily feedback limit for this class.", 429);
  }
}

function normalizeFeedbackStatus(value: unknown): StudentFeedbackStatus {
  const status = String(value ?? "new") as StudentFeedbackStatus;

  return feedbackStatuses.has(status) ? status : "new";
}

function normalizeFeedbackKind(value: unknown): StudentFeedbackKind {
  const kind = String(value ?? "general") as StudentFeedbackKind;

  return feedbackKinds.has(kind) ? kind : "general";
}

function normalizeFeedbackPromptReason(value: unknown): StudentFeedbackPromptReason | undefined {
  const promptReason = String(value ?? "") as StudentFeedbackPromptReason;

  return feedbackPromptReasons.has(promptReason) ? promptReason : undefined;
}

function normalizeFeedbackRating(value: unknown): StudentFeedbackRating | undefined {
  const rating = String(value ?? "") as StudentFeedbackRating;

  return feedbackRatings.has(rating) ? rating : undefined;
}

function normalizeUsageAllowancePercent(value: unknown) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(500, Math.round(numeric)));
}

function serializeFirestoreValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }

  return value ?? "";
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    return Date.parse(value) || 0;
  }

  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  return 0;
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();

  return text || null;
}

function compactFirestoreData(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function assertOptionalSafeDocumentId(value: string | null | undefined, label: string) {
  if (!value) {
    return;
  }

  assertSafeDocumentId(value, label);
}

function assertSafeDocumentId(value: string, label: string) {
  if (!value || value.includes("/") || value.length > maxDocumentIdLength) {
    throw new StudentFeedbackPersistenceError(`${label} is invalid.`, 400);
  }
}

function resolveStudentFeedbackClassId({
  requestedCourseId,
  savedClassId,
  savedClassIds
}: {
  requestedCourseId?: string;
  savedClassId: string;
  savedClassIds: string[];
}) {
  const requested = requestedCourseId?.trim() ?? "";
  const saved = savedClassId.trim();
  const memberships = new Set([saved, ...savedClassIds.map((classId) => classId.trim())].filter(Boolean));

  if (requested && memberships.has(requested)) {
    return requested;
  }

  if (saved) {
    return saved;
  }

  throw new StudentFeedbackPersistenceError("Your student profile needs a class before sending feedback.", 403);
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");

  return scheme?.toLowerCase() === "bearer" && token ? token : "";
}
