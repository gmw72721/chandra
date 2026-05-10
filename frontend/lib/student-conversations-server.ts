import { FieldValue, type DocumentData, type DocumentReference } from "firebase-admin/firestore";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  inferLearningStrategyObservedOutcome,
  normalizeLearningStrategyTelemetry
} from "./learning-strategy-telemetry";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import { associateStudentMessageAttachments } from "./student-attachments-server";
import { getTeacherFeedbackByConversationId, summarizeFeedback } from "./student-feedback-server";
import { normalizeStructuredTutorOutput } from "./tutor-response";
import type {
  ChatMessage,
  ConversationReviewStatus,
  MessageAttachment,
  RetrievalConfidence,
  StudentConversationSummary,
  StudentFeedbackSummary,
  StudentRosterActivitySummary,
  TeacherConversationLearningSignalSummary,
  TeacherConversationReview,
  TeacherConversationReviewSummary,
  TeacherConversationSourceAuditSummary,
  TutorApiResponse,
  TutorSource
} from "./types";

const maxTitleLength = 72;
const maxDocumentIdLength = 200;
const maxTeacherReviewNoteLength = 1000;
const presenceActiveWindowMs = 90 * 1000;
const conversationReviewStatuses = new Set<ConversationReviewStatus>([
  "new",
  "reviewed",
  "needs_follow_up",
  "misunderstanding_spotted",
  "good_learning_moment",
  "ai_answer_needs_review"
]);
const classMaterialQuestionPattern =
  /\b(assignment|class material|class materials|example|handout|homework|lecture|notes|page|pdf|problem|reading|rubric|textbook|worksheet)\b/i;
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
  attachments: MessageAttachment[];
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
  attachmentIds = [],
  conversationId,
  messages,
  modelId,
  scope
}: {
  attachmentIds?: string[];
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

  const attachments = await associateStudentMessageAttachments({
    attachmentIds,
    conversationId: resolvedConversationId,
    messageId: studentMessage.id,
    scope
  });
  const studentMessageWithAttachments = attachments.length
    ? {
        ...studentMessage,
        attachments
      }
    : studentMessage;

  await saveStudentMessage({
    conversationId: resolvedConversationId,
    modelId,
    scope,
    studentMessage: studentMessageWithAttachments
  });

  return {
    assistantMessageId: `${studentMessage.id}-assistant`,
    attachments,
    conversationId: resolvedConversationId,
    modelId,
    studentMessage: studentMessageWithAttachments
  };
}

export async function createStudentConversationDraft({
  scope,
  title
}: {
  scope: AuthorizedTutorChatScope;
  title?: string;
}): Promise<StudentConversationSummary> {
  if (scope.role !== "student") {
    throw new ConversationPersistenceError("Use a student account to start saved conversations.", 403);
  }

  assertFirebaseAdminAuthReady();

  const conversationId = await createStudentConversation({
    modelId: "",
    scope,
    title: title?.trim() || "New conversation"
  });
  const conversationSnapshot = await adminDb!
    .collection("classes")
    .doc(scope.classId)
    .collection("conversations")
    .doc(conversationId)
    .get();

  return conversationDocToSummary(conversationSnapshot.id, conversationSnapshot.data() ?? {});
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
      learningStrategyTelemetry: response.learningStrategyTelemetry,
      retrievalConfidence: response.retrievalConfidence,
      role: "assistant",
      sources: response.sources ?? [],
      structuredOutput: response.structuredOutput
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

export async function listTeacherClassConversations({
  classId
}: {
  classId: string;
}): Promise<TeacherConversationReviewSummary[]> {
  assertFirebaseAdminAuthReady();

  const classReference = adminDb!.collection("classes").doc(classId);
  const [conversationsSnapshot, reviewsSnapshot, feedbackByConversationId] = await Promise.all([
    classReference.collection("conversations").get(),
    classReference.collection("conversationReviews").get(),
    getTeacherFeedbackByConversationId(classId)
  ]);
  const reviewsByConversationId = new Map(
    reviewsSnapshot.docs.map((reviewDoc) => [reviewDoc.id, reviewDocToTeacherReview(reviewDoc.id, reviewDoc.data())])
  );

  const rows = await Promise.all(
    conversationsSnapshot.docs.map(async (conversationDoc) => {
      const conversation = conversationDoc.data();
      const sourceAudit = await getConversationSourceAuditForConversation({
        classId,
        conversation,
        conversationId: conversationDoc.id,
        conversationReference: conversationDoc.ref
      });
      const review = reviewsByConversationId.get(conversationDoc.id) ?? defaultTeacherConversationReview({
        classId,
        conversationId: conversationDoc.id,
        teacherId: String(conversation.teacherId ?? "")
      });
      const feedback = feedbackByConversationId.get(conversationDoc.id) ?? [];

      return {
        classId: String(conversation.classId ?? classId),
        conversationId: conversationDoc.id,
        feedback,
        feedbackSummary: summarizeFeedback(feedback),
        id: conversationDoc.id,
        lastMessageAt: serializeFirestoreValue(conversation.lastMessageAt),
        latestRetrievalConfidence: sourceAudit.latestRetrievalConfidence,
        messageCount: Number(conversation.messageCount ?? 0),
        modelId: String(conversation.modelId ?? ""),
        learningSignals: sourceAudit.learningSignals,
        review,
        reviewStatus: review.status,
        sourceAudit,
        studentEmail: String(conversation.studentEmail ?? ""),
        studentId: String(conversation.studentId ?? ""),
        studentName: String(conversation.studentName ?? "Student"),
        teacherId: String(conversation.teacherId ?? ""),
        teacherName: stringOrUndefined(conversation.teacherName),
        title: String(conversation.title ?? "Conversation"),
        topic: inferConversationTopic(
          String(conversation.title ?? ""),
          stringOrUndefined(conversation.assignment),
          Array.isArray(conversation.tags) ? conversation.tags.map(String) : undefined
        )
      };
    })
  );

  return rows.sort(
    (firstConversation, secondConversation) =>
      timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
  );
}

export async function getConversationSourceAudit({
  classId,
  conversationId
}: {
  classId: string;
  conversationId: string;
}): Promise<TeacherConversationSourceAuditSummary> {
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

  return getConversationSourceAuditForConversation({
    classId,
    conversation,
    conversationId,
    conversationReference
  });
}

async function getConversationSourceAuditForConversation({
  classId,
  conversation,
  conversationId,
  conversationReference
}: {
  classId: string;
  conversation: DocumentData;
  conversationId: string;
  conversationReference: DocumentReference<DocumentData>;
}): Promise<TeacherConversationSourceAuditSummary> {
  if (conversation.classId !== classId) {
    throw new ConversationPersistenceError("Conversation does not belong to this class.", 403);
  }

  const messagesSnapshot = await conversationReference.collection("messages").orderBy("createdAt", "asc").get();
  const sourcesByKey = new Map<string, TutorSource>();
  let hasAssistantMessage = false;
  let latestRetrievalConfidence: RetrievalConfidence | undefined;
  let hasLowRetrievalConfidence = false;
  let hasClassMaterialQuestion = false;
  const learningSignals = emptyConversationLearningSignals();

  messagesSnapshot.docs.forEach((messageDoc) => {
    const message = messageDoc.data();
    const role = String(message.role ?? "");

    if (role === "student" && classMaterialQuestionPattern.test(String(message.content ?? ""))) {
      hasClassMaterialQuestion = true;
    }

    if (role !== "assistant") {
      return;
    }

    hasAssistantMessage = true;
    learningSignals.assistantMessageCount += 1;
    const retrievalConfidence = normalizeRetrievalConfidence(message.retrievalConfidence);

    if (retrievalConfidence) {
      latestRetrievalConfidence = retrievalConfidence;
      hasLowRetrievalConfidence = hasLowRetrievalConfidence || retrievalConfidence === "low";
      if (retrievalConfidence === "low") {
        learningSignals.lowConfidenceMessageCount += 1;
      }
    }

    const assistantSources = normalizeTutorSources(message.sources);

    if (hasClassMaterialQuestion && !assistantSources.length) {
      learningSignals.noSourceAssistantMessageCount += 1;
    }

    const structuredOutput = normalizeStructuredTutorOutput(message.structuredOutput, String(message.content ?? ""));
    const metadata = structuredOutput?.metadata;

    if (metadata) {
      learningSignals.latestHintLevel = metadata.hintLevel;
      learningSignals.latestMode = metadata.mode;
      learningSignals.latestStudentActionNeeded = metadata.studentActionNeeded;

      if (metadata.studentActionNeeded === "ask_teacher") {
        learningSignals.askTeacherCount += 1;
      } else if (metadata.studentActionNeeded === "paste_problem") {
        learningSignals.pasteProblemCount += 1;
      } else if (metadata.studentActionNeeded === "review_source") {
        learningSignals.reviewSourceCount += 1;
      } else if (metadata.studentActionNeeded === "show_attempt") {
        learningSignals.showAttemptCount += 1;
      }

      if (metadata.hintLevel === "guided_step") {
        learningSignals.guidedStepCount += 1;
      } else if (metadata.hintLevel === "worked_example") {
        learningSignals.workedExampleCount += 1;
      }
    }

    const telemetry = normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry);

    if (telemetry?.observedOutcome === "student_still_stuck") {
      learningSignals.stuckOutcomeCount += 1;
    } else if (telemetry?.observedOutcome === "student_progressed") {
      learningSignals.progressedOutcomeCount += 1;
    } else if (telemetry?.observedOutcome === "student_disengaged") {
      learningSignals.disengagedOutcomeCount += 1;
    }

    for (const source of assistantSources) {
      sourcesByKey.set(sourceKey(source), source);
    }
  });

  const sources = Array.from(sourcesByKey.values());
  const sourceRequired = hasClassMaterialQuestion && hasAssistantMessage;
  const noSourceUsedWarning = sourceRequired && sources.length === 0;

  return {
    latestRetrievalConfidence,
    learningSignals,
    lowSourceConfidence: hasLowRetrievalConfidence || noSourceUsedWarning,
    noSourceUsedWarning,
    sourceCount: sources.length,
    sources
  };
}

function emptyConversationLearningSignals(): TeacherConversationLearningSignalSummary {
  return {
    assistantMessageCount: 0,
    lowConfidenceMessageCount: 0,
    noSourceAssistantMessageCount: 0,
    askTeacherCount: 0,
    pasteProblemCount: 0,
    reviewSourceCount: 0,
    showAttemptCount: 0,
    guidedStepCount: 0,
    workedExampleCount: 0,
    stuckOutcomeCount: 0,
    progressedOutcomeCount: 0,
    disengagedOutcomeCount: 0
  };
}

export async function updateTeacherConversationReview({
  classId,
  conversationId,
  flags,
  privateNote,
  status,
  teacherId
}: {
  classId: string;
  conversationId: string;
  teacherId: string;
  status: ConversationReviewStatus;
  privateNote: string;
  flags: string[];
}): Promise<TeacherConversationReview> {
  assertSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminAuthReady();

  if (!conversationReviewStatuses.has(status)) {
    throw new ConversationPersistenceError("Conversation review status is invalid.", 400);
  }

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

  if (conversation.classId !== classId) {
    throw new ConversationPersistenceError("Conversation does not belong to this class.", 403);
  }

  const reviewReference = adminDb!
    .collection("classes")
    .doc(classId)
    .collection("conversationReviews")
    .doc(conversationId);
  const reviewData = {
    classId,
    conversationId,
    flags: sanitizeReviewFlags(flags),
    privateNote: privateNote.slice(0, maxTeacherReviewNoteLength),
    reviewedAt: status === "new" ? null : FieldValue.serverTimestamp(),
    status,
    teacherId,
    updatedAt: FieldValue.serverTimestamp()
  };

  await reviewReference.set(reviewData, { merge: true });

  const savedReviewSnapshot = await reviewReference.get();
  return reviewDocToTeacherReview(conversationId, savedReviewSnapshot.data() ?? reviewData);
}

export async function listTeacherRosterActivity({
  classId,
  date,
  timezone
}: {
  classId: string;
  date?: string;
  timezone?: string;
}): Promise<StudentRosterActivitySummary[]> {
  assertFirebaseAdminAuthReady();

  const [rosterSnapshot, conversationsSnapshot, supportSnapshot] = await Promise.all([
    adminDb!.collection("classes").doc(classId).collection("students").get(),
    adminDb!.collection("classes").doc(classId).collection("conversations").get(),
    adminDb!.collection("classes").doc(classId).collection("studentSupport").get()
  ]);
  const rosterEmails = rosterSnapshot.docs
    .map((studentDoc) => String(studentDoc.data().email ?? "").trim().toLowerCase())
    .filter(Boolean);
  const presenceByEmail = await getStudentPresenceByEmail(classId, rosterEmails);
  const activeDaysByEmail = new Map<string, Set<string>>();
  const activityByEmail = new Map<string, StudentRosterActivitySummary>();
  const lastStudentMessageAtByEmail = new Map<string, number>();
  const todayKey = date || dateKey(new Date().toISOString(), timezone);
  const supportByEmail = new Map(
    supportSnapshot.docs
      .map((supportDoc) => {
        const support = supportDoc.data();
        const studentEmail = String(support.studentEmail ?? decodeURIComponent(supportDoc.id)).trim().toLowerCase();

        return [studentEmail, {
          chatBlocked: support.chatBlocked === true,
          teacherNotes: String(support.teacherNotes ?? support.notes ?? "")
        }] as const;
      })
      .filter(([studentEmail]) => Boolean(studentEmail))
  );

  rosterSnapshot.docs.forEach((studentDoc) => {
    const student = studentDoc.data();
    const studentEmail = String(student.email ?? "").trim().toLowerCase();

    if (!studentEmail) {
      return;
    }

    const presence = presenceByEmail.get(studentEmail);
    activityByEmail.set(studentEmail, {
      chatBlocked: supportByEmail.get(studentEmail)?.chatBlocked ?? student.chatBlocked === true,
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
      teacherNotes: supportByEmail.get(studentEmail)?.teacherNotes ?? "",
      totalQuestions: 0
    });
    if (presence?.isOnline) {
      activityByEmail.get(studentEmail)!.status = "active";
    }
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
    conversationDocs.map((conversationDoc) => conversationDoc.ref.collection("messages").where("role", "==", "student").get())
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
      const createdAt = serializeFirestoreValue(message.createdAt);

      activity.totalQuestions += 1;

      const activeDay = dateKey(createdAt, timezone);

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
    });

    const activeDays = activeDaysByEmail.get(studentEmail);

    if (activeDays?.size) {
      activity.questionsPerDay = roundPromptsPerDay(activity.totalQuestions / activeDays.size);
    }
  });

  activityByEmail.forEach((activity) => {
    const presence = presenceByEmail.get(activity.studentEmail.trim().toLowerCase());
    activity.recentConversations = activity.recentConversations
      .sort((firstConversation, secondConversation) =>
        timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
      )
      .slice(0, 3);
    activity.lastChatTopic = activity.recentConversations[0]?.title ?? "No saved topic";
    if (presence?.lastSeenAt && timestampMillis(presence.lastSeenAt) > timestampMillis(activity.lastActiveAt)) {
      activity.lastActiveAt = presence.lastSeenAt;
    }
    activity.status =
      presence?.isOnline ? "active" : activity.totalQuestions > 0 || activity.conversationCount > 0 ? "inactive" : "no_activity";
  });

  return Array.from(activityByEmail.values()).sort((firstActivity, secondActivity) =>
    firstActivity.studentEmail.localeCompare(secondActivity.studentEmail)
  );
}

async function getStudentPresenceByEmail(classId: string, studentEmails: string[]) {
  const uniqueEmails = Array.from(new Set(studentEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const presenceByEmail = new Map<string, { isOnline: boolean; lastSeenAt: string }>();
  const emailBatches: string[][] = [];

  for (let index = 0; index < uniqueEmails.length; index += 30) {
    const emailBatch = uniqueEmails.slice(index, index + 30);

    if (emailBatch.length) {
      emailBatches.push(emailBatch);
    }
  }

  const snapshots = await Promise.all(
    emailBatches.map((emailBatch) => adminDb!.collection("userPresence").where("email", "in", emailBatch).get())
  );
  const now = Date.now();

  snapshots.forEach((snapshot) => {
    snapshot.docs.forEach((presenceDoc) => {
      const presence = presenceDoc.data() ?? {};
      const email = String(presence.email ?? "").trim().toLowerCase();
      const lastSeenAt = String(serializeFirestoreValue(presence.lastSeenAt) ?? "");

      if (!email || presence.role !== "student" || presence.classId !== classId) {
        return;
      }

      const existingPresence = presenceByEmail.get(email);

      if (existingPresence && timestampMillis(existingPresence.lastSeenAt) >= timestampMillis(lastSeenAt)) {
        return;
      }

      presenceByEmail.set(email, {
        isOnline: Boolean(presence.online) && now - timestampMillis(lastSeenAt) <= presenceActiveWindowMs,
        lastSeenAt
      });
    });
  });

  return presenceByEmail;
}

export async function updateTeacherStudentSupport({
  chatBlocked,
  classId,
  notes,
  studentEmail,
  teacherId
}: {
  chatBlocked?: boolean;
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
        ...(typeof chatBlocked === "boolean" ? { chatBlocked } : {}),
        teacherNotes: notes.slice(0, 1000),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: teacherId
      },
      { merge: true }
    );
}

export async function updateTeacherStudentChatAccess({
  chatBlocked,
  classId,
  studentEmail,
  teacherId
}: {
  chatBlocked: boolean;
  classId: string;
  studentEmail: string;
  teacherId: string;
}) {
  assertFirebaseAdminAuthReady();

  const normalizedEmail = studentEmail.trim().toLowerCase();

  if (!normalizedEmail) {
    throw new ConversationPersistenceError("Student email is required.", 400);
  }

  const supportDocumentId = encodeURIComponent(normalizedEmail);
  const classReference = adminDb!.collection("classes").doc(classId);
  const rosterStudentReference = classReference.collection("students").doc(supportDocumentId);
  const rosterStudentSnapshot = await rosterStudentReference.get();

  if (!rosterStudentSnapshot.exists) {
    throw new ConversationPersistenceError("Student is not on this class roster.", 404);
  }

  await adminDb!.runTransaction(async (transaction) => {
    transaction.set(
      rosterStudentReference,
      {
        chatBlocked,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    transaction.set(
      classReference.collection("studentSupport").doc(supportDocumentId),
      {
        chatBlocked,
        studentEmail: normalizedEmail,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: teacherId
      },
      { merge: true }
    );
  });

  return { chatBlocked };
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
      attachments: normalizeMessageAttachments(data.attachments),
      createdAt: String(serializeFirestoreValue(data.createdAt) ?? ""),
      id: String(data.id ?? messageDoc.id),
      langGraphTrace: data.langGraphTrace,
      learningStrategyTelemetry: normalizeLearningStrategyTelemetry(data.learningStrategyTelemetry),
      retrievalConfidence: normalizeRetrievalConfidence(data.retrievalConfidence),
      role: data.role,
      sources: Array.isArray(data.sources) ? data.sources : undefined,
      structuredOutput: normalizeStructuredTutorOutput(data.structuredOutput, String(data.content ?? ""))
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

function dateKey(value: unknown, timezone?: string) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "";
  }

  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        month: "2-digit",
        timeZone: timezone,
        year: "numeric"
      }).formatToParts(new Date(millis));
      const byType = new Map(parts.map((part) => [part.type, part.value]));
      const year = byType.get("year");
      const month = byType.get("month");
      const day = byType.get("day");

      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // Fall back to UTC if the caller passes an unsupported timezone.
    }
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
      attachments: normalizeMessageAttachments(data.attachments),
      createdAt: String(serializeFirestoreValue(data.createdAt) ?? ""),
      id: String(data.id ?? messageDoc.id),
      langGraphTrace: data.langGraphTrace,
      retrievalConfidence: normalizeRetrievalConfidence(data.retrievalConfidence),
      role: data.role,
      sources: Array.isArray(data.sources) ? data.sources : undefined,
      structuredOutput: normalizeStructuredTutorOutput(data.structuredOutput, String(data.content ?? ""))
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

  return createStudentConversation({
    modelId,
    scope,
    title: buildConversationTitle(studentMessage.content)
  });
}

async function createStudentConversation({
  modelId,
  scope,
  title
}: {
  modelId: string;
  scope: AuthorizedTutorChatScope;
  title: string;
}) {
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
    lastMessageAt: createdAt,
    messageCount: 0,
    modelId,
    studentEmail: String(profile.email ?? "").trim().toLowerCase(),
    studentId: scope.uid,
    studentName: String(profile.displayName ?? profile.email ?? "Student").trim() || "Student",
    teacherId: scope.professorId,
    teacherName: scope.professorName ?? "",
    title,
    updatedAt: createdAt
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
  await updatePreviousLearningStrategyTelemetryOutcome({
    classId: scope.classId,
    conversationId,
    studentMessage
  }).catch((caughtError) => {
    console.error("Learning strategy telemetry outcome update skipped", JSON.stringify({
      classId: scope.classId,
      conversationId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError)
    }));
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
      learningStrategyTelemetry:
        message.role === "assistant" ? normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry) : undefined,
      modelId: message.role === "assistant" ? modelId : undefined,
      retrievalConfidence: message.role === "assistant" ? message.retrievalConfidence : undefined,
      role: message.role,
      attachments: message.attachments,
      sources: message.sources,
      structuredOutput: message.role === "assistant" ? message.structuredOutput : undefined
    }));

    transaction.update(conversationReference, {
      lastMessageAt,
      messageCount: FieldValue.increment(1),
      updatedAt: lastMessageAt
    });
  });
}

async function updatePreviousLearningStrategyTelemetryOutcome({
  classId,
  conversationId,
  studentMessage
}: {
  classId: string;
  conversationId: string;
  studentMessage: ChatMessage;
}) {
  const outcome = inferLearningStrategyObservedOutcome(studentMessage.content);

  if (outcome === "unknown") {
    return;
  }

  const conversationReference = adminDb!.collection("classes").doc(classId).collection("conversations").doc(conversationId);
  const messagesSnapshot = await conversationReference
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(8)
    .get();
  const studentCreatedAtMillis = timestampMillis(studentMessage.createdAt);

  for (const messageDoc of messagesSnapshot.docs) {
    const message = messageDoc.data() ?? {};

    if (message.role !== "assistant" || timestampMillis(message.createdAt) > studentCreatedAtMillis) {
      continue;
    }

    const telemetry = normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry);

    if (!telemetry || (telemetry.observedOutcome && telemetry.observedOutcome !== "unknown")) {
      continue;
    }

    await messageDoc.ref.set(
      {
        learningStrategyTelemetry: {
          ...telemetry,
          observedOutcome: outcome
        }
      },
      { merge: true }
    );
    return;
  }
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

function defaultTeacherConversationReview({
  classId,
  conversationId,
  teacherId
}: {
  classId: string;
  conversationId: string;
  teacherId: string;
}): TeacherConversationReview {
  return {
    classId,
    conversationId,
    flags: [],
    privateNote: "",
    reviewedAt: "",
    status: "new",
    teacherId,
    updatedAt: ""
  };
}

function reviewDocToTeacherReview(conversationId: string, data: Record<string, unknown>): TeacherConversationReview {
  const status = normalizeConversationReviewStatus(data.status);

  return {
    classId: String(data.classId ?? ""),
    conversationId: String(data.conversationId ?? conversationId),
    flags: sanitizeReviewFlags(data.flags),
    privateNote: String(data.privateNote ?? "").slice(0, maxTeacherReviewNoteLength),
    reviewedAt: serializeFirestoreValue(data.reviewedAt),
    status,
    teacherId: String(data.teacherId ?? ""),
    updatedAt: serializeFirestoreValue(data.updatedAt)
  };
}

function normalizeConversationReviewStatus(value: unknown): ConversationReviewStatus {
  const status = String(value ?? "new") as ConversationReviewStatus;

  return conversationReviewStatuses.has(status) ? status : "new";
}

function normalizeRetrievalConfidence(value: unknown): RetrievalConfidence | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function normalizeTutorSources(value: unknown): TutorSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<TutorSource[]>((sources, source) => {
    if (!source || typeof source !== "object") {
      return sources;
    }

    const sourceRecord = source as Record<string, unknown>;
    const title = String(sourceRecord.title ?? "").trim();

    if (!title) {
      return sources;
    }

    const normalizedSource: TutorSource = {
      materialType: String(sourceRecord.materialType ?? "class-material"),
      title
    };
    const problemNumber = stringOrUndefined(sourceRecord.problemNumber);

    if (typeof sourceRecord.citationsRequired === "boolean") {
      normalizedSource.citationsRequired = sourceRecord.citationsRequired;
    }

    if (typeof sourceRecord.pageNumber === "number") {
      normalizedSource.pageNumber = sourceRecord.pageNumber;
    }

    if (problemNumber) {
      normalizedSource.problemNumber = problemNumber;
    }

    sources.push(normalizedSource);
    return sources;
  }, []);
}

function normalizeMessageAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value.reduce<MessageAttachment[]>((items, attachment) => {
    if (!attachment || typeof attachment !== "object") {
      return items;
    }

    const record = attachment as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const fileName = String(record.fileName ?? "").trim();
    const storageKey = String(record.storageKey ?? "").trim();

    if (!id || !fileName || !storageKey) {
      return items;
    }

    items.push({
      classId: String(record.classId ?? ""),
      conversationId: String(record.conversationId ?? ""),
      createdAt: serializeFirestoreValue(record.createdAt),
      extractedText: stringOrUndefined(record.extractedText) ?? null,
      fileName,
      fileSize: Number(record.fileSize ?? 0),
      fileType: record.fileType === "pdf" ? "pdf" : "image",
      id,
      messageId: stringOrUndefined(record.messageId) ?? null,
      mimeType: String(record.mimeType ?? ""),
      pageCount: typeof record.pageCount === "number" ? record.pageCount : null,
      storageKey,
      studentId: String(record.studentId ?? ""),
      updatedAt: serializeFirestoreValue(record.updatedAt),
      uploadStatus: record.uploadStatus === "uploading" || record.uploadStatus === "failed" ? record.uploadStatus : "ready"
    });
    return items;
  }, []);

  return attachments.length ? attachments : undefined;
}

function sourceKey(source: TutorSource) {
  return [
    source.title,
    source.materialType,
    source.pageNumber ? `p${source.pageNumber}` : "",
    source.problemNumber ? `problem${source.problemNumber}` : ""
  ]
    .join("|")
    .toLowerCase();
}

function sanitizeReviewFlags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((flag) => String(flag ?? "").trim())
        .filter(Boolean)
        .map((flag) => flag.slice(0, 80))
    )
  ).slice(0, 20);
}

function inferConversationTopic(title: string, assignment?: string, tags?: string[]) {
  const source = [assignment, ...(tags ?? []), title].filter(Boolean).join(" ").toLowerCase();

  if (source.includes("off-topic") || source.includes("answer")) {
    return "Off-topic";
  }

  if (source.includes("derivative") || source.includes("chain")) {
    return "Derivatives";
  }

  if (source.includes("integral")) {
    return "Integrals";
  }

  if (source.includes("limit")) {
    return "Limits";
  }

  if (source.includes("problem")) {
    return "Problem setup";
  }

  return "General help";
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
