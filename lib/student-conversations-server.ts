import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import type { ChatMessage, StudentConversationSummary, StudentRosterActivitySummary, TutorApiResponse } from "./types";

const maxTitleLength = 72;
const maxDocumentIdLength = 200;
const topicTitlePatterns = [
  { pattern: /\b(chain\s*rule)\b/i, title: "Derivative chain rule" },
  { pattern: /\b(product\s*rule)\b/i, title: "Product rule derivatives" },
  { pattern: /\b(quotient\s*rule)\b/i, title: "Quotient rule derivatives" },
  { pattern: /\b(implicit\s+differentiation)\b/i, title: "Implicit differentiation" },
  { pattern: /\b(related\s+rates?)\b/i, title: "Related rates" },
  { pattern: /\b(linear\s+approximation|linearization)\b/i, title: "Linear approximation" },
  { pattern: /\b(trig(?:onometric)?\s+substitution|trig\s+sub)\b/i, title: "Trig substitution" },
  { pattern: /\b(u\s*[- ]?\s*substitution|u\s*sub)\b/i, title: "U-substitution" },
  { pattern: /\b(optimization|optimize|maximum|minimum|maximize|minimize|largest|smallest)\b/i, title: "Optimization problem" },
  { pattern: /\b(limits?|lim)\b[\s\S]*\b(fractions?|rational)\b/i, title: "Limits with fractions" },
  { pattern: /\b(fractions?|rational)\b[\s\S]*\b(limits?|lim)\b/i, title: "Limits with fractions" },
  { pattern: /\b(l'?hopital|lhopital)\b/i, title: "L'Hopital's rule" },
  { pattern: /\b(derivatives?|differentiate|differentiation)\b/i, title: "Derivatives" },
  { pattern: /\b(integrals?|integrate|integration)\b/i, title: "Integrals" },
  { pattern: /\b(limits?|lim)\b/i, title: "Limits" },
  { pattern: /\b(series|sequences?)\b/i, title: "Sequences and series" },
  { pattern: /\b(tangent\s+line)\b/i, title: "Tangent line" },
  { pattern: /\b(critical\s+points?)\b/i, title: "Critical points" }
];
const vagueConversationTitles = new Set([
  "help",
  "help me",
  "help with this",
  "help with a problem",
  "i dont know",
  "i don't know",
  "i am stuck",
  "i'm stuck",
  "im stuck",
  "need help",
  "new conversation",
  "question",
  "still stuck"
]);

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

  await updateVagueConversationTitleFromTutorResponse({
    classId: scope.classId,
    conversationId,
    response
  });
}

export function buildConversationTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "New conversation";
  }

  const topicTitle = inferTopicConversationTitle(normalized);

  if (topicTitle) {
    return topicTitle;
  }

  return truncateConversationTitle(cleanPromptForConversationTitle(normalized));
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

export async function listTeacherRosterActivity({
  classId
}: {
  classId: string;
}): Promise<StudentRosterActivitySummary[]> {
  assertFirebaseAdminAuthReady();

  const [rosterSnapshot, conversationsSnapshot, supportSnapshot] = await Promise.all([
    adminDb!.collection("classes").doc(classId).collection("students").get(),
    adminDb!.collection("classes").doc(classId).collection("conversations").get(),
    adminDb!.collection("classes").doc(classId).collection("studentSupport").get()
  ]);
  const activeDaysByEmail = new Map<string, Set<string>>();
  const activityByEmail = new Map<string, StudentRosterActivitySummary>();
  const lastStudentMessageAtByEmail = new Map<string, number>();
  const todayKey = dateKey(new Date().toISOString());
  const supportByEmail = new Map(
    supportSnapshot.docs
      .map((supportDoc) => {
        const support = supportDoc.data();
        const studentEmail = String(support.studentEmail ?? decodeURIComponent(supportDoc.id)).trim().toLowerCase();

        return [studentEmail, String(support.teacherNotes ?? support.notes ?? "")] as const;
      })
      .filter(([studentEmail]) => Boolean(studentEmail))
  );

  rosterSnapshot.docs.forEach((studentDoc) => {
    const student = studentDoc.data();
    const studentEmail = String(student.email ?? "").trim().toLowerCase();

    if (!studentEmail) {
      return;
    }

    activityByEmail.set(studentEmail, {
      conversationCount: 0,
      displayName: String(student.displayName ?? "").trim() || studentEmail,
      lastActiveAt: "",
      lastChatTopic: "No saved topic",
      questionsPerDay: 0,
      questionsToday: 0,
      recentConversations: [],
      status: "no_activity",
      studentId: studentDoc.id,
      studentEmail,
      teacherNotes: supportByEmail.get(studentEmail) ?? "",
      totalQuestions: 0
    });
    activeDaysByEmail.set(studentEmail, new Set());
    lastStudentMessageAtByEmail.set(studentEmail, 0);
  });

  const conversationDocs = conversationsSnapshot.docs.filter((conversationDoc) => {
    const studentEmail = String(conversationDoc.data().studentEmail ?? "").trim().toLowerCase();
    return activityByEmail.has(studentEmail);
  });

  conversationDocs.forEach((conversationDoc) => {
    const conversation = conversationDocToSummary(conversationDoc.id, conversationDoc.data());
    const studentEmail = conversation.studentEmail.trim().toLowerCase();
    const activity = activityByEmail.get(studentEmail);

    if (!activity) {
      return;
    }

    activity.conversationCount += 1;
    activity.recentConversations.push({
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      messageCount: conversation.messageCount,
      title: conversation.title
    });
  });

  const messageSnapshots = await Promise.all(
    conversationDocs.map((conversationDoc) => conversationDoc.ref.collection("messages").orderBy("createdAt", "asc").get())
  );

  messageSnapshots.forEach((messageSnapshot, conversationIndex) => {
    const conversationData = conversationDocs[conversationIndex]?.data() ?? {};
    const studentEmail = String(conversationData.studentEmail ?? "").trim().toLowerCase();
    const activity = activityByEmail.get(studentEmail);

    if (!activity) {
      return;
    }

    messageSnapshot.docs.forEach((messageDoc) => {
      const message = messageDoc.data();
      const role = String(message.role ?? "");
      const createdAt = serializeFirestoreValue(message.createdAt);

      if (role === "student") {
        activity.totalQuestions += 1;

        const activeDay = dateKey(createdAt);

        if (activeDay) {
          activeDaysByEmail.get(studentEmail)?.add(activeDay);
        }

        if (activeDay === todayKey) {
          activity.questionsToday += 1;
        }

        const activeAt = timestampMillis(createdAt);

        if (activeAt >= (lastStudentMessageAtByEmail.get(studentEmail) ?? 0)) {
          activity.lastActiveAt = String(createdAt ?? "");
          lastStudentMessageAtByEmail.set(studentEmail, activeAt);
        }
      }
    });

    const activeDays = activeDaysByEmail.get(studentEmail);

    if (activeDays?.size) {
      activity.questionsPerDay = roundPromptsPerDay(activity.totalQuestions / activeDays.size);
    }
  });

  activityByEmail.forEach((activity) => {
    activity.recentConversations = activity.recentConversations
      .sort((firstConversation, secondConversation) =>
        timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
      )
      .slice(0, 3);
    activity.lastChatTopic = activity.recentConversations[0]?.title ?? "No saved topic";
    activity.status =
      activity.questionsToday > 0 ? "active" : activity.totalQuestions > 0 || activity.conversationCount > 0 ? "inactive" : "no_activity";
  });

  return Array.from(activityByEmail.values()).sort((firstActivity, secondActivity) =>
    firstActivity.studentEmail.localeCompare(secondActivity.studentEmail)
  );
}

export async function updateTeacherStudentSupport({
  classId,
  notes,
  studentEmail,
  teacherId
}: {
  classId: string;
  notes: string;
  studentEmail: string;
  teacherId: string;
}) {
  assertFirebaseAdminAuthReady();

  const normalizedEmail = studentEmail.trim().toLowerCase();

  if (!normalizedEmail) {
    throw new ConversationPersistenceError("Student email is required.", 400);
  }

  const supportDocumentId = encodeURIComponent(normalizedEmail);
  const rosterStudentSnapshot = await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("students")
    .doc(supportDocumentId)
    .get();

  if (!rosterStudentSnapshot.exists) {
    throw new ConversationPersistenceError("Student is not on this class roster.", 404);
  }

  await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("studentSupport")
    .doc(supportDocumentId)
    .set(
      {
        studentEmail: normalizedEmail,
        teacherNotes: notes.slice(0, 1000),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: teacherId
      },
      { merge: true }
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

async function getLastSignInAt(studentEmail: string) {
  try {
    const userRecord = await adminAuth!.getUserByEmail(studentEmail);
    return userRecord.metadata.lastSignInTime ? new Date(userRecord.metadata.lastSignInTime).toISOString() : "";
  } catch {
    return "";
  }
}

function dateKey(value: unknown) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "";
  }

  return new Date(millis).toISOString().slice(0, 10);
}

function roundPromptsPerDay(value: number) {
  return Math.round(value * 10) / 10;
}

function latestReviewedProblemLabel(sources: unknown) {
  if (!Array.isArray(sources)) {
    return "";
  }

  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];

    if (!source || typeof source !== "object") {
      continue;
    }

    const sourceRecord = source as Record<string, unknown>;
    const title = String(sourceRecord.title ?? "").trim();
    const problemNumber = String(sourceRecord.problemNumber ?? "").trim();

    if (problemNumber) {
      return [title, `problem ${problemNumber}`].filter(Boolean).join(" / ");
    }
  }

  return "";
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

async function updateVagueConversationTitleFromTutorResponse({
  classId,
  conversationId,
  response
}: {
  classId: string;
  conversationId: string;
  response: TutorApiResponse;
}) {
  const nextTitle = buildConversationTitleFromTutorResponse(response);

  if (!nextTitle) {
    return;
  }

  const conversationReference = adminDb!.collection("classes").doc(classId).collection("conversations").doc(conversationId);

  await adminDb!.runTransaction(async (transaction) => {
    const conversationSnapshot = await transaction.get(conversationReference);
    const conversation = conversationSnapshot.data() ?? {};
    const currentTitle = String(conversation.title ?? "");
    const messageCount = Number(conversation.messageCount ?? 0);

    if (!conversationSnapshot.exists || messageCount > 2 || !isVagueConversationTitle(currentTitle)) {
      return;
    }

    transaction.update(conversationReference, {
      title: nextTitle,
      updatedAt: new Date().toISOString()
    });
  });
}

function buildConversationTitleFromTutorResponse(response: TutorApiResponse) {
  for (const source of response.sources ?? []) {
    const sourceText = [source.title, source.materialType, source.problemNumber ? `problem ${source.problemNumber}` : ""]
      .filter(Boolean)
      .join(" ");
    const topicTitle = inferTopicConversationTitle(sourceText);

    if (topicTitle) {
      return topicTitle;
    }

    if (source.problemNumber) {
      return truncateConversationTitle(`${shortSourceTitle(source.title)} problem ${source.problemNumber}`);
    }
  }

  for (const page of response.langGraphTrace?.selectedPages ?? []) {
    const pageText = [page.title, page.materialType].filter(Boolean).join(" ");
    const topicTitle = inferTopicConversationTitle(pageText);

    if (topicTitle) {
      return topicTitle;
    }

    if (page.title) {
      return truncateConversationTitle(shortSourceTitle(page.title));
    }
  }

  return inferTopicConversationTitle(response.message);
}

function inferTopicConversationTitle(text: string) {
  for (const topic of topicTitlePatterns) {
    if (topic.pattern.test(text)) {
      return topic.title;
    }
  }

  return "";
}

function cleanPromptForConversationTitle(prompt: string) {
  const cleaned = prompt
    .replace(/^(hi|hello|hey)[,!\s]+/i, "")
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, "")
    .replace(/^(please\s+)?(help|help me|i need help|i am stuck|i'm stuck|im stuck)\s*(with|on)?\s*/i, "")
    .replace(/^(how\s+do\s+i|how\s+to)\s+/i, "")
    .replace(/\?+$/g, "")
    .trim();

  if (!cleaned || isVagueConversationTitle(cleaned)) {
    return "Need help";
  }

  return sentenceCase(cleaned);
}

function sentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncateConversationTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "New conversation";
  }

  if (normalized.length <= maxTitleLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxTitleLength - 1).trimEnd()}...`;
}

function isVagueConversationTitle(title: string) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();

  return vagueConversationTitles.has(normalized);
}

function shortSourceTitle(title: string) {
  return (
    title
      .replace(/\.(pdf|docx?|pptx?)$/i, "")
      .replace(/\s*[-]\s*(worksheet|homework|assignment|practice problems?).*$/i, "")
      .trim() || "Class material"
  );
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
