import { conversationNeedsTeacherReview } from "../conversation-review-utils.ts";
import {
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeNotificationSettings,
  normalizePrivacySettings,
  normalizeResponseFormatSettings,
  normalizeSourceDefaultsSettings,
  normalizeSourceUsageSettings,
  normalizeTutorAccessSettings
} from "../class-settings.ts";
import type { MaterialRecord } from "../data/materials.ts";
import type { StudentRosterActivitySummary, TeacherConversationReviewSummary } from "../types.ts";

type ReadToolDependencies = {
  listClassMaterials?: (classId: string) => Promise<MaterialRecord[]>;
  listRosterActivity?: (classId: string) => Promise<StudentRosterActivitySummary[]>;
  listTeacherClassConversations?: (classId: string) => Promise<TeacherConversationReviewSummary[]>;
};

export async function getTeacherDashboardSummaryTool({
  classId,
  timezone
}: {
  classId: string;
  timezone?: string;
}) {
  const { getTeacherClassOverview } = await import("../teacher-overview-server.ts");
  const overview = await getTeacherClassOverview({
    classId,
    timezone
  });

  return {
    classId,
    date: overview.date,
    metrics: overview.metrics,
    nextActions: overview.nextActions.slice(0, 5),
    reviewQueueCount: overview.reviewQueueRows.length,
    summary: overview.summary,
    topReviewItems: overview.reviewQueueRows.slice(0, 5)
  };
}

export async function getReviewQueueTool({ classId }: { classId: string }) {
  const conversations = await listTeacherClassConversationsForAssistant(classId);
  const reviewQueue = conversations
    .filter((conversation) =>
      conversationNeedsTeacherReview({
        feedbackSummary: conversation.feedbackSummary,
        followUpDueAt: conversation.review.followUpDueAt,
        status: conversation.reviewStatus
      })
    )
    .slice(0, 20)
    .map(conversationToReviewQueueItem);

  return {
    classId,
    count: reviewQueue.length,
    reviewQueue
  };
}

export async function searchStudentsForAssistant({ classId, query }: { classId: string; query: string }) {
  return searchStudentsForAssistantWithDependencies({ classId, query });
}

export async function searchStudentsForAssistantWithDependencies(
  {
    classId,
    query
  }: {
    classId: string;
    query: string;
  },
  dependencies: ReadToolDependencies = {}
) {
  const normalizedQuery = query.trim().toLowerCase();
  const roster = dependencies.listRosterActivity
    ? await dependencies.listRosterActivity(classId)
    : await listTeacherRosterActivityForAssistant(classId);

  return roster
    .filter((student) =>
      normalizedQuery
        ? `${student.displayName} ${student.studentEmail}`.toLowerCase().includes(normalizedQuery)
        : true
    )
    .slice(0, 10)
    .map((student) => ({
      chatBlocked: student.chatBlocked,
      conversationCount: student.conversationCount,
      displayName: student.displayName,
      email: student.studentEmail,
      lastActiveAt: student.lastActiveAt,
      status: student.status,
      studentId: student.studentId
    }));
}

export async function getStudentContextTool(
  {
    classId,
    studentEmail
  }: {
    classId: string;
    studentEmail: string;
  },
  dependencies: ReadToolDependencies = {}
) {
  const email = studentEmail.trim().toLowerCase();
  const [students, conversations] = await Promise.all([
    searchStudentsForAssistantWithDependencies({ classId, query: email }, dependencies),
    dependencies.listTeacherClassConversations
      ? dependencies.listTeacherClassConversations(classId)
      : listTeacherClassConversationsForAssistant(classId)
  ]);
  const student = students.find((row) => row.email.trim().toLowerCase() === email);

  if (!student) {
    throw new Error("Student was not found in this class roster.");
  }

  const studentConversations = conversations
    .filter((conversation) => conversation.studentEmail.trim().toLowerCase() === email)
    .slice(0, 8)
    .map(conversationToReviewQueueItem);

  return {
    classId,
    recentConversations: studentConversations,
    student,
    summary: {
      body: `${student.displayName} has ${student.conversationCount} saved conversations. Current activity status: ${student.status}.`,
      title: student.displayName
    }
  };
}

export async function searchConversationsTool(
  {
    classId,
    query = "",
    retrievalConfidence = "",
    status = "",
    studentEmail = ""
  }: {
    classId: string;
    query?: string;
    retrievalConfidence?: string;
    status?: string;
    studentEmail?: string;
  },
  dependencies: ReadToolDependencies = {}
) {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedEmail = studentEmail.trim().toLowerCase();
  const normalizedStatus = status.trim();
  const normalizedRetrievalConfidence = retrievalConfidence.trim();
  const conversations = dependencies.listTeacherClassConversations
    ? await dependencies.listTeacherClassConversations(classId)
    : await listTeacherClassConversationsForAssistant(classId);
  const results = conversations
    .filter((conversation) => {
      if (normalizedEmail && conversation.studentEmail.trim().toLowerCase() !== normalizedEmail) {
        return false;
      }
      if (normalizedStatus && conversation.reviewStatus !== normalizedStatus) {
        return false;
      }
      if (normalizedRetrievalConfidence && conversation.latestRetrievalConfidence !== normalizedRetrievalConfidence) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return [
        conversation.title,
        conversation.topic,
        conversation.studentName,
        conversation.studentEmail,
        conversation.reviewStatus
      ].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
    })
    .slice(0, 10)
    .map(conversationToReviewQueueItem);

  return {
    classId,
    count: results.length,
    results
  };
}

export async function getClassMaterialsTool(
  { classId }: { classId: string },
  dependencies: ReadToolDependencies = {}
) {
  const materials = dependencies.listClassMaterials
    ? await dependencies.listClassMaterials(classId)
    : await listClassMaterialsForAssistant(classId);

  return {
    classId,
    count: materials.length,
    materials: materials.slice(0, 50).map(materialToAssistantSummary)
  };
}

export async function searchMaterialsTool(
  {
    classId,
    query
  }: {
    classId: string;
    query: string;
  },
  dependencies: ReadToolDependencies = {}
) {
  const normalizedQuery = query.trim().toLowerCase();
  const materials = await getClassMaterialsTool({ classId }, dependencies);
  const results = materials.materials
    .filter((material) =>
      normalizedQuery
        ? `${material.title} ${material.kind} ${material.fileName ?? ""} ${material.status}`.toLowerCase().includes(normalizedQuery)
        : true
    )
    .slice(0, 10);

  return {
    classId,
    count: results.length,
    results
  };
}

export function getClassSettingsSummaryTool({
  classData,
  classId
}: {
  classData: Record<string, unknown>;
  classId: string;
}) {
  return {
    classId,
    name: stringValue(classData.name) || "Class",
    notificationSettings: normalizeNotificationSettings(classData.notificationSettings),
    privacySettings: normalizePrivacySettings(classData.privacySettings),
    section: stringValue(classData.section),
    sourceDefaults: normalizeSourceDefaultsSettings(classData.sourceDefaults)
  };
}

export function getTutorSettingsSummaryTool({
  classData,
  classId
}: {
  classData: Record<string, unknown>;
  classId: string;
}) {
  return {
    answerPolicy: normalizeAnswerPolicySettings(classData.answerPolicy),
    behaviorInstructions: stringValue(classData.behaviorInstructions).slice(0, 1000),
    behaviorTitle: stringValue(classData.behaviorTitle),
    classId,
    modelSettings: normalizeClassModelSettings(classData.modelSettings),
    responseFormat: normalizeResponseFormatSettings(classData.responseFormat),
    sourceUsage: normalizeSourceUsageSettings(classData.sourceUsage),
    studentFacingInstructions: stringValue(classData.studentFacingInstructions).slice(0, 1000),
    tutorAccess: normalizeTutorAccessSettings(classData.tutorAccess)
  };
}

function conversationToReviewQueueItem(conversation: TeacherConversationReviewSummary) {
  return {
    conversationId: conversation.id,
    feedbackOpen: conversation.feedbackSummary.openCount,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    retrievalConfidence: conversation.latestRetrievalConfidence ?? "",
    reviewStatus: conversation.reviewStatus,
    sourceCount: conversation.sourceAudit.sourceCount,
    studentEmail: conversation.studentEmail,
    studentId: conversation.studentId,
    studentName: conversation.studentName,
    title: conversation.title,
    topic: conversation.topic
  };
}

function materialToAssistantSummary(material: MaterialRecord) {
  return {
    activeForStudents: material.activeForStudents,
    characterCount: material.characterCount,
    chunkCount: material.chunkCount,
    fileName: material.fileName,
    id: material.id,
    kind: material.kind,
    priority: material.priority,
    status: material.status,
    teacherOnly: material.teacherOnly,
    title: material.title,
    updatedAt: material.updatedAt?.toISOString?.() ?? String(material.updatedAt ?? "")
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function listTeacherRosterActivityForAssistant(classId: string) {
  const { listTeacherRosterActivity } = await import("../student-conversations-server.ts");
  return listTeacherRosterActivity({ classId });
}

async function listTeacherClassConversationsForAssistant(classId: string) {
  const { listTeacherClassConversations } = await import("../student-conversations-server.ts");
  return listTeacherClassConversations({ classId });
}

async function listClassMaterialsForAssistant(classId: string) {
  const { listClassMaterials } = await import("../data/materials.ts");
  return listClassMaterials(classId);
}
