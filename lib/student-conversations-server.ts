import { FieldValue } from "firebase-admin/firestore";
import { adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import type { ChatMessage, StudentConversationSummary, TutorApiResponse } from "./types";

const maxTitleLength = 72;
const maxDocumentIdLength = 200;

export type StudentConversationPersistence = {
  assistantMessageId: string;
  conversationId: string;
  modelId: string;
  studentMessage: ChatMessage;
};

export class ConversationPersistenceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function prepareStudentConversationPersistence({
  conversationId,
  messages,
  modelId,
  scope
}: {
  conversationId?: string;
  messages: ChatMessage[];
  modelId: string;
  scope: AuthorizedTutorChatScope;
}): Promise<StudentConversationPersistence | null> {
  if (scope.role !== "student") {
    return null;
  }

  const studentMessage = getLatestStudentMessage(messages);

  if (!studentMessage) {
    return null;
  }

  assertSafeDocumentId(studentMessage.id, "Message id");
  assertFirebaseAdminAuthReady();

  const resolvedConversationId = await createOrVerifyStudentConversation({
    conversationId,
    modelId,
    scope,
    studentMessage
  });

  await saveStudentMessage({
    conversationId: resolvedConversationId,
    modelId,
    scope,
    studentMessage
  });

  return {
    assistantMessageId: `${studentMessage.id}-assistant`,
    conversationId: resolvedConversationId,
    modelId,
    studentMessage
  };
}

export async function saveAssistantMessage({
  assistantMessageId,
  conversationId,
  modelId,
  response,
  scope
}: {
  assistantMessageId: string;
  conversationId: string;
  modelId: string;
  response: TutorApiResponse;
  scope: AuthorizedTutorChatScope;
}) {
  assertSafeDocumentId(assistantMessageId, "Assistant message id");
  assertFirebaseAdminAuthReady();

  const createdAt = new Date().toISOString();
  await saveConversationMessage({
    classId: scope.classId,
    conversationId,
    message: {
      content: response.message,
      createdAt,
      id: assistantMessageId,
      langGraphTrace: response.langGraphTrace,
      retrievalConfidence: response.retrievalConfidence,
      role: "assistant",
      sources: response.sources ?? []
    },
    modelId
  });
}

export function buildConversationTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "New conversation";
  }

  if (normalized.length <= maxTitleLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxTitleLength - 1).trimEnd()}...`;
}

export async function listTeacherStudentConversations({
  classId,
  studentEmail
}: {
  classId: string;
  studentEmail: string;
}): Promise<StudentConversationSummary[]> {
  assertFirebaseAdminAuthReady();

  const snapshot = await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("conversations")
    .where("studentEmail", "==", studentEmail.trim().toLowerCase())
    .get();

  return snapshot.docs
    .map((conversationDoc) => {
      const data = conversationDoc.data();

      return {
        assignment: stringOrUndefined(data.assignment),
        classId: String(data.classId ?? ""),
        createdAt: serializeFirestoreValue(data.createdAt),
        id: conversationDoc.id,
        lastMessageAt: serializeFirestoreValue(data.lastMessageAt),
        messageCount: Number(data.messageCount ?? 0),
        modelId: String(data.modelId ?? ""),
        studentEmail: String(data.studentEmail ?? ""),
        studentId: String(data.studentId ?? ""),
        studentName: String(data.studentName ?? "Student"),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
        teacherId: String(data.teacherId ?? ""),
        teacherName: stringOrUndefined(data.teacherName),
        title: String(data.title ?? "Conversation"),
        updatedAt: serializeFirestoreValue(data.updatedAt)
      };
    })
    .sort((firstConversation, secondConversation) =>
      timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
    );
}

export async function listStudentConversations({
  classId,
  studentId
}: {
  classId: string;
  studentId: string;
}): Promise<StudentConversationSummary[]> {
  assertFirebaseAdminAuthReady();

  const snapshot = await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("conversations")
    .where("studentId", "==", studentId)
    .get();

  return snapshot.docs
    .map((conversationDoc) => conversationDocToSummary(conversationDoc.id, conversationDoc.data()))
    .sort((firstConversation, secondConversation) =>
      timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
    );
}

export async function listTeacherConversationMessages({
  classId,
  conversationId
}: {
  classId: string;
  conversationId: string;
}): Promise<ChatMessage[]> {
  assertSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminAuthReady();

  const snapshot = await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .orderBy("createdAt", "asc")
    .get();

  return snapshot.docs.map((messageDoc) => {
    const data = messageDoc.data();

    return {
      content: String(data.content ?? ""),
      createdAt: String(serializeFirestoreValue(data.createdAt) ?? ""),
      id: String(data.id ?? messageDoc.id),
      langGraphTrace: data.langGraphTrace,
      role: data.role,
      sources: Array.isArray(data.sources) ? data.sources : undefined
    } as ChatMessage;
  });
}

export async function listStudentConversationMessages({
  classId,
  conversationId,
  studentId
}: {
  classId: string;
  conversationId: string;
  studentId: string;
}): Promise<ChatMessage[]> {
  assertSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminAuthReady();

  const conversationReference = adminDb!
    .collection("classes")
    .doc(classId)
    .collection("conversations")
    .doc(conversationId);
  const conversationSnapshot = await conversationReference.get();

  if (!conversationSnapshot.exists) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  const conversation = conversationSnapshot.data() ?? {};

  if (conversation.classId !== classId || conversation.studentId !== studentId) {
    throw new ConversationPersistenceError("You can only open your own class conversations.", 403);
  }

  const snapshot = await conversationReference.collection("messages").orderBy("createdAt", "asc").get();

  return snapshot.docs.map((messageDoc) => {
    const data = messageDoc.data();

    return {
      content: String(data.content ?? ""),
      createdAt: String(serializeFirestoreValue(data.createdAt) ?? ""),
      id: String(data.id ?? messageDoc.id),
      langGraphTrace: data.langGraphTrace,
      role: data.role,
      sources: Array.isArray(data.sources) ? data.sources : undefined
    } as ChatMessage;
  });
}

function conversationDocToSummary(id: string, data: Record<string, unknown>): StudentConversationSummary {
  return {
    assignment: stringOrUndefined(data.assignment),
    classId: String(data.classId ?? ""),
    createdAt: serializeFirestoreValue(data.createdAt),
    id,
    lastMessageAt: serializeFirestoreValue(data.lastMessageAt),
    messageCount: Number(data.messageCount ?? 0),
    modelId: String(data.modelId ?? ""),
    studentEmail: String(data.studentEmail ?? ""),
    studentId: String(data.studentId ?? ""),
    studentName: String(data.studentName ?? "Student"),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
    teacherId: String(data.teacherId ?? ""),
    teacherName: stringOrUndefined(data.teacherName),
    title: String(data.title ?? "Conversation"),
    updatedAt: serializeFirestoreValue(data.updatedAt)
  };
}

function getLatestStudentMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "student") {
      return messages[index];
    }
  }

  return null;
}

async function createOrVerifyStudentConversation({
  conversationId,
  modelId,
  scope,
  studentMessage
}: {
  conversationId?: string;
  modelId: string;
  scope: AuthorizedTutorChatScope;
  studentMessage: ChatMessage;
}) {
  if (conversationId) {
    assertSafeDocumentId(conversationId, "Conversation id");
    await verifyStudentConversation({ conversationId, scope });
    return conversationId;
  }

  const userSnapshot = await adminDb!.collection("users").doc(scope.uid).get();
  const profile = userSnapshot.data() ?? {};
  const conversationReference = adminDb!
    .collection("classes")
    .doc(scope.classId)
    .collection("conversations")
    .doc();
  const createdAt = new Date().toISOString();

  await conversationReference.set({
    classId: scope.classId,
    createdAt,
    messageCount: 0,
    modelId,
    studentEmail: String(profile.email ?? "").trim().toLowerCase(),
    studentId: scope.uid,
    studentName: String(profile.displayName ?? profile.email ?? "Student").trim() || "Student",
    teacherId: scope.professorId,
    teacherName: scope.professorName ?? "",
    title: buildConversationTitle(studentMessage.content),
    updatedAt: createdAt,
    lastMessageAt: createdAt
  });

  return conversationReference.id;
}

async function verifyStudentConversation({
  conversationId,
  scope
}: {
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  const conversationSnapshot = await adminDb!
    .collection("classes")
    .doc(scope.classId)
    .collection("conversations")
    .doc(conversationId)
    .get();

  if (!conversationSnapshot.exists) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  const conversation = conversationSnapshot.data() ?? {};

  if (conversation.classId !== scope.classId || conversation.studentId !== scope.uid) {
    throw new ConversationPersistenceError("You can only continue your own class conversations.", 403);
  }
}

async function saveStudentMessage({
  conversationId,
  modelId,
  scope,
  studentMessage
}: {
  conversationId: string;
  modelId: string;
  scope: AuthorizedTutorChatScope;
  studentMessage: ChatMessage;
}) {
  await saveConversationMessage({
    classId: scope.classId,
    conversationId,
    message: studentMessage,
    modelId
  });
}

async function saveConversationMessage({
  classId,
  conversationId,
  message,
  modelId
}: {
  classId: string;
  conversationId: string;
  message: ChatMessage & { retrievalConfidence?: string };
  modelId: string;
}) {
  const conversationReference = adminDb!.collection("classes").doc(classId).collection("conversations").doc(conversationId);
  const messageReference = conversationReference.collection("messages").doc(message.id);
  const lastMessageAt = message.createdAt || new Date().toISOString();

  await adminDb!.runTransaction(async (transaction) => {
    const existingMessage = await transaction.get(messageReference);

    if (existingMessage.exists) {
      return;
    }

    transaction.set(messageReference, compactFirestoreData({
      content: message.content,
      createdAt: lastMessageAt,
      id: message.id,
      langGraphTrace: message.langGraphTrace,
      modelId: message.role === "assistant" ? modelId : undefined,
      retrievalConfidence: message.role === "assistant" ? message.retrievalConfidence : undefined,
      role: message.role,
      sources: message.sources
    }));

    transaction.update(conversationReference, {
      lastMessageAt,
      messageCount: FieldValue.increment(1),
      updatedAt: lastMessageAt
    });
  });
}

function compactFirestoreData(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
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

function stringOrUndefined(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    return Date.parse(value) || 0;
  }

  return 0;
}

function assertSafeDocumentId(value: string, label: string) {
  if (!value || value.includes("/") || value.length > maxDocumentIdLength) {
    throw new ConversationPersistenceError(`${label} is invalid.`, 400);
  }
}
