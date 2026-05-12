import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  inferLearningStrategyObservedOutcome,
  normalizeLearningStrategyTelemetry
} from "./learning-strategy-telemetry";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import { associateStudentMessageAttachments } from "./student-attachments-server";
import { getTeacherFeedbackByConversationId, summarizeFeedback } from "./student-feedback-server";
import { normalizeStructuredTutorOutput } from "./tutor-response";
import {
  buildChatContextMemory,
  hasChatContextMemory,
  normalizeChatContextMemory
} from "./chat-context-memory";
import { getAccountProfile, listClassEnrollmentsPostgresFirst, tryPostgresData } from "./data/server";
import {
  addMessage as addPostgresMessage,
  getConversationById,
  listClassConversations as listPostgresClassConversations,
  listConversationMessages as listPostgresConversationMessages,
  listStudentConversations as listPostgresStudentConversations,
  listTeacherStudentConversations as listPostgresTeacherStudentConversations,
  updateConversationMetadata,
  updateConversationTitle,
  updateMessageLearningStrategyTelemetry,
  upsertConversation
} from "./data/conversations";
import {
  listConversationReviews,
  listStudentSupport,
  upsertConversationReview,
  upsertStudentSupport
} from "./data/student-records";
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
  TutorTrace,
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

type RosterActivityStudentRow = {
  chatBlocked?: boolean;
  displayName?: string;
  email?: string;
  id: string;
  uid?: string;
};

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
  const postgresConversation = await getConversationById(conversationId);

  if (postgresConversation) {
    return conversationRecordToSummary(postgresConversation);
  }

  throw new ConversationPersistenceError("Conversation failed to save.", 500);
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
  const assistantMessage: ChatMessage = {
    content: response.message,
    createdAt,
    id: assistantMessageId,
    langGraphTrace: response.langGraphTrace,
    learningStrategyTelemetry: response.learningStrategyTelemetry,
    retrievalConfidence: response.retrievalConfidence,
    role: "assistant",
    sources: response.sources ?? [],
    structuredOutput: response.structuredOutput
  };
  await saveConversationMessage({
    classId: scope.classId,
    conversationId,
    message: assistantMessage,
    modelId
  });
  await saveConversationCurrentContext({ conversationId });

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
  const postgresConversations = await listPostgresTeacherStudentConversations({ classId, studentEmail });

  return postgresConversations.map(conversationRecordToSummary);
}

export async function listStudentConversations({
  classId,
  studentId
}: {
  classId: string;
  studentId: string;
}): Promise<StudentConversationSummary[]> {
  assertFirebaseAdminAuthReady();
  const postgresConversations = await listPostgresStudentConversations({ classId, studentId });

  return postgresConversations.map(conversationRecordToSummary);
}

export async function listTeacherClassConversations({
  classId
}: {
  classId: string;
}): Promise<TeacherConversationReviewSummary[]> {
  assertFirebaseAdminAuthReady();

  const [postgresConversations, postgresReviews] = await Promise.all([
    listPostgresClassConversations(classId),
    tryPostgresData("conversation.review.read", () => listConversationReviews(classId))
  ]);
  const postgresFeedbackByConversationId = await getTeacherFeedbackByConversationId(classId);

  const reviewsByConversationId = new Map(
    (postgresReviews ?? []).map((review) => [review.conversationId, reviewRecordToTeacherReview(review)])
  );
  const rows = await Promise.all(
    postgresConversations.map(async (conversationRecord) => {
      const conversation = conversationRecordToFirestoreData(conversationRecord);
      const sourceAudit = await getConversationSourceAuditForConversation({
        classId,
        conversation,
        conversationId: conversationRecord.id
      });
      const review = reviewsByConversationId.get(conversationRecord.id) ?? defaultTeacherConversationReview({
        classId,
        conversationId: conversationRecord.id,
        teacherId: conversationRecord.teacherId ?? ""
      });
      const feedback = postgresFeedbackByConversationId.get(conversationRecord.id) ?? [];

      return {
        classId,
        conversationId: conversationRecord.id,
        feedback,
        feedbackSummary: summarizeFeedback(feedback),
        id: conversationRecord.id,
        lastMessageAt: conversationRecord.lastMessageAt?.toISOString() ?? conversationRecord.updatedAt.toISOString(),
        latestRetrievalConfidence: sourceAudit.latestRetrievalConfidence,
        messageCount: conversationRecord.messageCount,
        modelId: conversationRecord.modelId,
        learningSignals: sourceAudit.learningSignals,
        review,
        reviewStatus: review.status,
        sourceAudit,
        studentEmail: conversationRecord.studentEmail,
        studentId: conversationRecord.studentId ?? "",
        studentName: conversationRecord.studentName,
        teacherId: conversationRecord.teacherId ?? "",
        teacherName: stringOrUndefined(conversationRecord.teacherName),
        title: conversationRecord.title || "Conversation",
        topic: inferConversationTopic(conversationRecord.title, conversationRecord.assignment, conversationRecord.tags)
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

  const postgresConversation = await getConversationById(conversationId);

  if (!postgresConversation) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  return getConversationSourceAuditForConversation({
    classId,
    conversation: conversationRecordToFirestoreData(postgresConversation),
    conversationId
  });
}

async function getConversationSourceAuditForConversation({
  classId,
  conversation,
  conversationId
}: {
  classId: string;
  conversation: Record<string, unknown>;
  conversationId: string;
}): Promise<TeacherConversationSourceAuditSummary> {
  if (conversation.classId !== classId) {
    throw new ConversationPersistenceError("Conversation does not belong to this class.", 403);
  }

  const messages = (await listPostgresConversationMessages(conversationId)).map(messageRecordToFirestoreData);
  const sourcesByKey = new Map<string, TutorSource>();
  let hasAssistantMessage = false;
  let latestRetrievalConfidence: RetrievalConfidence | undefined;
  let hasLowRetrievalConfidence = false;
  let hasClassMaterialQuestion = false;
  const learningSignals = emptyConversationLearningSignals();

  messages.forEach((message) => {
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

  const postgresConversation = await getConversationById(conversationId);

  if (!postgresConversation) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  if (postgresConversation.classId !== classId) {
    throw new ConversationPersistenceError("Conversation does not belong to this class.", 403);
  }
  await tryPostgresData("conversation.review.write", () =>
    upsertConversationReview({
      classId,
      conversationId,
      flags: sanitizeReviewFlags(flags),
      privateNote: privateNote.slice(0, maxTeacherReviewNoteLength),
      reviewedBy: teacherId,
      status
    })
  );

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

  const [rosterSnapshot, supportSnapshot] = await Promise.all([
    adminDb!.collection("classes").doc(classId).collection("students").get(),
    adminDb!.collection("classes").doc(classId).collection("studentSupport").get()
  ]);
  const [postgresRoster, postgresConversations, postgresSupport] = await Promise.all([
    listClassEnrollmentsPostgresFirst(classId),
    listPostgresClassConversations(classId),
    tryPostgresData("support.roster_activity.read", () => listStudentSupport(classId))
  ]);
  const rosterRows: RosterActivityStudentRow[] = postgresRoster.length ? postgresRoster : rosterSnapshot.docs.map((studentDoc) => ({
    id: studentDoc.id,
    displayName: String(studentDoc.data().displayName ?? ""),
    email: String(studentDoc.data().email ?? ""),
    chatBlocked: studentDoc.data().chatBlocked === true
  }));
  const rosterEmails = rosterRows
    .map((student) => String(student.email ?? "").trim().toLowerCase())
    .filter(Boolean);
  const presenceByEmail = await getStudentPresenceByEmail(classId, rosterEmails);
  const activeDaysByEmail = new Map<string, Set<string>>();
  const activityByEmail = new Map<string, StudentRosterActivitySummary>();
  const lastStudentMessageAtByEmail = new Map<string, number>();
  const todayKey = date || dateKey(new Date().toISOString(), timezone);
  const supportByEmail = new Map(
    (postgresSupport?.length
      ? postgresSupport.map((support) => ({
          id: support.id,
          studentEmail: support.studentEmail,
          chatBlocked: support.chatBlocked,
          teacherNotes: support.supportNotes
        }))
      : supportSnapshot.docs.map((supportDoc) => {
          const support = supportDoc.data();
          return {
            id: supportDoc.id,
            studentEmail: String(support.studentEmail ?? decodeURIComponent(supportDoc.id)).trim().toLowerCase(),
            chatBlocked: support.chatBlocked === true,
            teacherNotes: String(support.teacherNotes ?? support.notes ?? "")
          };
        }))
      .map((support) => [support.studentEmail, {
        chatBlocked: support.chatBlocked,
        teacherNotes: support.teacherNotes
      }] as const)
      .filter(([studentEmail]) => Boolean(studentEmail))
  );

  rosterRows.forEach((student) => {
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
      studentId: student.id,
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

  const conversationRows = postgresConversations.map((conversation) => ({
    data: () => conversationRecordToFirestoreData(conversation),
    id: conversation.id
  }));
  const conversationDocs = conversationRows.filter((conversationDoc) => {
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

  const conversationStudentMessages = await Promise.all(
    conversationDocs.map(async (conversationDoc) => {
      const postgresMessages = await listPostgresConversationMessages(conversationDoc.id);
      return postgresMessages.filter((message) => message.role === "student").map(messageRecordToFirestoreData);
    })
  );

  conversationStudentMessages.forEach((messages, conversationIndex) => {
    const conversationData = conversationDocs[conversationIndex]?.data() ?? {};
    const studentEmail = String(conversationData.studentEmail ?? "").trim().toLowerCase();
    const activity = activityByEmail.get(studentEmail);

    if (!activity) {
      return;
    }

    messages.forEach((message) => {
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
  const postgresRosterStudent = rosterStudentSnapshot.exists
    ? null
    : ((await listClassEnrollmentsPostgresFirst(classId)) as RosterActivityStudentRow[]).find((student) =>
        String(student.email ?? "").trim().toLowerCase() === normalizedEmail
      );

  if (!rosterStudentSnapshot.exists && !postgresRosterStudent) {
    throw new ConversationPersistenceError("Student is not on this class roster.", 404);
  }
  await tryPostgresData("support.notes.write", () =>
    upsertStudentSupport({
      classId,
      displayName: rosterStudentSnapshot.exists
        ? String(rosterStudentSnapshot.data()?.displayName ?? "")
        : String(postgresRosterStudent?.displayName ?? ""),
      id: `${classId}:${supportDocumentId}`,
      studentEmail: normalizedEmail,
      studentId: rosterStudentSnapshot.exists ? rosterStudentSnapshot.id : String(postgresRosterStudent?.uid ?? ""),
      supportNotes: notes.slice(0, 1000),
      metadata: { updatedBy: teacherId },
      chatBlocked
    })
  );

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
  const postgresRosterStudent = rosterStudentSnapshot.exists
    ? null
    : ((await listClassEnrollmentsPostgresFirst(classId)) as RosterActivityStudentRow[]).find((student) =>
        String(student.email ?? "").trim().toLowerCase() === normalizedEmail
      );

  if (!rosterStudentSnapshot.exists && !postgresRosterStudent) {
    throw new ConversationPersistenceError("Student is not on this class roster.", 404);
  }
  await tryPostgresData("support.chat_access.write", () =>
    upsertStudentSupport({
      chatBlocked,
      classId,
      displayName: rosterStudentSnapshot.exists
        ? String(rosterStudentSnapshot.data()?.displayName ?? "")
        : String(postgresRosterStudent?.displayName ?? ""),
      id: `${classId}:${supportDocumentId}`,
      studentEmail: normalizedEmail,
      studentId: rosterStudentSnapshot.exists ? rosterStudentSnapshot.id : String(postgresRosterStudent?.uid ?? ""),
      metadata: { updatedBy: teacherId }
    })
  );

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
  const conversation = await getConversationById(conversationId);

  if (!conversation) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  if (conversation.classId !== classId) {
    throw new ConversationPersistenceError("Conversation does not belong to this class.", 403);
  }

  return (await listPostgresConversationMessages(conversationId)).map(messageRecordToStudentChatMessage);
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

  const conversation = await getConversationById(conversationId);

  if (!conversation) {
    throw new ConversationPersistenceError("Conversation was not found.", 404);
  }

  if (conversation.classId !== classId || conversation.studentId !== studentId) {
    throw new ConversationPersistenceError("You can only open your own class conversations.", 403);
  }

  return (await listPostgresConversationMessages(conversationId)).map(messageRecordToChatMessage);
}

function conversationDocToSummary(id: string, data: Record<string, unknown>): StudentConversationSummary {
  return {
    assignment: stringOrUndefined(data.assignment),
    classId: String(data.classId ?? ""),
    createdAt: serializeFirestoreValue(data.createdAt),
    contextMemory: normalizeChatContextMemory(data.currentContext),
    contextUpdatedAt: serializeFirestoreValue(data.currentContextUpdatedAt),
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

function conversationRecordToSummary(conversation: Awaited<ReturnType<typeof getConversationById>> extends infer T ? NonNullable<T> : never): StudentConversationSummary {
  return {
    assignment: conversation.assignment || undefined,
    classId: conversation.classId,
    createdAt: conversation.createdAt.toISOString(),
    contextMemory: normalizeChatContextMemory(conversation.metadata.currentContext),
    contextUpdatedAt: stringOrUndefined(conversation.metadata.contextUpdatedAt),
    id: conversation.id,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? conversation.updatedAt.toISOString(),
    messageCount: conversation.messageCount,
    modelId: conversation.modelId,
    studentEmail: conversation.studentEmail,
    studentId: conversation.studentId ?? "",
    studentName: conversation.studentName,
    tags: conversation.tags.length ? conversation.tags : undefined,
    teacherId: conversation.teacherId ?? "",
    teacherName: stringOrUndefined(conversation.teacherName),
    title: conversation.title || "Conversation",
    updatedAt: conversation.updatedAt.toISOString()
  };
}

function conversationRecordToFirestoreData(conversation: Parameters<typeof conversationRecordToSummary>[0]): Record<string, unknown> {
  return {
    assignment: conversation.assignment,
    classId: conversation.classId,
    createdAt: conversation.createdAt.toISOString(),
    currentContext: conversation.metadata.currentContext,
    currentContextUpdatedAt: conversation.metadata.contextUpdatedAt,
    id: conversation.id,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? conversation.updatedAt.toISOString(),
    messageCount: conversation.messageCount,
    modelId: conversation.modelId,
    studentEmail: conversation.studentEmail,
    studentId: conversation.studentId ?? "",
    studentName: conversation.studentName,
    tags: conversation.tags,
    teacherId: conversation.teacherId ?? "",
    teacherName: conversation.teacherName,
    title: conversation.title,
    updatedAt: conversation.updatedAt.toISOString()
  };
}

function messageRecordToFirestoreData(message: Awaited<ReturnType<typeof listPostgresConversationMessages>>[number]): Record<string, unknown> {
  return {
    attachments: message.attachments,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    debugInfo: message.debugInfo,
    id: message.id,
    langGraphTrace: isRecord(message.langGraphTrace) ? message.langGraphTrace as TutorTrace : undefined,
    learningStrategyTelemetry: message.learningStrategyTelemetry,
    modelId: message.modelId,
    retrievalConfidence: message.retrievalConfidence,
    role: message.role,
    sources: message.sources,
    structuredOutput: message.structuredOutput
  };
}

function messageRecordToChatMessage(message: Awaited<ReturnType<typeof listPostgresConversationMessages>>[number]): ChatMessage {
  return {
    content: message.content,
    attachments: normalizeMessageAttachments(message.attachments),
    createdAt: message.createdAt.toISOString(),
    id: message.id,
    langGraphTrace: isRecord(message.langGraphTrace) ? message.langGraphTrace as TutorTrace : undefined,
    learningStrategyTelemetry: normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry),
    retrievalConfidence: normalizeRetrievalConfidence(message.retrievalConfidence),
    role: message.role,
    sources: Array.isArray(message.sources) ? message.sources as ChatMessage["sources"] : undefined,
    structuredOutput: normalizeStructuredTutorOutput(message.structuredOutput, message.content)
  };
}

function messageRecordToStudentChatMessage(message: Awaited<ReturnType<typeof listPostgresConversationMessages>>[number]): ChatMessage {
  const chatMessage = messageRecordToChatMessage(message);

  if (chatMessage.role === "assistant") {
    delete chatMessage.learningStrategyTelemetry;
  }

  return chatMessage;
}

function reviewRecordToTeacherReview(review: Awaited<ReturnType<typeof listConversationReviews>>[number]): TeacherConversationReview {
  return {
    classId: review.classId,
    conversationId: review.conversationId,
    flags: Array.isArray(review.metadata.flags) ? review.metadata.flags.map(String) : [],
    privateNote: review.teacherNote,
    reviewedAt: review.reviewedAt?.toISOString() ?? null,
    status: normalizeConversationReviewStatus(review.status),
    teacherId: String(review.metadata.teacherId ?? review.reviewedBy ?? ""),
    updatedAt: review.updatedAt.toISOString()
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

  const conversation = await getConversationById(conversationId);

  if (!conversation || conversation.classId !== classId) {
    return;
  }

  if (conversation.messageCount > 2 || !isVagueConversationTitle(conversation.title)) {
    return;
  }

  await updateConversationTitle({ id: conversationId, title: nextTitle });
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
  const postgresProfile = await getAccountProfile(scope.uid).catch(() => null);
  const userSnapshot = postgresProfile ? null : await adminDb!.collection("users").doc(scope.uid).get();
  const profile = postgresProfile ?? userSnapshot?.data() ?? {};
  const conversationId = randomUUID();

  await upsertConversation({
    id: conversationId,
    classId: scope.classId,
    modelId,
    studentEmail: String(profile.email ?? "").trim().toLowerCase(),
    studentId: scope.uid,
    studentName: String(profile.displayName ?? profile.email ?? "Student").trim() || "Student",
    teacherId: scope.professorId,
    teacherName: scope.professorName ?? "",
    title
  });

  return conversationId;
}

async function verifyStudentConversation({
  conversationId,
  scope
}: {
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  const postgresConversation = await getConversationById(conversationId);

  if (postgresConversation) {
    if (postgresConversation.classId !== scope.classId || postgresConversation.studentId !== scope.uid) {
      throw new ConversationPersistenceError("You can only continue your own class conversations.", 403);
    }
    return;
  }

  throw new ConversationPersistenceError("Conversation was not found.", 404);
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
  await addPostgresMessage({
    attachments: message.attachments,
    classId,
    content: message.content,
    conversationId,
    debugInfo: message.debugInfo,
    id: message.id,
    langGraphTrace: message.langGraphTrace,
    learningStrategyTelemetry: message.role === "assistant" ? normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry) : undefined,
    modelId: message.role === "assistant" ? modelId : undefined,
    retrievalConfidence: message.role === "assistant" ? message.retrievalConfidence : undefined,
    role: message.role,
    sources: message.sources,
    structuredOutput: message.role === "assistant" ? message.structuredOutput : undefined
  });
}

async function saveConversationCurrentContext({ conversationId }: { conversationId: string }) {
  const messages = (await listPostgresConversationMessages(conversationId)).map(messageRecordToChatMessage);
  const currentContext = buildChatContextMemory(messages);

  if (!hasChatContextMemory(currentContext)) {
    return;
  }

  await updateConversationMetadata({
    contextUpdatedAt: new Date().toISOString(),
    currentContext,
    id: conversationId
  });
}

async function updatePreviousLearningStrategyTelemetryOutcome({
  conversationId,
  studentMessage
}: {
  conversationId: string;
  studentMessage: ChatMessage;
}) {
  const outcome = inferLearningStrategyObservedOutcome(studentMessage.content);

  if (outcome === "unknown") {
    return;
  }

  const messages = (await listPostgresConversationMessages(conversationId)).slice(-8).reverse();
  const studentCreatedAtMillis = timestampMillis(studentMessage.createdAt);

  for (const message of messages) {
    if (message.role !== "assistant" || timestampMillis(message.createdAt.toISOString()) > studentCreatedAtMillis) {
      continue;
    }

    const telemetry = normalizeLearningStrategyTelemetry(message.learningStrategyTelemetry);

    if (!telemetry || (telemetry.observedOutcome && telemetry.observedOutcome !== "unknown")) {
      continue;
    }

    await updateMessageLearningStrategyTelemetry({
      conversationId,
      learningStrategyTelemetry: {
        ...telemetry,
        observedOutcome: outcome
      },
      messageId: message.id
    });
    return;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
