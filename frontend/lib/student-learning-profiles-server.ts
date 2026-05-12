import { FieldValue } from "firebase-admin/firestore";
import { adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import type { LearningStrategyProfileContext } from "./learning-strategy-telemetry";
import { defaultOpenRouterModelId } from "./model-options";
import { ConversationPersistenceError, listTeacherConversationMessages } from "./student-conversations-server";
import { tryPostgresData } from "./data/server";
import {
  listStudentConversations as listPostgresStudentConversations,
  listTeacherStudentConversations as listPostgresTeacherStudentConversations,
  type ConversationRecord
} from "./data/conversations";
import {
  addLearningProfileRevision,
  getStudentLearningProfileById,
  upsertStudentLearningProfile,
  type StudentLearningProfileRecord
} from "./data/student-records";
import type {
  ChatMessage,
  LearningStrategyTelemetry,
  RetrievalConfidence,
  StudentLearningEvidenceObservationType,
  StudentLearningProfileConfidence,
  StudentLearningProfileContent,
  StudentLearningProfileDocument,
  StudentLearningStrategyStatus,
  StudentLearningTriedStrategy
} from "./types";

export const defaultMinimumConversationsForUpdate = 3;
export const defaultMinimumStudentMessagesForUpdate = 8;

const maxSummaryLength = 800;
const maxArrayItems = 8;
const maxArrayItemLength = 240;
const maxEvidenceItems = 20;
const maxTriedStrategies = 12;
const profileModelMaxConversations = 8;
const profileModelMaxMessagesPerConversation = 20;

const strategyStatuses = new Set<StudentLearningStrategyStatus>([
  "try_next",
  "currently_testing",
  "appears_helpful",
  "appears_unhelpful",
  "inconclusive",
  "retired"
]);
const evidenceObservationTypes = new Set<StudentLearningEvidenceObservationType>([
  "learning_signal",
  "strategy_helpful",
  "strategy_unhelpful",
  "improvement",
  "open_question"
]);
const confidenceValues = new Set<StudentLearningProfileConfidence>(["low", "medium", "high"]);
const unsafeStudentLabels = /\b(lazy|weak|anxious|disabled|unmotivated|slow|low[-\s]?ability|adhd|autistic|depressed|traumatized)\b/i;

export type StudentLearningProfileUpdateResult = {
  attempted: boolean;
  draftCreated: boolean;
  pendingConversationCount: number;
  pendingStudentMessageCount: number;
  profileId: string;
  reason: "updated" | "below_threshold" | "missing_student" | "model_unavailable" | "no_recent_data";
};

type StudentProfileIdentity = {
  classId: string;
  studentEmail?: string;
  studentId?: string;
};

type ProfileUpdateGenerator = (input: {
  previousProfile: StudentLearningProfileContent | null;
  conversations: StudentLearningConversationForModel[];
}) => Promise<unknown>;

type StudentLearningConversationForModel = {
  id: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  messages: Array<{
    id: string;
    role: "student" | "assistant";
    createdAt: string;
    content: string;
    learningStrategyTelemetry?: LearningStrategyTelemetry;
    retrievalConfidence?: RetrievalConfidence;
    sources?: ChatMessage["sources"];
  }>;
};

type StudentConversationDocForProfile = {
  id: string;
  data: () => Record<string, unknown>;
};

export function encodedStudentLearningProfileId({ studentEmail, studentId }: { studentEmail?: string; studentId?: string }) {
  const normalizedEmail = String(studentEmail ?? "").trim().toLowerCase();
  const fallbackId = String(studentId ?? "").trim();
  return encodeURIComponent(normalizedEmail || fallbackId);
}

export async function getActiveStudentLearningProfileDigest(input: StudentProfileIdentity) {
  return (await getActiveStudentLearningProfileTutorContext(input)).digest;
}

export async function getActiveStudentLearningProfileTutorContext(
  input: StudentProfileIdentity
): Promise<LearningStrategyProfileContext> {
  const profileDocument = await getStudentLearningProfile(input);

  if (!profileDocument?.active || !profileDocument.teacherReviewed || !profileDocument.activeProfile) {
    return {
      digest: "",
      strategies: []
    };
  }

  return {
    digest: buildStudentLearningProfileDigest(profileDocument),
    strategies: buildLearningStrategyTelemetryCandidates(profileDocument.activeProfile)
  };
}

export async function getStudentLearningProfile(input: StudentProfileIdentity): Promise<StudentLearningProfileDocument | null> {
  assertFirebaseAdminAuthReady();

  const identity = await resolveStudentProfileIdentity(input);
  const profileId = encodedStudentLearningProfileId(identity);

  if (!profileId) {
    return null;
  }

  const postgresProfile = await tryPostgresData("learning_profile.read", () => getStudentLearningProfileById(`${identity.classId}:${profileId}`));

  if (postgresProfile) {
    return profileRecordToApi(profileId, postgresProfile);
  }

  const snapshot = await adminDb!
    .collection("classes")
    .doc(identity.classId)
    .collection("studentLearningProfiles")
    .doc(profileId)
    .get();

  return snapshot.exists ? profileDocToApi(profileId, snapshot.data() ?? {}) : null;
}

export async function updateOneStudentLearningProfile({
  classId,
  force = false,
  generator,
  lookbackDays,
  studentEmail,
  studentId
}: StudentProfileIdentity & {
  force?: boolean;
  generator?: ProfileUpdateGenerator;
  lookbackDays?: number;
}): Promise<StudentLearningProfileUpdateResult> {
  assertFirebaseAdminAuthReady();

  const identity = await resolveStudentProfileIdentity({ classId, studentEmail, studentId });

  if (!identity.studentEmail && !identity.studentId) {
    return {
      attempted: false,
      draftCreated: false,
      pendingConversationCount: 0,
      pendingStudentMessageCount: 0,
      profileId: "",
      reason: "missing_student"
    };
  }

  const profileId = encodedStudentLearningProfileId(identity);
  const profileReference = adminDb!
    .collection("classes")
    .doc(classId)
    .collection("studentLearningProfiles")
    .doc(profileId);
  const profileSnapshot = await profileReference.get();
  const existingProfile = profileSnapshot.exists ? profileDocToApi(profileId, profileSnapshot.data() ?? {}) : null;
  const minimumConversationsForUpdate =
    existingProfile?.minimumConversationsForUpdate ?? defaultMinimumConversationsForUpdate;
  const minimumStudentMessagesForUpdate =
    existingProfile?.minimumStudentMessagesForUpdate ?? defaultMinimumStudentMessagesForUpdate;
  const updateSince = force && lookbackDays ? lookbackDateIso(lookbackDays) : existingProfile?.lastSuccessfulUpdateAt;
  const counts = await countPendingConversationData({
    classId,
    since: updateSince,
    studentEmail: identity.studentEmail,
    studentId: identity.studentId
  });
  const baseMetadata = {
    active: existingProfile?.active ?? false,
    classId,
    confidence: existingProfile?.confidence ?? ("low" as const),
    lastUpdateAttemptAt: FieldValue.serverTimestamp(),
    minimumConversationsForUpdate,
    minimumStudentMessagesForUpdate,
    pendingConversationCount: counts.pendingConversationCount,
    pendingStudentMessageCount: counts.pendingStudentMessageCount,
    studentEmail: identity.studentEmail ?? existingProfile?.studentEmail ?? "",
    studentId: identity.studentId ?? existingProfile?.studentId ?? "",
    studentName: identity.studentName ?? existingProfile?.studentName ?? "Student"
  };
  const thresholdMet =
    counts.pendingConversationCount >= minimumConversationsForUpdate ||
    counts.pendingStudentMessageCount >= minimumStudentMessagesForUpdate;

  await profileReference.set(baseMetadata, { merge: true });
  await tryPostgresData("learning_profile.metadata.write", () =>
    upsertStudentLearningProfile({
      classId,
      id: `${classId}:${profileId}`,
      confidence: existingProfile?.confidence ?? "low",
      metadata: {
        ...baseMetadata,
        lastUpdateAttemptAt: new Date().toISOString()
      },
      studentEmail: identity.studentEmail ?? existingProfile?.studentEmail ?? "",
      studentId: identity.studentId ?? existingProfile?.studentId ?? "",
      studentName: identity.studentName ?? existingProfile?.studentName ?? "Student"
    })
  );

  if (force && counts.pendingConversationCount === 0 && counts.pendingStudentMessageCount === 0) {
    return {
      attempted: true,
      draftCreated: false,
      pendingConversationCount: 0,
      pendingStudentMessageCount: 0,
      profileId,
      reason: "no_recent_data"
    };
  }

  if (!force && !thresholdMet) {
    return {
      attempted: true,
      draftCreated: false,
      pendingConversationCount: counts.pendingConversationCount,
      pendingStudentMessageCount: counts.pendingStudentMessageCount,
      profileId,
      reason: "below_threshold"
    };
  }

  const conversations = await loadRecentConversationsForProfileUpdate({
    classId,
    since: updateSince,
    studentEmail: identity.studentEmail,
    studentId: identity.studentId
  });
  const previousProfile = existingProfile?.draftProfile ?? existingProfile?.activeProfile ?? null;
  const modelOutput = await (generator ?? generateProfileUpdateWithOpenRouter)({
    conversations,
    previousProfile
  });
  const draftProfile = normalizeStudentLearningProfileContent(modelOutput);
  const confidence = inferProfileConfidence({
    conversationCount: counts.pendingConversationCount,
    existingConfidence: existingProfile?.confidence,
    profile: draftProfile,
    studentMessageCount: counts.pendingStudentMessageCount
  });

  await profileReference.set(
    {
      ...baseMetadata,
      active: existingProfile?.active ?? false,
      confidence,
      draftCreatedAt: FieldValue.serverTimestamp(),
      draftProfile,
      teacherReviewed: false,
      updatedAt: FieldValue.serverTimestamp(),
      lastSuccessfulUpdateAt: FieldValue.serverTimestamp(),
      pendingConversationCount: 0,
      pendingStudentMessageCount: 0,
      ...profileContentTopLevelFields(existingProfile?.activeProfile ?? null)
    },
    { merge: true }
  );
  await tryPostgresData("learning_profile.draft.write", () =>
    upsertStudentLearningProfile({
      activeProfile: existingProfile?.activeProfile ?? null,
      classId,
      confidence,
      draftProfile,
      id: `${classId}:${profileId}`,
      metadata: {
        ...baseMetadata,
        active: existingProfile?.active ?? false,
        lastSuccessfulUpdateAt: new Date().toISOString(),
        teacherReviewed: false
      },
      studentEmail: identity.studentEmail ?? existingProfile?.studentEmail ?? "",
      studentId: identity.studentId ?? existingProfile?.studentId ?? "",
      studentName: identity.studentName ?? existingProfile?.studentName ?? "Student"
    })
  );
  await profileReference.collection("revisions").add({
    confidence,
    createdAt: FieldValue.serverTimestamp(),
    profile: draftProfile,
    source: "automated_update",
    status: "draft",
    triggerCounts: counts
  });
  await tryPostgresData("learning_profile.revision.write", () =>
    addLearningProfileRevision({
      classId,
      confidence,
      nextProfile: draftProfile,
      previousProfile,
      profileId: `${classId}:${profileId}`,
      revisionType: "draft_generated",
      studentId: identity.studentId ?? null
    })
  );

  return {
    attempted: true,
    draftCreated: true,
    pendingConversationCount: counts.pendingConversationCount,
    pendingStudentMessageCount: counts.pendingStudentMessageCount,
    profileId,
    reason: "updated"
  };
}

export async function updateWeeklyStudentLearningProfiles({
  classId,
  generator
}: {
  classId?: string;
  generator?: ProfileUpdateGenerator;
} = {}) {
  assertFirebaseAdminAuthReady();

  const classSnapshots = classId
    ? [await adminDb!.collection("classes").doc(classId).get()]
    : (await adminDb!.collection("classes").get()).docs;
  const results: StudentLearningProfileUpdateResult[] = [];

  for (const classSnapshot of classSnapshots) {
    if (!classSnapshot.exists) {
      continue;
    }

    const rosterSnapshot = await classSnapshot.ref.collection("students").get();

    for (const studentDoc of rosterSnapshot.docs) {
      const student = studentDoc.data() ?? {};
      try {
        results.push(
          await updateOneStudentLearningProfile({
            classId: classSnapshot.id,
            generator,
            studentEmail: String(student.email ?? ""),
            studentId: studentDoc.id
          })
        );
      } catch {
        results.push({
          attempted: true,
          draftCreated: false,
          pendingConversationCount: 0,
          pendingStudentMessageCount: 0,
          profileId: encodedStudentLearningProfileId({
            studentEmail: String(student.email ?? ""),
            studentId: studentDoc.id
          }),
          reason: "model_unavailable"
        });
      }
    }
  }

  return results;
}

export async function approveStudentLearningProfile({
  classId,
  profile,
  studentEmail,
  studentId
}: StudentProfileIdentity & {
  profile?: unknown;
}) {
  const profileDocument = await getStudentLearningProfile({ classId, studentEmail, studentId });

  if (!profileDocument) {
    throw new ConversationPersistenceError("Learning profile was not found.", 404);
  }

  const identity = await resolveStudentProfileIdentity({ classId, studentEmail, studentId });
  const profileId = encodedStudentLearningProfileId(identity);
  const activeProfile = normalizeStudentLearningProfileContent(
    profile ?? profileDocument.draftProfile ?? profileDocument.activeProfile
  );

  await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("studentLearningProfiles")
    .doc(profileId)
    .set(
      {
        active: true,
        activeProfile,
        draftProfile: null,
        teacherReviewed: true,
        updatedAt: FieldValue.serverTimestamp(),
        lastReviewedAt: FieldValue.serverTimestamp(),
        ...profileContentTopLevelFields(activeProfile)
      },
      { merge: true }
    );
  await tryPostgresData("learning_profile.approve.write", () =>
    upsertStudentLearningProfile({
      activeProfile,
      approvedAt: new Date(),
      classId,
      confidence: profileDocument.confidence,
      draftProfile: null,
      id: `${classId}:${profileId}`,
      metadata: { active: true, teacherReviewed: true },
      studentEmail: identity.studentEmail ?? profileDocument.studentEmail,
      studentId: identity.studentId ?? profileDocument.studentId,
      studentName: identity.studentName ?? profileDocument.studentName
    })
  );
  await tryPostgresData("learning_profile.approve_revision.write", () =>
    addLearningProfileRevision({
      classId,
      confidence: profileDocument.confidence,
      nextProfile: activeProfile,
      previousProfile: profileDocument.activeProfile,
      profileId: `${classId}:${profileId}`,
      revisionType: "approved",
      studentId: identity.studentId ?? null
    })
  );
}

export async function saveDraftStudentLearningProfile({
  classId,
  profile,
  studentEmail,
  studentId
}: StudentProfileIdentity & {
  profile: unknown;
}) {
  const identity = await resolveStudentProfileIdentity({ classId, studentEmail, studentId });
  const profileId = encodedStudentLearningProfileId(identity);
  const draftProfile = normalizeStudentLearningProfileContent(profile);

  await adminDb!
    .collection("classes")
    .doc(classId)
    .collection("studentLearningProfiles")
    .doc(profileId)
    .set(
      {
        classId,
        draftProfile,
        studentEmail: identity.studentEmail ?? "",
        studentId: identity.studentId ?? "",
        studentName: identity.studentName ?? "Student",
        teacherReviewed: false,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  await tryPostgresData("learning_profile.draft_save.write", () =>
    upsertStudentLearningProfile({
      classId,
      draftProfile,
      id: `${classId}:${profileId}`,
      metadata: { teacherReviewed: false },
      studentEmail: identity.studentEmail ?? "",
      studentId: identity.studentId ?? "",
      studentName: identity.studentName ?? "Student"
    })
  );
}

export async function disableStudentLearningProfile(input: StudentProfileIdentity) {
  await setProfileState(input, {
    active: false,
    teacherReviewed: true,
    updatedAt: FieldValue.serverTimestamp()
  });
}

export async function clearDraftStudentLearningProfile(input: StudentProfileIdentity) {
  await setProfileState(input, {
    draftProfile: null,
    updatedAt: FieldValue.serverTimestamp()
  });
}

export async function clearStudentLearningProfile(input: StudentProfileIdentity) {
  await setProfileState(input, {
    active: false,
    activeProfile: null,
    draftProfile: null,
    teacherReviewed: true,
    updatedAt: FieldValue.serverTimestamp(),
    ...profileContentTopLevelFields(null)
  });
}

export function normalizeStudentLearningProfileContent(value: unknown): StudentLearningProfileContent {
  const source = isRecord(value) ? value : {};

  return {
    summary: sanitizeProfileText(source.summary, maxSummaryLength),
    learningSignals: sanitizeProfileTextArray(source.learningSignals),
    effectiveSupports: sanitizeProfileTextArray(source.effectiveSupports),
    lessEffectiveSupports: sanitizeProfileTextArray(source.lessEffectiveSupports),
    strategiesToTryNext: sanitizeProfileTextArray(source.strategiesToTryNext),
    avoid: sanitizeProfileTextArray(source.avoid),
    openQuestions: sanitizeProfileTextArray(source.openQuestions),
    notableImprovements: sanitizeProfileTextArray(source.notableImprovements),
    profileChangeNotes: sanitizeProfileTextArray(source.profileChangeNotes),
    triedStrategies: Array.isArray(source.triedStrategies)
      ? source.triedStrategies.slice(0, maxTriedStrategies).map(normalizeTriedStrategy).filter((strategy) => strategy.strategy)
      : [],
    evidence: Array.isArray(source.evidence)
      ? source.evidence.slice(0, maxEvidenceItems).map(normalizeEvidence).filter((evidence) => evidence.note)
      : []
  };
}

export function isStudentLearningStrategyStatus(value: unknown): value is StudentLearningStrategyStatus {
  return typeof value === "string" && strategyStatuses.has(value as StudentLearningStrategyStatus);
}

function buildStudentLearningProfileDigest(profileDocument: StudentLearningProfileDocument) {
  const profile = profileDocument.activeProfile;

  if (!profile) {
    return "";
  }

  const sections = [
    compactProfileLine("Summary", [profile.summary]),
    compactProfileLine("Learning signals", profile.learningSignals),
    compactProfileLine("Effective supports", profile.effectiveSupports),
    compactProfileLine("Less effective supports", profile.lessEffectiveSupports),
    compactProfileLine("Try next", profile.strategiesToTryNext),
    compactProfileLine("Avoid repeating", profile.avoid),
    compactProfileLine(
      "Strategies being tested",
      profile.triedStrategies
        .filter((strategy) => strategy.status === "try_next" || strategy.status === "currently_testing")
        .slice(0, 4)
        .map((strategy) => `${strategy.strategy} (${strategy.status}; next: ${strategy.nextAction})`)
    ),
    compactProfileLine("Notable improvements", profile.notableImprovements),
    compactProfileLine("Open questions", profile.openQuestions)
  ].filter(Boolean);

  return sections.join("\n").slice(0, 2400);
}

function compactProfileLine(label: string, items: string[]) {
  const filteredItems = items.map((item) => item.trim()).filter(Boolean).slice(0, 4);
  return filteredItems.length ? `${label}: ${filteredItems.join("; ")}` : "";
}

function buildLearningStrategyTelemetryCandidates(profile: StudentLearningProfileContent) {
  return [
    ...profile.strategiesToTryNext.map((strategy) => ({
      label: strategy,
      source: "strategiesToTryNext" as const
    })),
    ...profile.triedStrategies.map((strategy) => ({
      id: strategy.id,
      label: strategy.strategy,
      source: "triedStrategies" as const
    }))
  ].filter((strategy) => strategy.label.trim());
}

async function setProfileState(input: StudentProfileIdentity, data: Record<string, unknown>) {
  const identity = await resolveStudentProfileIdentity(input);
  const profileId = encodedStudentLearningProfileId(identity);

  if (!profileId) {
    throw new ConversationPersistenceError("Student is required.", 400);
  }

  await adminDb!
    .collection("classes")
    .doc(identity.classId)
    .collection("studentLearningProfiles")
    .doc(profileId)
    .set(data, { merge: true });
  await tryPostgresData("learning_profile.state.write", () =>
    upsertStudentLearningProfile({
      activeProfile: Object.prototype.hasOwnProperty.call(data, "activeProfile")
        ? data.activeProfile
          ? normalizeStudentLearningProfileContent(data.activeProfile) as unknown as Record<string, unknown>
          : null
        : undefined,
      classId: identity.classId,
      disabled: data.active === false && !Object.prototype.hasOwnProperty.call(data, "activeProfile"),
      draftProfile: Object.prototype.hasOwnProperty.call(data, "draftProfile")
        ? data.draftProfile
          ? normalizeStudentLearningProfileContent(data.draftProfile) as unknown as Record<string, unknown>
          : null
        : undefined,
      id: `${identity.classId}:${profileId}`,
      metadata: profileStateMetadata(data),
      studentEmail: identity.studentEmail ?? "",
      studentId: identity.studentId ?? "",
      studentName: identity.studentName ?? "Student"
    })
  );
}

function profileStateMetadata(data: Record<string, unknown>) {
  const metadata: Record<string, unknown> = {};

  for (const key of [
    "active",
    "teacherReviewed",
    "lastReviewedAt",
    "lastSuccessfulUpdateAt",
    "lastUpdateAttemptAt",
    "minimumConversationsForUpdate",
    "minimumStudentMessagesForUpdate",
    "pendingConversationCount",
    "pendingStudentMessageCount"
  ]) {
    const value = data[key];

    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key] = value;
    }
  }

  return metadata;
}

async function resolveStudentProfileIdentity(input: StudentProfileIdentity) {
  const normalizedEmail = String(input.studentEmail ?? "").trim().toLowerCase();
  let studentId = String(input.studentId ?? "").trim();
  let studentEmail = normalizedEmail;
  let studentName = "";

  if (studentEmail) {
    const rosterSnapshot = await adminDb!
      .collection("classes")
      .doc(input.classId)
      .collection("students")
      .doc(encodeURIComponent(studentEmail))
      .get();

    if (rosterSnapshot.exists) {
      const student = rosterSnapshot.data() ?? {};
      studentId = studentId || rosterSnapshot.id;
      studentName = String(student.displayName ?? "").trim();
    }
  }

  if (!studentEmail && studentId) {
    const userSnapshot = await adminDb!.collection("users").doc(studentId).get();
    const user = userSnapshot.data() ?? {};
    studentEmail = String(user.email ?? "").trim().toLowerCase();
    studentName = String(user.displayName ?? "").trim();
  }

  return {
    classId: input.classId,
    studentEmail,
    studentId,
    studentName
  };
}

async function countPendingConversationData({
  classId,
  since,
  studentEmail,
  studentId
}: StudentProfileIdentity & {
  since: unknown;
}) {
  const sinceMillis = timestampMillis(since);
  const conversationDocs = await getStudentConversationDocs({ classId, studentEmail, studentId });
  let pendingConversationCount = 0;
  let pendingStudentMessageCount = 0;

  for (const conversationDoc of conversationDocs) {
    const conversation = conversationDoc.data() ?? {};
    const conversationCreatedAt = timestampMillis(conversation.createdAt);

    if (!sinceMillis || conversationCreatedAt > sinceMillis) {
      pendingConversationCount += 1;
    }

    const messages = await listTeacherConversationMessages({ classId, conversationId: conversationDoc.id });

    messages.forEach((message) => {
      if (message.role === "student" && (!sinceMillis || timestampMillis(message.createdAt) > sinceMillis)) {
        pendingStudentMessageCount += 1;
      }
    });
  }

  return { pendingConversationCount, pendingStudentMessageCount };
}

async function loadRecentConversationsForProfileUpdate({
  classId,
  since,
  studentEmail,
  studentId
}: StudentProfileIdentity & {
  since: unknown;
}): Promise<StudentLearningConversationForModel[]> {
  const sinceMillis = timestampMillis(since);
  const conversationDocs = (await getStudentConversationDocs({ classId, studentEmail, studentId })).sort(
    (first, second) => timestampMillis(second.data().lastMessageAt) - timestampMillis(first.data().lastMessageAt)
  );
  const conversations: StudentLearningConversationForModel[] = [];

  for (const conversationDoc of conversationDocs.slice(0, profileModelMaxConversations)) {
    const conversation = conversationDoc.data() ?? {};
    const messages = await listTeacherConversationMessages({ classId, conversationId: conversationDoc.id });
    const transcriptMessages = messages.filter((message) => message.role === "student" || message.role === "assistant");
    const filteredMessages = selectProfileUpdateTranscriptMessages(transcriptMessages, sinceMillis)
      .slice(-profileModelMaxMessagesPerConversation);

    if (!filteredMessages.length) {
      continue;
    }

    conversations.push({
      createdAt: String(serializeFirestoreValue(conversation.createdAt) ?? ""),
      id: conversationDoc.id,
      lastMessageAt: String(serializeFirestoreValue(conversation.lastMessageAt) ?? ""),
      messages: filteredMessages.map((message) => ({
        content: sanitizeTranscriptText(message.content),
        createdAt: message.createdAt,
        id: message.id,
        learningStrategyTelemetry: message.role === "assistant" ? message.learningStrategyTelemetry : undefined,
        retrievalConfidence: message.role === "assistant" ? message.retrievalConfidence : undefined,
        sources: message.role === "assistant" ? message.sources : undefined,
        role: message.role as "student" | "assistant"
      })),
      title: String(conversation.title ?? "Conversation").slice(0, 120)
    });
  }

  return conversations;
}

function selectProfileUpdateTranscriptMessages(messages: ChatMessage[], sinceMillis: number) {
  if (!sinceMillis) {
    return messages;
  }

  const includedIndexes = new Set<number>();

  messages.forEach((message, index) => {
    if (timestampMillis(message.createdAt) <= sinceMillis) {
      return;
    }

    includedIndexes.add(index - 1);
    includedIndexes.add(index);
    includedIndexes.add(index + 1);
  });

  return messages.filter((_message, index) => includedIndexes.has(index));
}

async function getStudentConversationDocs({
  classId,
  studentEmail,
  studentId
}: StudentProfileIdentity): Promise<StudentConversationDocForProfile[]> {
  const normalizedEmail = String(studentEmail ?? "").trim().toLowerCase();
  const postgresConversations = normalizedEmail
    ? await listPostgresTeacherStudentConversations({ classId, studentEmail: normalizedEmail })
    : studentId
      ? await listPostgresStudentConversations({ classId, studentId })
      : [];

  return postgresConversations.map((conversation) => ({
    id: conversation.id,
    data: () => conversationRecordToProfileData(conversation)
  }));
}

function conversationRecordToProfileData(conversation: ConversationRecord): Record<string, unknown> {
  return {
    assignment: conversation.assignment,
    classId: conversation.classId,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? conversation.updatedAt.toISOString(),
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

async function generateProfileUpdateWithOpenRouter(input: {
  previousProfile: StudentLearningProfileContent | null;
  conversations: StudentLearningConversationForModel[];
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new ConversationPersistenceError("Learning profile model updates require OPENROUTER_API_KEY.", 503);
  }

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    body: JSON.stringify({
      model: process.env.LEARNING_PROFILE_MODEL || process.env.DEFAULT_MODEL || defaultOpenRouterModelId,
      messages: [
        {
          role: "system",
          content: buildProfileUpdateSystemPrompt()
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER } : {}),
      ...(process.env.OPENROUTER_APP_TITLE ? { "X-Title": process.env.OPENROUTER_APP_TITLE } : {})
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new ConversationPersistenceError("Learning profile model update failed.", response.status);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ConversationPersistenceError("Learning profile model returned invalid JSON.", 502);
  }
}

function buildProfileUpdateSystemPrompt() {
  return [
    "Update a private student_learning_profile from recent tutor conversations. Return strict JSON only.",
    "The profile describes observed tutoring supports and interaction patterns, never fixed judgments about the student.",
    "Use phrasing like 'the student benefits from...' or 'try...'. Do not label the student lazy, weak, anxious, disabled, unmotivated, or similar.",
    "Do not infer diagnosis, emotion, protected or sensitive traits, discipline, placement, grading, or high-stakes decisions.",
    "Preserve useful existing profile details, remove stale or contradicted claims, and avoid overfitting to one conversation.",
    "Use assistant learningStrategyTelemetry when present to update triedStrategies, effectiveSupports, lessEffectiveSupports, strategiesToTryNext, and evidence.",
    "Treat telemetry as teacher-only strategy evidence, not as grading, discipline, diagnosis, placement, or sensitive trait data.",
    "When telemetry observedOutcome is student_progressed, consider whether the selected tutorMove or selectedStrategy appears helpful, using adjacent student turns as confirmation.",
    "When telemetry observedOutcome is student_still_stuck, consider whether to mark the support less effective, revise nextAction, or try a different strategy.",
    "Update strategy statuses, retire ineffective supports, add strategies to try, track small improvements, and include concise evidence references.",
    "In profileChangeNotes, briefly explain meaningful changes from the previous profile and the evidence behind them.",
    "JSON fields: summary, learningSignals, effectiveSupports, lessEffectiveSupports, strategiesToTryNext, avoid, openQuestions, notableImprovements, profileChangeNotes, triedStrategies, evidence.",
    "Keep summary under 800 characters, arrays concise, evidence at most 20 items, and triedStrategies at most 12 items."
  ].join("\n");
}

function normalizeTriedStrategy(value: unknown): StudentLearningTriedStrategy {
  const source = isRecord(value) ? value : {};
  const rawStatus = source.status;
  const status = isStudentLearningStrategyStatus(rawStatus) ? rawStatus : "inconclusive";

  return {
    id: sanitizeProfileText(source.id, 80) || `strategy-${Math.random().toString(36).slice(2, 10)}`,
    strategy: sanitizeProfileText(source.strategy, maxArrayItemLength),
    reasonTried: sanitizeProfileText(source.reasonTried, maxArrayItemLength),
    firstTriedAt: sanitizeProfileText(source.firstTriedAt, 80),
    lastObservedAt: sanitizeProfileText(source.lastObservedAt, 80),
    status,
    evidenceFor: sanitizeProfileTextArray(source.evidenceFor, 4),
    evidenceAgainst: sanitizeProfileTextArray(source.evidenceAgainst, 4),
    nextAction: sanitizeProfileText(source.nextAction, maxArrayItemLength)
  };
}

function normalizeEvidence(value: unknown) {
  const source = isRecord(value) ? value : {};
  const rawObservationType = source.observationType;
  const observationType = evidenceObservationTypes.has(rawObservationType as StudentLearningEvidenceObservationType)
    ? (rawObservationType as StudentLearningEvidenceObservationType)
    : "open_question";

  return {
    conversationId: sanitizeProfileText(source.conversationId, 120),
    messageId: sanitizeProfileText(source.messageId, 120) || undefined,
    date: sanitizeProfileText(source.date, 80) || undefined,
    observationType,
    note: sanitizeProfileText(source.note, maxArrayItemLength)
  };
}

function sanitizeProfileTextArray(value: unknown, limit = maxArrayItems) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => sanitizeProfileText(item, maxArrayItemLength))
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizeProfileText(value: unknown, maxLength: number) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || unsafeStudentLabels.test(text)) {
    return "";
  }

  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

function sanitizeTranscriptText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function inferProfileConfidence({
  conversationCount,
  existingConfidence,
  profile,
  studentMessageCount
}: {
  conversationCount: number;
  existingConfidence?: StudentLearningProfileConfidence;
  profile: StudentLearningProfileContent;
  studentMessageCount: number;
}) {
  if (existingConfidence && confidenceValues.has(existingConfidence) && conversationCount < 3 && studentMessageCount < 8) {
    return existingConfidence;
  }

  if (conversationCount >= 6 || studentMessageCount >= 20) {
    return "high" as const;
  }

  if (conversationCount >= 3 || studentMessageCount >= 8 || profile.evidence.length >= 4) {
    return "medium" as const;
  }

  return "low" as const;
}

function profileContentTopLevelFields(profile: StudentLearningProfileContent | null) {
  return {
    summary: profile?.summary ?? "",
    learningSignals: profile?.learningSignals ?? [],
    effectiveSupports: profile?.effectiveSupports ?? [],
    lessEffectiveSupports: profile?.lessEffectiveSupports ?? [],
    strategiesToTryNext: profile?.strategiesToTryNext ?? [],
    avoid: profile?.avoid ?? [],
    openQuestions: profile?.openQuestions ?? [],
    notableImprovements: profile?.notableImprovements ?? [],
    profileChangeNotes: profile?.profileChangeNotes ?? [],
    triedStrategies: profile?.triedStrategies ?? [],
    evidence: profile?.evidence ?? []
  };
}

function profileDocToApi(id: string, data: Record<string, unknown>): StudentLearningProfileDocument {
  return {
    id,
    active: Boolean(data.active),
    activeProfile: data.activeProfile ? normalizeStudentLearningProfileContent(data.activeProfile) : null,
    classId: String(data.classId ?? ""),
    confidence: confidenceValues.has(data.confidence as StudentLearningProfileConfidence)
      ? (data.confidence as StudentLearningProfileConfidence)
      : "low",
    draftProfile: data.draftProfile ? normalizeStudentLearningProfileContent(data.draftProfile) : null,
    lastReviewedAt: serializeFirestoreValue(data.lastReviewedAt),
    lastSuccessfulUpdateAt: serializeFirestoreValue(data.lastSuccessfulUpdateAt),
    lastUpdateAttemptAt: serializeFirestoreValue(data.lastUpdateAttemptAt),
    minimumConversationsForUpdate: Number(data.minimumConversationsForUpdate ?? defaultMinimumConversationsForUpdate),
    minimumStudentMessagesForUpdate: Number(
      data.minimumStudentMessagesForUpdate ?? defaultMinimumStudentMessagesForUpdate
    ),
    pendingConversationCount: Number(data.pendingConversationCount ?? 0),
    pendingStudentMessageCount: Number(data.pendingStudentMessageCount ?? 0),
    studentEmail: String(data.studentEmail ?? ""),
    studentId: String(data.studentId ?? ""),
    studentName: String(data.studentName ?? "Student"),
    teacherReviewed: Boolean(data.teacherReviewed),
    updatedAt: serializeFirestoreValue(data.updatedAt)
  };
}

function profileRecordToApi(id: string, record: StudentLearningProfileRecord): StudentLearningProfileDocument {
  const metadata = record.metadata ?? {};
  const activeProfile = record.activeProfile ? normalizeStudentLearningProfileContent(record.activeProfile) : null;
  const draftProfile = record.draftProfile ? normalizeStudentLearningProfileContent(record.draftProfile) : null;

  return {
    id,
    active: !record.disabled && Boolean(metadata.active),
    activeProfile,
    classId: record.classId,
    confidence: confidenceValues.has(record.confidence) ? record.confidence : "low",
    draftProfile,
    lastReviewedAt: serializePostgresValue(metadata.lastReviewedAt ?? record.approvedAt),
    lastSuccessfulUpdateAt: serializePostgresValue(metadata.lastSuccessfulUpdateAt),
    lastUpdateAttemptAt: serializePostgresValue(metadata.lastUpdateAttemptAt),
    minimumConversationsForUpdate: Number(metadata.minimumConversationsForUpdate ?? defaultMinimumConversationsForUpdate),
    minimumStudentMessagesForUpdate: Number(
      metadata.minimumStudentMessagesForUpdate ?? defaultMinimumStudentMessagesForUpdate
    ),
    pendingConversationCount: Number(metadata.pendingConversationCount ?? 0),
    pendingStudentMessageCount: Number(metadata.pendingStudentMessageCount ?? 0),
    studentEmail: record.studentEmail,
    studentId: record.studentId ?? "",
    studentName: record.studentName || "Student",
    teacherReviewed: Boolean(metadata.teacherReviewed),
    updatedAt: record.updatedAt.toISOString()
  };
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

function serializePostgresValue(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return serializeFirestoreValue(value);
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    return Date.parse(value) || 0;
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }

  return 0;
}

function lookbackDateIso(days: number) {
  const normalizedDays = Number.isFinite(days) ? Math.max(1, Math.min(30, Math.floor(days))) : 7;
  return new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
