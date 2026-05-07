import { adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  listTeacherClassConversations,
  listTeacherRosterActivity,
  ConversationPersistenceError
} from "./student-conversations-server";
import type {
  StudentRosterActivitySummary,
  TeacherClassOverview,
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
const maxNextActions = 6;
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
  const [rosterActivity, conversations, knowledgeStatus, learningProfileRows, insightSummary] = await Promise.all([
    listTeacherRosterActivity({ classId, date: overviewDate, timezone: overviewTimezone }),
    listTeacherClassConversations({ classId }),
    buildKnowledgeStatus(classId),
    buildLearningProfileRows(classId),
    getOverviewInsightSummary(classId)
  ]);
  const conversationsToday = conversations.filter((conversation) =>
    isOverviewDate(conversation.lastMessageAt, overviewDate, overviewTimezone)
  );
  const questionsToday = rosterActivity.reduce((sum, row) => sum + row.questionsToday, 0);
  const activeStudentsToday = rosterActivity.filter((row) => row.status === "active" || row.questionsToday > 0).length;
  const priorityRows = buildPriorityRows(rosterActivity, conversations);
  const reviewQueueRows = buildReviewQueueRows(conversations);

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
        insightSummary.body ||
        buildFallbackSummaryBody({
          activeStudentsToday,
          conversationCountToday: conversationsToday.length,
          questionsToday
        }),
      conversationCountToday: conversationsToday.length,
      questionsToday,
      title: insightSummary.title || "Today's Summary",
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

function buildReviewQueueRows(conversations: TeacherConversationReviewSummary[]): TeacherClassOverviewReviewQueueRow[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.reviewStatus === "new" ||
        conversation.reviewStatus === "needs_follow_up" ||
        conversation.reviewStatus === "misunderstanding_spotted" ||
        conversation.reviewStatus === "ai_answer_needs_review" ||
        conversation.sourceAudit.lowSourceConfidence ||
        conversation.topic.toLowerCase().includes("off-topic")
    )
    .slice(0, maxReviewRows)
    .map((conversation) => ({
      conversationId: conversation.id,
      id: conversation.id,
      meta: conversation.sourceAudit.lowSourceConfidence
        ? "low confidence"
        : `${conversation.messageCount} ${conversation.messageCount === 1 ? "message" : "messages"}`,
      status: formatReviewQueueStatus(conversation),
      studentId: conversation.studentId,
      studentName: conversation.studentName,
      title: conversation.title,
      tone: reviewQueueTone(conversation)
    }));
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

async function getOverviewInsightSummary(classId: string) {
  const snapshot = await adminDb!.collection("classes").doc(classId).collection("teacherInsights").doc("today").get();
  const data = snapshot.data() ?? {};
  const insight = data.insight && typeof data.insight === "object" ? (data.insight as Record<string, unknown>) : {};
  const dailySummary =
    insight.dailySummary && typeof insight.dailySummary === "object"
      ? (insight.dailySummary as Record<string, unknown>)
      : {};

  return {
    body: conciseSummaryText(String(dailySummary.body ?? "")),
    title: conciseSummaryText(String(dailySummary.title ?? ""))
  };
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

function buildNextActions({
  knowledgeStatus,
  learningProfileRows,
  priorityRows,
  reviewQueueRows,
  rosterActivity
}: {
  knowledgeStatus: TeacherClassOverviewKnowledgeStat[];
  learningProfileRows: TeacherClassOverviewLearningProfileRow[];
  priorityRows: TeacherClassOverviewPriorityRow[];
  reviewQueueRows: TeacherClassOverviewReviewQueueRow[];
  rosterActivity: StudentRosterActivitySummary[];
}): TeacherClassOverviewNextAction[] {
  type ScoredAction = TeacherClassOverviewNextAction & { score: number };
  const actions: ScoredAction[] = [];
  const addAction = (action: TeacherClassOverviewNextAction, score: number) => {
    if (!actions.some((currentAction) => currentAction.id === action.id)) {
      actions.push({ ...action, score });
    }
  };
  const totalUploaded = knowledgeStatus.find((stat) => stat.label === "Total uploaded")?.value ?? 0;
  const ready = knowledgeStatus.find((stat) => stat.label === "Ready")?.value ?? 0;
  const failed = knowledgeStatus.find((stat) => stat.label === "Failed / needs review")?.value ?? 0;
  const processing = knowledgeStatus.find((stat) => stat.label === "Processing")?.value ?? 0;
  const activeForStudents = knowledgeStatus.find((stat) => stat.label === "Active for students")?.value ?? 0;
  const highPriority = priorityRows.find((row) => row.tone === "high");
  const followUpPriority = priorityRows.find((row) => row.tone === "follow-up" || row.tone === "ai-review");
  const notePriority = priorityRows.find((row) => row.tone === "note");
  const noConversationStudents = rosterActivity.filter((row) => row.conversationCount === 0);
  const inactiveStudents = rosterActivity.filter((row) => row.status === "no_activity");
  const lowConfidenceReview = reviewQueueRows.find((row) => row.meta.toLowerCase().includes("low confidence"));
  const followUpReview = reviewQueueRows.find((row) => row.tone === "follow-up" || row.tone === "ai-review");
  const draftProfiles = learningProfileRows.filter((row) => row.status === "Draft");
  const noProfileRows = learningProfileRows.filter((row) => row.status === "No profile");

  if (!rosterActivity.length) {
    addAction({
      action: "addStudent",
      detail: "Build the roster before students can use Chandra.",
      id: "add-student",
      label: "Add student",
      tone: "inactive"
    }, 100);
  }

  if (highPriority) {
    addAction({
      action: "viewStudentChats",
      detail: `${highPriority.studentName}: ${highPriority.issue.toLowerCase()}.`,
      id: `high-volume-${highPriority.studentId || highPriority.studentEmail}`,
      label: "Check high-volume student",
      studentEmail: highPriority.studentEmail,
      studentId: highPriority.studentId,
      studentName: highPriority.studentName,
      tone: "high"
    }, 95);
  }

  if (followUpReview) {
    addAction({
      action: "reviewConversations",
      conversationId: followUpReview.conversationId,
      detail: `${followUpReview.studentName}: ${followUpReview.status.toLowerCase()} in "${followUpReview.title}".`,
      id: `review-${followUpReview.conversationId}`,
      label: "Review flagged chat",
      studentId: followUpReview.studentId,
      studentName: followUpReview.studentName,
      tone: followUpReview.tone
    }, 92);
  }

  if (lowConfidenceReview) {
    addAction({
      action: "testRetrieval",
      conversationId: lowConfidenceReview.conversationId,
      detail: `Low source confidence in "${lowConfidenceReview.title}".`,
      id: `low-confidence-${lowConfidenceReview.conversationId}`,
      label: "Test retrieval",
      studentId: lowConfidenceReview.studentId,
      studentName: lowConfidenceReview.studentName,
      tone: "ai-review"
    }, 88);
  }

  if (failed) {
    addAction({
      action: "openKnowledge",
      detail: `${failed} knowledge source${failed === 1 ? "" : "s"} failed or need review.`,
      id: "fix-knowledge",
      label: "Fix knowledge source",
      tone: "failed"
    }, 86);
  }

  if (!totalUploaded) {
    addAction({
      action: "addKnowledge",
      detail: "No class materials are uploaded, so answers cannot use class context.",
      id: "add-first-knowledge",
      label: "Add first knowledge source",
      tone: "processing"
    }, rosterActivity.length ? 84 : 90);
  } else if (!activeForStudents && ready) {
    addAction({
      action: "openKnowledge",
      detail: `${ready} ready source${ready === 1 ? "" : "s"} are not active for students.`,
      id: "activate-knowledge",
      label: "Activate knowledge",
      tone: "ready"
    }, 82);
  } else if (processing) {
    addAction({
      action: "openKnowledge",
      detail: `${processing} source${processing === 1 ? " is" : "s are"} still processing.`,
      id: "check-processing-knowledge",
      label: "Check knowledge status",
      tone: "processing"
    }, 58);
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
    }, 80);
  }

  if (followUpPriority) {
    addAction({
      action: "viewStudentChats",
      detail: `${followUpPriority.studentName}: ${followUpPriority.issue.toLowerCase()}.`,
      id: `follow-up-${followUpPriority.studentId || followUpPriority.studentEmail}`,
      label: "Follow up with student",
      studentEmail: followUpPriority.studentEmail,
      studentId: followUpPriority.studentId,
      studentName: followUpPriority.studentName,
      tone: followUpPriority.tone
    }, 78);
  }

  if (reviewQueueRows.length) {
    addAction({
      action: "reviewConversations",
      conversationId: reviewQueueRows[0]?.conversationId,
      detail: `${reviewQueueRows.length} conversation${reviewQueueRows.length === 1 ? "" : "s"} are still unreviewed.`,
      id: "review-conversations",
      label: "Clear review queue",
      tone: "new"
    }, 72);
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
    }, 66);
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
    }, 54);
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
    }, 50);
  }

  if (noProfileRows.length && reviewQueueRows.length) {
    const firstProfile = noProfileRows[0];
    addAction({
      action: "reviewLearningProfiles",
      detail: `${noProfileRows.length} student${noProfileRows.length === 1 ? "" : "s"} still have no reviewed profile.`,
      id: "review-missing-profiles",
      label: "Build profile coverage",
      studentEmail: firstProfile?.studentEmail,
      studentId: firstProfile?.studentId,
      studentName: firstProfile?.studentName,
      tone: "inactive"
    }, 46);
  }

  if (ready && activeForStudents) {
    addAction({
      action: "testRetrieval",
      detail: "Spot-check ready sources against today’s questions.",
      id: "test-retrieval",
      label: "Spot-check retrieval",
      tone: "ready"
    }, 42);
  }

  addAction({
    action: "openInsights",
    detail: "Inspect trend evidence before planning tomorrow’s lesson.",
    id: "open-insights",
    label: "Inspect insight evidence",
    tone: "teacher-only"
  }, 36);

  addAction({
    action: "openStudentView",
    detail: "Preview what students see after your latest changes.",
    id: "open-student-view",
    label: "Preview student view",
    tone: "teacher-only"
  }, 20);

  return actions
    .sort((first, second) => second.score - first.score || first.label.localeCompare(second.label))
    .slice(0, maxNextActions)
    .map(({ score, ...action }) => action);
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
