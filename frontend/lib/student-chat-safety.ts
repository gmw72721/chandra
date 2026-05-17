import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { writeAuditLog, writeSecurityLog } from "./audit-log.ts";
import { adminDb } from "./firebase-admin.ts";
import { getAccountProfile, tryPostgresData } from "./data/server.ts";
import { getConversationById, updateConversationMetadata, upsertConversation } from "./data/conversations.ts";
import { upsertConversationReview, upsertStudentSupport } from "./data/student-records.ts";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth.ts";
import type { ChatMessage } from "./types.ts";

export const studentChatSafetyBlockedCode = "CHAT_SAFETY_BLOCKED" as const;
export const studentChatSafetyModerationModel = "omni-moderation-latest";
export const generalStudentSafetyMessage =
  "I can't help with that message. Please rephrase it in a way that stays safe and focused on classwork.";
export const selfHarmStudentSafetyMessage = [
  generalStudentSafetyMessage,
  "If you might hurt yourself or feel in immediate crisis, call or text 988, or chat 988lifeline.org.",
  "If you or someone else is in immediate danger, call 911 or go to the nearest emergency room."
].join(" ");
export const violenceStudentSafetyMessage = [
  generalStudentSafetyMessage,
  "If anyone is in immediate danger, call 911 now.",
  "If this is about a crisis or you might hurt yourself or someone else, call or text 988 or chat 988lifeline.org."
].join(" ");

const urgentSafetyCategories = new Set([
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence",
  "violence/graphic",
  "harassment/threatening",
  "hate/threatening",
  "illicit/violent"
]);
const selfHarmSafetyCategories = new Set(["self-harm", "self-harm/intent", "self-harm/instructions"]);
const violenceSafetyCategories = new Set([
  "violence",
  "violence/graphic",
  "harassment/threatening",
  "hate/threatening",
  "illicit/violent"
]);
export const studentChatSafetyTemporaryPauseThreshold = 2;
export const studentChatSafetyPermanentUrgentPauseThreshold = 3;
export const studentChatSafetyPermanentTotalPauseThreshold = 5;
export const studentChatSafetyTemporaryPauseDurationMs = 60 * 60 * 1000;

export type StudentChatSafetyDecision = {
  blocked: boolean;
  categories: string[];
  categoryScores: Record<string, number>;
  primaryReason: string;
  riskLevel: "none" | "general" | "urgent";
  supportMessage: string;
};

export type StudentChatSafetyBlockedEvent = StudentChatSafetyDecision & {
  blockedMessageText: string;
  classId: string;
  conversationId: string;
  count: number;
  date: string;
  messageHash: string;
  messageId: string;
  model: string;
  pauseAction: "none" | "temporary_pause" | "permanent_pause";
  pauseUntil?: string;
  requestId: string;
  studentId: string;
  urgentCount: number;
};

export class StudentChatSafetyBlockedError extends Error {
  event: StudentChatSafetyBlockedEvent;

  constructor(event: StudentChatSafetyBlockedEvent) {
    super(studentChatSafetyBlockedCode);
    this.name = "StudentChatSafetyBlockedError";
    this.event = event;
  }
}

type StudentChatSafetyAttachmentInput = {
  dataUrl?: string;
  fileType?: string;
  mimeType?: string;
};

type ModerationResultShape = {
  categories?: Record<string, unknown>;
  category_scores?: Record<string, unknown>;
  categoryScores?: Record<string, unknown>;
  flagged?: boolean;
};

export function latestStudentMessageForSafety(
  messages: Array<Pick<ChatMessage, "attachments" | "content" | "id" | "role">>
) {
  return [...messages].reverse().find((message) => message.role === "student") ?? null;
}

export function normalizeStudentChatSafetyDecision(result: ModerationResultShape): StudentChatSafetyDecision {
  const categories = Object.entries(result.categories ?? {})
    .filter(([, flagged]) => flagged === true)
    .map(([category]) => category)
    .sort();
  const categoryScores = Object.fromEntries(
    Object.entries(result.category_scores ?? result.categoryScores ?? {})
      .map(([category, score]) => [category, typeof score === "number" && Number.isFinite(score) ? score : 0])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
  );
  const primaryReason = primarySafetyReason(categories);
  const riskLevel = categories.some((category) => urgentSafetyCategories.has(category)) ? "urgent" : "general";

  return {
    blocked: result.flagged === true,
    categories,
    categoryScores,
    primaryReason,
    riskLevel,
    supportMessage: supportMessageForSafetyCategories(categories)
  };
}

export function supportMessageForSafetyCategories(categories: string[]) {
  if (categories.some((category) => selfHarmSafetyCategories.has(category))) {
    return selfHarmStudentSafetyMessage;
  }

  if (categories.some((category) => violenceSafetyCategories.has(category))) {
    return violenceStudentSafetyMessage;
  }

  return generalStudentSafetyMessage;
}

export function hashStudentMessageContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function studentChatSafetyBlockedPayload(event: StudentChatSafetyBlockedEvent) {
  return {
    code: studentChatSafetyBlockedCode,
    error: event.supportMessage,
    errorCode: studentChatSafetyBlockedCode,
    categories: event.categories,
    reason: event.primaryReason,
    safety: {
      blocked: true,
      categories: event.categories,
      code: studentChatSafetyBlockedCode,
      count: event.count,
      pauseAction: event.pauseAction,
      pauseUntil: event.pauseUntil,
      reason: event.primaryReason,
      supportMessage: event.supportMessage
    }
  };
}

export function isStudentChatSafetyFilterEnabled() {
  return process.env.STUDENT_CHAT_SAFETY_FILTER_ENABLED?.trim().toLowerCase() !== "false";
}

export async function checkLatestStudentChatSafety({
  attachmentFiles = [],
  conversationId,
  messages,
  requestId,
  scope
}: {
  attachmentFiles?: StudentChatSafetyAttachmentInput[];
  conversationId?: string;
  messages: ChatMessage[];
  requestId: string;
  scope: AuthorizedTutorChatScope;
}): Promise<StudentChatSafetyBlockedEvent | null> {
  if (scope.role !== "student" || !isStudentChatSafetyFilterEnabled()) {
    return null;
  }

  const latestStudentMessage = latestStudentMessageForSafety(messages);

  if (!latestStudentMessage) {
    return null;
  }

  const decision = await moderateStudentChatInput({
    attachmentFiles: [
      ...attachmentFiles,
      ...((latestStudentMessage.attachments ?? []) as StudentChatSafetyAttachmentInput[])
    ],
    text: latestStudentMessage.content
  });

  if (!decision.blocked) {
    return null;
  }

  return recordStudentChatSafetyBlockedEvent({
    conversationId,
    decision,
    messageContent: latestStudentMessage.content,
    messageId: latestStudentMessage.id,
    requestId,
    scope
  });
}

async function moderateStudentChatInput({
  attachmentFiles,
  text
}: {
  attachmentFiles: StudentChatSafetyAttachmentInput[];
  text: string;
}) {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    logModerationUnavailable("missing_openai_api_key");
    return unavailableModerationDecision("missing_openai_api_key");
  }

  const input = buildModerationInput({ attachmentFiles, text });

  try {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      body: JSON.stringify({
        input,
        model: studentChatSafetyModerationModel
      }),
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`OpenAI moderation failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { results?: ModerationResultShape[] };
    const result = payload.results?.[0];

    if (!result) {
      throw new Error("OpenAI moderation response did not include a result.");
    }

    return normalizeStudentChatSafetyDecision(result);
  } catch (caughtError) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Student chat safety moderation unavailable; allowing request in non-production.", {
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
        model: studentChatSafetyModerationModel
      });
      return {
        blocked: false,
        categories: [],
        categoryScores: {},
        primaryReason: "moderation_unavailable",
        riskLevel: "none" as const,
        supportMessage: generalStudentSafetyMessage
      };
    }

    logModerationUnavailable(
      "moderation_unavailable",
      caughtError instanceof Error ? caughtError.message : String(caughtError)
    );
    return unavailableModerationDecision("moderation_unavailable");
  }
}

function unavailableModerationDecision(primaryReason: string): StudentChatSafetyDecision {
  if (process.env.NODE_ENV !== "production" || !shouldBlockWhenModerationIsUnavailable()) {
    return {
      blocked: false,
      categories: [],
      categoryScores: {},
      primaryReason,
      riskLevel: "none",
      supportMessage: generalStudentSafetyMessage
    };
  }

  return {
    blocked: true,
    categories: ["moderation_unavailable"],
    categoryScores: {},
    primaryReason,
    riskLevel: "general",
    supportMessage: generalStudentSafetyMessage
  };
}

function shouldBlockWhenModerationIsUnavailable() {
  return process.env.STUDENT_CHAT_SAFETY_FAIL_CLOSED?.trim().toLowerCase() === "true";
}

function logModerationUnavailable(primaryReason: string, message = "") {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  console.error("Student chat safety moderation unavailable; allowing request.", JSON.stringify({
    message,
    model: studentChatSafetyModerationModel,
    primaryReason
  }));
}

function buildModerationInput({
  attachmentFiles,
  text
}: {
  attachmentFiles: StudentChatSafetyAttachmentInput[];
  text: string;
}) {
  const imageInputs = attachmentFiles
    .filter((attachment) => attachment.fileType === "image" && typeof attachment.dataUrl === "string")
    .map((attachment) => ({
      image_url: {
        url: attachment.dataUrl
      },
      type: "image_url"
    }));

  if (!imageInputs.length) {
    return text;
  }

  return [
    {
      text,
      type: "text"
    },
    ...imageInputs
  ];
}

async function recordStudentChatSafetyBlockedEvent({
  conversationId,
  decision,
  messageContent,
  messageId,
  requestId,
  scope
}: {
  conversationId?: string;
  decision: StudentChatSafetyDecision;
  messageContent: string;
  messageId: string;
  requestId: string;
  scope: AuthorizedTutorChatScope;
}): Promise<StudentChatSafetyBlockedEvent> {
  const date = new Date().toISOString().slice(0, 10);
  let resolvedConversationId = conversationId?.trim() || randomUUID();
  try {
    resolvedConversationId = await ensureSafetyReviewConversation({
      conversationId,
      date,
      decision,
      messageId,
      scope
    });
  } catch (caughtError) {
    console.error("Student chat safety conversation metadata write failed.", JSON.stringify({
      classId: scope.classId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      requestId,
      studentId: scope.uid
    }));
  }
  const messageHash = hashStudentMessageContent(messageContent);
  let countSnapshot = {
    count: 1,
    urgentCount: decision.categories.some((category) => urgentSafetyCategories.has(category)) ? 1 : 0
  };

  try {
    countSnapshot = await incrementDailySafetyCount({
      classId: scope.classId,
      conversationId: resolvedConversationId,
      date,
      categories: decision.categories,
      categoryScores: decision.categoryScores,
      messageHash,
      messageId,
      model: studentChatSafetyModerationModel,
      primaryReason: decision.primaryReason,
      requestId,
      riskLevel: decision.riskLevel,
      studentId: scope.uid
    });
  } catch (caughtError) {
    console.error("Student chat safety count write failed.", JSON.stringify({
      classId: scope.classId,
      conversationId: resolvedConversationId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      requestId,
      studentId: scope.uid
    }));
  }
  const pauseDecision = safetyPauseDecision(countSnapshot);
  const event: StudentChatSafetyBlockedEvent = {
    ...decision,
    blockedMessageText: messageContent,
    classId: scope.classId,
    conversationId: resolvedConversationId,
    count: countSnapshot.count,
    date,
    messageHash,
    messageId,
    model: studentChatSafetyModerationModel,
    pauseAction: pauseDecision.pauseAction,
    pauseUntil: pauseDecision.pauseUntil,
    requestId,
    studentId: scope.uid,
    urgentCount: countSnapshot.urgentCount
  };

  await writeAuditLog({
    actor: { uid: scope.uid },
    eventType: "student_chat.safety_blocked",
    metadata: auditSafetyMetadata(event),
    route: "/api/chat",
    target: {
      id: resolvedConversationId,
      type: "conversation"
    }
  }).catch((caughtError) => {
    console.error("Student chat safety audit write failed.", JSON.stringify({
      classId: scope.classId,
      conversationId: resolvedConversationId,
      message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      requestId,
      studentId: scope.uid
    }));
  });

  if (event.count >= 1) {
    await markConversationForSafetyReview({
      event,
      urgent: event.pauseAction === "permanent_pause" || event.riskLevel === "urgent"
    }).catch((caughtError) => {
      console.error("Student chat safety review write failed.", JSON.stringify({
        classId: event.classId,
        conversationId: event.conversationId,
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
        requestId: event.requestId,
        studentId: event.studentId
      }));
    });
  }

  if (event.pauseAction !== "none") {
    await applyStudentChatSafetyPause(event).catch((caughtError) => {
      console.error("Student chat safety pause write failed.", JSON.stringify({
        classId: event.classId,
        conversationId: event.conversationId,
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
        requestId: event.requestId,
        studentId: event.studentId
      }));
    });
  }

  if (event.pauseAction === "permanent_pause") {
    await writeSecurityLog({
      eventType:
        event.urgentCount >= studentChatSafetyPermanentUrgentPauseThreshold
          ? "student_chat.safety_urgent_escalation"
          : "student_chat.safety_permanent_pause",
      metadata: auditSafetyMetadata(event),
      route: "/api/chat"
    }).catch((caughtError) => {
      console.error("Student chat urgent safety security write failed.", JSON.stringify({
        classId: event.classId,
        conversationId: event.conversationId,
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
        requestId: event.requestId,
        studentId: event.studentId
      }));
    });
  }

  return event;
}

function safetyPauseDecision({
  count,
  urgentCount
}: {
  count: number;
  urgentCount: number;
}): Pick<StudentChatSafetyBlockedEvent, "pauseAction" | "pauseUntil"> {
  if (
    urgentCount >= studentChatSafetyPermanentUrgentPauseThreshold ||
    count >= studentChatSafetyPermanentTotalPauseThreshold
  ) {
    return { pauseAction: "permanent_pause" };
  }

  if (count >= studentChatSafetyTemporaryPauseThreshold) {
    return {
      pauseAction: "temporary_pause",
      pauseUntil: new Date(Date.now() + studentChatSafetyTemporaryPauseDurationMs).toISOString()
    };
  }

  return { pauseAction: "none" };
}

async function ensureSafetyReviewConversation({
  conversationId,
  date,
  decision,
  messageId,
  scope
}: {
  conversationId?: string;
  date: string;
  decision: StudentChatSafetyDecision;
  messageId: string;
  scope: AuthorizedTutorChatScope;
}) {
  const requestedConversationId = conversationId?.trim();
  const existingConversation = requestedConversationId
    ? await tryPostgresData("student_chat.safety.conversation.read", () => getConversationById(requestedConversationId))
    : null;

  if (requestedConversationId && existingConversation) {
    await tryPostgresData("student_chat.safety.conversation_metadata.write", () =>
      updateConversationMetadata({
        id: requestedConversationId,
        metadata: {
          safetyReview: {
            categories: decision.categories,
            date,
            lastBlockedMessageId: messageId,
            primaryReason: decision.primaryReason,
            riskLevel: decision.riskLevel
          }
        }
      })
    );
    return requestedConversationId;
  }

  const profile = await getAccountProfile(scope.uid).catch(() => null);
  const resolvedConversationId = requestedConversationId || randomUUID();

  await tryPostgresData("student_chat.safety.conversation.write", () =>
    upsertConversation({
      id: resolvedConversationId,
      classId: scope.classId,
      metadata: {
        safetyReview: {
          categories: decision.categories,
          date,
          firstBlockedMessageId: messageId,
          primaryReason: decision.primaryReason,
          riskLevel: decision.riskLevel
        }
      },
      modelId: studentChatSafetyModerationModel,
      studentEmail: String(profile?.email ?? "").trim().toLowerCase(),
      studentId: scope.uid,
      studentName: String(profile?.displayName ?? profile?.email ?? "Student").trim() || "Student",
      teacherId: scope.professorId,
      teacherName: scope.professorName ?? "",
      title: "Safety review needed"
    })
  );

  return resolvedConversationId;
}

async function incrementDailySafetyCount({
  categories,
  categoryScores,
  classId,
  conversationId,
  date,
  messageHash,
  messageId,
  model,
  primaryReason,
  requestId,
  riskLevel,
  studentId
}: {
  categories: string[];
  categoryScores: Record<string, number>;
  classId: string;
  conversationId: string;
  date: string;
  messageHash: string;
  messageId: string;
  model: string;
  primaryReason: string;
  requestId: string;
  riskLevel: StudentChatSafetyDecision["riskLevel"];
  studentId: string;
}) {
  if (!adminDb) {
    return {
      count: 1,
      urgentCount: categories.some((category) => urgentSafetyCategories.has(category)) ? 1 : 0
    };
  }

  const eventRef = adminDb
    .collection("classes")
    .doc(classId)
    .collection("studentChatSafetyEvents")
    .doc(randomUUID());
  const dailyCountId = hashStudentMessageContent([classId, studentId, date].join("|"));
  const dailyCountRef = adminDb
    .collection("classes")
    .doc(classId)
    .collection("studentChatSafetyDailyCounts")
    .doc(dailyCountId);
  const isUrgent = categories.some((category) => urgentSafetyCategories.has(category));

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(dailyCountRef);
    const data = snapshot.data() ?? {};
    const categoryCounts = categoryCountsWithIncrement(data.categoryCounts, categories);
    const nextCount = nonnegativeInteger(data.count) + 1;
    const nextUrgentCount = nonnegativeInteger(data.urgentCount) + (isUrgent ? 1 : 0);

    transaction.set(eventRef, {
      categories,
      categoryScores,
      classId,
      conversationId,
      createdAt: FieldValue.serverTimestamp(),
      date,
      messageHash,
      messageId,
      model,
      primaryReason,
      requestId,
      riskLevel,
      studentId
    });
    transaction.set(dailyCountRef, {
      categoryCounts,
      classId,
      conversationId,
      count: nextCount,
      date,
      lastBlockedAt: FieldValue.serverTimestamp(),
      lastMessageHash: messageHash,
      model,
      studentId,
      urgentCount: nextUrgentCount,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      count: nextCount,
      urgentCount: nextUrgentCount
    };
  });
}

async function markConversationForSafetyReview({
  event,
  urgent
}: {
  event: StudentChatSafetyBlockedEvent;
  urgent: boolean;
}) {
  const flags = urgent
    ? ["student_chat_safety", "urgent_safety_escalation"]
    : ["student_chat_safety"];
  const privateNote = urgent
    ? "Urgent safety review: repeated self-harm or violence-risk blocked chat events today. The flagged blocked message is stored in the scoped safety review field."
    : "Safety review: blocked chat event. The flagged blocked message is stored in the scoped safety review field.";
  const safetyReview = safetyReviewMetadata(event);

  await tryPostgresData("student_chat.safety.conversation_metadata.write", () =>
    updateConversationMetadata({
      id: event.conversationId,
      metadata: {
        safetyReview
      }
    })
  );

  await tryPostgresData("student_chat.safety.review.write", () =>
    upsertConversationReview({
      classId: event.classId,
      conversationId: event.conversationId,
      flags,
      metadata: {
        safetyReview
      },
      privateNote,
      status: "needs_follow_up"
    })
  );

  await tryPostgresData("student_chat.safety.support.write", () =>
    upsertStudentSupport({
      classId: event.classId,
      id: `${event.classId}:${event.studentId}`,
      metadata: {
        safetyReview: {
          categories: event.categories,
          conversationId: event.conversationId,
          count: event.count,
          date: event.date,
          primaryReason: event.primaryReason,
          riskLevel: event.riskLevel,
          pauseAction: event.pauseAction,
          pauseUntil: event.pauseUntil,
          urgent,
          urgentCount: event.urgentCount
        }
      },
      studentEmail: "",
      studentId: event.studentId,
      supportNotes: privateNote
    })
  );

  if (!adminDb) {
    return;
  }

  await adminDb
    .collection("classes")
    .doc(event.classId)
    .collection("conversationReviews")
    .doc(event.conversationId)
    .set({
      classId: event.classId,
      conversationId: event.conversationId,
      flags,
      privateNote,
      reviewedAt: null,
      status: "needs_follow_up",
      updatedAt: FieldValue.serverTimestamp(),
      safetyReview: {
        ...safetyReview,
        urgent,
      }
    }, { merge: true });
}

async function applyStudentChatSafetyPause(event: StudentChatSafetyBlockedEvent) {
  const profile = await getAccountProfile(event.studentId).catch(() => null);
  const studentEmail = String(profile?.email ?? "").trim().toLowerCase();

  if (!studentEmail) {
    return;
  }

  const supportDocumentId = encodeURIComponent(studentEmail);
  const chatBlockedUntil = event.pauseAction === "temporary_pause" ? event.pauseUntil ?? "" : null;
  const metadata = {
    safetyChatPause: {
      action: event.pauseAction,
      conversationId: event.conversationId,
      count: event.count,
      date: event.date,
      messageHash: event.messageHash,
      pausedAt: new Date().toISOString(),
      pauseUntil: chatBlockedUntil,
      primaryReason: event.primaryReason,
      riskLevel: event.riskLevel,
      urgentCount: event.urgentCount
    }
  };

  await tryPostgresData("student_chat.safety.pause.write", () =>
    upsertStudentSupport({
      chatBlocked: true,
      classId: event.classId,
      displayName: String(profile?.displayName ?? profile?.email ?? ""),
      id: `${event.classId}:${supportDocumentId}`,
      metadata,
      studentEmail,
      studentId: event.studentId
    })
  );

  if (!adminDb) {
    return;
  }
  const db = adminDb;

  await db.runTransaction(async (transaction) => {
    const classReference = db.collection("classes").doc(event.classId);
    const supportReference = classReference.collection("studentSupport").doc(supportDocumentId);
    const rosterReference = classReference.collection("students").doc(supportDocumentId);
    const pauseFields = {
      chatBlocked: true,
      chatBlockedReason: "student_chat_safety",
      chatBlockedUntil,
      safetyChatPause: metadata.safetyChatPause,
      studentEmail,
      updatedAt: FieldValue.serverTimestamp()
    };

    transaction.set(supportReference, pauseFields, { merge: true });
    transaction.set(rosterReference, pauseFields, { merge: true });
  });
}

function safetyReviewMetadata(event: StudentChatSafetyBlockedEvent) {
  return {
    blockedMessageText: event.blockedMessageText,
    categories: event.categories,
    count: event.count,
    createdAt: new Date().toISOString(),
    label: "Flagged blocked message",
    messageHash: event.messageHash,
    pauseAction: event.pauseAction,
    pauseUntil: event.pauseUntil,
    primaryReason: event.primaryReason,
    riskLevel: event.riskLevel,
    urgentCount: event.urgentCount
  };
}

function primarySafetyReason(categories: string[]) {
  return categories[0] ?? "moderation_unavailable";
}

function categoryCountsWithIncrement(value: unknown, categories: string[]) {
  const current = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next: Record<string, number> = {};

  for (const [category, count] of Object.entries(current)) {
    next[category] = nonnegativeInteger(count);
  }

  for (const category of categories) {
    next[category] = (next[category] ?? 0) + 1;
  }

  return next;
}

function auditSafetyMetadata(event: StudentChatSafetyBlockedEvent) {
  return {
    categories: event.categories,
    classId: event.classId,
    conversationId: event.conversationId,
    count: event.count,
    date: event.date,
    messageHash: event.messageHash,
    messageId: event.messageId,
    model: event.model,
    primaryReason: event.primaryReason,
    requestId: event.requestId,
    riskLevel: event.riskLevel,
    studentId: event.studentId,
    urgentCount: event.urgentCount
  };
}

function nonnegativeInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}
