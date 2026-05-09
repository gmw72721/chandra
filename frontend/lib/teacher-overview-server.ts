import { adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  listTeacherClassConversations,
  listTeacherRosterActivity,
  ConversationPersistenceError
} from "./student-conversations-server";
import type {
  StudentRosterActivitySummary,
  TeacherClassOverview,
  TeacherClassOverviewActionPriority,
  TeacherClassOverviewKnowledgeStat,
  TeacherClassOverviewLearningProfileRow,
  TeacherClassOverviewNextAction,
  TeacherClassOverviewPriorityRow,
  TeacherClassOverviewReviewQueueRow,
  TeacherConversationReviewSummary,
  TeacherOverviewStatusTone
} from "./types";

const defaultOverviewTimezone = "America/Los_Angeles";
const maxOverviewTopics = 3;
const maxPriorityRows = 5;
const maxRecentActivityRows = 4;
const maxReviewRows = 4;
const maxLearningProfileRows = 4;
const maxNextActions = 3;
const maxSummaryBodyLength = 170;

export async function getTeacherClassOverview({
  classId,
  date,
  timezone
}: {
  classId: string;
  date?: string | null;
  timezone?: string | null;
}): Promise<TeacherClassOverview> {
  assertFirebaseAdminAuthReady();

  const overviewTimezone = normalizeOverviewTimezone(timezone);
  const overviewDate = normalizeOverviewDate(date, overviewTimezone);
  const [rosterActivity, conversations, knowledgeStatus, learningProfileRows, insightContext] = await Promise.all([
    listTeacherRosterActivity({ classId, date: overviewDate, timezone: overviewTimezone }),
    listTeacherClassConversations({ classId }),
    buildKnowledgeStatus(classId),
    buildLearningProfileRows(classId),
    getOverviewInsightContext(classId)
  ]);
  const conversationsToday = conversations.filter((conversation) =>
    isOverviewDate(conversation.lastMessageAt, overviewDate, overviewTimezone)
  );
  const questionsToday = rosterActivity.reduce((sum, row) => sum + row.questionsToday, 0);
  const activeStudentsToday = rosterActivity.filter((row) => row.status === "active" || row.questionsToday > 0).length;
  const priorityRows = buildPriorityRows(rosterActivity, conversations);
  const reviewQueueRows = buildReviewQueueRows(conversations, overviewDate, overviewTimezone);

  return {
    classId,
    date: overviewDate,
    dateLabel: formatOverviewDateLabel(overviewDate),
    generatedAt: new Date().toISOString(),
    knowledgeStatus,
    learningProfileRows,
    metrics: {
      activeNow: rosterActivity.filter((row) => row.status === "active").length,
      averageQuestionsPerStudentPerDay: averageQuestionsPerStudentDay(rosterActivity),
      noActivity: rosterActivity.filter((row) => row.status === "no_activity").length,
      questionsToday,
      totalConversations: conversations.length,
      totalStudents: rosterActivity.length
    },
    nextActions: buildNextActions({
      conversations,
      insightContext,
      knowledgeStatus,
      learningProfileRows,
      priorityRows,
      reviewQueueRows,
      rosterActivity
    }),
    priorityRows,
    recentActivityRows: conversations.slice(0, maxRecentActivityRows).map((conversation) => ({
      conversationId: conversation.id,
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      lastMessageLabel: formatOverviewConversationDate(conversation.lastMessageAt, overviewDate, overviewTimezone),
      messageCount: conversation.messageCount,
      studentId: conversation.studentId,
      studentName: conversation.studentName,
      title: conversation.title
    })),
    reviewQueueRows,
    summary: {
      activeStudentsToday,
      body:
        insightContext.body ||
        buildFallbackSummaryBody({
          activeStudentsToday,
          conversationCountToday: conversationsToday.length,
          questionsToday
        }),
      conversationCountToday: conversationsToday.length,
      questionsToday,
      title: insightContext.title || "Today's Summary",
      topTopics: buildTopTopics(conversationsToday.length ? conversationsToday : conversations)
    },
    timezone: overviewTimezone
  };
}

function buildPriorityRows(
  rosterActivity: StudentRosterActivitySummary[],
  conversations: TeacherConversationReviewSummary[]
): TeacherClassOverviewPriorityRow[] {
  const rows: TeacherClassOverviewPriorityRow[] = [];
  const seenStudents = new Set<string>();
  const addRow = (row: StudentRosterActivitySummary, data: Omit<TeacherClassOverviewPriorityRow, "id" | "studentEmail" | "studentId" | "studentName">) => {
    const key = row.studentId || row.studentEmail;

    if (!key || seenStudents.has(key) || rows.length >= maxPriorityRows) {
      return;
    }

    seenStudents.add(key);
    rows.push({
      ...data,
      id: `${key}-${data.status.toLowerCase().replace(/\s+/g, "-")}`,
      studentEmail: row.studentEmail,
      studentId: row.studentId,
      studentName: row.displayName
    });
  };
  const rosterByEmail = new Map(rosterActivity.map((row) => [row.studentEmail.trim().toLowerCase(), row]));

  rosterActivity
    .filter((row) => row.questionsToday >= 5 || row.questionsPerDay >= 3)
    .sort((first, second) => second.questionsToday - first.questionsToday || second.questionsPerDay - first.questionsPerDay)
    .forEach((row) =>
      addRow(row, {
        action: "viewChats",
        actionLabel: "View chats",
        issue: "High question volume today",
        status: "High volume",
        tone: "high"
      })
    );

  conversations
    .filter((conversation) =>
      ["needs_follow_up", "misunderstanding_spotted", "ai_answer_needs_review"].includes(conversation.reviewStatus)
    )
    .forEach((conversation) => {
      const row = rosterByEmail.get(conversation.studentEmail.trim().toLowerCase());

      if (row) {
        addRow(row, {
          action: "viewChats",
          actionLabel: "View chats",
          issue: "Recent conversation may need follow-up",
          status: conversation.reviewStatus === "ai_answer_needs_review" ? "AI review" : "Follow-up",
          tone: conversation.reviewStatus === "ai_answer_needs_review" ? "ai-review" : "follow-up"
        });
      }
    });

  rosterActivity
    .filter((row) => row.teacherNotes.trim())
    .forEach((row) =>
      addRow(row, {
        action: "addNote",
        actionLabel: "Add note",
        issue: "Teacher note exists",
        status: "Note",
        tone: "note"
      })
    );

  rosterActivity
    .filter((row) => row.status === "no_activity" || row.conversationCount === 0)
    .forEach((row) =>
      addRow(row, {
        action: "openRoster",
        actionLabel: "Open roster",
        issue: row.conversationCount === 0 ? "No conversations yet" : "Inactive this week",
        status: "No activity",
        tone: "inactive"
      })
    );

  return rows;
}

function buildReviewQueueRows(
  conversations: TeacherConversationReviewSummary[],
  overviewDate: string,
  timezone: string
): TeacherClassOverviewReviewQueueRow[] {
  return conversations
    .filter(conversationNeedsTeacherReview)
    .slice(0, maxReviewRows)
    .map((conversation) => ({
      conversationId: conversation.id,
      id: conversation.id,
      issue: reviewQueueIssue(conversation),
      lastMessageAt: conversation.lastMessageAt,
      lastMessageLabel: formatOverviewConversationDate(conversation.lastMessageAt, overviewDate, timezone),
      meta: conversation.sourceAudit.lowSourceConfidence
        ? "low confidence"
        : `${conversation.messageCount} ${conversation.messageCount === 1 ? "message" : "messages"}`,
      sourceLabel: reviewQueueSourceLabel(conversation),
      sourceCount: conversation.sourceAudit.sourceCount,
      status: formatReviewQueueStatus(conversation),
      studentId: conversation.studentId,
      studentName: conversation.studentName,
      suggestedAction: reviewQueueSuggestedAction(conversation),
      title: conversation.title,
      tone: reviewQueueTone(conversation)
    }));
}

function conversationNeedsTeacherReview(conversation: Pick<TeacherConversationReviewSummary, "reviewStatus">) {
  return (
    conversation.reviewStatus === "new" ||
    conversation.reviewStatus === "needs_follow_up" ||
    conversation.reviewStatus === "misunderstanding_spotted" ||
    conversation.reviewStatus === "ai_answer_needs_review"
  );
}

async function buildLearningProfileRows(classId: string): Promise<TeacherClassOverviewLearningProfileRow[]> {
  const [studentsSnapshot, profilesSnapshot] = await Promise.all([
    adminDb!.collection("classes").doc(classId).collection("students").get(),
    adminDb!.collection("classes").doc(classId).collection("studentLearningProfiles").get()
  ]);
  const profileByEmail = new Map(
    profilesSnapshot.docs.map((profileDoc) => {
      const profile = profileDoc.data() ?? {};
      return [String(profile.studentEmail ?? decodeURIComponent(profileDoc.id)).trim().toLowerCase(), profile] as const;
    })
  );

  return studentsSnapshot.docs
    .map((studentDoc): TeacherClassOverviewLearningProfileRow => {
      const student = studentDoc.data() ?? {};
      const studentEmail = String(student.email ?? "").trim().toLowerCase();
      const studentName = String(student.displayName ?? "").trim() || studentEmail || "Student";
      const profile = profileByEmail.get(studentEmail);
      const status = profileStatus(profile);

      return {
        id: studentDoc.id,
        meta: profileMeta(profile),
        status: status.label,
        studentEmail,
        studentId: studentDoc.id,
        studentName,
        tone: status.tone
      };
    })
    .sort(learningProfileRowSort)
    .slice(0, maxLearningProfileRows);
}

async function buildKnowledgeStatus(classId: string): Promise<TeacherClassOverviewKnowledgeStat[]> {
  const [materialsSnapshot, jobsSnapshot] = await Promise.all([
    adminDb!.collection("classes").doc(classId).collection("materials").get(),
    adminDb!.collection("classes").doc(classId).collection("materialJobs").get()
  ]);
  const materials = materialsSnapshot.docs.map((materialDoc) => materialDoc.data() ?? {});
  const failedJobs = jobsSnapshot.docs.filter((jobDoc) => String(jobDoc.data().step ?? "") === "failed").length;
  const ready = materials.filter((material) => material.status === "ready").length;
  const processing = materials.filter((material) => material.status === "processing" || material.status === "uploaded").length;
  const teacherOnly = materials.filter((material) => material.teacherOnly === true).length;
  const activeForStudents = materials.filter(
    (material) => material.status === "ready" && material.activeForStudents !== false && material.teacherOnly !== true
  ).length;

  return [
    { label: "Total uploaded", tone: "ink", value: materials.length },
    { label: "Ready", tone: "ready", value: ready },
    { label: "Processing", tone: "processing", value: processing },
    { label: "Failed / needs review", tone: "failed", value: failedJobs },
    { label: "Teacher-only", tone: "teacher-only", value: teacherOnly },
    { label: "Active for students", tone: "ready", value: activeForStudents }
  ];
}

type OverviewInsightRecommendation = {
  action: "inspect" | "upload" | "adjust" | "approve";
  evidenceConversationIds: string[];
  evidenceCount: number;
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
};

type OverviewInsightContext = {
  body: string;
  dismissedItemIds: Set<string>;
  notUsefulItemIds: Set<string>;
  recommendations: OverviewInsightRecommendation[];
  resolvedItemIds: Set<string>;
  title: string;
  usefulItemIds: Set<string>;
};

async function getOverviewInsightContext(classId: string): Promise<OverviewInsightContext> {
  const snapshot = await adminDb!.collection("classes").doc(classId).collection("teacherInsights").doc("today").get();
  const data = snapshot.data() ?? {};
  const insight = data.insight && typeof data.insight === "object" ? (data.insight as Record<string, unknown>) : {};
  const dailySummary =
    insight.dailySummary && typeof insight.dailySummary === "object"
      ? (insight.dailySummary as Record<string, unknown>)
      : {};

  return {
    body: conciseSummaryText(String(dailySummary.body ?? "")),
    dismissedItemIds: stringSet(data.dismissedItemIds),
    notUsefulItemIds: stringSet(data.notUsefulItemIds),
    recommendations: Array.isArray(insight.recommendations)
      ? insight.recommendations
          .map(normalizeOverviewInsightRecommendation)
          .filter((recommendation): recommendation is OverviewInsightRecommendation => Boolean(recommendation))
      : [],
    resolvedItemIds: stringSet(data.resolvedItemIds),
    usefulItemIds: stringSet(data.usefulItemIds),
    title: conciseSummaryText(String(dailySummary.title ?? ""))
  };
}

function normalizeOverviewInsightRecommendation(value: unknown): OverviewInsightRecommendation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const title = conciseSummaryText(String(source.title ?? ""));

  if (!title) {
    return null;
  }

  return {
    action: normalizeOverviewInsightRecommendationAction(source.action),
    evidenceConversationIds: Array.isArray(source.evidenceConversationIds)
      ? Array.from(new Set(source.evidenceConversationIds.map(String).filter(Boolean))).slice(0, 6)
      : [],
    evidenceCount: Math.max(0, Number(source.evidenceCount ?? 0)),
    id: String(source.id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-+|-+$/g, "") || title,
    priority: source.priority === "high" || source.priority === "medium" ? source.priority : "low",
    title
  };
}

function normalizeOverviewInsightRecommendationAction(value: unknown): OverviewInsightRecommendation["action"] {
  return value === "upload" || value === "adjust" || value === "approve" ? value : "inspect";
}

function stringSet(value: unknown) {
  return new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : []);
}

function conciseSummaryText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() || normalized;
  const summary = firstSentence.length >= 50 ? firstSentence : normalized;

  return summary.length > maxSummaryBodyLength ? `${summary.slice(0, maxSummaryBodyLength - 3).trim()}...` : summary;
}

function buildFallbackSummaryBody({
  activeStudentsToday,
  conversationCountToday,
  questionsToday
}: {
  activeStudentsToday: number;
  conversationCountToday: number;
  questionsToday: number;
}) {
  if (!questionsToday && !conversationCountToday) {
    return "No student questions have been recorded for this class today.";
  }

  return `${activeStudentsToday} students asked ${questionsToday} questions across ${conversationCountToday} conversations today.`;
}

type OverviewActionFactors = {
  confidence: number;
  effort: number;
  evidence: number;
  fatigue?: number;
  freshness: number;
  impact: number;
  urgency: number;
};

type OverviewActionCandidate = TeacherClassOverviewNextAction & {
  score: number;
  semanticKey: string;
};

function buildNextActions({
  conversations,
  insightContext,
  knowledgeStatus,
  learningProfileRows,
  priorityRows,
  reviewQueueRows,
  rosterActivity
}: {
  conversations: TeacherConversationReviewSummary[];
  insightContext: OverviewInsightContext;
  knowledgeStatus: TeacherClassOverviewKnowledgeStat[];
  learningProfileRows: TeacherClassOverviewLearningProfileRow[];
  priorityRows: TeacherClassOverviewPriorityRow[];
  reviewQueueRows: TeacherClassOverviewReviewQueueRow[];
  rosterActivity: StudentRosterActivitySummary[];
}): TeacherClassOverviewNextAction[] {
  type ScoredAction = OverviewActionCandidate;
  const actions: ScoredAction[] = [];
  const addAction = (
    action: Omit<TeacherClassOverviewNextAction, "priority" | "rationale">,
    factors: OverviewActionFactors,
    semanticKey: string,
    rationale: Array<string | false | null | undefined>
  ) => {
    const score = scoreOverviewAction(factors);

    actions.push({
      ...action,
      priority: priorityForOverviewScore(score),
      rationale: compactRationale(rationale),
      score,
      semanticKey
    });
  };
  const totalUploaded = knowledgeStatus.find((stat) => stat.label === "Total uploaded")?.value ?? 0;
  const ready = knowledgeStatus.find((stat) => stat.label === "Ready")?.value ?? 0;
  const failed = knowledgeStatus.find((stat) => stat.label === "Failed / needs review")?.value ?? 0;
  const processing = knowledgeStatus.find((stat) => stat.label === "Processing")?.value ?? 0;
  const activeForStudents = knowledgeStatus.find((stat) => stat.label === "Active for students")?.value ?? 0;
  const notePriority = priorityRows.find((row) => row.tone === "note");
  const reviewNeededConversations = conversations.filter(conversationNeedsTeacherReview);
  const reviewQueueCount = Math.max(reviewQueueRows.length, reviewNeededConversations.length);
  const noConversationStudents = rosterActivity.filter((row) => row.conversationCount === 0);
  const inactiveStudents = rosterActivity.filter((row) => row.status === "no_activity");
  const draftProfiles = learningProfileRows.filter((row) => row.status === "Draft");
  const noProfileRows = learningProfileRows.filter((row) => row.status === "No profile");
  const questionsTodayMedian = medianNumber(rosterActivity.map((row) => row.questionsToday));
  const questionsPerDayMedian = medianNumber(rosterActivity.map((row) => row.questionsPerDay));
  const conversationsByStudent = groupConversationsByStudent(conversations);
  const retrievalRiskConversations = conversations
    .filter(conversationHasRetrievalRisk)
    .sort((first, second) => conversationRiskScore(second) - conversationRiskScore(first));

  if (!rosterActivity.length) {
    addAction({
      action: "addStudent",
      detail: "Build the roster before students can use Chandra.",
      id: "add-student",
      label: "Add student",
      tone: "inactive"
    }, {
      confidence: 98,
      effort: 42,
      evidence: 100,
      freshness: 92,
      impact: 100,
      urgency: 100
    }, "setup:roster", ["No students are on the roster", "Students cannot start until roster exists"]);
  }

  if (failed) {
    addAction({
      action: "openKnowledge",
      detail: `${failed} knowledge source${failed === 1 ? "" : "s"} failed or need review.`,
      id: "fix-knowledge",
      label: "Fix knowledge source",
      tone: "failed"
    }, {
      confidence: 95,
      effort: 55,
      evidence: clampScore(65 + failed * 12),
      freshness: 78,
      impact: 92,
      urgency: 88
    }, "knowledge:failed", [`${failed} failed source${failed === 1 ? "" : "s"}`, "Student answers may lose class context"]);
  }

  if (!totalUploaded) {
    addAction({
      action: "addKnowledge",
      detail: "No class materials are uploaded, so answers cannot use class context.",
      id: "add-first-knowledge",
      label: "Add first knowledge source",
      tone: "processing"
    }, {
      confidence: 96,
      effort: 70,
      evidence: 100,
      freshness: rosterActivity.length ? 78 : 88,
      impact: rosterActivity.length ? 92 : 82,
      urgency: rosterActivity.length ? 86 : 74
    }, "knowledge:first-source", ["No uploaded class materials", rosterActivity.length ? "Roster is ready for source-grounded help" : "Set up before students arrive"]);
  } else if (!activeForStudents && ready) {
    addAction({
      action: "openKnowledge",
      detail: `${ready} ready source${ready === 1 ? "" : "s"} are not active for students.`,
      id: "activate-knowledge",
      label: "Activate knowledge",
      tone: "ready"
    }, {
      confidence: 92,
      effort: 35,
      evidence: clampScore(64 + ready * 8),
      freshness: 76,
      impact: 86,
      urgency: 78
    }, "knowledge:activate", [`${ready} ready source${ready === 1 ? " is" : "s are"} hidden from students`, "Low effort, high impact"]);
  } else if (processing) {
    addAction({
      action: "openKnowledge",
      detail: `${processing} source${processing === 1 ? " is" : "s are"} still processing.`,
      id: "check-processing-knowledge",
      label: "Check knowledge status",
      tone: "processing"
    }, {
      confidence: 82,
      effort: 30,
      evidence: clampScore(45 + processing * 8),
      freshness: 56,
      impact: activeForStudents ? 48 : 72,
      urgency: activeForStudents ? 44 : 64
    }, "knowledge:processing", [`${processing} source${processing === 1 ? " is" : "s are"} processing`, activeForStudents ? "Active sources are already available" : "No active source fallback yet"]);
  }

  if (retrievalRiskConversations.length && totalUploaded) {
    const firstRisk = retrievalRiskConversations[0];
    const lowConfidenceMessages = retrievalRiskConversations.reduce(
      (sum, conversation) => sum + conversation.learningSignals.lowConfidenceMessageCount,
      0
    );
    const noSourceMessages = retrievalRiskConversations.reduce(
      (sum, conversation) => sum + conversation.learningSignals.noSourceAssistantMessageCount,
      0
    );

    addAction({
      action: "testRetrieval",
      conversationId: firstRisk?.id,
      detail: `Check the answer in "${firstRisk?.title ?? "the latest chat"}" against the assigned class material.`,
      evidenceConversationIds: retrievalRiskConversations.map((conversation) => conversation.id).slice(0, 6),
      id: "test-retrieval-risk",
      label: "Check source accuracy",
      studentId: firstRisk?.studentId,
      studentName: firstRisk?.studentName,
      tone: "ai-review"
    }, {
      confidence: 88,
      effort: 50,
      evidence: clampScore(58 + lowConfidenceMessages * 9 + noSourceMessages * 12),
      freshness: freshnessScore(firstRisk?.lastMessageAt),
      impact: 88,
      urgency: clampScore(68 + lowConfidenceMessages * 5 + noSourceMessages * 7)
    }, "knowledge:retrieval-risk", [
      lowConfidenceMessages ? `${lowConfidenceMessages} low-confidence tutor answer${lowConfidenceMessages === 1 ? "" : "s"}` : null,
      noSourceMessages ? `${noSourceMessages} answer${noSourceMessages === 1 ? "" : "s"} missing class sources` : null,
      "Verify before more students see it"
    ]);
  }

  if (draftProfiles.length) {
    const firstDraft = draftProfiles[0];
    addAction({
      action: "reviewLearningProfiles",
      detail: `${draftProfiles.length} profile draft${draftProfiles.length === 1 ? "" : "s"} pending; start with ${firstDraft.studentName}.`,
      id: "review-learning-profiles",
      label: "Review profile draft",
      studentEmail: firstDraft.studentEmail,
      studentId: firstDraft.studentId,
      studentName: firstDraft.studentName,
      tone: "draft"
    }, {
      confidence: 90,
      effort: 48,
      evidence: clampScore(58 + draftProfiles.length * 8),
      freshness: 72,
      impact: 78,
      urgency: 72
    }, "profiles:drafts", [`${draftProfiles.length} draft profile${draftProfiles.length === 1 ? "" : "s"}`, `Start with ${firstDraft.studentName}`]);
  }

  reviewNeededConversations
    .slice()
    .sort((first, second) => conversationRiskScore(second) - conversationRiskScore(first))
    .slice(0, 5)
    .forEach((conversation) => {
      if (retrievalRiskConversations.length && conversationHasRetrievalRisk(conversation)) {
        return;
      }

      const reasons = conversationRiskReasons(conversation);

      addAction({
        action: "reviewConversations",
        conversationId: conversation.id,
        detail: buildConversationActionDetail(conversation),
        evidenceConversationIds: [conversation.id],
        id: `review-${conversation.id}`,
        label: conversation.sourceAudit.lowSourceConfidence ? "Review source accuracy" : "Review student support",
        studentId: conversation.studentId,
        studentName: conversation.studentName,
        tone: reviewQueueTone(conversation)
      }, {
        confidence: conversation.reviewStatus === "new" ? 66 : 88,
        effort: 38,
        evidence: clampScore(48 + conversation.learningSignals.assistantMessageCount * 5 + reasons.length * 10),
        freshness: freshnessScore(conversation.lastMessageAt),
        impact: clampScore(52 + Math.min(conversation.messageCount, 12) * 3 + conversation.learningSignals.askTeacherCount * 8),
        urgency: clampScore(48 + conversationRiskScore(conversation))
      }, `conversation:${conversation.id}`, reasons);
    });

  rosterActivity.forEach((row) => {
    const studentKey = row.studentId || row.studentEmail.trim().toLowerCase();
    const studentConversations = conversationsByStudent.get(studentKey) ?? [];
    const studentSignals = summarizeStudentConversationSignals(studentConversations);
    const volumeThreshold = Math.max(4, questionsTodayMedian + 2);
    const dailyThreshold = Math.max(2.5, questionsPerDayMedian + 1);
    const hasRelativeVolume = row.questionsToday >= volumeThreshold || row.questionsPerDay >= dailyThreshold;
    const hasLearningRisk =
      studentSignals.askTeacherCount > 0 ||
      studentSignals.stuckOutcomeCount > 0 ||
      studentSignals.lowConfidenceMessageCount > 0 ||
      studentSignals.flaggedConversationCount > 0;

    if (!hasRelativeVolume && !hasLearningRisk) {
      return;
    }

    const reasons = compactRationale([
      hasRelativeVolume ? `${formatOverviewNumber(row.questionsToday)} questions today` : null,
      studentSignals.flaggedConversationCount ? `${studentSignals.flaggedConversationCount} flagged chat${studentSignals.flaggedConversationCount === 1 ? "" : "s"}` : null,
      studentSignals.askTeacherCount ? `${studentSignals.askTeacherCount} ask-teacher signal${studentSignals.askTeacherCount === 1 ? "" : "s"}` : null,
      studentSignals.stuckOutcomeCount ? `${studentSignals.stuckOutcomeCount} stuck follow-up${studentSignals.stuckOutcomeCount === 1 ? "" : "s"}` : null,
      studentSignals.lowConfidenceMessageCount ? `${studentSignals.lowConfidenceMessageCount} low-confidence answer${studentSignals.lowConfidenceMessageCount === 1 ? "" : "s"}` : null
    ]);

    addAction({
      action: "viewStudentChats",
      detail: `${row.displayName}: ${reasons[0]?.toLowerCase() ?? "recent activity needs review"}.`,
      evidenceConversationIds: studentConversations.map((conversation) => conversation.id).slice(0, 6),
      id: `student-risk-${studentKey}`,
      label: hasLearningRisk ? "Check student support" : "Check high-volume student",
      studentEmail: row.studentEmail,
      studentId: row.studentId,
      studentName: row.displayName,
      tone: hasLearningRisk ? "follow-up" : "high"
    }, {
      confidence: hasLearningRisk ? 86 : 72,
      effort: 36,
      evidence: clampScore(45 + row.questionsToday * 6 + studentSignals.flaggedConversationCount * 12 + studentSignals.askTeacherCount * 10),
      freshness: freshnessScore(row.lastActiveAt),
      impact: clampScore(55 + row.questionsToday * 5 + studentSignals.stuckOutcomeCount * 9),
      urgency: clampScore(48 + (hasRelativeVolume ? 18 : 0) + studentSignals.flaggedConversationCount * 14 + studentSignals.askTeacherCount * 12)
    }, `student:${studentKey}`, reasons);
  });

  if (reviewQueueCount > 1) {
    addAction({
      action: "reviewConversations",
      conversationId: reviewQueueRows[0]?.conversationId ?? reviewNeededConversations[0]?.id,
      detail: `${reviewQueueCount} student chat${reviewQueueCount === 1 ? "" : "s"} need a teacher decision.`,
      id: "review-conversations",
      label: "Triage student chats",
      tone: "new"
    }, {
      confidence: 78,
      effort: 62,
      evidence: clampScore(42 + reviewQueueCount * 7),
      freshness: freshnessScore(reviewNeededConversations[0]?.lastMessageAt),
      impact: clampScore(58 + reviewQueueCount * 4),
      urgency: clampScore(54 + reviewQueueCount * 5)
    }, "conversation:review-queue", [`${reviewQueueCount} chats need review`, "Handle the highest-risk chat first"]);
  }

  if (notePriority) {
    addAction({
      action: "openRoster",
      detail: `${notePriority.studentName} has a private teacher note.`,
      id: `note-${notePriority.studentId || notePriority.studentEmail}`,
      label: "Revisit teacher note",
      studentEmail: notePriority.studentEmail,
      studentId: notePriority.studentId,
      studentName: notePriority.studentName,
      tone: "note"
    }, {
      confidence: 86,
      effort: 28,
      evidence: 58,
      freshness: 48,
      impact: 58,
      urgency: 46
    }, `student-note:${notePriority.studentId || notePriority.studentEmail}`, ["Private teacher note", "Bring the note back into planning"]);
  }

  if (noConversationStudents.length) {
    const firstStudent = noConversationStudents[0];
    addAction({
      action: "openRoster",
      detail: `${noConversationStudents.length} student${noConversationStudents.length === 1 ? "" : "s"} have not started a chat.`,
      id: "students-no-conversations",
      label: "Check inactive starters",
      studentEmail: firstStudent?.studentEmail,
      studentId: firstStudent?.studentId,
      studentName: firstStudent?.displayName,
      tone: "inactive"
    }, {
      confidence: 92,
      effort: 44,
      evidence: clampScore(52 + noConversationStudents.length * 4),
      freshness: 40,
      impact: 56,
      urgency: 44
    }, "roster:no-conversations", [`${noConversationStudents.length} student${noConversationStudents.length === 1 ? "" : "s"} have not started`, "Check access or onboarding"]);
  } else if (inactiveStudents.length) {
    const firstStudent = inactiveStudents[0];
    addAction({
      action: "openRoster",
      detail: `${inactiveStudents.length} student${inactiveStudents.length === 1 ? "" : "s"} show no activity.`,
      id: "students-no-activity",
      label: "Check no-activity students",
      studentEmail: firstStudent?.studentEmail,
      studentId: firstStudent?.studentId,
      studentName: firstStudent?.displayName,
      tone: "inactive"
    }, {
      confidence: 80,
      effort: 42,
      evidence: clampScore(40 + inactiveStudents.length * 4),
      freshness: 34,
      impact: 48,
      urgency: 36
    }, "roster:no-activity", [`${inactiveStudents.length} student${inactiveStudents.length === 1 ? "" : "s"} show no activity`, "Lower priority than active learning risks"]);
  }

  if (noProfileRows.length && rosterActivity.some((row) => row.conversationCount > 0)) {
    const firstProfile = noProfileRows[0];
    addAction({
      action: "reviewLearningProfiles",
      detail: `${noProfileRows.length} active student${noProfileRows.length === 1 ? "" : "s"} still need a reviewed learning profile.`,
      id: "review-missing-profiles",
      label: "Review learner profiles",
      studentEmail: firstProfile?.studentEmail,
      studentId: firstProfile?.studentId,
      studentName: firstProfile?.studentName,
      tone: "inactive"
    }, {
      confidence: 76,
      effort: 58,
      evidence: clampScore(38 + noProfileRows.length * 7),
      freshness: 44,
      impact: 62,
      urgency: 42
    }, "profiles:missing", [`${noProfileRows.length} missing profile${noProfileRows.length === 1 ? "" : "s"}`, "Use chat evidence to personalize support"]);
  }

  if (ready && activeForStudents) {
    addAction({
      action: "testRetrieval",
      detail: "Open a recent student question and confirm the answer matches the active materials.",
      id: "test-retrieval",
      label: "Spot-check class sources",
      tone: "ready"
    }, {
      confidence: 68,
      effort: 46,
      evidence: rosterActivity.reduce((sum, row) => sum + row.questionsToday, 0) ? 48 : 30,
      freshness: 36,
      impact: 42,
      urgency: 32
    }, "knowledge:spot-check", ["Active sources are available", "Quality-control today's answers"]);
  }

  insightContext.recommendations
    .filter((recommendation) => !insightContext.resolvedItemIds.has(recommendation.id))
    .filter((recommendation) => !insightContext.dismissedItemIds.has(recommendation.id))
    .filter((recommendation) => !insightContext.notUsefulItemIds.has(recommendation.id))
    .slice(0, 4)
    .forEach((recommendation) => {
      const action = actionForInsightRecommendation(recommendation, {
        draftProfiles,
        totalUploaded
      });
      const firstEvidenceConversationId = recommendation.evidenceConversationIds.find((conversationId) =>
        conversations.some((conversation) => conversation.id === conversationId)
      );
      const usefulBoost = insightContext.usefulItemIds.has(recommendation.id) ? 10 : 0;
      const recommendationPriority = recommendation.priority === "high" ? 84 : recommendation.priority === "medium" ? 66 : 48;

      addAction({
        action,
        conversationId: action === "reviewConversations" ? firstEvidenceConversationId : undefined,
        detail: `${recommendation.title}${recommendation.evidenceCount ? ` (${recommendation.evidenceCount} supporting ${recommendation.evidenceCount === 1 ? "chat" : "chats"})` : ""}.`,
        evidenceConversationIds: recommendation.evidenceConversationIds,
        id: `insight-${recommendation.id}`,
        label: labelForInsightRecommendation(recommendation),
        tone: recommendation.priority === "high" ? "follow-up" : "teacher-only"
      }, {
        confidence: clampScore(72 + usefulBoost),
        effort: action === "addKnowledge" ? 70 : 42,
        evidence: clampScore(45 + recommendation.evidenceCount * 9 + recommendation.evidenceConversationIds.length * 6),
        freshness: 78,
        impact: recommendationPriority,
        urgency: recommendationPriority
      }, `insight:${recommendation.id}`, [
        `${capitalizeOverviewWord(recommendation.priority)} planning signal`,
        recommendation.evidenceCount ? `${recommendation.evidenceCount} supporting ${recommendation.evidenceCount === 1 ? "chat" : "chats"}` : null,
        insightContext.usefulItemIds.has(recommendation.id) ? "Marked useful before" : null
      ]);
    });

  addAction({
    action: "openInsights",
    detail: "Review the strongest learning pattern before planning tomorrow's lesson.",
    id: "open-insights",
    label: "Review class insight",
    tone: "teacher-only"
  }, {
    confidence: 64,
    effort: 32,
    evidence: insightContext.body ? 42 : 22,
    freshness: 34,
    impact: 38,
    urgency: 28
  }, "insights:fallback", [insightContext.body ? "Daily insight summary is available" : "Fallback planning check"]);

  addAction({
    action: "openStudentView",
    detail: "Preview what students see after your latest changes.",
    id: "open-student-view",
    label: "Preview student view",
    tone: "teacher-only"
  }, {
    confidence: 60,
    effort: 20,
    evidence: 18,
    freshness: 28,
    impact: 30,
    urgency: 18
  }, "student-view:fallback", ["Preview after roster or source changes"]);

  return rankOverviewActions(actions)
    .slice(0, maxNextActions)
    .map(({ score, semanticKey, ...action }) => action);
}

function scoreOverviewAction(factors: OverviewActionFactors) {
  return Math.round(
    clampScore(
      5 +
        factors.urgency * 0.3 +
        factors.impact * 0.25 +
        factors.evidence * 0.2 +
        factors.freshness * 0.1 +
        factors.confidence * 0.1 -
        factors.effort * 0.05 -
        (factors.fatigue ?? 0)
    )
  );
}

function priorityForOverviewScore(score: number): TeacherClassOverviewActionPriority {
  if (score >= 82) {
    return "critical";
  }

  if (score >= 68) {
    return "high";
  }

  if (score >= 48) {
    return "medium";
  }

  return "low";
}

function rankOverviewActions(actions: OverviewActionCandidate[]) {
  const bestBySemanticKey = new Map<string, OverviewActionCandidate>();

  actions.forEach((action) => {
    const existing = bestBySemanticKey.get(action.semanticKey);

    if (!existing || action.score > existing.score || (action.score === existing.score && action.label.localeCompare(existing.label) < 0)) {
      bestBySemanticKey.set(action.semanticKey, action);
    }
  });

  return Array.from(bestBySemanticKey.values()).sort(
    (first, second) => second.score - first.score || first.label.localeCompare(second.label)
  );
}

function compactRationale(reasons: Array<string | false | null | undefined>) {
  return Array.from(
    new Set(
      reasons
        .map((reason) => String(reason ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  ).slice(0, 3);
}

function conversationHasRetrievalRisk(conversation: TeacherConversationReviewSummary) {
  return (
    conversation.sourceAudit.lowSourceConfidence ||
    conversation.learningSignals.lowConfidenceMessageCount > 0 ||
    conversation.learningSignals.noSourceAssistantMessageCount > 0 ||
    conversation.learningSignals.reviewSourceCount > 0
  );
}

function conversationRiskScore(conversation: TeacherConversationReviewSummary) {
  const signals = conversation.learningSignals;
  const reviewStatusScore =
    conversation.reviewStatus === "ai_answer_needs_review"
      ? 36
      : conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted"
        ? 32
        : conversation.reviewStatus === "new"
          ? 14
          : 0;

  return clampScore(
    reviewStatusScore +
      (conversation.sourceAudit.lowSourceConfidence ? 22 : 0) +
      signals.askTeacherCount * 12 +
      signals.stuckOutcomeCount * 10 +
      signals.lowConfidenceMessageCount * 8 +
      signals.noSourceAssistantMessageCount * 10 +
      signals.disengagedOutcomeCount * 6 +
      Math.min(conversation.messageCount, 12)
  );
}

function conversationRiskReasons(conversation: TeacherConversationReviewSummary) {
  const signals = conversation.learningSignals;

  return compactRationale([
    conversation.reviewStatus === "ai_answer_needs_review" ? "AI answer marked for review" : null,
    conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted"
      ? "Teacher follow-up flag"
      : null,
    conversation.sourceAudit.lowSourceConfidence || signals.lowConfidenceMessageCount
      ? `${Math.max(1, signals.lowConfidenceMessageCount)} low-confidence answer${Math.max(1, signals.lowConfidenceMessageCount) === 1 ? "" : "s"}`
      : null,
    signals.noSourceAssistantMessageCount
      ? `${signals.noSourceAssistantMessageCount} answer${signals.noSourceAssistantMessageCount === 1 ? "" : "s"} without class sources`
      : null,
    signals.askTeacherCount ? `${signals.askTeacherCount} ask-teacher signal${signals.askTeacherCount === 1 ? "" : "s"}` : null,
    signals.stuckOutcomeCount ? `${signals.stuckOutcomeCount} stuck follow-up${signals.stuckOutcomeCount === 1 ? "" : "s"}` : null,
    `Last active ${formatRelativeOverviewTime(conversation.lastMessageAt)}`
  ]);
}

function buildConversationActionDetail(conversation: TeacherConversationReviewSummary) {
  const primaryReason = reviewQueueIssue(conversation).toLowerCase();

  return `${conversation.studentName} needs a teacher check for ${primaryReason} in "${conversation.title}".`;
}

function groupConversationsByStudent(conversations: TeacherConversationReviewSummary[]) {
  const byStudent = new Map<string, TeacherConversationReviewSummary[]>();

  conversations.forEach((conversation) => {
    const keys = Array.from(new Set([
      conversation.studentId,
      conversation.studentEmail.trim().toLowerCase()
    ].filter(Boolean)));

    keys.forEach((key) => {
      const rows = byStudent.get(key) ?? [];
      rows.push(conversation);
      byStudent.set(key, rows);
    });
  });

  return byStudent;
}

function summarizeStudentConversationSignals(conversations: TeacherConversationReviewSummary[]) {
  return conversations.reduce(
    (summary, conversation) => {
      summary.askTeacherCount += conversation.learningSignals.askTeacherCount;
      summary.flaggedConversationCount += conversationNeedsTeacherReview(conversation) ? 1 : 0;
      summary.lowConfidenceMessageCount += conversation.learningSignals.lowConfidenceMessageCount;
      summary.stuckOutcomeCount += conversation.learningSignals.stuckOutcomeCount;
      return summary;
    },
    {
      askTeacherCount: 0,
      flaggedConversationCount: 0,
      lowConfidenceMessageCount: 0,
      stuckOutcomeCount: 0
    }
  );
}

function actionForInsightRecommendation(
  recommendation: OverviewInsightRecommendation,
  context: {
    draftProfiles: TeacherClassOverviewLearningProfileRow[];
    totalUploaded: number;
  }
): TeacherClassOverviewNextAction["action"] {
  if (recommendation.action === "upload") {
    return context.totalUploaded ? "openKnowledge" : "addKnowledge";
  }

  if (recommendation.action === "approve" && context.draftProfiles.length) {
    return "reviewLearningProfiles";
  }

  if (recommendation.action === "inspect" && recommendation.evidenceConversationIds.length) {
    return "reviewConversations";
  }

  return "openInsights";
}

function labelForInsightRecommendation(recommendation: OverviewInsightRecommendation) {
  if (recommendation.action === "upload") {
    return "Add missing class source";
  }

  if (recommendation.action === "approve") {
    return "Approve learner profile";
  }

  if (recommendation.action === "adjust") {
    return "Plan a teaching scaffold";
  }

  return "Review insight evidence";
}

function medianNumber(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((first, second) => first - second);

  if (!sorted.length) {
    return 0;
  }

  const midpoint = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[midpoint] : ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function freshnessScore(value: unknown) {
  const millis = timestampMillis(value);

  if (!millis) {
    return 35;
  }

  const ageHours = Math.max(0, (Date.now() - millis) / 3_600_000);

  if (ageHours <= 2) {
    return 100;
  }

  if (ageHours <= 12) {
    return 90;
  }

  if (ageHours <= 24) {
    return 80;
  }

  if (ageHours <= 72) {
    return 62;
  }

  if (ageHours <= 168) {
    return 46;
  }

  if (ageHours <= 720) {
    return 28;
  }

  return 14;
}

function formatRelativeOverviewTime(value: unknown) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "recently";
  }

  const ageHours = Math.max(0, Math.round((Date.now() - millis) / 3_600_000));

  if (ageHours < 1) {
    return "this hour";
  }

  if (ageHours < 24) {
    return `${ageHours}h ago`;
  }

  const ageDays = Math.round(ageHours / 24);

  return `${ageDays}d ago`;
}

function formatOverviewNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function capitalizeOverviewWord(value: string) {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, value));
}

function buildTopTopics(conversations: TeacherConversationReviewSummary[]) {
  const topicCounts = new Map<string, number>();

  conversations.forEach((conversation) => {
    const topic = conversation.topic.trim() || conversation.title.trim();

    if (topic && topic !== "General help") {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  });

  return Array.from(topicCounts.entries())
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([topic]) => topic)
    .slice(0, maxOverviewTopics);
}

function averageQuestionsPerStudentDay(rows: StudentRosterActivitySummary[]) {
  if (!rows.length) {
    return 0;
  }

  return Math.round((rows.reduce((sum, row) => sum + row.questionsPerDay, 0) / rows.length) * 10) / 10;
}

function profileStatus(profile: Record<string, unknown> | undefined): { label: string; tone: TeacherOverviewStatusTone } {
  if (!profile) {
    return { label: "No profile", tone: "inactive" };
  }

  if (profile.draftProfile && profile.teacherReviewed !== true) {
    return { label: "Draft", tone: "draft" };
  }

  if (profile.active === false) {
    return { label: "Disabled", tone: "inactive" };
  }

  return { label: "Active", tone: "active" };
}

function profileMeta(profile: Record<string, unknown> | undefined) {
  if (!profile) {
    return "No conversations yet";
  }

  const pendingMessages = Number(profile.pendingStudentMessageCount ?? 0);

  if (pendingMessages > 0) {
    return `${pendingMessages} pending ${pendingMessages === 1 ? "message" : "messages"}`;
  }

  const updatedAt = profile.lastSuccessfulUpdateAt || profile.updatedAt || profile.lastReviewedAt;
  const updatedLabel = formatShortDate(updatedAt);

  return updatedLabel ? `Updated ${updatedLabel}` : "No pending messages";
}

function learningProfileRowSort(
  first: TeacherClassOverviewLearningProfileRow,
  second: TeacherClassOverviewLearningProfileRow
) {
  const order = { draft: 0, active: 1, inactive: 2 } as Record<string, number>;

  return (order[first.tone] ?? 3) - (order[second.tone] ?? 3) || first.studentName.localeCompare(second.studentName);
}

function formatReviewQueueStatus(conversation: TeacherConversationReviewSummary) {
  if (conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted") {
    return "Needs follow-up";
  }

  if (conversation.reviewStatus === "ai_answer_needs_review") {
    return "AI review";
  }

  if (conversation.topic.toLowerCase().includes("off-topic")) {
    return "Off-topic redirect";
  }

  return "New";
}

function reviewQueueIssue(conversation: TeacherConversationReviewSummary) {
  if (conversation.sourceAudit.lowSourceConfidence || conversation.learningSignals.lowConfidenceMessageCount > 0) {
    return "Check source accuracy";
  }

  if (conversation.learningSignals.noSourceAssistantMessageCount > 0) {
    return "Answer needs a class source";
  }

  if (conversation.learningSignals.askTeacherCount > 0) {
    return "Student asked for teacher help";
  }

  if (conversation.learningSignals.stuckOutcomeCount > 0) {
    return "Student still seems stuck";
  }

  if (conversation.reviewStatus === "misunderstanding_spotted") {
    return "Possible misunderstanding";
  }

  if (conversation.reviewStatus === "ai_answer_needs_review") {
    return "AI answer needs a teacher check";
  }

  return "New chat to review";
}

function reviewQueueSourceLabel(conversation: TeacherConversationReviewSummary) {
  const sourceCount = conversation.sourceAudit.sourceCount;

  if (sourceCount <= 0) {
    return "No class source used";
  }

  if (conversation.sourceAudit.lowSourceConfidence || conversation.learningSignals.lowConfidenceMessageCount > 0) {
    return `${sourceCount} class ${sourceCount === 1 ? "source" : "sources"} need checking`;
  }

  return `${sourceCount} class ${sourceCount === 1 ? "source" : "sources"} cited`;
}

function reviewQueueSuggestedAction(conversation: TeacherConversationReviewSummary) {
  if (
    conversation.sourceAudit.lowSourceConfidence ||
    conversation.learningSignals.lowConfidenceMessageCount > 0 ||
    conversation.learningSignals.noSourceAssistantMessageCount > 0
  ) {
    return "Compare the answer with the assigned material.";
  }

  if (conversation.learningSignals.askTeacherCount > 0) {
    return "Decide whether to step in or send a short prompt.";
  }

  if (conversation.learningSignals.stuckOutcomeCount > 0 || conversation.reviewStatus === "misunderstanding_spotted") {
    return "Add a scaffold before the student keeps going.";
  }

  return "Skim the exchange and mark it reviewed.";
}

function reviewQueueTone(conversation: TeacherConversationReviewSummary): TeacherOverviewStatusTone {
  if (conversation.reviewStatus === "needs_follow_up" || conversation.reviewStatus === "misunderstanding_spotted") {
    return "follow-up";
  }

  if (conversation.reviewStatus === "ai_answer_needs_review" || conversation.sourceAudit.lowSourceConfidence) {
    return "ai-review";
  }

  if (conversation.topic.toLowerCase().includes("off-topic")) {
    return "inactive";
  }

  return "new";
}

function normalizeOverviewTimezone(timezone: string | null | undefined) {
  const candidate = String(timezone ?? "").trim() || defaultOverviewTimezone;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return defaultOverviewTimezone;
  }
}

function normalizeOverviewDate(date: string | null | undefined, timezone: string) {
  const candidate = String(date ?? "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    return candidate;
  }

  return dateKeyInTimezone(new Date().toISOString(), timezone);
}

function isOverviewDate(value: unknown, date: string, timezone: string) {
  return dateKeyInTimezone(value, timezone) === date;
}

function dateKeyInTimezone(value: unknown, timezone: string) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "";
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric"
    }).formatToParts(new Date(millis));
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
  } catch {
    return new Date(millis).toISOString().slice(0, 10);
  }
}

function formatOverviewDateLabel(date: string) {
  const [, month, day] = date.split("-");
  const parsedDate = new Date(`${date}T12:00:00.000Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    return date;
  }

  return `${parsedDate.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${Number(day || month)}`;
}

function formatOverviewConversationDate(value: unknown, overviewDate: string, timezone: string) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "";
  }

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(new Date(millis));

  if (dateKeyInTimezone(value, timezone) === overviewDate) {
    return `Today ${time}`;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: timezone
  }).format(new Date(millis));
}

function formatShortDate(value: unknown) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).format(new Date(millis));
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    return Date.parse(value) || 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }

  return 0;
}

export function assertOverviewDate(value: string | null) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConversationPersistenceError("Overview date must use YYYY-MM-DD.", 400);
  }
}
