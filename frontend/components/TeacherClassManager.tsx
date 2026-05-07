"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api-client";
import { signOutCurrentUser, updateUserThemePreference } from "@/lib/auth";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  teacherClassThemeColorOptions
} from "@/lib/class-theme";
import {
  defaultRefusalStyle,
  mathNotationOptions,
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeResponseFormatSettings,
  normalizeSourceUsageSettings,
  normalizeTutorBehavior,
  preferredSourceTypeOptions,
  readingLevelOptions,
  reasoningEffortOptions,
  responseLengthOptions,
  tutorBehaviorOptions,
  type AnswerPolicySettings,
  type ResponseFormatSettings,
  type SourceUsageSettings
} from "@/lib/class-settings";
import {
  addStudentToClass,
  createTeacherClass,
  ensureClassJoinCode,
  subscribeToMaterialJob,
  subscribeToClassMaterials,
  subscribeToClassStudents,
  subscribeToTeacherClasses,
  updateTeacherClassSettings,
  type ClassMaterial,
  type MaterialJobProgress,
  type ClassStudent,
  type TeacherClass
} from "@/lib/classes";
import { defaultModelOptions } from "@/lib/model-options";
import {
  formatBytes,
  supportedTutorKnowledgeExtensions,
  tutorKnowledgeKinds,
  type TutorKnowledgeKind
} from "@/lib/tutor-knowledge";
import type {
  ChatMessage,
  ConversationReviewStatus,
  StudentConversationSummary,
  StudentLearningProfileContent,
  StudentLearningProfileDocument,
  StudentLearningTriedStrategy,
  StudentRosterActivitySummary,
  TeacherClassOverview,
  TeacherClassInsightsDocument,
  TeacherConversationReviewSummary,
  TeacherConversationSourceAuditSummary,
  TeacherInsightFeedbackAction,
  TeacherInsightRange
} from "@/lib/types";
import { useAuth } from "./AuthProvider";

type MaterialUploadProgress = {
  detail: string;
  percent: number;
  step: "prepare" | "upload" | "read" | "chunk" | "embed" | "save" | "complete";
  uploadPercent: number;
};

type TeacherTab = "overview" | "roster" | "settings" | "knowledge" | "insights" | "conversations";
type KnowledgeFilter = "All" | "Assignments" | "Textbook" | "Notes" | "Worked Examples" | "Rubrics" | "Answer Keys";
type RosterFilter = "all" | "active" | "inactive" | "highQuestions" | "noConversations";
type ConversationFilter =
  | "all"
  | "unreviewed"
  | "activeToday"
  | "highMessageCount"
  | "noTeacherReview"
  | "offTopic"
  | "lowConfidence";
type RosterConversationPreview = {
  id: string;
  lastMessageAt: unknown;
  messageCount: number;
  meta: string;
  title: string;
};
type ConversationReviewRow = {
  id: string;
  lastMessageAt: unknown;
  lastMessageLabel: string;
  messageCount: number;
  modelId: string;
  status: ConversationReviewStatus;
  review: TeacherConversationReviewSummary["review"];
  sourceAudit: TeacherConversationSourceAuditSummary;
  latestRetrievalConfidence?: TeacherConversationReviewSummary["latestRetrievalConfidence"];
  studentEmail: string;
  studentId: string;
  studentName: string;
  title: string;
  topic: string;
};
type ConversationSourceRow = {
  citationCount: number;
  confidence: string;
  confidenceClass: "high" | "medium" | "low";
  detail: string;
  materialType: string;
  pages: string[];
  title: string;
};
type RosterRow = {
  activeToday: boolean;
  conversationsCount: number;
  conversationsLabel: string;
  hasConversations: boolean;
  highQuestions: boolean;
  lastActive: string;
  lastChatTopic: string;
  questionsLabel: string;
  questionsPerDay: number;
  questionsToday: number;
  recentConversations: RosterConversationPreview[];
  status: "Active" | "Inactive" | "No activity";
  statusTone: "active" | "inactive" | "none";
  student: ClassStudent;
  studentEmail: string;
  teacherNotes: string;
  totalQuestions: number;
};

type KnowledgeSourceSettings = {
  activeForStudents: boolean;
  citationsRequired: boolean;
  priority: "Primary" | "Normal" | "Low";
  teacherOnly: boolean;
};

type RetrievalTestResult = {
  chunkId: string;
  chunkIndex?: number;
  chunkLabel: string;
  confidence: number;
  excerpt: string;
  materialId: string;
  title: string;
};

type MaterialDetailChunk = {
  id: string;
  excerpt: string;
  label: string;
  pageEnd?: number | null;
  pageStart?: number | null;
  problemNumbers: string[];
  sectionHeading: string;
};

type MaterialDetail = {
  materialId: string;
  relatedTopics: string[];
  sampleChunks: MaterialDetailChunk[];
};

const teacherTabs: Array<{ id: TeacherTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roster", label: "Roster" },
  { id: "knowledge", label: "Knowledge" },
  { id: "insights", label: "Insights" },
  { id: "conversations", label: "Conversations" },
  { id: "settings", label: "Settings" }
];

const rosterFilters: Array<{ id: RosterFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active now" },
  { id: "inactive", label: "Not active" },
  { id: "highQuestions", label: "High questions volume" },
  { id: "noConversations", label: "No conversations yet" }
];

const knowledgeFilters: KnowledgeFilter[] = [
  "All",
  "Assignments",
  "Textbook",
  "Notes",
  "Worked Examples",
  "Rubrics",
  "Answer Keys"
];

const conversationFilters: Array<{ id: ConversationFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unreviewed", label: "Unreviewed" },
  { id: "activeToday", label: "Active today" },
  { id: "highMessageCount", label: "High message count" },
  { id: "noTeacherReview", label: "No teacher review yet" },
  { id: "offTopic", label: "Off-topic redirects" },
  { id: "lowConfidence", label: "Low source confidence" }
];

const conversationReviewActions: Array<{ label: string; status: ConversationReviewStatus }> = [
  { label: "Reviewed", status: "reviewed" },
  { label: "Needs follow-up", status: "needs_follow_up" },
  { label: "Misunderstanding spotted", status: "misunderstanding_spotted" },
  { label: "Good learning moment", status: "good_learning_moment" },
  { label: "AI answer needs review", status: "ai_answer_needs_review" }
];

const insightTimeFilters: Array<{ label: string; range: TeacherInsightRange }> = [
  { label: "Today", range: "today" },
  { label: "Yesterday", range: "yesterday" },
  { label: "Last 7 days", range: "7d" },
  { label: "Last 30 days", range: "30d" }
];

const answerPolicySettings = [
  {
    id: "doNotGiveFinalAnswers",
    title: "Do not give final answers",
    description: "Avoid providing final answers unless explicitly allowed."
  },
  {
    id: "requireStudentAttemptFirst",
    title: "Require student attempt first",
    description: "Ask for an attempt before task-specific help."
  },
  {
    id: "askGuidingQuestionBeforeExplaining",
    title: "Ask guiding question before explaining",
    description: "Prompt with a question to promote deeper thinking."
  },
  {
    id: "allowWorkedExamples",
    title: "Allow worked examples",
    description: "Provide full worked examples when appropriate."
  },
  {
    id: "refuseAnswerOnlyRequests",
    title: "Refuse answer-only requests",
    description: "Decline requests that seek only answers."
  }
] as const;

const sourceUsageSettings = [
  {
    id: "useClassMaterialsFirst",
    title: "Use class materials first",
    description: "Prefer uploaded materials and textbook content."
  },
  {
    id: "citeSourcePages",
    title: "Cite source pages",
    description: "Include page numbers or section references."
  },
  {
    id: "askClarificationIfSourceUnclear",
    title: "Ask clarification if source is unclear",
    description: "Confirm intent when materials are ambiguous."
  },
  {
    id: "quoteSourcePassages",
    title: "Quote source passages",
    description: "Allow exact excerpts from uploaded class materials when students ask."
  }
] as const;

const responseFormatSettings = [
  {
    id: "oneStepAtATime",
    title: "One step at a time",
    description: "After an attempt, give one hint or step before continuing."
  },
  {
    id: "endWithCheckQuestion",
    title: "End with a check question",
    description: "Close replies with a quick question that checks understanding."
  }
] as const;

const selectableModelOptions = defaultModelOptions.filter((modelOption) => modelOption.provider === "openrouter");
const classAppearanceOptions = ["light", "dark"] as const;

export function TeacherClassManager() {
  const router = useRouter();
  const { profile, user } = useAuth();
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [materials, setMaterials] = useState<ClassMaterial[]>([]);
  const [rosterActivity, setRosterActivity] = useState<StudentRosterActivitySummary[]>([]);
  const [studentConversations, setStudentConversations] = useState<StudentConversationSummary[]>([]);
  const [classConversations, setClassConversations] = useState<TeacherConversationReviewSummary[]>([]);
  const [classConversationMetrics, setClassConversationMetrics] = useState<{
    followUp: number;
    lowConfidence: number;
    total: number;
    unreviewed: number;
  } | null>(null);
  const [classOverview, setClassOverview] = useState<TeacherClassOverview | null>(null);
  const [isLoadingClassOverview, setIsLoadingClassOverview] = useState(false);
  const [selectedStudentLearningProfile, setSelectedStudentLearningProfile] =
    useState<StudentLearningProfileDocument | null>(null);
  const [learningProfileStatusMessage, setLearningProfileStatusMessage] = useState("");
  const [canForceLearningProfileUpdate, setCanForceLearningProfileUpdate] = useState(false);
  const [conversationMessages, setConversationMessages] = useState<ChatMessage[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [selectedStudentClassId, setSelectedStudentClassId] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
  const [knowledgeFilter, setKnowledgeFilter] = useState<KnowledgeFilter>("All");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [sourceSettingsByMaterialId, setSourceSettingsByMaterialId] = useState<Record<string, KnowledgeSourceSettings>>({});
  const [retrievalQuery, setRetrievalQuery] = useState("");
  const [retrievalResults, setRetrievalResults] = useState<RetrievalTestResult[]>([]);
  const [isTestingRetrieval, setIsTestingRetrieval] = useState(false);
  const [reprocessingMaterialId, setReprocessingMaterialId] = useState("");
  const [settingsCreativityPreview, setSettingsCreativityPreview] = useState<{
    classId: string;
    value: number;
  } | null>(null);
  const [className, setClassName] = useState("");
  const [classSection, setClassSection] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [studentName, setStudentName] = useState("");
  const [activeTab, setActiveTab] = useState<TeacherTab>("overview");
  const [rosterSearchQuery, setRosterSearchQuery] = useState("");
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>("all");
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationStudentFilter, setConversationStudentFilter] = useState("all");
  const [conversationTopicFilter, setConversationTopicFilter] = useState("all");
  const [evidenceConversationIds, setEvidenceConversationIds] = useState<string[]>([]);
  const [checkedStudentIds, setCheckedStudentIds] = useState<string[]>([]);
  const [isRosterDetailOpen, setIsRosterDetailOpen] = useState(true);
  const [isProfessorReviewOpen, setIsProfessorReviewOpen] = useState(false);
  const [teacherNotesByStudentId, setTeacherNotesByStudentId] = useState<Record<string, string>>({});
  const [conversationNotesById, setConversationNotesById] = useState<Record<string, string>>({});
  const [savingNotesStudentId, setSavingNotesStudentId] = useState("");
  const [savingReviewConversationId, setSavingReviewConversationId] = useState("");
  const [reviewSaveMessage, setReviewSaveMessage] = useState("");
  const [highlightedNoteConversationId, setHighlightedNoteConversationId] = useState("");
  const [expandedSourceConversationId, setExpandedSourceConversationId] = useState("");
  const [savingLearningProfileAction, setSavingLearningProfileAction] = useState("");
  const [teacherInsights, setTeacherInsights] = useState<TeacherClassInsightsDocument | null>(null);
  const [teacherInsightRange, setTeacherInsightRange] = useState<TeacherInsightRange>("today");
  const [teacherInsightNote, setTeacherInsightNote] = useState("");
  const [isLoadingTeacherInsights, setIsLoadingTeacherInsights] = useState(false);
  const [isGeneratingTeacherInsights, setIsGeneratingTeacherInsights] = useState(false);
  const [savingInsightFeedback, setSavingInsightFeedback] = useState("");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialKind, setMaterialKind] = useState<TutorKnowledgeKind>("Assignment");
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialText, setMaterialText] = useState("");
  const [materialUploadProgress, setMaterialUploadProgress] = useState<MaterialUploadProgress | null>(null);
  const [materialSuccess, setMaterialSuccess] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [error, setError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [inviteLinkCopyResult, setInviteLinkCopyResult] = useState<{
    classCode: string;
    status: "copied" | "failed";
  } | null>(null);
  const [loadedTeacherId, setLoadedTeacherId] = useState("");
  const [loadedDetailsClassId, setLoadedDetailsClassId] = useState("");
  const [isSavingClass, setIsSavingClass] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingStudent, setIsSavingStudent] = useState(false);
  const [isSavingMaterial, setIsSavingMaterial] = useState(false);
  const [isSavingThemePreference, setIsSavingThemePreference] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [isStudentDialogOpen, setIsStudentDialogOpen] = useState(false);
  const [isKnowledgeDialogOpen, setIsKnowledgeDialogOpen] = useState(false);
  const [isMaterialDetailDrawerOpen, setIsMaterialDetailDrawerOpen] = useState(false);
  const [materialDetailsById, setMaterialDetailsById] = useState<Record<string, MaterialDetail>>({});
  const [materialDetailLoadingId, setMaterialDetailLoadingId] = useState("");
  const [materialDetailError, setMaterialDetailError] = useState("");
  const [deletingMaterialId, setDeletingMaterialId] = useState("");
  const isLoadingClasses = Boolean(user && loadedTeacherId !== user.uid);

  useEffect(() => {
    if (!user) {
      return () => {};
    }

    return subscribeToTeacherClasses(
      user.uid,
      (nextClasses) => {
        setClasses(nextClasses);
        setLoadedTeacherId(user.uid);
      },
      (caughtError) => {
        setClasses([]);
        setError(formatClassError(caughtError, "Class load failed."));
        setLoadedTeacherId(user.uid);
      }
    );
  }, [user]);

  const activeClassId = useMemo(() => {
    if (classes.some((teacherClass) => teacherClass.id === selectedClassId)) {
      return selectedClassId;
    }

    return classes[0]?.id ?? "";
  }, [classes, selectedClassId]);

  const selectedClass = useMemo(
    () => classes.find((teacherClass) => teacherClass.id === activeClassId) ?? null,
    [activeClassId, classes]
  );
  const activeSelectedStudentId = selectedStudentClassId === activeClassId ? selectedStudentId : "";
  const rosterStudents = students;
  const studentActivityByEmail = useMemo(() => buildStudentActivityByEmail(rosterActivity), [rosterActivity]);
  const displaySelectedStudentId =
    activeSelectedStudentId && rosterStudents.some((student) => student.id === activeSelectedStudentId)
      ? activeSelectedStudentId
      : rosterStudents[0]?.id ?? "";
  const selectedStudent = useMemo(() => {
    return rosterStudents.find((student) => student.id === displaySelectedStudentId) ?? null;
  }, [displaySelectedStudentId, rosterStudents]);
  const rosterRows = useMemo(
    () =>
      buildRosterRows({
        studentActivityByEmail,
        students: rosterStudents
      }),
    [rosterStudents, studentActivityByEmail]
  );
  const filteredRosterRows = useMemo(
    () => filterRosterRows(rosterRows, rosterSearchQuery, rosterFilter),
    [rosterFilter, rosterRows, rosterSearchQuery]
  );
  const selectedRosterRow = isRosterDetailOpen
    ? rosterRows.find((row) => row.student.id === displaySelectedStudentId) ?? rosterRows[0] ?? null
    : null;
  const currentRosterStudentIds = useMemo(() => new Set(rosterStudents.map((student) => student.id)), [rosterStudents]);
  const availableCheckedStudentIds = checkedStudentIds.filter((studentId) => currentRosterStudentIds.has(studentId));
  const checkedStudentIdSet = useMemo(() => new Set(availableCheckedStudentIds), [availableCheckedStudentIds]);
  const checkedVisibleStudentIds = filteredRosterRows
    .map((row) => row.student.id)
    .filter((studentId) => checkedStudentIdSet.has(studentId));
  const allVisibleStudentsChecked =
    filteredRosterRows.length > 0 && checkedVisibleStudentIds.length === filteredRosterRows.length;
  const someVisibleStudentsChecked = checkedVisibleStudentIds.length > 0;
  const rosterStats = useMemo(() => buildRosterStats(rosterRows), [rosterRows]);
  const conversationReviewRows = useMemo(
    () => buildConversationReviewRows(classConversations, activeClassId),
    [activeClassId, classConversations]
  );
  const visibleStudentConversations = studentConversations.filter(
    (conversation) =>
      conversation.classId === activeClassId &&
      conversation.studentEmail === selectedStudent?.email.trim().toLowerCase()
  );
  const activeSelectedConversationId =
    selectedConversationClassId === activeClassId &&
    (conversationReviewRows.some((conversation) => conversation.id === selectedConversationId) ||
      visibleStudentConversations.some((conversation) => conversation.id === selectedConversationId))
      ? selectedConversationId
      : activeTab === "conversations"
        ? conversationReviewRows[0]?.id ?? visibleStudentConversations[0]?.id ?? ""
        : visibleStudentConversations[0]?.id ?? "";
  const selectedConversation = visibleStudentConversations.find(
    (conversation) => conversation.id === activeSelectedConversationId
  );
  const conversationStudentOptions = useMemo(
    () =>
      Array.from(
        new Map(
          conversationReviewRows.map((conversation) => [
            conversation.studentEmail,
            { email: conversation.studentEmail, name: conversation.studentName }
          ])
        ).values()
      ),
    [conversationReviewRows]
  );
  const conversationTopicOptions = useMemo(
    () => Array.from(new Set(conversationReviewRows.map((conversation) => conversation.topic))).filter(Boolean),
    [conversationReviewRows]
  );
  const filteredConversationReviewRows = useMemo(
    () =>
      filterConversationReviewRows({
        evidenceConversationIds,
        filter: conversationFilter,
        query: conversationSearchQuery,
        rows: conversationReviewRows,
        studentEmail: conversationStudentFilter,
        topic: conversationTopicFilter
      }),
    [
      conversationFilter,
      conversationReviewRows,
      conversationSearchQuery,
      evidenceConversationIds,
      conversationStudentFilter,
      conversationTopicFilter
    ]
  );
  const selectedConversationReviewRow =
    filteredConversationReviewRows.find((conversation) => conversation.id === activeSelectedConversationId) ??
    conversationReviewRows.find((conversation) => conversation.id === activeSelectedConversationId) ??
    filteredConversationReviewRows[0] ??
    conversationReviewRows[0] ??
    null;
  const selectedConversationRosterRow =
    rosterRows.find((row) => row.student.id === selectedConversationReviewRow?.studentId) ??
    rosterRows.find((row) => row.student.email.trim().toLowerCase() === selectedConversationReviewRow?.studentEmail) ??
    null;
  const transcriptMessages =
    selectedConversationReviewRow?.id === activeSelectedConversationId
      ? conversationMessages.filter((message) => message.role === "student" || message.role === "assistant")
      : [];
  const conversationMetrics = classConversationMetrics ?? buildConversationMetrics(conversationReviewRows, rosterRows);
  const conversationSourceRows = buildConversationSourceRows(
    selectedConversationReviewRow?.sourceAudit,
    transcriptMessages,
    materials
  );
  const hasSourceWarning = Boolean(selectedConversationReviewRow?.sourceAudit.noSourceUsedWarning);
  const isSourceAuditExpanded = Boolean(
    selectedConversationReviewRow && expandedSourceConversationId === selectedConversationReviewRow.id
  );
  const visibleConversationSourceRows = isSourceAuditExpanded ? conversationSourceRows : conversationSourceRows.slice(0, 3);
  const conversationCitationCount = conversationSourceRows.reduce((sum, source) => sum + source.citationCount, 0);
  const selectedConversationPrivateNote = selectedConversationReviewRow
    ? conversationNotesById[selectedConversationReviewRow.id] ?? selectedConversationReviewRow.review.privateNote
    : "";
  const isConversationNoteHighlighted = Boolean(
    selectedConversationReviewRow && highlightedNoteConversationId === selectedConversationReviewRow.id
  );
  const studentTimelineBars = buildStudentTimelineBars(selectedConversationRosterRow, conversationReviewRows);
  const displayedStudentLearningProfile =
    selectedStudentLearningProfile?.studentEmail === selectedStudent?.email.trim().toLowerCase()
      ? selectedStudentLearningProfile
      : null;
  const filteredMaterials = useMemo(
    () => materials.filter((material) => knowledgeFilterMatchesMaterial(knowledgeFilter, material)),
    [knowledgeFilter, materials]
  );
  const selectedMaterial = useMemo(() => {
    if (filteredMaterials.some((material) => material.id === selectedMaterialId)) {
      return filteredMaterials.find((material) => material.id === selectedMaterialId) ?? null;
    }

    if (materials.some((material) => material.id === selectedMaterialId)) {
      return materials.find((material) => material.id === selectedMaterialId) ?? null;
    }

    return filteredMaterials[0] ?? materials[0] ?? null;
  }, [filteredMaterials, materials, selectedMaterialId]);
  const selectedMaterialSettings = selectedMaterial
    ? sourceSettingsByMaterialId[selectedMaterial.id] ?? defaultKnowledgeSourceSettings(selectedMaterial)
    : null;
  const selectedMaterialDetail = selectedMaterial ? materialDetailsById[selectedMaterial.id] ?? null : null;
  const selectedClassCode = selectedClass?.joinCode ?? "";
  const selectedAnswerPolicy = normalizeAnswerPolicySettings(selectedClass?.answerPolicy);
  const selectedSourceUsage = normalizeSourceUsageSettings(selectedClass?.sourceUsage);
  const selectedModelSettings = normalizeClassModelSettings(selectedClass?.modelSettings);
  const selectedResponseFormat = normalizeResponseFormatSettings(selectedClass?.responseFormat);
  const selectedTutorBehavior = normalizeTutorBehavior(selectedClass?.behaviorTitle);
  const selectedClassAppearance = normalizeTeacherClassAppearance(selectedClass?.appearance);
  const selectedClassThemeColor = normalizeTeacherClassThemeColor(selectedClass?.themeColor);
  const selectedAppearance = normalizeTeacherClassAppearance(profile?.appearance ?? selectedClass?.appearance);
  const selectedThemeColor = normalizeTeacherClassThemeColor(profile?.themeColor ?? selectedClass?.themeColor);
  const displayedCreativity =
    settingsCreativityPreview?.classId === activeClassId
      ? settingsCreativityPreview.value
      : selectedModelSettings.creativity;
  const inviteLinkCopyStatus =
    inviteLinkCopyResult?.classCode === selectedClassCode ? inviteLinkCopyResult.status : "";
  const isLoadingClassDetails = Boolean(activeClassId && loadedDetailsClassId !== activeClassId);
  const hasTutorKnowledgeSource = Boolean(materialFile || materialText.trim());
  const accountName = profile?.displayName ?? user?.displayName ?? "Teacher";
  const accountEmail = user?.email ?? "";
  const totalConversationCount = rosterRows.reduce((sum, row) => sum + row.conversationsCount, 0);
  const insightsDateLabel = formatInsightsDateLabel(new Date());
  const hasGeneratedTeacherInsights = Boolean(teacherInsights?.generatedAt);
  const displayedInsightMetrics = hasGeneratedTeacherInsights ? teacherInsights?.insight.metrics ?? [] : [];
  const displayedInsightSummary = hasGeneratedTeacherInsights ? teacherInsights?.insight.dailySummary : null;
  const displayedInsightEvidenceChips =
    hasGeneratedTeacherInsights && teacherInsights?.insight.evidenceChips.length
      ? teacherInsights.insight.evidenceChips
      : [];
  const displayedInsightTrends =
    hasGeneratedTeacherInsights && teacherInsights?.insight.trends.length
      ? teacherInsights.insight.trends
      : null;
  const displayedInsightTimeline =
    hasGeneratedTeacherInsights && teacherInsights?.insight.misconceptionTimeline.length
      ? teacherInsights.insight.misconceptionTimeline
      : null;
  const displayedInsightRecommendations =
    hasGeneratedTeacherInsights && teacherInsights?.insight.recommendations.length
      ? teacherInsights.insight.recommendations
      : null;
  const displayedInsightEvidenceLinks =
    hasGeneratedTeacherInsights && teacherInsights?.insight.evidenceLinks.length
      ? teacherInsights.insight.evidenceLinks
      : null;
  const insightTrendDisplayRows = displayedInsightTrends
    ? displayedInsightTrends.map((row) => ({
        change: row.change,
        conversationIds: row.evidenceConversationIds,
        evidence: formatConversationCount(row.evidenceConversationIds.length),
        key: row.id,
        label: row.label,
        points: row.sparkline,
        tone: row.direction
      }))
    : [];
  const insightTimelineDisplayRows = displayedInsightTimeline
    ? displayedInsightTimeline.map((row) => {
        const evidenceCount = row.evidenceConversationIds.length || row.seenInConversations;

        return {
          appeared: formatInsightDateOnly(row.firstAppeared),
          conversationIds: row.evidenceConversationIds,
          key: row.id,
          misconception: row.misconception,
          seen: formatConversationCount(evidenceCount),
          status: capitalizeLabel(row.status)
        };
      })
    : [];
  const insightRecommendationDisplayRows = displayedInsightRecommendations
    ? displayedInsightRecommendations.map((row) => {
        const evidenceCount = row.evidenceConversationIds.length || row.evidenceCount;

        return {
          action: capitalizeLabel(row.action),
          conversationIds: row.evidenceConversationIds,
          evidence: `${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of evidence`,
          key: row.id,
          priority: capitalizeLabel(row.priority),
          title: row.title
        };
      })
    : [];
  const insightEvidenceDisplayRows = displayedInsightEvidenceLinks
    ? displayedInsightEvidenceLinks.map((row) => ({
        count: `${row.conversationCount} ${row.conversationCount === 1 ? "conversation" : "conversations"}`,
        conversationIds: row.conversationIds,
        initials: row.studentInitials,
        key: row.id,
        timestamp: formatConversationDate(row.lastSeenAt),
        topic: row.topic
      }))
    : [];
  const insightMetricValue = (metricId: string) =>
    displayedInsightMetrics.find((metric) => metric.id === metricId)?.value ?? 0;
  const overviewTotalStudents = classOverview?.metrics.totalStudents ?? rosterStats.totalStudents;
  const overviewActiveStudents = classOverview?.metrics.activeNow ?? rosterStats.activeToday;
  const overviewQuestionsToday =
    classOverview?.metrics.questionsToday ?? rosterRows.reduce((sum, row) => sum + row.questionsToday, 0);
  const overviewTotalConversations = classOverview?.metrics.totalConversations ?? conversationMetrics.total ?? totalConversationCount;
  const overviewAverageQuestions = rosterStats.totalStudents ? rosterStats.averageQuestions : 0;
  const overviewNoActivity = classOverview?.metrics.noActivity ?? rosterStats.noActivity;
  const overviewDateLabel =
    classOverview?.dateLabel ?? new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const overviewAverageQuestionsValue =
    classOverview?.metrics.averageQuestionsPerStudentPerDay ?? overviewAverageQuestions;
  const overviewKnowledgeStats = classOverview?.knowledgeStatus ?? buildOverviewKnowledgeStats(materials);
  const overviewTopics = classOverview?.summary.topTopics ?? [];
  const overviewSummaryTitle = classOverview?.summary.title || "Today's Summary";
  const overviewSummaryBody =
    classOverview?.summary.body ||
    "No daily AI summary is available yet. It will appear after Chandra has enough recent class activity.";
  const overviewPriorityRows = classOverview?.priorityRows ?? [];
  const overviewRecentActivityRows = classOverview?.recentActivityRows ?? [];
  const overviewReviewQueueRows = classOverview?.reviewQueueRows ?? [];
  const overviewLearningProfileRows = classOverview?.learningProfileRows ?? [];
  const overviewNextActions = classOverview?.nextActions ?? [];

  useEffect(() => {
    if (!selectedClass || selectedClass.joinCode) {
      return;
    }

    ensureClassJoinCode(selectedClass.id).catch((caughtError) => {
      setError(formatClassError(caughtError, "Class code setup failed."));
    });
  }, [selectedClass]);

  useEffect(() => {
    if (!activeClassId) {
      return () => {};
    }

    let studentsLoaded = false;
    let materialsLoaded = false;
    const markLoaded = () => {
      if (studentsLoaded && materialsLoaded) {
        setLoadedDetailsClassId(activeClassId);
      }
    };

    const unsubscribeStudents = subscribeToClassStudents(
      activeClassId,
      (nextStudents) => {
        studentsLoaded = true;
        setStudents(nextStudents);
        markLoaded();
      },
      (caughtError) => {
        studentsLoaded = true;
        setStudents([]);
        setError(formatClassError(caughtError, "Roster load failed."));
        markLoaded();
      }
    );
    const unsubscribeMaterials = subscribeToClassMaterials(
      activeClassId,
      (nextMaterials) => {
        materialsLoaded = true;
        setMaterials(nextMaterials);
        markLoaded();
      },
      (caughtError) => {
        materialsLoaded = true;
        setMaterials([]);
        setError(formatClassError(caughtError, "Tutor knowledge load failed."));
        markLoaded();
      }
    );

    return () => {
      unsubscribeStudents();
      unsubscribeMaterials();
    };
  }, [activeClassId]);

  useEffect(() => {
    if (!activeClassId || !user) {
      return;
    }

    let isCancelled = false;
    let refreshTimer: number | undefined;

    async function loadRosterActivity() {
      try {
        const token = await user!.getIdToken();
        const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/roster/activity`), {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
        const data = (await response.json()) as { activity?: StudentRosterActivitySummary[]; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Roster activity load failed.");
        }

        if (!isCancelled) {
          setRosterActivity(data.activity ?? []);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setRosterActivity([]);
          setError(formatConversationError(caughtError, "Roster activity load failed."));
        }
      }
    }

    void loadRosterActivity();
    refreshTimer = window.setInterval(loadRosterActivity, 15000);

    return () => {
      isCancelled = true;
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [activeClassId, user]);

  useEffect(() => {
    if (!activeClassId || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(
          apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/roster/sync`),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error ?? "Roster sync failed.");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setError(formatClassError(caughtError, "Roster sync failed."));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClassId, user]);

  useEffect(() => {
    if (!activeClassId || !user) {
      return;
    }

    let isCancelled = false;
    const loadingTimer = window.setTimeout(() => {
      if (!isCancelled) {
        setIsLoadingClassOverview(true);
      }
    }, 0);

    user
      .getIdToken()
      .then(async (token) => {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
        const response = await fetch(
          apiUrl(
            `/api/classes/${encodeURIComponent(activeClassId)}/overview?timezone=${encodeURIComponent(timezone)}`
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        const data = (await response.json()) as { error?: string; overview?: TeacherClassOverview };

        if (!response.ok || !data.overview) {
          throw new Error(data.error ?? "Class overview load failed.");
        }

        if (!isCancelled) {
          setClassOverview(data.overview);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setClassOverview(null);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingClassOverview(false);
        }
      });

    return () => {
      isCancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [activeClassId, user]);

  useEffect(() => {
    if (!activeClassId || !selectedStudent || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(
          apiUrl(
            `/api/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(
              selectedStudent.email
            )}/conversations`
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        const data = (await response.json()) as { conversations?: StudentConversationSummary[]; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Conversation load failed.");
        }

        if (!isCancelled) {
          setStudentConversations(data.conversations ?? []);
          setConversationError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setStudentConversations([]);
          setConversationError(formatConversationError(caughtError, "Conversation load failed."));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClassId, selectedStudent, user]);

  useEffect(() => {
    if (!activeClassId || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/conversations`), {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
        const data = (await response.json()) as {
          conversations?: TeacherConversationReviewSummary[];
          error?: string;
          metrics?: {
            lowConfidence: number;
            needsFollowUp: number;
            total: number;
            unreviewed: number;
          };
        };

        if (!response.ok) {
          throw new Error(data.error ?? "Class conversations load failed.");
        }

        if (!isCancelled) {
          setClassConversations(data.conversations ?? []);
          setClassConversationMetrics(
            data.metrics
              ? {
                  followUp: data.metrics.needsFollowUp,
                  lowConfidence: data.metrics.lowConfidence,
                  total: data.metrics.total,
                  unreviewed: data.metrics.unreviewed
                }
              : null
          );
          setConversationError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setClassConversations([]);
          setClassConversationMetrics(null);
          setConversationError(formatConversationError(caughtError, "Class conversations load failed."));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClassId, user]);

  useEffect(() => {
    if (!activeClassId || !selectedStudent || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(
          apiUrl(
            `/api/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(
              selectedStudent.email
            )}/learning-profile`
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        const data = (await response.json()) as { profile?: StudentLearningProfileDocument | null; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Learning profile load failed.");
        }

        if (!isCancelled) {
          setSelectedStudentLearningProfile(data.profile ?? null);
          setLearningProfileStatusMessage("");
          setCanForceLearningProfileUpdate(false);
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setSelectedStudentLearningProfile(null);
          setLearningProfileStatusMessage("");
          setCanForceLearningProfileUpdate(false);
          setError(formatConversationError(caughtError, "Learning profile load failed."));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClassId, selectedStudent, user]);

  useEffect(() => {
    if (!activeClassId || !activeSelectedConversationId || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(
          apiUrl(
            `/api/classes/${encodeURIComponent(activeClassId)}/conversations/${encodeURIComponent(
              activeSelectedConversationId
            )}/messages`
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        const data = (await response.json()) as { messages?: ChatMessage[]; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Conversation messages failed.");
        }

        if (!isCancelled) {
          setConversationMessages(data.messages ?? []);
          setConversationError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setConversationMessages([]);
          setConversationError(formatConversationError(caughtError, "Conversation messages failed."));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClassId, activeSelectedConversationId, user]);

  useEffect(() => {
    if (activeTab !== "insights" || !activeClassId || !user) {
      return;
    }

    let isCancelled = false;
    const loadingTimer = window.setTimeout(() => {
      if (!isCancelled) {
        setIsLoadingTeacherInsights(true);
      }
    }, 0);

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(
          apiUrl(
            `/api/classes/${encodeURIComponent(activeClassId)}/insights?range=${encodeURIComponent(
              teacherInsightRange
            )}`
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        const data = (await response.json()) as { error?: string; snapshot?: TeacherClassInsightsDocument };

        if (!response.ok) {
          throw new Error(data.error ?? "Teacher insights load failed.");
        }

        if (!isCancelled) {
          setTeacherInsights(data.snapshot ?? null);
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setTeacherInsights(null);
          setError(formatConversationError(caughtError, "Teacher insights load failed."));
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingTeacherInsights(false);
        }
      });

    return () => {
      isCancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [activeClassId, activeTab, teacherInsightRange, user]);

  useEffect(() => {
    if (activeTab !== "conversations" || !activeClassId || activeSelectedConversationId || !conversationReviewRows.length) {
      return;
    }

    const firstConversation = conversationReviewRows[0];
    const selectionTimer = window.setTimeout(() => {
      setSelectedStudentId(firstConversation.studentId);
      setSelectedStudentClassId(activeClassId);
      setSelectedConversationId(firstConversation.id);
      setSelectedConversationClassId(activeClassId);
    }, 0);

    return () => window.clearTimeout(selectionTimer);
  }, [activeClassId, activeSelectedConversationId, activeTab, conversationReviewRows]);

  async function submitClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user || !profile) {
      return;
    }

    setError("");
    setIsSavingClass(true);

    try {
      const createdClass = await createTeacherClass({
        name: className,
        section: classSection,
        teacherId: user.uid,
        teacherName: profile.displayName
      });

      setSelectedClassId(createdClass.id);
      setSelectedStudentId("");
      setSelectedStudentClassId(createdClass.id);
      setSelectedConversationId("");
      setSelectedConversationClassId(createdClass.id);
      setClassName("");
      setClassSection("");
      setIsClassDialogOpen(false);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Class creation failed."));
    } finally {
      setIsSavingClass(false);
    }
  }

  async function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeClassId) {
      return;
    }

    setError("");
    setIsSavingSettings(true);
    const formData = new FormData(event.currentTarget);

    try {
      const answerPolicy: AnswerPolicySettings = {
        doNotGiveFinalAnswers: formData.has("answerPolicy.doNotGiveFinalAnswers"),
        requireStudentAttemptFirst: formData.has("answerPolicy.requireStudentAttemptFirst"),
        askGuidingQuestionBeforeExplaining: formData.has("answerPolicy.askGuidingQuestionBeforeExplaining"),
        allowWorkedExamples: formData.has("answerPolicy.allowWorkedExamples"),
        refuseAnswerOnlyRequests: formData.has("answerPolicy.refuseAnswerOnlyRequests")
      };
      const sourceUsage: SourceUsageSettings = {
        useClassMaterialsFirst: formData.has("sourceUsage.useClassMaterialsFirst"),
        citeSourcePages: formData.has("sourceUsage.citeSourcePages"),
        askClarificationIfSourceUnclear: formData.has("sourceUsage.askClarificationIfSourceUnclear"),
        preferredSourceType: normalizeSourceUsageSettings({
          preferredSourceType: String(formData.get("sourceUsage.preferredSourceType") ?? "")
        }).preferredSourceType,
        quoteSourcePassages: formData.has("sourceUsage.quoteSourcePassages")
      };
      const responseFormat: ResponseFormatSettings = normalizeResponseFormatSettings({
        oneStepAtATime: formData.has("responseFormat.oneStepAtATime"),
        endWithCheckQuestion: formData.has("responseFormat.endWithCheckQuestion"),
        readingLevel: String(formData.get("responseFormat.readingLevel") ?? ""),
        mathNotation: String(formData.get("responseFormat.mathNotation") ?? "")
      });

      await updateTeacherClassSettings({
        answerPolicy,
        appearance: selectedClassAppearance,
        behaviorInstructions: String(formData.get("behaviorInstructions") ?? ""),
        behaviorTitle: normalizeTutorBehavior(formData.get("behaviorTitle")),
        classId: activeClassId,
        defaultAssignmentContext: String(formData.get("defaultAssignmentContext") ?? ""),
        modelSettings: normalizeClassModelSettings({
          creativity: String(formData.get("modelSettings.creativity") ?? ""),
          modelId: String(formData.get("modelSettings.modelId") ?? ""),
          reasoningEffort: String(formData.get("modelSettings.reasoningEffort") ?? ""),
          responseLength: String(formData.get("modelSettings.responseLength") ?? "")
        }),
        name: String(formData.get("name") ?? ""),
        refusalStyle: String(formData.get("refusalStyle") ?? "").trim() || defaultRefusalStyle,
        responseFormat,
        section: String(formData.get("section") ?? ""),
        sourceUsage,
        themeColor: selectedClassThemeColor
      });
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Class settings failed."));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function copyStudentInviteLink() {
    if (!selectedClassCode) {
      return;
    }

    const inviteUrl = new URL("/auth", window.location.origin);
    inviteUrl.searchParams.set("role", "student");
    inviteUrl.searchParams.set("classId", selectedClassCode);

    try {
      await copyTextToClipboard(inviteUrl.toString());
      setInviteLinkCopyResult({ classCode: selectedClassCode, status: "copied" });
    } catch {
      setInviteLinkCopyResult({ classCode: selectedClassCode, status: "failed" });
    }
  }

  async function updatePersonalThemePreference(nextPreference: {
    appearance?: unknown;
    themeColor?: unknown;
  }) {
    if (!user) {
      return;
    }

    setError("");
    setIsSavingThemePreference(true);

    try {
      await updateUserThemePreference({
        appearance: normalizeTeacherClassAppearance(nextPreference.appearance ?? selectedAppearance),
        themeColor: normalizeTeacherClassThemeColor(nextPreference.themeColor ?? selectedThemeColor),
        uid: user.uid
      });
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Theme preference failed."));
    } finally {
      setIsSavingThemePreference(false);
    }
  }

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth");
  }

  async function submitStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeClassId) {
      return;
    }

    setError("");
    setIsSavingStudent(true);

    try {
      await addStudentToClass({
        classId: activeClassId,
        displayName: studentName,
        email: studentEmail
      });

      setStudentEmail("");
      setStudentName("");
      setIsStudentDialogOpen(false);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Student add failed."));
    } finally {
      setIsSavingStudent(false);
    }
  }

  async function saveTeacherNotes(row: RosterRow) {
    if (!activeClassId || !user || savingNotesStudentId) {
      return;
    }

    const teacherNotes = teacherNotesByStudentId[row.student.id] ?? row.teacherNotes;

    setSavingNotesStudentId(row.student.id);
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(
            row.studentEmail
          )}/support`
        ),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ teacherNotes })
        }
      );
      const data = (await response.json()) as { teacherNotes?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Student notes save failed.");
      }

      const savedNotes = data.teacherNotes ?? teacherNotes;
      setTeacherNotesByStudentId((currentNotes) => ({
        ...currentNotes,
        [row.student.id]: savedNotes
      }));
      setRosterActivity((currentActivity) =>
        currentActivity.map((activity) =>
          activity.studentEmail === row.studentEmail ? { ...activity, teacherNotes: savedNotes } : activity
        )
      );
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Student notes save failed."));
    } finally {
      setSavingNotesStudentId("");
    }
  }

  async function saveConversationReview(row: ConversationReviewRow, status: ConversationReviewStatus = row.status) {
    if (!activeClassId || !user || savingReviewConversationId) {
      return;
    }

    const privateNote = conversationNotesById[row.id] ?? row.review.privateNote;

    setSavingReviewConversationId(row.id);
    setReviewSaveMessage(status === row.status ? "Saving note..." : "Saving review status...");
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(activeClassId)}/conversations/${encodeURIComponent(row.id)}/review`
        ),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            flags: row.review.flags,
            privateNote,
            status
          })
        }
      );
      const data = (await response.json()) as {
        error?: string;
        review?: TeacherConversationReviewSummary["review"];
      };

      if (!response.ok || !data.review) {
        throw new Error(data.error ?? "Conversation review save failed.");
      }

      setClassConversations((currentConversations) =>
        currentConversations.map((conversation) =>
          conversation.id === row.id
            ? {
                ...conversation,
                review: data.review!,
                reviewStatus: data.review!.status
              }
            : conversation
        )
      );
      setConversationNotesById((currentNotes) => ({
        ...currentNotes,
        [row.id]: data.review!.privateNote
      }));
      setReviewSaveMessage(status === row.status ? "Note saved" : `Marked ${formatConversationStatus(data.review.status)}`);
      setClassConversationMetrics(null);
    } catch (caughtError) {
      setReviewSaveMessage("");
      setError(formatClassError(caughtError, "Conversation review save failed."));
    } finally {
      setSavingReviewConversationId("");
    }
  }

  function focusConversationPrivateNote() {
    if (!selectedConversationReviewRow) {
      return;
    }

    setHighlightedNoteConversationId(selectedConversationReviewRow.id);
    window.setTimeout(() => {
      document.getElementById("conversation-private-note")?.focus();
    }, 0);
  }

  async function saveLearningProfileAction(action: "approve" | "disable" | "clearDraft" | "clear") {
    if (!activeClassId || !selectedStudent || !user || savingLearningProfileAction) {
      return;
    }

    setSavingLearningProfileAction(action);
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(
            selectedStudent.email
          )}/learning-profile`
        ),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ action })
        }
      );
      const data = (await response.json()) as { profile?: StudentLearningProfileDocument | null; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Learning profile save failed.");
      }

      setSelectedStudentLearningProfile(data.profile ?? null);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Learning profile save failed."));
    } finally {
      setSavingLearningProfileAction("");
    }
  }

  async function updateLearningProfileNow(forceLastSevenDays = false) {
    if (!activeClassId || !selectedStudent || !user || savingLearningProfileAction) {
      return;
    }

    setSavingLearningProfileAction("update");
    setError("");
    setLearningProfileStatusMessage("");
    setCanForceLearningProfileUpdate(false);

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(
            selectedStudent.email
          )}/learning-profile`
        ),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(forceLastSevenDays ? { force: true, lookbackDays: 7 } : {})
        }
      );
      const data = (await response.json()) as {
        profile?: StudentLearningProfileDocument | null;
        error?: string;
        result?: { reason?: string };
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Learning profile update failed.");
      }

      setSelectedStudentLearningProfile(data.profile ?? null);
      setLearningProfileStatusMessage(formatLearningProfileUpdateResult(data.result, forceLastSevenDays));
      setCanForceLearningProfileUpdate(!forceLastSevenDays && data.result?.reason === "below_threshold");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Learning profile update failed."));
    } finally {
      setSavingLearningProfileAction("");
    }
  }

  async function saveInsightFeedback(action: TeacherInsightFeedbackAction, itemId = "dailySummary", note = "") {
    if (!activeClassId || !user || savingInsightFeedback || !hasGeneratedTeacherInsights) {
      return;
    }

    const feedbackKey = `${action}:${itemId}`;
    setSavingInsightFeedback(feedbackKey);
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/insights/feedback`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action,
            itemId,
            note,
            range: teacherInsightRange
          })
        }
      );
      const data = (await response.json()) as { error?: string; snapshot?: TeacherClassInsightsDocument };

      if (!response.ok) {
        throw new Error(data.error ?? "Teacher insights feedback save failed.");
      }

      setTeacherInsights(data.snapshot ?? null);
      if (action === "addNote") {
        setTeacherInsightNote("");
      }
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Teacher insights feedback save failed."));
    } finally {
      setSavingInsightFeedback("");
    }
  }

  async function generateTeacherInsights(force = true) {
    if (!activeClassId || !user || isGeneratingTeacherInsights) {
      return;
    }

    setIsGeneratingTeacherInsights(true);
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/insights`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          force,
          range: teacherInsightRange
        })
      });
      const data = (await response.json()) as { error?: string; snapshot?: TeacherClassInsightsDocument };

      if (!response.ok) {
        throw new Error(data.error ?? "Teacher insights generation failed.");
      }

      setTeacherInsights(data.snapshot ?? null);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Teacher insights generation failed."));
    } finally {
      setIsGeneratingTeacherInsights(false);
    }
  }

  async function submitMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeClassId) {
      return;
    }

    if (!hasTutorKnowledgeSource) {
      setError("Add a supported file or paste tutor knowledge text before saving.");
      return;
    }

    setError("");
    setMaterialSuccess("");
    setMaterialUploadProgress(null);
    setIsSavingMaterial(true);

    let unsubscribeJob = () => {};

    try {
      const formData = buildTutorKnowledgeFormData(activeClassId);
      const jobId = createMaterialJobId();
      formData.append("jobId", jobId);
      unsubscribeJob = subscribeToMaterialJob(
        activeClassId,
        jobId,
        (progress) => {
          if (progress) {
            setMaterialUploadProgress(materialJobToUploadProgress(progress));
          }
        },
        (caughtError) => {
          setError(formatClassError(caughtError, "Tutor knowledge progress failed."));
        }
      );
      const token = await getTeacherToken();
      await postTutorKnowledgeForm({
        formData,
        label: "Uploading source",
        useBackendProgress: true,
        token,
        url: apiUrl("/api/materials"),
        onProgress: setMaterialUploadProgress
      });

      setMaterialTitle("");
      setMaterialFile(null);
      setMaterialText("");
      setMaterialKind("Assignment");
      setFileInputKey((currentKey) => currentKey + 1);
      setMaterialSuccess("Tutor knowledge saved.");
      setIsKnowledgeDialogOpen(false);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Tutor knowledge save failed."));
    } finally {
      setIsSavingMaterial(false);
      unsubscribeJob();
    }
  }

  async function deleteMaterial(material: ClassMaterial) {
    if (!activeClassId || deletingMaterialId) {
      return;
    }

    const confirmed = window.confirm(`Delete "${material.title}" and its knowledge chunks?`);

    if (!confirmed) {
      return;
    }

    setError("");
    setMaterialSuccess("");
    setDeletingMaterialId(material.id);

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(`/api/materials/${encodeURIComponent(material.id)}?classId=${encodeURIComponent(activeClassId)}`),
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Tutor knowledge delete failed.");
      }

      setMaterialSuccess("Tutor knowledge deleted.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Tutor knowledge delete failed."));
    } finally {
      setDeletingMaterialId("");
    }
  }

  function buildTutorKnowledgeFormData(classId: string) {
    if (!materialFile && !materialText.trim()) {
      throw new Error("Add a supported file or paste tutor knowledge text before previewing.");
    }

    const formData = new FormData();
    formData.append("classId", classId);
    formData.append("title", materialTitle);
    formData.append("kind", materialKind);
    formData.append("text", materialText);

    if (materialFile) {
      validateTutorKnowledgeFile(materialFile);
      formData.append("file", materialFile);
    }

    return formData;
  }

  async function getTeacherToken() {
    if (!user) {
      throw new Error("Sign in as the class teacher to manage tutor knowledge.");
    }

    return user.getIdToken();
  }

  function handleMaterialFileChange(file: File | null) {
    setMaterialSuccess("");
    setMaterialUploadProgress(null);

    if (!file) {
      setMaterialFile(null);
      return;
    }

    try {
      validateTutorKnowledgeFile(file);
      setMaterialFile(file);
      setError("");
    } catch (caughtError) {
      setMaterialFile(null);
      setFileInputKey((currentKey) => currentKey + 1);
      setError(formatClassError(caughtError, "Tutor knowledge file failed validation."));
    }
  }

  function handleMaterialTextChange(text: string) {
    setMaterialText(text);
    setMaterialSuccess("");
    setMaterialUploadProgress(null);
  }

  function closeClassDialog() {
    if (isSavingClass) {
      return;
    }

    setClassName("");
    setClassSection("");
    setIsClassDialogOpen(false);
  }

  function closeStudentDialog() {
    if (isSavingStudent) {
      return;
    }

    setStudentEmail("");
    setStudentName("");
    setIsStudentDialogOpen(false);
  }

  function closeKnowledgeDialog() {
    if (isSavingMaterial) {
      return;
    }

    setMaterialTitle("");
    setMaterialFile(null);
    setMaterialText("");
    setMaterialKind("Assignment");
    setMaterialUploadProgress(null);
    setFileInputKey((currentKey) => currentKey + 1);
    setIsKnowledgeDialogOpen(false);
  }

  function openMaterialDetail(material: ClassMaterial) {
    setSelectedMaterialId(material.id);
    setIsMaterialDetailDrawerOpen(true);
    void loadMaterialDetail(material.id);
  }

  function closeMaterialDetail() {
    setIsMaterialDetailDrawerOpen(false);
    setMaterialDetailError("");
  }

  async function loadMaterialDetail(materialId: string) {
    if (!activeClassId || materialDetailLoadingId === materialId) {
      return;
    }

    setMaterialDetailError("");
    setMaterialDetailLoadingId(materialId);

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(`/api/materials/${encodeURIComponent(materialId)}?classId=${encodeURIComponent(activeClassId)}`),
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );
      const data = await response.json() as MaterialDetail & { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Tutor knowledge detail load failed.");
      }

      setMaterialDetailsById((currentDetails) => ({
        ...currentDetails,
        [materialId]: {
          materialId: data.materialId,
          relatedTopics: data.relatedTopics ?? [],
          sampleChunks: data.sampleChunks ?? []
        }
      }));
    } catch (caughtError) {
      setMaterialDetailError(formatClassError(caughtError, "Tutor knowledge detail load failed."));
    } finally {
      setMaterialDetailLoadingId("");
    }
  }

  async function updateKnowledgeSourceSetting(materialId: string, settings: Partial<KnowledgeSourceSettings>) {
    const material = materials.find((currentMaterial) => currentMaterial.id === materialId);
    const nextSettings = {
      ...(material ? defaultKnowledgeSourceSettings(material) : defaultKnowledgeSourceSettings()),
      ...sourceSettingsByMaterialId[materialId],
      ...settings
    };

    setSourceSettingsByMaterialId((currentSettings) => ({
      ...currentSettings,
      [materialId]: nextSettings
    }));

    try {
      const token = await getTeacherToken();
      const response = await fetch(apiUrl(`/api/materials/${encodeURIComponent(materialId)}`), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          activeForStudents: nextSettings.activeForStudents,
          classId: activeClassId,
          priority: knowledgePriorityToApi(nextSettings.priority),
          requireCitations: nextSettings.citationsRequired,
          teacherOnly: nextSettings.teacherOnly
        })
      });
      const data = await response.json() as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Tutor knowledge update failed.");
      }
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Tutor knowledge update failed."));
    }
  }

  async function runRetrievalTest() {
    if (!activeClassId || !selectedMaterial || isTestingRetrieval) {
      return;
    }

    const query = retrievalQuery.trim();

    if (!query) {
      setError("Add a student question before testing retrieval.");
      return;
    }

    setError("");
    setIsTestingRetrieval(true);

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/materials/retrieval-test`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            materialId: selectedMaterial.id,
            query
          })
        }
      );
      const data = await response.json() as { error?: string; results?: RetrievalTestResult[] };

      if (!response.ok) {
        throw new Error(data.error ?? "Retrieval test failed.");
      }

      setRetrievalResults(data.results ?? []);
    } catch (caughtError) {
      setRetrievalResults([]);
      setError(formatClassError(caughtError, "Retrieval test failed."));
    } finally {
      setIsTestingRetrieval(false);
    }
  }

  async function reprocessMaterial(material: ClassMaterial) {
    if (!activeClassId || reprocessingMaterialId) {
      return;
    }

    setError("");
    setMaterialSuccess("");
    setReprocessingMaterialId(material.id);

    try {
      const token = await getTeacherToken();
      const response = await fetch(apiUrl(`/api/materials/${encodeURIComponent(material.id)}/reprocess`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ classId: activeClassId })
      });
      const data = await response.json() as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Tutor knowledge reprocess failed.");
      }

      setMaterialSuccess("Tutor knowledge reprocessed.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Tutor knowledge reprocess failed."));
    } finally {
      setReprocessingMaterialId("");
    }
  }

  function findOverviewRosterRow(studentName?: string, studentId?: string, studentEmail?: string) {
    const normalizedStudentName = studentName?.trim().toLowerCase() ?? "";
    const normalizedStudentEmail = studentEmail?.trim().toLowerCase() ?? "";

    return (
      rosterRows.find((row) => studentId && row.student.id === studentId) ??
      rosterRows.find((row) => normalizedStudentEmail && row.student.email.trim().toLowerCase() === normalizedStudentEmail) ??
      rosterRows.find((row) => row.student.displayName.trim().toLowerCase() === normalizedStudentName) ??
      rosterRows.find((row) => row.student.displayName.trim().toLowerCase().includes(normalizedStudentName)) ??
      null
    );
  }

  function openOverviewRoster(studentName?: string, studentId?: string, studentEmail?: string) {
    const row = studentName || studentId || studentEmail ? findOverviewRosterRow(studentName, studentId, studentEmail) : null;

    if (row) {
      setSelectedStudentId(row.student.id);
      setSelectedStudentClassId(activeClassId);
      setIsRosterDetailOpen(true);
    }

    setIsProfessorReviewOpen(false);
    setActiveTab("roster");
  }

  function openOverviewStudentChats(studentName?: string, studentId?: string, studentEmail?: string) {
    const row = findOverviewRosterRow(studentName, studentId, studentEmail);

    if (row) {
      const recentConversation = row.recentConversations.find((conversation) => conversation.id !== "empty");

      setSelectedStudentId(row.student.id);
      setSelectedStudentClassId(activeClassId);
      setSelectedConversationId(recentConversation?.id ?? "");
      setSelectedConversationClassId(activeClassId);
      setIsRosterDetailOpen(true);
    }

    setIsProfessorReviewOpen(false);
    setActiveTab("conversations");
  }

  function openOverviewConversation(title?: string, studentName?: string, conversationId?: string) {
    const normalizedTitle = title?.trim().toLowerCase() ?? "";
    const normalizedStudentName = studentName?.trim().toLowerCase() ?? "";
    const conversation =
      conversationReviewRows.find((row) => conversationId && row.id === conversationId) ??
      conversationReviewRows.find(
        (row) =>
          (normalizedTitle && row.title.trim().toLowerCase().includes(normalizedTitle)) ||
          (normalizedStudentName && row.studentName.trim().toLowerCase() === normalizedStudentName)
      ) ?? conversationReviewRows[0] ?? null;

    if (conversation) {
      setSelectedStudentId(conversation.studentId);
      setSelectedStudentClassId(activeClassId);
      setSelectedConversationId(conversation.id);
      setSelectedConversationClassId(activeClassId);
      setIsRosterDetailOpen(true);
    }

    setIsProfessorReviewOpen(false);
    setActiveTab("conversations");
  }

  function handleOverviewNextAction(action: NonNullable<TeacherClassOverview["nextActions"]>[number]) {
    if (action.action === "addStudent") {
      setIsStudentDialogOpen(true);
      return;
    }

    if (action.action === "addKnowledge") {
      setIsKnowledgeDialogOpen(true);
      return;
    }

    if (action.action === "openKnowledge") {
      setActiveTab("knowledge");
      return;
    }

    if (action.action === "reviewConversations") {
      openOverviewConversation(undefined, action.studentName, action.conversationId);
      return;
    }

    if (action.action === "viewStudentChats") {
      openOverviewStudentChats(action.studentName, action.studentId, action.studentEmail);
      return;
    }

    if (action.action === "reviewLearningProfiles" || action.action === "openRoster") {
      openOverviewRoster(action.studentName, action.studentId, action.studentEmail);
      return;
    }

    if (action.action === "testRetrieval") {
      setActiveTab("knowledge");
      return;
    }

    if (action.action === "openInsights") {
      setActiveTab("insights");
    }
  }

  function openInsightEvidenceConversations(conversationIds: string[]) {
    const ids = Array.from(new Set(conversationIds.filter(Boolean)));

    if (!ids.length) {
      return;
    }

    const firstConversation =
      conversationReviewRows.find((conversation) => ids.includes(conversation.id)) ??
      conversationReviewRows.find((conversation) => conversation.id === ids[0]);

    setEvidenceConversationIds(ids);
    setConversationFilter("all");
    setConversationSearchQuery("");
    setConversationStudentFilter("all");
    setConversationTopicFilter("all");

    if (firstConversation) {
      setSelectedStudentId(firstConversation.studentId);
      setSelectedStudentClassId(activeClassId);
      setSelectedConversationId(firstConversation.id);
      setSelectedConversationClassId(activeClassId);
      setIsRosterDetailOpen(true);
    } else {
      setSelectedConversationId(ids[0] ?? "");
      setSelectedConversationClassId(activeClassId);
    }

    setIsProfessorReviewOpen(false);
    setActiveTab("conversations");
  }

  return (
    <>
      <section
        className="teacher-dashboard"
        data-appearance={selectedAppearance}
        data-theme-color={selectedThemeColor}
        aria-label="Teacher dashboard"
      >
        <aside className="teacher-sidebar" aria-label="Teacher navigation">
          <div className="teacher-sidebar-scroll">
            <div className="teacher-brand">
              <Link className="teacher-wordmark" href="/">
                Chandra
              </Link>
            </div>

            <button
              className="sidebar-create-button"
              type="button"
              onClick={() => setIsClassDialogOpen(true)}
            >
              <PlusIcon />
              Create class
            </button>

            <section className="teacher-sidebar-card class-list-card" aria-label="Classes">
              <span className="count-pill classes-total">{isLoadingClasses ? "Loading" : `${classes.length} total`}</span>

              <div className="teacher-class-list">
                {classes.map((teacherClass) => (
                  <button
                    aria-pressed={teacherClass.id === activeClassId}
                    className="class-row"
                    key={teacherClass.id}
                    type="button"
                    onClick={() => {
                      setSelectedClassId(teacherClass.id);
                      setSelectedStudentId("");
                      setSelectedStudentClassId(teacherClass.id);
                      setSelectedConversationId("");
                      setSelectedConversationClassId(teacherClass.id);
                      setRosterActivity([]);
                      setStudentConversations([]);
                      setClassConversations([]);
                      setClassConversationMetrics(null);
                      setClassOverview(null);
                      setConversationMessages([]);
                      setConversationError("");
                      setSelectedMaterialId("");
                      setKnowledgeFilter("All");
                      setCheckedStudentIds([]);
                      setIsRosterDetailOpen(true);
                      setIsProfessorReviewOpen(false);
                      setRosterSearchQuery("");
                      setRosterFilter("all");
                      setConversationFilter("all");
                      setConversationSearchQuery("");
                      setConversationStudentFilter("all");
                      setConversationTopicFilter("all");
                    }}
                  >
                    <span className="class-row-icon" aria-hidden="true">
                      <BookOpenIcon />
                    </span>
                    <span className="class-row-copy">
                      <strong>{teacherClass.name}</strong>
                      <span>{formatSectionLabel(teacherClass.section)}</span>
                    </span>
                    <span className="row-chevron" aria-hidden="true">
                      <ChevronRightIcon />
                    </span>
                  </button>
                ))}

                {isLoadingClasses ? (
                  <div className="empty-state">
                    <strong>Loading classes</strong>
                    <span>Fetching your teacher workspace.</span>
                  </div>
                ) : null}

                {!isLoadingClasses && !classes.length ? (
                  <div className="empty-state">
                    <strong>No classes yet</strong>
                    <span>Create a class to add students, policies, and tutor knowledge.</span>
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <section className="teacher-account-card" aria-label="Account">
            <span className="teacher-avatar" aria-hidden="true">
              {getInitials(accountName, accountEmail)}
            </span>
            <span className="teacher-account-copy">
              <strong>{accountName}</strong>
              {accountEmail ? <span>{accountEmail}</span> : null}
            </span>
            <button className="sidebar-signout-button" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </section>
        </aside>

        <section className="teacher-main" aria-label="Class workspace">
          <div className="teacher-main-inner">
            <div className={selectedClass ? "teacher-sticky-chrome" : undefined}>
              <header className="teacher-main-header">
                <div>
                  <h1>{selectedClass ? selectedClass.name : "Create a class"}</h1>
                  <p>{selectedClass ? formatSectionLabel(selectedClass.section) : "Add your first class from the sidebar."}</p>
                </div>

                {selectedClass ? (
                  <div className="class-heading-actions">
                    <span className="class-code">
                      {/* Class code: {selectedClassCode || "Creating code..."} */}
                      Class code: <strong>{selectedClassCode || "Creating code..."}</strong>
                    </span>
                    <button
                      aria-label="Copy student invite link"
                      className="teacher-action-button"
                      disabled={!selectedClassCode}
                      type="button"
                      onClick={copyStudentInviteLink}
                    >
                      <LinkIcon />
                      {inviteLinkCopyStatus === "copied"
                        ? "Copied"
                        : inviteLinkCopyStatus === "failed"
                          ? "Copy failed"
                          : "Copy invite link"}
                    </button>
                    <Link
                      className="teacher-action-button"
                      href={`/student?classId=${selectedClass.id}&preview=teacher`}
                    >
                      <ExternalLinkIcon />
                      Student view
                    </Link>
                  </div>
                ) : null}
              </header>

              {error ? <p className="form-error teacher-alert">{error}</p> : null}

              {selectedClass ? (
                <div className="tab-list teacher-tab-list" role="tablist" aria-label="Class editor sections">
                  {teacherTabs.map((tab) => (
                    <button
                      aria-selected={activeTab === tab.id}
                      key={tab.id}
                      role="tab"
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {selectedClass ? (
              <>
                {isLoadingClassDetails ? (
                  <div className="empty-state detail-loading">
                    <strong>Loading class details</strong>
                    <span>Fetching roster and tutor knowledge.</span>
                  </div>
                ) : null}

                {activeTab === "overview" ? (
                  <div className="overview-workspace teacher-content-block" role="tabpanel" aria-busy={isLoadingClassOverview}>
                    <div className="overview-heading-row">
                      <div className="overview-title-block">
                        <h2>Today&apos;s Teacher Dashboard</h2>
                        <span>What needs attention in {selectedClass.name} right now.</span>
                      </div>
                      <button className="overview-date-button" aria-pressed="false" type="button">
                        <CalendarIcon />
                        {overviewDateLabel}
                        <ChevronDownIcon />
                      </button>
                    </div>

                    <div className="overview-metric-grid" aria-label="Today overview metrics">
                      <OverviewMetricCard icon={<UserGroupIcon />} label="Total students" value={String(overviewTotalStudents)} />
                      <OverviewMetricCard icon={<CircleIcon />} label="Active now" value={String(overviewActiveStudents)} />
                      <OverviewMetricCard icon={<ChatIcon />} label="Questions today" value={String(overviewQuestionsToday)} />
                      <OverviewMetricCard icon={<ChatIcon />} label="Total conversations" value={String(overviewTotalConversations)} />
                      <OverviewMetricCard
                        icon={<TrendLineIcon />}
                        label="Avg questions / student"
                        value={formatStatNumber(overviewAverageQuestionsValue)}
                      />
                      <OverviewMetricCard icon={<UserIcon />} label="No activity" value={String(overviewNoActivity)} />
                    </div>

                    <div className="overview-grid">
                      <div className="overview-column">
                        <section className="overview-panel summary-panel" aria-labelledby="overview-summary-title">
                          <h3 id="overview-summary-title">{overviewSummaryTitle}</h3>
                          <p>{overviewSummaryBody}</p>
                          <div className="overview-topic-list" aria-label="Recent topics">
                            {overviewTopics.map((topic) => (
                              <span key={topic}>{topic}</span>
                            ))}
                            {!overviewTopics.length ? <span>No topics yet</span> : null}
                          </div>
                        </section>

                        <section className="overview-panel" aria-labelledby="overview-priority-title">
                          <h3 id="overview-priority-title">Needs Attention</h3>
                          <div className="priority-row-list" role="table" aria-label="Students needing attention">
                            {overviewPriorityRows.map((row) => (
                              <div className="priority-row" key={row.id} role="row">
                                <span className={`overview-row-icon ${row.tone}`} aria-hidden="true">
                                  {row.tone === "high" ? <StrugglingTopicsIcon /> : row.tone === "note" ? <NoteIcon /> : <CircleIcon />}
                                </span>
                                <strong role="cell">{row.studentName}</strong>
                                <span className={`overview-status-pill ${row.tone}`} role="cell">
                                  {row.status}
                                </span>
                                <span className="overview-row-copy" role="cell">{row.issue}</span>
                                <button
                                  className="overview-small-action"
                                  type="button"
                                  onClick={() =>
                                    row.action === "viewChats"
                                      ? openOverviewStudentChats(row.studentName, row.studentId, row.studentEmail)
                                      : openOverviewRoster(row.studentName, row.studentId, row.studentEmail)
                                  }
                                >
                                  {row.actionLabel}
                                </button>
                              </div>
                            ))}
                            {!overviewPriorityRows.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No priority items</strong>
                                <span>Students needing attention will appear here.</span>
                              </div>
                            ) : null}
                          </div>
                        </section>

                        <section className="overview-panel" aria-labelledby="overview-activity-title">
                          <h3 id="overview-activity-title">Recent Activity</h3>
                          <div className="recent-activity-list" role="table" aria-label="Recent student activity">
                            {overviewRecentActivityRows.map((row) => (
                              <div className="recent-activity-row" key={row.id} role="row">
                                <span className="overview-row-icon chat" aria-hidden="true">
                                  <ChatIcon />
                                </span>
                                <strong role="cell">{row.studentName}</strong>
                                <span role="cell">{row.title}</span>
                                <span role="cell">{row.messageCount} messages</span>
                                <time role="cell">{row.lastMessageLabel}</time>
                              </div>
                            ))}
                            {!overviewRecentActivityRows.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No recent activity</strong>
                                <span>Saved student chats will appear here.</span>
                              </div>
                            ) : null}
                          </div>
                        </section>
                      </div>

                      <div className="overview-column">
                        <section className="overview-panel" aria-labelledby="overview-review-title">
                          <h3 id="overview-review-title">Conversation Review Queue</h3>
                          <div className="review-queue-list" role="table" aria-label="Conversation review queue">
                            {overviewReviewQueueRows.map((row) => (
                              <button
                                className="review-queue-row"
                                key={row.id}
                                role="row"
                                type="button"
                                onClick={() => openOverviewConversation(row.title, row.studentName, row.conversationId)}
                              >
                                <span className="overview-row-icon chat" aria-hidden="true">
                                  <ChatIcon />
                                </span>
                                <strong role="cell">{row.title}</strong>
                                <span role="cell">{row.studentName}</span>
                                <span className={`overview-status-pill ${row.tone}`} role="cell">
                                  {row.status}
                                </span>
                                <span className="overview-row-copy" role="cell">{row.meta}</span>
                                <span className="row-chevron" aria-hidden="true">
                                  <ChevronRightIcon />
                                </span>
                              </button>
                            ))}
                            {!overviewReviewQueueRows.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No review queue</strong>
                                <span>Conversations needing review will appear here.</span>
                              </div>
                            ) : null}
                          </div>
                          <button
                            className="overview-review-button"
                            type="button"
                            onClick={() => openOverviewConversation()}
                          >
                            Review in Conversations
                          </button>
                        </section>

                        <section className="overview-panel" aria-labelledby="overview-profiles-title">
                          <h3 id="overview-profiles-title">Learning Profile Queue</h3>
                          <div className="profile-queue-list" role="table" aria-label="Learning profile queue">
                            {overviewLearningProfileRows.map((row) => (
                              <div className="profile-queue-row" key={row.id} role="row">
                                <strong role="cell">{row.studentName}</strong>
                                <span className={`overview-status-pill ${row.tone}`} role="cell">
                                  {row.status}
                                </span>
                                <span className="overview-row-copy" role="cell">{row.meta}</span>
                                <button
                                  className="overview-small-action"
                                  type="button"
                                  onClick={() => openOverviewRoster(row.studentName, row.studentId, row.studentEmail)}
                                >
                                  Review profile
                                </button>
                              </div>
                            ))}
                            {!overviewLearningProfileRows.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No learning profiles</strong>
                                <span>Add students and conversations to build profile queues.</span>
                              </div>
                            ) : null}
                          </div>
                        </section>

                        <section className="overview-panel knowledge-status-panel" aria-labelledby="overview-knowledge-title">
                          <div className="overview-panel-heading">
                            <div>
                              <h3 id="overview-knowledge-title">Knowledge Status</h3>
                            </div>
                            <div className="knowledge-status-actions">
                              <button
                                className="overview-filled-action"
                                type="button"
                                onClick={() => setIsKnowledgeDialogOpen(true)}
                              >
                                Add knowledge
                              </button>
                              <button
                                className="overview-small-action"
                                type="button"
                                onClick={() => setActiveTab("knowledge")}
                              >
                                Test retrieval
                              </button>
                            </div>
                          </div>
                          <div className="knowledge-status-strip" aria-label="Knowledge source status">
                            {overviewKnowledgeStats.map((stat) => (
                              <span className={stat.tone} key={stat.label}>
                                <strong>{stat.value}</strong>
                                <small>{stat.label}</small>
                              </span>
                            ))}
                          </div>
                        </section>

                        <section className="overview-panel" aria-labelledby="overview-next-title">
                          <h3 id="overview-next-title">Recommended Next Actions</h3>
                          <div className="next-action-grid">
                            {overviewNextActions.map((action) =>
                              action.action === "openStudentView" ? (
                                <Link
                                  className="next-action-tile"
                                  href={`/student?classId=${selectedClass.id}&preview=teacher`}
                                  key={action.id}
                                >
                                  <span aria-hidden="true">
                                    {overviewNextActionIcon(action.action)}
                                  </span>
                                  <span className="next-action-copy">
                                    <strong>{action.label}</strong>
                                    <small>{action.detail}</small>
                                  </span>
                                  <ChevronRightIcon />
                                </Link>
                              ) : (
                                <button
                                  className="next-action-tile"
                                  key={action.id}
                                  type="button"
                                  onClick={() => handleOverviewNextAction(action)}
                                >
                                  <span aria-hidden="true">
                                    {overviewNextActionIcon(action.action)}
                                  </span>
                                  <span className="next-action-copy">
                                    <strong>{action.label}</strong>
                                    <small>{action.detail}</small>
                                  </span>
                                  <ChevronRightIcon />
                                </button>
                              )
                            )}
                            {!overviewNextActions.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No next actions</strong>
                                <span>Recommended actions will appear as class activity changes.</span>
                              </div>
                            ) : null}
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeTab === "insights" ? (
                  <div className="insights-workspace teacher-content-block" role="tabpanel">
                    <div className="insights-heading-row">
                      <div className="insights-title-block">
                        <h2>Teaching Intelligence</h2>
                        <span>
                          Daily patterns, misconceptions, and recommended follow-ups for {selectedClass.name}.
                        </span>
                      </div>
                      <div className="insights-controls" aria-label="Insight date and range controls">
                        <button className="insights-date-button" type="button">
                          <CalendarIcon />
                          {insightsDateLabel}
                          <ChevronDownIcon />
                        </button>
                        <button
                          className="insights-generate-button"
                          disabled={isGeneratingTeacherInsights}
                          onClick={() => generateTeacherInsights(true)}
                          type="button"
                        >
                          {isGeneratingTeacherInsights ? "Generating..." : hasGeneratedTeacherInsights ? "Regenerate" : "Generate"}
                        </button>
                        <div className="insights-time-filters" aria-label="Insight time range">
                          {insightTimeFilters.map((filter) => (
                            <button
                              aria-pressed={filter.range === teacherInsightRange}
                              key={filter.range}
                              onClick={() => setTeacherInsightRange(filter.range)}
                              type="button"
                            >
                              {filter.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="insight-metric-grid" aria-label="Insight metrics">
                      <InsightMetricCard
                        icon={<ChatIcon />}
                        label="conversations analyzed"
                        tone="teal"
                        value={String(insightMetricValue("conversationsAnalyzed"))}
                      />
                      <InsightMetricCard
                        icon={<UserIcon />}
                        label="students active"
                        tone="teal"
                        value={String(insightMetricValue("studentsActive"))}
                      />
                      <InsightMetricCard
                        icon={<StrugglingTopicsIcon />}
                        label="emerging misconceptions"
                        tone="neutral"
                        value={String(insightMetricValue("emergingMisconceptions"))}
                      />
                      <InsightMetricCard
                        icon={<LinkIcon />}
                        label="evidence links"
                        tone="teal"
                        value={String(insightMetricValue("evidenceLinks"))}
                      />
                      <InsightMetricCard
                        icon={<LightbulbIcon />}
                        label="recommendations"
                        tone="gold"
                        value={String(insightMetricValue("recommendations"))}
                      />
                    </div>

                    <div className="insights-grid">
                      <div className="insights-column">
                        <section className="insights-panel daily-summary-panel" aria-labelledby="daily-summary-title">
                          <div className="daily-summary-header">
                            <div>
                              <h3 id="daily-summary-title">
                                {displayedInsightSummary?.title || "No insight generated yet"}
                              </h3>
                            </div>
                            <InsightFeedbackActions
                              disabled={Boolean(savingInsightFeedback) || !hasGeneratedTeacherInsights}
                              itemId="dailySummary"
                              onAction={saveInsightFeedback}
                            />
                          </div>
                          <p>
                            {displayedInsightSummary?.body ||
                              "Generate a class insight snapshot to summarize recent student conversations for this range."}
                          </p>
                          <div className="insight-evidence-chip-list" aria-label="Summary evidence">
                            {displayedInsightEvidenceChips.map((chip) => (
                                <button
                                  className="insight-evidence-chip"
                                  disabled={!chip.conversationId}
                                  key={chip.id}
                                  onClick={() => openInsightEvidenceConversations([chip.conversationId])}
                                  type="button"
                                >
                                  {chip.label}
                                  <ExternalLinkIcon />
                                </button>
                            ))}
                          </div>
                        </section>

                        <section className="insights-panel" aria-labelledby="trends-title">
                          <h3 id="trends-title">Trends Over Time</h3>
                          <div className="insights-table trends-table" role="table" aria-label="Trends over time">
                            <div className="insights-table-header trend-row" role="row">
                              <span role="columnheader">Trend</span>
                              <span role="columnheader">Change</span>
                              <span role="columnheader">Evidence</span>
                            </div>
                            {insightTrendDisplayRows.length ? insightTrendDisplayRows.map((row) => (
                              <div className="trend-row" key={row.key} role="row">
                                <span className="trend-name-cell" role="cell">
                                  <TrendIcon tone={row.tone} />
                                  <span>
                                    <strong>{row.label}</strong>
                                    <small>{row.change}</small>
                                  </span>
                                </span>
                                <span role="cell">
                                  <InsightSparkline points={row.points} tone={row.tone} />
                                </span>
                                <button
                                  className="insight-link-button"
                                  disabled={!row.conversationIds.length}
                                  onClick={() => openInsightEvidenceConversations(row.conversationIds)}
                                  role="cell"
                                  type="button"
                                >
                                  {row.evidence}
                                </button>
                              </div>
                            )) : (
                              <div className="insight-empty-row" role="row">
                                Generate insights to see class-level trends.
                              </div>
                            )}
                          </div>
                        </section>

                        <section className="insights-panel" aria-labelledby="timeline-title">
                          <h3 id="timeline-title">Misconception Timeline</h3>
                          <div className="insights-table timeline-table" role="table" aria-label="Misconception timeline">
                            <div className="insights-table-header timeline-row" role="row">
                              <span role="columnheader">Misconception</span>
                              <span role="columnheader">First appeared</span>
                              <span role="columnheader">Seen in conversations</span>
                              <span role="columnheader">Status</span>
                            </div>
                            {insightTimelineDisplayRows.length ? insightTimelineDisplayRows.map((row) => (
                              <div className="timeline-row" key={row.key} role="row">
                                <strong role="cell">{row.misconception}</strong>
                                <span role="cell">{row.appeared}</span>
                                <span role="cell">{row.seen}</span>
                                <span role="cell">
                                  <span className={`insight-status-pill ${row.status.toLowerCase()}`}>
                                    {row.status}
                                  </span>
                                </span>
                              </div>
                            )) : (
                              <div className="insight-empty-row" role="row">
                                No misconceptions have been generated for this range.
                              </div>
                            )}
                          </div>
                        </section>
                      </div>

                      <div className="insights-column">
                        <section className="insights-panel recommendations-panel" aria-labelledby="recommendations-title">
                          <h3 id="recommendations-title">Teaching Recommendations</h3>
                          <div className="recommendation-list">
                            {insightRecommendationDisplayRows.length ? insightRecommendationDisplayRows.map((row) => (
                              <article className="recommendation-row" key={row.key}>
                                <span className={`priority-pill ${row.priority.toLowerCase()}`}>{row.priority}</span>
                                <span className="recommendation-copy">
                                  <strong>{row.title}</strong>
                                  <button
                                    className="recommendation-evidence-link"
                                    disabled={!row.conversationIds.length}
                                    onClick={() => openInsightEvidenceConversations(row.conversationIds)}
                                    type="button"
                                  >
                                    {row.evidence}
                                  </button>
                                </span>
                                <button className="recommendation-action" type="button">
                                  {row.action}
                                </button>
                                <span className="recommendation-icon-actions">
                                  <button
                                    aria-label={`Mark ${row.title} useful`}
                                    disabled={Boolean(savingInsightFeedback) || !hasGeneratedTeacherInsights}
                                    onClick={() => saveInsightFeedback("useful", row.key)}
                                    type="button"
                                  >
                                    <ThumbUpIcon />
                                  </button>
                                  <button
                                    aria-label={`Mark ${row.title} not useful`}
                                    disabled={Boolean(savingInsightFeedback) || !hasGeneratedTeacherInsights}
                                    onClick={() => saveInsightFeedback("notUseful", row.key)}
                                    type="button"
                                  >
                                    <ThumbDownIcon />
                                  </button>
                                  <button
                                    aria-label={`Dismiss ${row.title}`}
                                    disabled={Boolean(savingInsightFeedback) || !hasGeneratedTeacherInsights}
                                    onClick={() => saveInsightFeedback("dismiss", row.key)}
                                    type="button"
                                  >
                                    <CloseIcon />
                                  </button>
                                </span>
                              </article>
                            )) : (
                              <div className="insight-empty-card">
                                No teaching recommendations have been generated for this range.
                              </div>
                            )}
                          </div>
                        </section>

                        <section className="insights-panel" aria-labelledby="evidence-title">
                          <h3 id="evidence-title">Evidence Links</h3>
                          <div className="insights-table evidence-table" role="table" aria-label="Evidence links">
                            {insightEvidenceDisplayRows.length ? insightEvidenceDisplayRows.map((row) => (
                              <div className="evidence-row" key={row.key} role="row">
                                <strong role="cell">{row.topic}</strong>
                                <span role="cell">{row.count}</span>
                                <span className="initials-pill-list" role="cell">
                                  {row.initials.map((initial) => (
                                    <span className="initials-pill" key={`${row.topic}-${initial}`}>
                                      {initial}
                                    </span>
                                  ))}
                                </span>
                                <span role="cell">{row.timestamp}</span>
                                <button
                                  className="insight-link-button"
                                  disabled={!row.conversationIds.length}
                                  onClick={() => openInsightEvidenceConversations(row.conversationIds)}
                                  role="cell"
                                  type="button"
                                >
                                  View evidence
                                </button>
                              </div>
                            )) : (
                              <div className="insight-empty-row" role="row">
                                No evidence links have been generated for this range.
                              </div>
                            )}
                          </div>
                        </section>

                        <section className="insights-panel feedback-panel" aria-labelledby="teacher-feedback-title">
                          <h3 id="teacher-feedback-title">Teacher Feedback</h3>
                          <p>
                            {isLoadingTeacherInsights
                              ? "Loading the latest saved insight snapshot."
                              : hasGeneratedTeacherInsights
                                ? "Feedback is saved with this snapshot and included the next time insights are regenerated."
                                : "Generate an insight snapshot before saving feedback."}
                          </p>
                          <InsightFeedbackActions
                            disabled={Boolean(savingInsightFeedback) || !hasGeneratedTeacherInsights}
                            itemId="overall"
                            onAction={saveInsightFeedback}
                          />
                          <label className="sr-only" htmlFor="teacher-feedback-note">
                            Teacher feedback note
                          </label>
                          <textarea
                            id="teacher-feedback-note"
                            onChange={(event) => setTeacherInsightNote(event.target.value)}
                            placeholder="Tell Chandra what matters for this class..."
                            rows={3}
                            value={teacherInsightNote}
                          />
                          <button
                            className="feedback-save-button"
                            disabled={
                              Boolean(savingInsightFeedback) || !teacherInsightNote.trim() || !hasGeneratedTeacherInsights
                            }
                            onClick={() => saveInsightFeedback("addNote", "overall", teacherInsightNote)}
                            type="button"
                          >
                            {savingInsightFeedback === "addNote:overall" ? "Saving..." : "Save feedback"}
                          </button>
                        </section>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeTab === "settings" ? (
                  <form className="class-settings-form settings-workspace" key={selectedClass.id} onSubmit={submitSettings}>
                    <div className="teacher-section-heading settings-page-heading">
                      <div>
                        <h2>Guidance settings</h2>
                        <span>Control how Chandra helps students in this class</span>
                      </div>
                      <button
                        className="primary-button teacher-primary-button compact"
                        disabled={isSavingSettings}
                        type="submit"
                      >
                        {isSavingSettings ? "Saving" : "Save changes"}
                      </button>
                    </div>

                    <div className="settings-columns">
                      <div className="settings-column">
                        <section className="settings-card" aria-labelledby="settings-class-details">
                          <h3 id="settings-class-details">Class Details</h3>
                          <div className="settings-field-pair">
                            <div>
                              <label className="field-label" htmlFor="settings-name">
                                Class name
                              </label>
                              <input id="settings-name" name="name" required defaultValue={selectedClass.name} />
                            </div>

                            <div>
                              <label className="field-label" htmlFor="settings-section">
                                Section
                              </label>
                              <input id="settings-section" name="section" required defaultValue={selectedClass.section} />
                            </div>
                          </div>

                          <label className="field-label" htmlFor="default-assignment-context">
                            Default assignment context
                          </label>
                          <textarea
                            id="default-assignment-context"
                            name="defaultAssignmentContext"
                            rows={4}
                            defaultValue={selectedClass.defaultAssignmentContext ?? ""}
                            placeholder="Limits and introductory derivatives"
                          />

                          <div className="settings-theme-control" aria-label="Personal theme color" role="radiogroup">
                            <span className="settings-control-label">Personal theme color</span>
                            <div className="settings-theme-swatches">
                              {teacherClassThemeColorOptions.map((option) => (
                                <label className="settings-theme-swatch" key={option.id}>
                                  <input
                                    checked={selectedThemeColor === option.id}
                                    disabled={isSavingThemePreference}
                                    name="personalThemeColor"
                                    type="radio"
                                    value={option.id}
                                    onChange={() => updatePersonalThemePreference({ themeColor: option.id })}
                                  />
                                  <span>
                                    <span
                                      className="settings-theme-swatch-dot"
                                      style={{ backgroundColor: option.color }}
                                      aria-hidden="true"
                                    />
                                    {option.label}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>

                          <div className="settings-appearance-control" aria-label="Personal appearance" role="radiogroup">
                            <span className="settings-control-label">Personal appearance</span>
                            <div className="settings-appearance-pills">
                              {classAppearanceOptions.map((appearance) => (
                                <label className="settings-choice-pill" key={appearance}>
                                  <input
                                    checked={selectedAppearance === appearance}
                                    disabled={isSavingThemePreference}
                                    name="personalAppearance"
                                    type="radio"
                                    value={appearance}
                                    onChange={() => updatePersonalThemePreference({ appearance })}
                                  />
                                  <span>{capitalizeLabel(appearance)}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        </section>

                        <section className="settings-card compact-settings-card" aria-labelledby="settings-tutor-behavior">
                          <h3 id="settings-tutor-behavior">Tutor Behavior</h3>
                          <p>Choose the general tutoring approach Chandra should use.</p>
                          <div className="settings-pill-group" role="radiogroup" aria-label="Tutor behavior">
                            {tutorBehaviorOptions.map((option) => (
                              <label className="settings-choice-pill" key={option}>
                                <input
                                  defaultChecked={selectedTutorBehavior === option}
                                  name="behaviorTitle"
                                  type="radio"
                                  value={option}
                                />
                                <span>{option}</span>
                              </label>
                            ))}
                          </div>
                        </section>

                        <section className="settings-card" aria-labelledby="settings-hidden-instructions">
                          <h3 id="settings-hidden-instructions">Hidden Tutor Instructions</h3>
                          <p>Teacher-only instructions not shown to students.</p>
                          <textarea
                            id="behavior-instructions"
                            name="behaviorInstructions"
                            rows={6}
                            defaultValue={selectedClass.behaviorInstructions ?? ""}
                          />
                        </section>
                      </div>

                      <div className="settings-column">
                        <section className="settings-card" aria-labelledby="settings-answer-policy">
                          <h3 id="settings-answer-policy">Answer Policy</h3>
                          <p>Control how Chandra responds to student questions.</p>
                          <div className="settings-toggle-list">
                            {answerPolicySettings.map((setting) => (
                              <SettingsToggle
                                defaultChecked={selectedAnswerPolicy[setting.id]}
                                key={setting.title}
                                name={`answerPolicy.${setting.id}`}
                                {...setting}
                              />
                            ))}
                          </div>
                        </section>

                        <section className="settings-card" aria-labelledby="settings-refusal-style">
                          <h3 id="settings-refusal-style">Direct-answer Redirect</h3>
                          <p>Tell Chandra how to respond when students ask for answers only.</p>
                          <textarea
                            id="refusal-style"
                            name="refusalStyle"
                            rows={5}
                            defaultValue={selectedClass.refusalStyle ?? defaultRefusalStyle}
                          />
                        </section>

                        <section className="settings-card" aria-labelledby="settings-model">
                          <h3 id="settings-model">Model Settings</h3>
                          <p>Configure the AI model and response style.</p>
                          <label className="settings-control-label" htmlFor="class-model">
                            Model
                          </label>
                          <select id="class-model" name="modelSettings.modelId" defaultValue={selectedModelSettings.modelId}>
                            {selectableModelOptions.map((modelOption) => (
                              <option key={modelOption.id} value={modelOption.id}>
                                {modelOption.label}
                              </option>
                            ))}
                          </select>

                          <label className="settings-control-label" htmlFor="reasoning-effort">
                            Thinking time
                          </label>
                          <select
                            id="reasoning-effort"
                            name="modelSettings.reasoningEffort"
                            defaultValue={selectedModelSettings.reasoningEffort}
                          >
                            {reasoningEffortOptions.map((effort) => (
                              <option key={effort} value={effort}>
                                {capitalizeLabel(effort)}
                              </option>
                            ))}
                          </select>

                          <div className="settings-slider-heading">
                            <span>Creativity</span>
                            <strong>{displayedCreativity}%</strong>
                          </div>
                          <input
                            aria-label="Creativity"
                            className="settings-slider"
                            name="modelSettings.creativity"
                            type="range"
                            min="0"
                            max="100"
                            defaultValue={selectedModelSettings.creativity}
                            onChange={(event) =>
                              setSettingsCreativityPreview({
                                classId: activeClassId,
                                value: Number(event.target.value)
                              })
                            }
                          />

                          <label className="settings-control-label" htmlFor="max-response-length">
                            Max response length
                          </label>
                          <select
                            id="max-response-length"
                            name="modelSettings.responseLength"
                            defaultValue={selectedModelSettings.responseLength}
                          >
                            {responseLengthOptions.map((responseLength) => (
                              <option key={responseLength} value={responseLength}>
                                {capitalizeLabel(responseLength)}
                              </option>
                            ))}
                          </select>
                        </section>
                      </div>

                      <div className="settings-column">
                        <section className="settings-card" aria-labelledby="settings-response-format">
                          <h3 id="settings-response-format">Response Format</h3>
                          <p>Control the structure and reading style of normal tutoring replies.</p>
                          <div className="settings-toggle-list">
                            {responseFormatSettings.map((setting) => (
                              <SettingsToggle
                                defaultChecked={selectedResponseFormat[setting.id]}
                                key={setting.title}
                                name={`responseFormat.${setting.id}`}
                                {...setting}
                              />
                            ))}
                          </div>

                          <label className="settings-control-label" htmlFor="reading-level">
                            Reading level
                          </label>
                          <select
                            id="reading-level"
                            name="responseFormat.readingLevel"
                            defaultValue={selectedResponseFormat.readingLevel}
                          >
                            {readingLevelOptions.map((readingLevel) => (
                              <option key={readingLevel} value={readingLevel}>
                                {capitalizeLabel(readingLevel)}
                              </option>
                            ))}
                          </select>

                          <label className="settings-control-label" htmlFor="math-notation">
                            Math notation
                          </label>
                          <select
                            id="math-notation"
                            name="responseFormat.mathNotation"
                            defaultValue={selectedResponseFormat.mathNotation}
                          >
                            {mathNotationOptions.map((notation) => (
                              <option key={notation} value={notation}>
                                {formatMathNotationLabel(notation)}
                              </option>
                            ))}
                          </select>
                        </section>

                        <section className="settings-card" aria-labelledby="settings-source-usage">
                          <h3 id="settings-source-usage">Source Usage</h3>
                          <p>Control how Chandra uses class materials.</p>
                          <div className="settings-toggle-list">
                            {sourceUsageSettings.map((setting) => (
                              <SettingsToggle
                                defaultChecked={selectedSourceUsage[setting.id]}
                                key={setting.title}
                                name={`sourceUsage.${setting.id}`}
                                {...setting}
                              />
                            ))}
                          </div>

                          <label className="settings-control-label" htmlFor="preferred-source-type">
                            Preferred source type
                          </label>
                          <select
                            id="preferred-source-type"
                            name="sourceUsage.preferredSourceType"
                            defaultValue={selectedSourceUsage.preferredSourceType}
                          >
                            {preferredSourceTypeOptions.map((sourceType) => (
                              <option key={sourceType} value={sourceType}>
                                {sourceType}
                              </option>
                            ))}
                          </select>
                        </section>
                      </div>
                    </div>
                  </form>
                ) : null}

                {activeTab === "roster" ? (
                  <div className="roster-editor teacher-content-block">
                    {selectedStudent && isProfessorReviewOpen ? (
                      <section className="professor-chat-review" aria-label="Professor conversation review">
                        <aside className="professor-chat-sidebar">
                          <button
                            className="secondary-button compact"
                            type="button"
                            onClick={() => {
                              setIsProfessorReviewOpen(false);
                              setSelectedConversationId("");
                              setSelectedConversationClassId(activeClassId);
                              setConversationMessages([]);
                            }}
                          >
                            Back to roster
                          </button>
                          <div className="professor-student-summary">
                            <h3>{selectedStudent.displayName}</h3>
                            <span>{selectedStudent.email}</span>
                          </div>
                          <div className="sidebar-section-heading">
                            <strong>Conversations</strong>
                            <span className="status muted">{visibleStudentConversations.length} saved</span>
                          </div>
                          {conversationError ? <p className="form-error">{conversationError}</p> : null}
                          <div className="teacher-conversation-list">
                            {visibleStudentConversations.map((conversation) => (
                              <button
                                aria-pressed={conversation.id === activeSelectedConversationId}
                                className="teacher-conversation-row"
                                key={conversation.id}
                                type="button"
                                onClick={() => {
                                  setSelectedConversationId(conversation.id);
                                  setSelectedConversationClassId(activeClassId);
                                }}
                              >
                                <strong>{conversation.title}</strong>
                                <span>{formatConversationMeta(conversation)}</span>
                              </button>
                            ))}
                            {!visibleStudentConversations.length ? (
                              <div className="empty-state">
                                <strong>No saved conversations</strong>
                                <span>This student has not chatted with Chandra for this class yet.</span>
                              </div>
                            ) : null}
                          </div>
                        </aside>

                        <section className="professor-chat-panel" aria-label="Saved transcript">
                          <div className="professor-chat-heading">
                            <div>
                              <h3>{selectedConversation?.title ?? "No conversation selected"}</h3>
                            </div>
                            {selectedConversation ? (
                              <span className="status muted">{formatConversationMeta(selectedConversation)}</span>
                            ) : null}
                          </div>
                          <div className="message-list professor-message-list">
                            {activeSelectedConversationId && conversationMessages.length ? (
                              conversationMessages.map((message) => (
                                <article className={`message ${message.role}`} key={message.id}>
                                  <div className="message-meta">
                                    {message.role === "student" ? selectedStudent.displayName : "Chandra"}
                                  </div>
                                  <p>{message.content}</p>
                                  {message.role === "assistant" && message.sources?.length ? (
                                    <div className="message-sources" aria-label="Sources used">
                                      {message.sources.map((source, index) => (
                                        <span
                                          key={`${source.title}-${source.pageNumber ?? ""}-${source.problemNumber ?? ""}-${index}`}
                                        >
                                          {formatSourceLabel(source)}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </article>
                              ))
                            ) : (
                              <div className="empty-state professor-chat-empty">
                                <strong>No transcript yet</strong>
                                <span>Saved student chats will appear here after the student uses Chandra.</span>
                              </div>
                            )}
                          </div>
                        </section>
                      </section>
                    ) : (
                      <div className="roster-dashboard">
                        <div className="teacher-section-heading roster-heading">
                          <div>
                            <h2>Students</h2>
                            <span>Manage student activity and support needs</span>
                          </div>
                          <button
                            className="primary-button teacher-primary-button compact"
                            type="button"
                            onClick={() => setIsStudentDialogOpen(true)}
                          >
                            Add student
                          </button>
                        </div>

                        <div className="roster-stats-grid" aria-label="Roster summary">
                          <RosterStatCard label="Total students" value={String(rosterStats.totalStudents)} />
                          <RosterStatCard label="Active now" tone="positive" value={String(rosterStats.activeToday)} />
                          <RosterStatCard label="Avg questions/student" value={`${formatStatNumber(rosterStats.averageQuestions)}/day`} />
                          <RosterStatCard label="No activity" value={String(rosterStats.noActivity)} />
                        </div>

                        <div className="roster-workspace">
                          <section className="roster-table-card" aria-label="Student roster">
                            <div className="roster-toolbar">
                              <label className="roster-search" htmlFor="roster-search-input">
                                <SearchIcon />
                                <input
                                  id="roster-search-input"
                                  type="search"
                                  value={rosterSearchQuery}
                                  onChange={(event) => setRosterSearchQuery(event.target.value)}
                                  placeholder="Search students by name or email"
                                />
                              </label>

                              <div className="roster-filter-list" aria-label="Filter students">
                                {rosterFilters.map((filter) => (
                                  <button
                                    aria-pressed={rosterFilter === filter.id}
                                    key={filter.id}
                                    type="button"
                                    onClick={() => setRosterFilter(filter.id)}
                                  >
                                    {filter.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="roster-bulk-bar">
                              <label className="roster-check-label">
                                <input
                                  aria-label="Select all visible students"
                                  checked={allVisibleStudentsChecked}
                                  type="checkbox"
                                  onChange={(event) => {
                                    const visibleStudentIds = filteredRosterRows.map((row) => row.student.id);

                                    setCheckedStudentIds((currentIds) =>
                                      event.target.checked
                                        ? Array.from(new Set([...currentIds, ...visibleStudentIds]))
                                        : currentIds.filter((studentId) => !visibleStudentIds.includes(studentId))
                                    );
                                  }}
                                />
                                <span>Select all</span>
                              </label>
                              <button
                                disabled={!someVisibleStudentsChecked}
                                type="button"
                                onClick={() => setCheckedStudentIds([])}
                              >
                                <CloseIcon />
                                Clear selection
                              </button>
                            </div>

                            <div className="roster-table" role="table" aria-label="Students">
                              <div className="roster-table-header" role="row">
                                <span aria-hidden="true" />
                                <span>Student</span>
                                <span>Activity</span>
                                <span>Questions asked</span>
                                <span>Last chat topic</span>
                                <span>Conversations</span>
                                <span>Actions</span>
                              </div>

                              {filteredRosterRows.map((row) => {
                                const isChecked = checkedStudentIdSet.has(row.student.id);
                                const isSelected = selectedRosterRow?.student.id === row.student.id;

                                return (
                                  <div
                                    aria-selected={isSelected}
                                    className="roster-table-row"
                                    key={row.student.id}
                                    role="row"
                                    onClick={() => {
                                      // Legacy test marker: setSelectedStudentId(student.id)
                                      setSelectedStudentId(row.student.id);
                                      setSelectedStudentClassId(activeClassId);
                                      setIsRosterDetailOpen(true);
                                      setIsProfessorReviewOpen(false);
                                    }}
                                  >
                                    <span className="roster-cell roster-checkbox-cell" role="cell">
                                      <input
                                        aria-label={`Select ${row.student.displayName}`}
                                        checked={isChecked}
                                        type="checkbox"
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={(event) => {
                                          setCheckedStudentIds((currentIds) =>
                                            event.target.checked
                                              ? Array.from(new Set([...currentIds, row.student.id]))
                                              : currentIds.filter((studentId) => studentId !== row.student.id)
                                          );
                                          setSelectedStudentId(row.student.id);
                                          setSelectedStudentClassId(activeClassId);
                                          setIsRosterDetailOpen(true);
                                        }}
                                      />
                                    </span>
                                    <span className="roster-cell roster-student-cell" role="cell">
                                      <strong>{row.student.displayName}</strong>
                                      <span>{row.student.email}</span>
                                    </span>
                                    <span className="roster-cell roster-activity-cell" role="cell">
                                      <span className={`roster-status-pill ${row.statusTone}`}>{row.status}</span>
                                      <span>{row.lastActive}</span>
                                    </span>
                                    <span className="roster-cell" role="cell">{row.questionsLabel}</span>
                                    <span className="roster-cell" role="cell">{row.lastChatTopic}</span>
                                    <span className="roster-cell" role="cell">{row.conversationsLabel}</span>
                                    <span className="roster-cell roster-actions-cell" role="cell">
                                      <button
                                        aria-label={`View chats for ${row.student.displayName}`}
                                        className="student-icon-button"
                                        title="View chats"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSelectedStudentId(row.student.id);
                                          setSelectedStudentClassId(activeClassId);
                                          setIsRosterDetailOpen(true);
                                          setSelectedConversationId("");
                                          setSelectedConversationClassId(activeClassId);
                                          setConversationMessages([]);
                                          setIsProfessorReviewOpen(true);
                                        }}
                                      >
                                        <ChatIcon />
                                      </button>
                                      <button
                                        aria-label={`Open knowledge for ${row.student.displayName}`}
                                        className="student-icon-button"
                                        title="Knowledge"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSelectedStudentId(row.student.id);
                                          setSelectedStudentClassId(activeClassId);
                                          setIsRosterDetailOpen(true);
                                        }}
                                      >
                                        <BookOpenIcon />
                                      </button>
                                      <button
                                        aria-label={`Open student profile for ${row.student.displayName}`}
                                        className="student-icon-button"
                                        title="Student profile"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSelectedStudentId(row.student.id);
                                          setSelectedStudentClassId(activeClassId);
                                          setIsRosterDetailOpen(true);
                                        }}
                                      >
                                        <UserIcon />
                                      </button>
                                    </span>
                                  </div>
                                );
                              })}

                              {!filteredRosterRows.length ? (
                                <div className="empty-state roster-empty-state">
                                  <strong>No matching students</strong>
                                  <span>Adjust the search or filter to see more roster rows.</span>
                                </div>
                              ) : null}
                            </div>

                            <div className="roster-table-footer">
                              <span>
                                {filteredRosterRows.length
                                  ? `1-${filteredRosterRows.length} of ${rosterRows.length} students`
                                  : `0 of ${rosterRows.length} students`}
                              </span>
                              <div className="roster-pagination" aria-label="Roster pages">
                                <button aria-label="Previous page" disabled type="button">
                                  <ChevronLeftIcon />
                                </button>
                                <button aria-current="page" type="button">1</button>
                                <button aria-label="Next page" disabled type="button">
                                  <ChevronRightIcon />
                                </button>
                              </div>
                            </div>
                          </section>

                          {selectedRosterRow ? (
                            <aside className="student-detail-panel" aria-label={`${selectedRosterRow.student.displayName} details`}>
                              <div className="student-detail-heading">
                                <div>
                                  <h3>{selectedRosterRow.student.displayName}</h3>
                                  <span>{selectedRosterRow.student.email}</span>
                                </div>
                                <button
                                  aria-label="Close student detail"
                                  className="student-detail-close"
                                  type="button"
                                  onClick={() => {
                                    setIsRosterDetailOpen(false);
                                  }}
                                >
                                  <CloseIcon />
                                </button>
                              </div>

                              <section className="student-detail-card student-activity-card" aria-label="Student activity">
                                <dl>
                                  <div>
                                    <dt>Last active</dt>
                                    <dd>{selectedRosterRow.lastActive}</dd>
                                  </div>
                                  <div>
                                    <dt>Questions/day</dt>
                                    <dd>{formatStatNumber(selectedRosterRow.questionsPerDay)}</dd>
                                  </div>
                                  <div>
                                    <dt>Today&apos;s activity</dt>
                                    <dd>{formatQuestionCount(selectedRosterRow.questionsToday)}</dd>
                                  </div>
                                  <div>
                                    <dt>Conversations</dt>
                                    <dd>{selectedRosterRow.conversationsLabel}</dd>
                                  </div>
                                </dl>
                              </section>

                              <section className="student-detail-card">
                                <div className="student-detail-card-heading">
                                  <h4>Recent conversations</h4>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsProfessorReviewOpen(true);
                                    }}
                                  >
                                    View all
                                  </button>
                                </div>
                                <div className="student-recent-list">
                                  {buildRecentConversationPreviews(selectedRosterRow).map((conversation) => (
                                    <div className="student-recent-row" key={`${conversation.title}-${conversation.meta}`}>
                                      <span>{conversation.title}</span>
                                      <time>{conversation.meta}</time>
                                    </div>
                                  ))}
                                </div>
                              </section>

                              <StudentLearningProfileCard
                                canForceUpdate={canForceLearningProfileUpdate}
                                isSavingAction={savingLearningProfileAction}
                                statusMessage={learningProfileStatusMessage}
                                profile={displayedStudentLearningProfile}
                                onApprove={() => {
                                  void saveLearningProfileAction("approve");
                                }}
                                onClearDraft={() => {
                                  void saveLearningProfileAction("clearDraft");
                                }}
                                onDisable={() => {
                                  void saveLearningProfileAction("disable");
                                }}
                                onUpdateNow={() => {
                                  void updateLearningProfileNow();
                                }}
                                onForceSevenDays={() => {
                                  void updateLearningProfileNow(true);
                                }}
                              />

                              <section className="student-detail-card">
                                <h4>Private teacher notes</h4>
                                <textarea
                                  aria-label={`Private teacher notes for ${selectedRosterRow.student.displayName}`}
                                  maxLength={1000}
                                  rows={5}
                                  value={
                                    teacherNotesByStudentId[selectedRosterRow.student.id] ??
                                    selectedRosterRow.teacherNotes
                                  }
                                  onChange={(event) =>
                                    setTeacherNotesByStudentId((currentNotes) => ({
                                      ...currentNotes,
                                      [selectedRosterRow.student.id]: event.target.value
                                    }))
                                  }
                                  onBlur={() => {
                                    void saveTeacherNotes(selectedRosterRow);
                                  }}
                                />
                                <span className="student-note-count">
                                  {(
                                    teacherNotesByStudentId[selectedRosterRow.student.id] ??
                                    selectedRosterRow.teacherNotes
                                  ).length}{" "}
                                  / 1000
                                  {savingNotesStudentId === selectedRosterRow.student.id ? " / saving" : ""}
                                </span>
                              </section>

                              <section className="student-detail-card">
                                <h4>Quick actions</h4>
                                <div className="student-quick-actions">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsProfessorReviewOpen(true);
                                    }}
                                  >
                                    <ChatIcon />
                                    View chats
                                  </button>
                                </div>
                              </section>
                            </aside>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {activeTab === "knowledge" ? (
                  <div className="knowledge-workspace teacher-content-block">
                    <div className="teacher-section-heading">
                      <div>
                        <h2>Tutor Knowledge</h2>
                        <span>Manage the materials Chandra can use when helping students</span>
                      </div>
                    </div>

                    {materialSuccess ? <p className="form-success">{materialSuccess}</p> : null}

                    <div className="knowledge-layout">
                      <section className="knowledge-library-card" aria-labelledby="knowledge-library-title">
                        <div className="knowledge-library-heading">
                          <h3 id="knowledge-library-title">Sources Library</h3>
                          <button
                            className="primary-button teacher-primary-button compact"
                            type="button"
                            onClick={() => setIsKnowledgeDialogOpen(true)}
                          >
                            Add knowledge
                          </button>
                        </div>

                        <div className="knowledge-filter-list" aria-label="Filter knowledge sources">
                          {knowledgeFilters.map((filter) => (
                            <button
                              aria-pressed={knowledgeFilter === filter}
                              key={filter}
                              type="button"
                              onClick={() => setKnowledgeFilter(filter)}
                            >
                              {filter}
                            </button>
                          ))}
                        </div>

                        <div className="knowledge-source-table" role="table" aria-label="Knowledge sources">
                          <div className="knowledge-source-header" role="row">
                            <span role="columnheader">Source</span>
                            <span role="columnheader">Visibility</span>
                            <span role="columnheader">Status</span>
                            <span role="columnheader">Chunks</span>
                            <span role="columnheader">Actions</span>
                          </div>

                          {filteredMaterials.map((material) => {
                            const settings = sourceSettingsByMaterialId[material.id] ?? defaultKnowledgeSourceSettings(material);
                            const isSelected = selectedMaterial?.id === material.id;

                            return (
                              <div
                                aria-selected={isSelected}
                                className="knowledge-source-row"
                                key={material.id}
                                role="row"
                              >
                                <button
                                  className="knowledge-source-cell knowledge-source-title"
                                  role="cell"
                                  type="button"
                                  onClick={() => openMaterialDetail(material)}
                                >
                                  <span className="material-icon" aria-hidden="true">
                                    <KnowledgeSourceIcon kind={material.kind} />
                                  </span>
                                  <span className="material-copy">
                                    <strong>{material.title}</strong>
                                    <span>{formatMaterialMeta(material)}</span>
                                  </span>
                                </button>
                                <span className="knowledge-source-cell" role="cell">
                                  <span className={`knowledge-badge ${knowledgeVisibilityClass(settings)}`}>
                                    {formatKnowledgeVisibility(settings)}
                                  </span>
                                </span>
                                <span className="knowledge-source-cell" role="cell">
                                  <span className={`knowledge-badge ${knowledgeStatusClass(material)}`}>
                                    {formatKnowledgeStatus(material)}
                                  </span>
                                </span>
                                <span className="knowledge-source-cell numeric" role="cell">
                                  {formatMaterialChunkCount(material)}
                                </span>
                                <span className="knowledge-source-cell knowledge-row-actions" role="cell">
                                  <button
                                    aria-label={`View ${material.title}`}
                                    className="knowledge-icon-button"
                                    title="View source details"
                                    type="button"
                                    onClick={() => openMaterialDetail(material)}
                                  >
                                    <EyeIcon />
                                  </button>
                                  <button
                                    aria-label={`Reprocess ${material.title}`}
                                    className="knowledge-icon-button"
                                    disabled={reprocessingMaterialId === material.id}
                                    title="Reprocess source"
                                    type="button"
                                    onClick={() => {
                                      setSelectedMaterialId(material.id);
                                      void reprocessMaterial(material);
                                    }}
                                  >
                                    <RefreshIcon />
                                  </button>
                                  <button
                                    aria-label={`Delete ${material.title}`}
                                    className="knowledge-icon-button danger"
                                    disabled={deletingMaterialId === material.id}
                                    title="Delete source"
                                    type="button"
                                    onClick={() => deleteMaterial(material)}
                                  >
                                    <TrashIcon />
                                  </button>
                                </span>
                              </div>
                            );
                          })}

                          {!filteredMaterials.length ? (
                            <div className="empty-state knowledge-empty-state">
                              <strong>{materials.length ? "No matching sources" : "No tutor knowledge yet"}</strong>
                              <span>
                                {materials.length
                                  ? "Try another filter or add a source for this category."
                                  : "Add assignments, notes, readings, examples, or rubrics to ground the tutor."}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        <div className="knowledge-library-footer">
                          <span>
                            {filteredMaterials.length
                              ? `1-${filteredMaterials.length} of ${filteredMaterials.length} sources`
                              : "0 sources"}
                          </span>
                          <div className="knowledge-pagination" aria-label="Source pagination">
                            <button disabled type="button" aria-label="Previous page">
                              <ChevronLeftIcon />
                            </button>
                            <button aria-current="page" type="button">
                              1
                            </button>
                            <button disabled type="button" aria-label="Next page">
                              <ChevronRightIcon />
                            </button>
                          </div>
                        </div>
                      </section>

                      <aside className="knowledge-detail-stack" aria-label="Knowledge source controls">
                        <section className="knowledge-detail-card" aria-labelledby="visibility-priority-title">
                          <div className="knowledge-card-heading">
                            <h3 id="visibility-priority-title">Visibility &amp; Priority</h3>
                            {selectedMaterial ? <span>{selectedMaterial.title}</span> : null}
                          </div>

                          {selectedMaterial && selectedMaterialSettings ? (
                            <div className="knowledge-visibility-grid">
                              <div className="knowledge-toggle-list">
                                <KnowledgeToggle
                                  checked={selectedMaterialSettings.activeForStudents}
                                  label="Active for students"
                                  onChange={(checked) =>
                                    updateKnowledgeSourceSetting(selectedMaterial.id, { activeForStudents: checked })
                                  }
                                />
                                <KnowledgeToggle
                                  checked={selectedMaterialSettings.teacherOnly}
                                  label="Teacher-only material"
                                  onChange={(checked) =>
                                    updateKnowledgeSourceSetting(selectedMaterial.id, { teacherOnly: checked })
                                  }
                                />
                                <KnowledgeToggle
                                  checked={selectedMaterialSettings.citationsRequired}
                                  label="Require citations from this source"
                                  onChange={(checked) =>
                                    updateKnowledgeSourceSetting(selectedMaterial.id, { citationsRequired: checked })
                                  }
                                />
                              </div>

                              <div className="knowledge-priority-control">
                                <label className="field-label" htmlFor="knowledge-priority">
                                  Priority
                                </label>
                                <select
                                  id="knowledge-priority"
                                  value={selectedMaterialSettings.priority}
                                  onChange={(event) =>
                                    updateKnowledgeSourceSetting(selectedMaterial.id, {
                                      priority: event.target.value as KnowledgeSourceSettings["priority"]
                                    })
                                  }
                                >
                                  <option>Primary</option>
                                  <option>Normal</option>
                                  <option>Low</option>
                                </select>
                                <p>Primary sources are preferred in responses.</p>
                              </div>
                            </div>
                          ) : (
                            <div className="empty-state knowledge-card-empty">
                              <strong>Select a source</strong>
                              <span>Visibility controls will appear after a source is available.</span>
                            </div>
                          )}
                        </section>

                        <section className="knowledge-detail-card" aria-labelledby="retrieval-test-title">
                          <div className="knowledge-card-heading compact-heading">
                            <h3 id="retrieval-test-title">Retrieval Test</h3>
                          </div>
                          <form
                            className="retrieval-test-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void runRetrievalTest();
                            }}
                          >
                            <label className="sr-only" htmlFor="retrieval-test-query">
                              Retrieval test query
                            </label>
                            <div className="retrieval-search-row">
                              <span aria-hidden="true">
                                <SearchIcon />
                              </span>
                              <input
                                id="retrieval-test-query"
                                placeholder="Try a student question or problem number"
                                value={retrievalQuery}
                                onChange={(event) => setRetrievalQuery(event.target.value)}
                              />
                              <button
                                className="primary-button teacher-primary-button compact"
                                disabled={isTestingRetrieval || !selectedMaterial}
                                type="submit"
                              >
                                {isTestingRetrieval ? "Testing" : "Test search"}
                              </button>
                            </div>
                          </form>
                          <div className="retrieval-results">
                            <div className="retrieval-results-heading">
                              <span>Top results</span>
                              <span>Confidence</span>
                            </div>
                            {(retrievalResults.length ? retrievalResults : buildPlaceholderRetrievalResults(selectedMaterial)).map((result) => (
                              <div className="retrieval-result-row" key={`${result.title}-${result.chunkId}`}>
                                <div>
                                  <strong>{result.title}</strong>
                                  <span>{result.excerpt}</span>
                                </div>
                                <span className="retrieval-page-pill">{result.chunkLabel}</span>
                                <strong>{formatRetrievalConfidence(result.confidence)}</strong>
                              </div>
                            ))}
                          </div>
                        </section>

                      </aside>
                    </div>
                  </div>
                ) : null}

                {activeTab === "conversations" ? (
                  <div className="conversation-review-page teacher-content-block">
                    <div className="teacher-section-heading conversation-review-heading">
                      <div>
                        <h2>Conversation Review Center</h2>
                        <span>
                          Review student chats, source usage, and follow-up opportunities across {selectedClass.name}.
                        </span>
                      </div>
                    </div>

                    {conversationError ? <p className="form-error">{conversationError}</p> : null}

                    <div className="conversation-metric-grid" aria-label="Conversation summary">
                      <ConversationMetricCard
                        icon={<ChatIcon />}
                        label="conversations"
                        tone="teal"
                        value={String(conversationMetrics.total)}
                      />
                      <ConversationMetricCard
                        icon={<CircleIcon />}
                        label="unreviewed"
                        tone="gold"
                        value={String(conversationMetrics.unreviewed)}
                      />
                      <ConversationMetricCard
                        icon={<StrugglingTopicsIcon />}
                        label="need follow-up"
                        tone="neutral"
                        value={String(conversationMetrics.followUp)}
                      />
                      <ConversationMetricCard
                        icon={<LowConfidenceIcon />}
                        label="low confidence"
                        tone="neutral"
                        value={String(conversationMetrics.lowConfidence)}
                      />
                    </div>

                    <div className="conversation-filter-stack">
                      <div className="conversation-chip-list" aria-label="Filter conversations">
                        {conversationFilters.map((filter) => (
                          <button
                            aria-pressed={conversationFilter === filter.id}
                            key={filter.id}
                            type="button"
                            onClick={() => setConversationFilter(filter.id)}
                          >
                            {filter.label}
                          </button>
                        ))}
                      </div>

                      <div className="conversation-control-row">
                        <label className="sr-only" htmlFor="conversation-student-filter">
                          Filter by student
                        </label>
                        <select
                          id="conversation-student-filter"
                          value={conversationStudentFilter}
                          onChange={(event) => setConversationStudentFilter(event.target.value)}
                        >
                          <option value="all">By student</option>
                          {conversationStudentOptions.map((studentOption) => (
                            <option key={studentOption.email} value={studentOption.email}>
                              {studentOption.name}
                            </option>
                          ))}
                        </select>

                        <label className="sr-only" htmlFor="conversation-topic-filter">
                          Filter by topic
                        </label>
                        <select
                          id="conversation-topic-filter"
                          value={conversationTopicFilter}
                          onChange={(event) => setConversationTopicFilter(event.target.value)}
                        >
                          <option value="all">By topic</option>
                          {conversationTopicOptions.map((topic) => (
                            <option key={topic} value={topic}>
                              {topic}
                            </option>
                          ))}
                        </select>

                        <label className="conversation-search" htmlFor="conversation-search-input">
                          <SearchIcon />
                          <input
                            id="conversation-search-input"
                            placeholder="Search conversations"
                            type="search"
                            value={conversationSearchQuery}
                            onChange={(event) => setConversationSearchQuery(event.target.value)}
                          />
                        </label>
                      </div>
                      {evidenceConversationIds.length ? (
                        <div className="conversation-evidence-filter">
                          <span>{formatConversationCount(evidenceConversationIds.length)} from selected insight evidence</span>
                          <button type="button" onClick={() => setEvidenceConversationIds([])}>
                            Clear evidence filter
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="conversation-review-grid">
                      <section className="conversation-inbox-panel" aria-label="Conversation Inbox">
                        <div className="conversation-panel-heading">
                          <h3>Conversation Inbox</h3>
                        </div>
                        <div className="conversation-inbox-table" aria-label="Conversation summaries">
                          {filteredConversationReviewRows.map((conversation) => (
                            <button
                              aria-pressed={conversation.id === selectedConversationReviewRow?.id}
                              className="conversation-inbox-row"
                              key={conversation.id}
                              type="button"
                              onClick={() => {
                                setSelectedStudentId(conversation.studentId);
                                setSelectedStudentClassId(activeClassId);
                                setSelectedConversationId(conversation.id);
                                setSelectedConversationClassId(activeClassId);
                                setIsRosterDetailOpen(true);
                                setIsProfessorReviewOpen(false);
                              }}
                            >
                              <span className="conversation-inbox-primary">
                                <strong>{conversation.title}</strong>
                                <span className={`conversation-status-pill ${conversationStatusClass(conversation.status)}`}>
                                  {formatConversationStatus(conversation.status)}
                                </span>
                              </span>
                              <span className="conversation-inbox-meta">
                                <span>
                                  <em>Student</em>
                                  {conversation.studentName}
                                </span>
                                <span>
                                  <em>Last</em>
                                  {conversation.lastMessageLabel}
                                </span>
                                <span>
                                  <em>Messages</em>
                                  {conversation.messageCount}
                                </span>
                                <span>
                                  <em>Topic</em>
                                  {conversation.topic}
                                </span>
                              </span>
                            </button>
                          ))}

                          {!filteredConversationReviewRows.length ? (
                            <div className="empty-state conversation-empty-state">
                              <strong>No matching conversations</strong>
                              <span>Saved student chats will appear here after students use Chandra.</span>
                            </div>
                          ) : null}
                        </div>
                        <div className="conversation-panel-footer">
                          {filteredConversationReviewRows.length
                            ? `Showing 1-${filteredConversationReviewRows.length} of ${conversationReviewRows.length} conversations`
                            : `Showing 0 of ${conversationReviewRows.length} conversations`}
                        </div>
                      </section>

                      <section className="transcript-viewer-panel" aria-label="Transcript Viewer">
                        <div className="transcript-header">
                          <div>
                            <p>Transcript Viewer</p>
                            <h3>{selectedConversationReviewRow?.title ?? "No conversation selected"}</h3>
                            <span>
                              {selectedConversationReviewRow
                                ? `${selectedConversationReviewRow.studentName} / Last active ${selectedConversationReviewRow.lastMessageLabel}`
                                : "Select a conversation to review the saved transcript."}
                            </span>
                          </div>
                          <div className="transcript-header-actions">
                            <button
                              disabled={!selectedConversationReviewRow}
                              type="button"
                              onClick={() => {
                                if (!selectedConversationReviewRow) {
                                  return;
                                }
                                setSelectedStudentId(selectedConversationReviewRow.studentId);
                                setSelectedStudentClassId(activeClassId);
                                setActiveTab("roster");
                              }}
                            >
                              Open student profile
                            </button>
                            <button disabled={!selectedConversationReviewRow} type="button" onClick={focusConversationPrivateNote}>
                              Add teacher note
                            </button>
                          </div>
                        </div>

                        <div className="transcript-chip-row">
                          <span>Model: {selectedConversationReviewRow?.modelId || selectedConversation?.modelId || "Not recorded"}</span>
                          <span>{formatRetrievalConfidenceLabel(selectedConversationReviewRow?.latestRetrievalConfidence)}</span>
                        </div>

                        <div className="transcript-message-list" aria-label="Conversation transcript">
                          {transcriptMessages.length ? (
                            transcriptMessages.map((message) => {
                              const isStudentMessage = message.role === "student";

                              return (
                                <article
                                  className={`review-message ${isStudentMessage ? "student" : "assistant"}`}
                                  key={message.id}
                                >
                                  {!isStudentMessage ? (
                                    <span className="review-message-avatar" aria-hidden="true">
                                      C
                                    </span>
                                  ) : null}
                                  <div className="review-message-stack">
                                    <div className="review-message-bubble">
                                      <p>{message.content}</p>
                                      {!isStudentMessage && message.sources?.length ? (
                                        <div className="review-source-pills" aria-label="Sources used">
                                          {message.sources.map((source, index) => (
                                            <span
                                              key={`${source.title}-${source.pageNumber ?? ""}-${source.problemNumber ?? ""}-${index}`}
                                            >
                                              {formatSourceLabel(source)}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                    <time>{formatConversationDate(message.createdAt)}</time>
                                  </div>
                                </article>
                              );
                            })
                          ) : (
                            <div className="empty-state transcript-empty-state">
                              <strong>No transcript loaded</strong>
                              <span>Select a saved conversation to review messages and source citations.</span>
                            </div>
                          )}
                        </div>

                        <div className="review-readonly-footer" aria-label="Review-only transcript">
                          <span>This transcript is read-only. Use teacher review actions and private notes for follow-up.</span>
                        </div>
                      </section>

                      <aside className="conversation-review-side" aria-label="Teacher review and metadata">
                        <section className="review-side-panel" aria-labelledby="teacher-review-actions-title">
                          <div className="conversation-panel-heading">
                            <h3 id="teacher-review-actions-title">Teacher Review Actions</h3>
                            <span>
                              {reviewSaveMessage ||
                                (selectedConversationReviewRow
                                  ? `Current: ${formatConversationStatus(selectedConversationReviewRow.status)}`
                                  : "Select a conversation")}
                            </span>
                          </div>
                          <div className="review-action-grid">
                            {conversationReviewActions.map((action) => (
                              <button
                                aria-pressed={selectedConversationReviewRow?.status === action.status}
                                disabled={
                                  !selectedConversationReviewRow ||
                                  savingReviewConversationId === selectedConversationReviewRow.id
                                }
                                key={action.status}
                                type="button"
                                onClick={() => {
                                  if (selectedConversationReviewRow) {
                                    void saveConversationReview(selectedConversationReviewRow, action.status);
                                  }
                                }}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                          <label className="sr-only" htmlFor="conversation-private-note">
                            Add private note
                          </label>
                          <textarea
                            className={isConversationNoteHighlighted ? "highlighted" : undefined}
                            id="conversation-private-note"
                            maxLength={1000}
                            placeholder="Add private note..."
                            rows={3}
                            value={selectedConversationPrivateNote}
                            onChange={(event) => {
                              if (!selectedConversationReviewRow) {
                                return;
                              }
                              setHighlightedNoteConversationId(selectedConversationReviewRow.id);
                              setConversationNotesById((currentNotes) => ({
                                ...currentNotes,
                                [selectedConversationReviewRow.id]: event.target.value
                              }));
                            }}
                          />
                          <div className="review-note-actions">
                            <button
                              disabled={
                                !selectedConversationReviewRow ||
                                savingReviewConversationId === selectedConversationReviewRow.id
                              }
                              type="button"
                              onClick={() => {
                                if (selectedConversationReviewRow) {
                                  void saveConversationReview(selectedConversationReviewRow);
                                }
                              }}
                            >
                              {selectedConversationReviewRow &&
                              savingReviewConversationId === selectedConversationReviewRow.id
                                ? "Saving"
                                : "Save note"}
                            </button>
                            <span>Private to you</span>
                          </div>
                        </section>

                        <section className="review-side-panel" aria-labelledby="conversation-summary-title">
                          <div className="conversation-panel-heading">
                            <h3 id="conversation-summary-title">Conversation Summary</h3>
                            <span>{selectedConversationReviewRow ? formatConversationStatus(selectedConversationReviewRow.status) : ""}</span>
                          </div>
                          <div className="conversation-summary-card">
                            <span>Topic</span>
                            <strong>{selectedConversationReviewRow?.topic ?? "No topic yet"}</strong>
                          </div>
                          <div className="conversation-summary-stack">
                            <article>
                              <span>Student asked</span>
                              <p>{formatConversationMainQuestion(transcriptMessages, selectedConversationReviewRow)}</p>
                            </article>
                            <article>
                              <span>Chandra responded with</span>
                              <p>{formatAssistantHelpSummary(transcriptMessages, selectedConversationReviewRow)}</p>
                            </article>
                            <article>
                              <span>Materials referenced</span>
                              <p>{formatReferencedMaterials(conversationSourceRows)}</p>
                            </article>
                            <article>
                              <span>Suggested next step</span>
                              <p>{formatSuggestedFollowUp(selectedConversationReviewRow)}</p>
                            </article>
                          </div>
                        </section>

                        <section className="review-side-panel" aria-labelledby="source-audit-title">
                          <div className="source-audit-heading">
                            <h3 id="source-audit-title">Materials & Citations</h3>
                            <div>
                              <button
                                disabled={!conversationCitationCount}
                                type="button"
                                onClick={() => {
                                  if (selectedConversationReviewRow) {
                                    setExpandedSourceConversationId((currentId) =>
                                      currentId === selectedConversationReviewRow.id ? "" : selectedConversationReviewRow.id
                                    );
                                  }
                                }}
                              >
                                {conversationCitationCount} citation{conversationCitationCount === 1 ? "" : "s"}
                              </button>
                              <span>{conversationSourceRows.length} material{conversationSourceRows.length === 1 ? "" : "s"}</span>
                              <span>{hasSourceWarning ? "No source used warning" : "Sources present"}</span>
                            </div>
                          </div>
                          <div className="source-audit-list">
                            {visibleConversationSourceRows.map((source, index) => (
                              <div className="source-audit-row" key={`${source.title}-${source.detail}-${index}`}>
                                <span>{index + 1}</span>
                                <strong>{source.title}</strong>
                                <em>{source.detail}</em>
                                <span className={`source-confidence-pill ${source.confidenceClass}`}>
                                  {source.confidence}
                                </span>
                              </div>
                            ))}
                            {!isSourceAuditExpanded && conversationSourceRows.length > visibleConversationSourceRows.length ? (
                              <button
                                className="source-audit-expand"
                                type="button"
                                onClick={() => {
                                  if (selectedConversationReviewRow) {
                                    setExpandedSourceConversationId(selectedConversationReviewRow.id);
                                  }
                                }}
                              >
                                Show {conversationSourceRows.length - visibleConversationSourceRows.length} more material
                                {conversationSourceRows.length - visibleConversationSourceRows.length === 1 ? "" : "s"}
                              </button>
                            ) : null}
                            {hasSourceWarning ? (
                              <div className="source-warning-row">
                                <StrugglingTopicsIcon />
                                Class-material question with no source used
                              </div>
                            ) : null}
                          </div>
                        </section>

                        <section className="review-side-panel" aria-labelledby="student-timeline-title">
                          <div className="student-timeline-heading">
                            <h3 id="student-timeline-title">Student Timeline</h3>
                            <button
                              disabled={!selectedConversationReviewRow}
                              type="button"
                              onClick={() => {
                                if (!selectedConversationReviewRow) {
                                  return;
                                }
                                setSelectedStudentId(selectedConversationReviewRow.studentId);
                                setSelectedStudentClassId(activeClassId);
                                setActiveTab("roster");
                              }}
                            >
                              Learning profile
                              <ExternalLinkIcon />
                            </button>
                          </div>
                          <div className="student-timeline-grid">
                            <dl>
                              <div>
                                <dt>Recent conversations</dt>
                                <dd>{selectedConversationRosterRow?.conversationsLabel ?? "0 conversations"}</dd>
                              </div>
                              <div>
                                <dt>Last active</dt>
                                <dd>{selectedConversationRosterRow?.lastActive ?? "Never"}</dd>
                              </div>
                              <div>
                                <dt>Questions asked</dt>
                                <dd>{selectedConversationRosterRow ? formatQuestionCount(selectedConversationRosterRow.totalQuestions) : "0 questions"}</dd>
                              </div>
                            </dl>
                            <div className="timeline-chart" aria-label="Question volume last 7 days">
                              {studentTimelineBars.map((bar, index) => (
                                <span key={`${bar.dateKey}-${index}`} title={`${bar.count} activity point${bar.count === 1 ? "" : "s"} on ${bar.fullLabel}`}>
                                  <i
                                    className={bar.count ? undefined : "empty"}
                                    style={{ height: `${bar.height}%` }}
                                  />
                                  <small>{bar.label}</small>
                                </span>
                              ))}
                            </div>
                          </div>
                        </section>
                      </aside>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty-state teacher-empty-state">
                <strong>Start with a class</strong>
                <span>Your editable roster, behavior settings, and tutor knowledge will appear here.</span>
              </div>
            )}
          </div>
        </section>
      </section>

      {isMaterialDetailDrawerOpen && selectedMaterial ? (
        <div className="detail-drawer-backdrop" role="presentation" onClick={closeMaterialDetail}>
          <aside
            aria-labelledby="material-detail-title"
            aria-modal="true"
            className="material-detail-drawer"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="material-detail-heading">
              <span className="material-icon" aria-hidden="true">
                <KnowledgeSourceIcon kind={selectedMaterial.kind} />
              </span>
              <div>
                <h3 id="material-detail-title">{selectedMaterial.title}</h3>
                <span>{formatMaterialMeta(selectedMaterial) || "Tutor knowledge source"}</span>
              </div>
              <button
                aria-label="Close source details"
                className="knowledge-icon-button"
                type="button"
                onClick={closeMaterialDetail}
              >
                <CloseIcon />
              </button>
            </div>

            <dl className="material-detail-stat-grid">
              <div>
                <dt>Upload date</dt>
                <dd>{formatMaterialUploadDate(selectedMaterial)}</dd>
              </div>
              <div>
                <dt>File type</dt>
                <dd>{formatMaterialFileType(selectedMaterial)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatMaterialSize(selectedMaterial)}</dd>
              </div>
              <div>
                <dt>Chunks</dt>
                <dd>{formatMaterialChunkCount(selectedMaterial)}</dd>
              </div>
              <div>
                <dt>Indexing status</dt>
                <dd>
                  <span className={`knowledge-badge ${knowledgeStatusClass(selectedMaterial)}`}>
                    {formatKnowledgeStatus(selectedMaterial)}
                  </span>
                </dd>
              </div>
            </dl>

            <section className="material-detail-section" aria-labelledby="material-detail-visibility">
              <h4 id="material-detail-visibility">Visibility settings</h4>
              {selectedMaterialSettings ? (
                <div className="material-detail-badge-list">
                  <span className={`knowledge-badge ${knowledgeVisibilityClass(selectedMaterialSettings)}`}>
                    {formatKnowledgeVisibility(selectedMaterialSettings)}
                  </span>
                  <span className="knowledge-badge hidden">Priority: {selectedMaterialSettings.priority}</span>
                  <span className="knowledge-badge hidden">
                    {selectedMaterialSettings.citationsRequired ? "Citations required" : "Citations optional"}
                  </span>
                </div>
              ) : null}
            </section>

            <section className="material-detail-section" aria-labelledby="material-detail-topics">
              <h4 id="material-detail-topics">Related topics detected</h4>
              {selectedMaterialDetail?.relatedTopics.length ? (
                <div className="material-topic-list">
                  {selectedMaterialDetail.relatedTopics.map((topic) => (
                    <span key={topic}>{topic}</span>
                  ))}
                </div>
              ) : (
                <p className="material-detail-muted">
                  {materialDetailLoadingId === selectedMaterial.id
                    ? "Detecting topics from indexed chunks."
                    : "No related topics detected yet."}
                </p>
              )}
            </section>

            <section className="material-detail-section" aria-labelledby="material-detail-chunks">
              <div className="material-detail-section-heading">
                <h4 id="material-detail-chunks">Sample chunks</h4>
                {materialDetailLoadingId === selectedMaterial.id ? <span>Loading</span> : null}
              </div>

              {materialDetailError ? <p className="form-error">{materialDetailError}</p> : null}

              {selectedMaterialDetail?.sampleChunks.length ? (
                <div className="material-sample-list">
                  {selectedMaterialDetail.sampleChunks.map((chunk) => (
                    <article className="material-sample-row" key={chunk.id}>
                      <div>
                        <strong>{chunk.sectionHeading || chunk.label}</strong>
                        <span>{formatMaterialChunkLocation(chunk)}</span>
                      </div>
                      <p>{chunk.excerpt}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state material-detail-empty">
                  <strong>{materialDetailLoadingId === selectedMaterial.id ? "Loading chunks" : "No sample chunks"}</strong>
                  <span>
                    {materialDetailLoadingId === selectedMaterial.id
                      ? "Reading indexed excerpts for this source."
                      : "Reprocess this source if the chunk count looks incorrect."}
                  </span>
                </div>
              )}
            </section>
          </aside>
        </div>
      ) : null}

      {isClassDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="create-class-title"
            aria-modal="true"
            className="modal-dialog"
            role="dialog"
            >
            <div className="modal-heading">
              <div>
                <h3 id="create-class-title">New class</h3>
              </div>
              <button
                aria-label="Close create class dialog"
                className="secondary-button compact"
                disabled={isSavingClass}
                type="button"
                onClick={closeClassDialog}
              >
                Close
              </button>
            </div>

            <form className="class-form modal-form" onSubmit={submitClass}>
              <label className="field-label" htmlFor="class-name">
                Class name
              </label>
              <input
                id="class-name"
                required
                value={className}
                onChange={(event) => setClassName(event.target.value)}
                placeholder="Algebra 2"
              />

              <label className="field-label" htmlFor="class-section">
                Section
              </label>
              <input
                id="class-section"
                required
                value={classSection}
                onChange={(event) => setClassSection(event.target.value)}
                placeholder="Period 3"
              />

              <div className="dialog-actions">
                <button
                  className="secondary-button compact"
                  disabled={isSavingClass}
                  type="button"
                  onClick={closeClassDialog}
                >
                  Cancel
                </button>
                <button className="primary-button compact" disabled={isSavingClass} type="submit">
                  {isSavingClass ? "Creating" : "Create class"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isStudentDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="add-student-title"
            aria-modal="true"
            className="modal-dialog"
            role="dialog"
            >
            <div className="modal-heading">
              <div>
                <h3 id="add-student-title">Add student</h3>
              </div>
              <button
                aria-label="Close add student dialog"
                className="secondary-button compact"
                disabled={isSavingStudent}
                type="button"
                onClick={closeStudentDialog}
              >
                Close
              </button>
            </div>

            <form className="student-add-form modal-form" onSubmit={submitStudent}>
              <label className="field-label" htmlFor="student-name">
                Student name
              </label>
              <input
                id="student-name"
                required
                value={studentName}
                onChange={(event) => setStudentName(event.target.value)}
                placeholder="Maya Rivera"
              />

              <label className="field-label" htmlFor="student-email">
                Student email
              </label>
              <input
                id="student-email"
                required
                type="email"
                value={studentEmail}
                onChange={(event) => setStudentEmail(event.target.value)}
                placeholder="student@example.com"
              />

              <div className="dialog-actions">
                <button
                  className="secondary-button compact"
                  disabled={isSavingStudent}
                  type="button"
                  onClick={closeStudentDialog}
                >
                  Cancel
                </button>
                <button className="primary-button compact" disabled={isSavingStudent} type="submit">
                  {isSavingStudent ? "Adding" : "Add"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isKnowledgeDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="add-knowledge-title"
            aria-modal="true"
            className="modal-dialog knowledge-modal-dialog"
            role="dialog"
            >
            <div className="modal-heading">
              <div>
                <h3 id="add-knowledge-title">Add knowledge</h3>
              </div>
              <button
                aria-label="Close add knowledge dialog"
                className="secondary-button compact"
                disabled={isSavingMaterial}
                type="button"
                onClick={closeKnowledgeDialog}
              >
                Close
              </button>
            </div>

            <form className="material-add-form modal-form" onSubmit={submitMaterial}>
              <label className="field-label" htmlFor="material-title">
                Tutor knowledge title
              </label>
              <input
                id="material-title"
                required
                value={materialTitle}
                onChange={(event) => setMaterialTitle(event.target.value)}
                placeholder="Chapter 5 notes"
              />

              <label className="field-label" htmlFor="material-kind">
                Tutor knowledge type
              </label>
              <select
                id="material-kind"
                value={materialKind}
                onChange={(event) => setMaterialKind(event.target.value as TutorKnowledgeKind)}
              >
                {tutorKnowledgeKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>

              <label className="field-label" htmlFor="material-file">
                Upload file
              </label>
              <input
                accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv"
                id="material-file"
                key={fileInputKey}
                type="file"
                onChange={(event) => handleMaterialFileChange(event.target.files?.[0] ?? null)}
              />
              <p className="field-hint">PDF, TXT, MD, or CSV only.</p>

              <label className="field-label" htmlFor="material-text">
                Paste tutor knowledge text
              </label>
              <textarea
                id="material-text"
                rows={7}
                value={materialText}
                onChange={(event) => handleMaterialTextChange(event.target.value)}
                placeholder="Paste notes, examples, assignment instructions, or textbook excerpts..."
              />
              <p className="field-hint">{materialText.length.toLocaleString()} pasted characters</p>

              {materialUploadProgress ? (
                <div
                  aria-live="polite"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={materialUploadProgress.percent}
                  className="upload-progress"
                  role="progressbar"
                >
                  <div>
                    <strong>{uploadStepLabel(materialUploadProgress.step)}</strong>
                    <span>{materialUploadProgress.percent}%</span>
                  </div>
                  <p>{materialUploadProgress.detail}</p>
                  <div className="upload-progress-track">
                    <span style={{ width: `${materialUploadProgress.percent}%` }} />
                  </div>
                  <ol className="upload-progress-steps">
                    {(["prepare", "upload", "read", "chunk", "embed", "save"] as const).map((step) => (
                      <li
                        className={uploadStepStatus(step, materialUploadProgress.step)}
                        key={step}
                      >
                        <span>{uploadStepLabel(step)}</span>
                        {step === "upload" ? (
                          <small>{materialUploadProgress.uploadPercent}%</small>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <div className="dialog-actions">
                <button
                  className="secondary-button compact"
                  disabled={isSavingMaterial}
                  type="button"
                  onClick={closeKnowledgeDialog}
                >
                  Cancel
                </button>
                <button
                  className="primary-button compact"
                  disabled={!hasTutorKnowledgeSource || isSavingMaterial}
                  type="submit"
                >
                  {isSavingMaterial ? "Saving" : "Save"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}

function SettingsToggle({
  defaultChecked,
  description,
  name,
  title
}: {
  defaultChecked: boolean;
  description: string;
  name: string;
  title: string;
}) {
  return (
    <label className="settings-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input defaultChecked={defaultChecked} name={name} type="checkbox" />
      <span className="settings-toggle-switch" aria-hidden="true" />
    </label>
  );
}

function InsightMetricCard({
  icon,
  label,
  tone,
  value
}: {
  icon: ReactNode;
  label: string;
  tone: "gold" | "neutral" | "teal";
  value: string;
}) {
  return (
    <article className={`insight-metric-card ${tone}`}>
      <span className="insight-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="insight-metric-copy">
        <strong>{value}</strong>
        <span>{label}</span>
      </span>
    </article>
  );
}

function InsightFeedbackActions({
  disabled = false,
  itemId,
  onAction
}: {
  disabled?: boolean;
  itemId: string;
  onAction: (action: TeacherInsightFeedbackAction, itemId?: string) => void;
}) {
  return (
    <div className="insight-feedback-actions" aria-label="Insight feedback actions">
      <button disabled={disabled} onClick={() => onAction("useful", itemId)} type="button">
        <ThumbUpIcon />
        Useful
      </button>
      <button disabled={disabled} onClick={() => onAction("notUseful", itemId)} type="button">
        <ThumbDownIcon />
        Not useful
      </button>
      <button disabled={disabled} onClick={() => onAction("dismiss", itemId)} type="button">
        <CloseIcon />
        Dismiss
      </button>
      <button disabled={disabled} onClick={() => onAction("markResolved", itemId)} type="button">
        <CheckCircleIcon />
        Mark resolved
      </button>
      <button
        disabled={disabled}
        onClick={() => document.getElementById("teacher-feedback-note")?.focus()}
        type="button"
      >
        <NoteIcon />
        Add note
      </button>
    </div>
  );
}

type InsightTrendTone = "up" | "down" | "new" | "recurring";

function TrendIcon({ tone }: { tone: InsightTrendTone }) {
  if (tone === "new") {
    return (
      <span className={`trend-icon ${tone}`} aria-hidden="true">
        <svg fill="none" height="18" viewBox="0 0 18 18" width="18">
          <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9 6.4v5.2M6.4 9h5.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      </span>
    );
  }

  return (
    <span className={`trend-icon ${tone}`} aria-hidden="true">
      <svg fill="none" height="18" viewBox="0 0 18 18" width="18">
        {tone === "up" ? (
          <path d="M4 12.5 12.5 4M8 4h4.5v4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        ) : tone === "down" ? (
          <path d="M4 5.5 12.5 14M8 14h4.5V9.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        ) : (
          <path d="M5.2 6.4A5 5 0 0 1 13.5 8M13.5 8V4.8M13.5 8h-3.2M12.8 11.6A5 5 0 0 1 4.5 10M4.5 10v3.2M4.5 10h3.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        )}
      </svg>
    </span>
  );
}

function InsightSparkline({ points, tone }: { points?: number[]; tone: InsightTrendTone }) {
  const pointsByTone = {
    down: "2,5 14,13 25,12 36,17 47,13 58,16 69,14 80,25 91,23 102,28 113,25 124,31",
    new: "2,27 14,28 25,23 36,22 47,17 58,20 69,11 80,18 91,12 102,15 113,3 124,7",
    recurring: "2,12 14,16 25,14 36,8 47,22 58,24 69,7 80,13 91,15 102,19 113,14 124,24",
    up: "2,23 14,21 25,17 36,10 47,15 58,13 69,4 80,15 91,10 102,12 113,10 124,11"
  };
  const polylinePoints = points?.length ? insightSparklinePoints(points) : pointsByTone[tone];

  return (
    <svg className={`insight-sparkline ${tone}`} viewBox="0 0 126 34" role="img" aria-label={`${tone} trend sparkline`}>
      <polyline points={polylinePoints} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function insightSparklinePoints(points: number[]) {
  const boundedPoints = points.slice(0, 14).map((point) => Math.max(0, Math.min(100, Number(point) || 0)));
  const maxPoint = Math.max(...boundedPoints, 1);
  const horizontalStep = boundedPoints.length > 1 ? 124 / (boundedPoints.length - 1) : 124;

  return boundedPoints
    .map((point, index) => {
      const x = 2 + index * horizontalStep;
      const y = 31 - (point / maxPoint) * 28;
      return `${Math.round(x)},${Math.round(y)}`;
    })
    .join(" ");
}

function capitalizeLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMathNotationLabel(value: string) {
  if (value === "plain") {
    return "Plain language";
  }

  if (value === "symbolic") {
    return "More symbols";
  }

  return "Balanced";
}

function KnowledgeToggle({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="knowledge-toggle-row">
      <span>{label}</span>
      <input checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-toggle-switch" aria-hidden="true" />
    </label>
  );
}

function formatMaterialMeta(material: ClassMaterial) {
  return [
    material.kind,
    material.fileName
  ].filter(Boolean).join(" / ");
}

function formatMaterialUploadDate(material: ClassMaterial) {
  return formatConversationDate(material.addedAt) || "Not recorded";
}

function formatMaterialFileType(material: ClassMaterial) {
  if (material.sourceMode === "pasted") {
    return "Pasted text";
  }

  if (material.contentType) {
    if (material.contentType === "application/pdf") {
      return "PDF";
    }

    if (material.contentType.includes("markdown")) {
      return "Markdown";
    }

    if (material.contentType.includes("csv")) {
      return "CSV";
    }

    if (material.contentType.startsWith("text/")) {
      return "Text";
    }

    return material.contentType;
  }

  const extension = material.fileName?.split(".").pop()?.trim().toUpperCase();

  return extension || "Source";
}

function formatMaterialSize(material: ClassMaterial) {
  if (typeof material.fileSize === "number" && material.fileSize > 0) {
    return formatBytes(material.fileSize);
  }

  if (typeof material.characterCount === "number" && material.characterCount > 0) {
    return `${material.characterCount.toLocaleString()} chars`;
  }

  return "Not recorded";
}

function formatMaterialChunkLocation(chunk: MaterialDetailChunk) {
  const parts = [
    chunk.pageStart ? formatChunkPageRange(chunk.pageStart, chunk.pageEnd) : "",
    chunk.problemNumbers.length ? `Problems ${chunk.problemNumbers.join(", ")}` : "",
    chunk.label
  ];

  return parts.filter(Boolean).join(" / ");
}

function formatChunkPageRange(pageStart: number, pageEnd?: number | null) {
  if (pageEnd && pageEnd !== pageStart) {
    return `Pages ${pageStart}-${pageEnd}`;
  }

  return `Page ${pageStart}`;
}

function knowledgeFilterMatchesMaterial(filter: KnowledgeFilter, material: ClassMaterial) {
  if (filter === "All") {
    return true;
  }

  if (filter === "Assignments") {
    return material.kind === "Assignment" || material.kind === "Practice Problems";
  }

  if (filter === "Textbook") {
    return material.kind === "Reading";
  }

  if (filter === "Worked Examples") {
    return material.kind === "Example";
  }

  if (filter === "Answer Keys") {
    return material.kind === "Practice Solutions";
  }

  if (filter === "Rubrics") {
    return material.kind === "Rubric";
  }

  return material.kind === "Notes";
}

function defaultKnowledgeSourceSettings(material?: ClassMaterial): KnowledgeSourceSettings {
  const isTeacherOnly = material?.kind === "Practice Solutions";

  return {
    activeForStudents: material?.activeForStudents ?? (material?.status === "ready" && !isTeacherOnly),
    citationsRequired: material?.citationsRequired ?? material?.requireCitations ?? true,
    priority: knowledgePriorityFromApi(material?.priority) ??
      (material?.kind === "Assignment" || material?.kind === "Reading" ? "Primary" : "Normal"),
    teacherOnly: material?.teacherOnly ?? isTeacherOnly
  };
}

function buildOverviewKnowledgeStats(materials: ClassMaterial[]) {
  const total = materials.length;
  const ready = materials.filter((material) => material.status === "ready").length;
  const processing = materials.filter((material) => material.status === "processing").length;
  const needsReview =
    materials.filter((material) => material.status !== "ready" && material.status !== "processing").length;
  const teacherOnly =
    materials.filter((material) => defaultKnowledgeSourceSettings(material).teacherOnly).length;
  const activeForStudents =
    materials.filter((material) => defaultKnowledgeSourceSettings(material).activeForStudents).length;

  return [
    { label: "Total uploaded", tone: "ink", value: total },
    { label: "Ready", tone: "ready", value: ready },
    { label: "Processing", tone: "processing", value: processing },
    { label: "Failed / needs review", tone: "failed", value: needsReview },
    { label: "Teacher-only", tone: "teacher-only", value: teacherOnly },
    { label: "Active for students", tone: "ready", value: activeForStudents }
  ];
}

function formatKnowledgeVisibility(settings: KnowledgeSourceSettings) {
  if (!settings.activeForStudents) {
    return "Hidden";
  }

  return settings.teacherOnly ? "Teacher-only" : "Active";
}

function knowledgeVisibilityClass(settings: KnowledgeSourceSettings) {
  if (!settings.activeForStudents) {
    return "hidden";
  }

  return settings.teacherOnly ? "teacher-only" : "active";
}

function formatKnowledgeStatus(material: ClassMaterial) {
  if (material.status === "ready") {
    return "Ready";
  }

  if (material.status === "processing") {
    return "Processing";
  }

  return "Needs review";
}

function knowledgeStatusClass(material: ClassMaterial) {
  if (material.status === "ready") {
    return "ready";
  }

  if (material.status === "processing") {
    return "processing";
  }

  return "review";
}

function formatMaterialChunkCount(material: ClassMaterial) {
  return material.chunkCount ?? "-";
}

function buildPlaceholderRetrievalResults(material: ClassMaterial | null): RetrievalTestResult[] {
  const title = material?.title ?? "Selected source";

  return [
    {
      chunkId: "placeholder-12",
      chunkLabel: "Chunk 12",
      confidence: 0.91,
      excerpt: "Run a test search to see live ranked chunks from this source.",
      materialId: material?.id ?? "",
      title: `${title} > Product Rule`
    },
    {
      chunkId: "placeholder-18",
      chunkLabel: "Chunk 18",
      confidence: 0.85,
      excerpt: "Practice problem context and surrounding instructions.",
      materialId: material?.id ?? "",
      title: `${title} > Practice Problems`
    },
    {
      chunkId: "placeholder-11",
      chunkLabel: "Chunk 11",
      confidence: 0.81,
      excerpt: "Worked example pattern likely relevant to the student question.",
      materialId: material?.id ?? "",
      title: `${title} > Worked Examples`
    }
  ];
}

function formatRetrievalConfidence(confidence: number) {
  return confidence.toFixed(2);
}

function knowledgePriorityToApi(priority: KnowledgeSourceSettings["priority"]) {
  if (priority === "Primary") {
    return "primary";
  }

  if (priority === "Low") {
    return "low";
  }

  return "normal";
}

function knowledgePriorityFromApi(priority: ClassMaterial["priority"]): KnowledgeSourceSettings["priority"] | null {
  if (priority === "primary") {
    return "Primary";
  }

  if (priority === "low") {
    return "Low";
  }

  if (priority === "normal") {
    return "Normal";
  }

  return null;
}

function formatSectionLabel(section: string) {
  const trimmedSection = section.trim();

  if (!trimmedSection) {
    return "Section";
  }

  if (/^(section|period|block)\b/i.test(trimmedSection)) {
    return trimmedSection;
  }

  return /^[0-9A-Z]$/i.test(trimmedSection) ? `Section ${trimmedSection}` : trimmedSection;
}

function formatInsightsDateLabel(date: Date) {
  return `Today · ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function getInitials(name: string, email: string) {
  const source = name.trim() || email.trim();
  const words = source
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);

  if (!words.length) {
    return "TD";
  }

  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
}

function RosterStatCard({
  label,
  tone,
  value
}: {
  label: string;
  tone?: "positive" | "warning";
  value: string;
}) {
  return (
    <article className={`roster-stat-card ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ConversationMetricCard({
  icon,
  label,
  tone,
  value
}: {
  icon: ReactNode;
  label: string;
  tone: "gold" | "neutral" | "teal";
  value: string;
}) {
  return (
    <article className={`conversation-metric-card ${tone}`}>
      <span className="conversation-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <strong>{value}</strong>
        <em>{label}</em>
      </span>
    </article>
  );
}

function OverviewMetricCard({
  icon,
  isTinted,
  label,
  value
}: {
  icon: ReactNode;
  isTinted?: boolean;
  label: string;
  value: string;
}) {
  return (
    <article className={`overview-metric-card ${isTinted ? "tinted" : ""}`}>
      <span className="overview-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="overview-metric-copy">
        <strong>{value}</strong>
        <span>{label}</span>
      </span>
    </article>
  );
}

function overviewNextActionIcon(action: TeacherClassOverview["nextActions"][number]["action"]) {
  if (action === "addStudent" || action === "openRoster" || action === "viewStudentChats") {
    return <UserIcon />;
  }

  if (action === "addKnowledge" || action === "openKnowledge" || action === "testRetrieval") {
    return <BookOpenIcon />;
  }

  if (action === "reviewConversations") {
    return <ChatIcon />;
  }

  if (action === "reviewLearningProfiles") {
    return <NoteIcon />;
  }

  if (action === "openStudentView") {
    return <ExternalLinkIcon />;
  }

  return <LightbulbIcon />;
}

function StudentLearningProfileCard({
  isSavingAction,
  canForceUpdate,
  onApprove,
  onClearDraft,
  onDisable,
  onForceSevenDays,
  onUpdateNow,
  profile,
  statusMessage
}: {
  canForceUpdate: boolean;
  isSavingAction: string;
  onApprove: () => void;
  onClearDraft: () => void;
  onDisable: () => void;
  onForceSevenDays: () => void;
  onUpdateNow: () => void;
  profile: StudentLearningProfileDocument | null;
  statusMessage: string;
}) {
  const activeProfile = profile?.activeProfile ?? null;
  const draftProfile = profile?.draftProfile ?? null;
  const [selectedProfileView, setSelectedProfileView] = useState<"active" | "draft" | null>("draft");
  const displayProfile =
    selectedProfileView === "active" && activeProfile
      ? activeProfile
      : selectedProfileView === "draft" && draftProfile
        ? draftProfile
        : null;
  const testingStrategies = displayProfile?.triedStrategies.filter(isTestingStrategy).slice(0, 4) ?? [];
  const profileChanges = activeProfile && draftProfile ? buildLearningProfileChanges(activeProfile, draftProfile) : [];

  return (
    <section className="student-detail-card learning-profile-card">
      <div className="student-detail-card-heading">
        <div>
          <h4>Learning profile</h4>
          <span className="learning-profile-status">
            {formatLearningProfileStatus(profile)}
            {profile?.lastSuccessfulUpdateAt ? ` / updated ${formatConversationDate(profile.lastSuccessfulUpdateAt)}` : ""}
          </span>
        </div>
        <div className="learning-profile-heading-actions">
          <button disabled={Boolean(isSavingAction)} type="button" onClick={onUpdateNow}>
            {isSavingAction === "update" ? "Updating" : "Update"}
          </button>
          {canForceUpdate ? (
            <button disabled={Boolean(isSavingAction)} type="button" onClick={onForceSevenDays}>
              Force 7d
            </button>
          ) : null}
        </div>
      </div>

      <div className="learning-profile-counts">
        <span>{profile?.pendingConversationCount ?? 0} pending conversations</span>
        <span>{profile?.pendingStudentMessageCount ?? 0} pending student messages</span>
      </div>
      {statusMessage ? <p className="learning-profile-status-note">{statusMessage}</p> : null}

      {profileChanges.length ? (
        <div className="learning-profile-content">
          <LearningProfileList title="Model change notes" items={draftProfile?.profileChangeNotes ?? []} />
          <LearningProfileList title="Changes in new draft" items={profileChanges} />
        </div>
      ) : null}

      {activeProfile || draftProfile ? (
        <div className="learning-profile-view-tabs" aria-label="Learning profile versions">
          <button
            aria-pressed={selectedProfileView === "active"}
            disabled={!activeProfile}
            type="button"
            onClick={() => setSelectedProfileView(selectedProfileView === "active" ? null : "active")}
          >
            Reviewed profile
          </button>
          <button
            aria-pressed={selectedProfileView === "draft"}
            disabled={!draftProfile}
            type="button"
            onClick={() => setSelectedProfileView(selectedProfileView === "draft" ? null : "draft")}
          >
            New draft
          </button>
        </div>
      ) : null}

      {displayProfile ? (
        <div className="learning-profile-content">
          {displayProfile.summary ? <p className="learning-profile-summary">{displayProfile.summary}</p> : null}
          <LearningProfileList title="Effective supports" items={displayProfile.effectiveSupports} />
          <LearningProfileList title="Less effective supports" items={displayProfile.lessEffectiveSupports} />
          <LearningProfileStrategyList strategies={testingStrategies} />
          <LearningProfileList title="Try next" items={displayProfile.strategiesToTryNext} />
          <LearningProfileList title="Notable improvements" items={displayProfile.notableImprovements} />
          <LearningProfileList title="Evidence notes" items={displayProfile.evidence.map((evidence) => evidence.note)} />
        </div>
      ) : (
        <p className="learning-profile-empty">
          {activeProfile || draftProfile ? "Select a profile version to view it." : "No reviewed learning profile yet."}
        </p>
      )}

      <div className="learning-profile-actions">
        <button disabled={!draftProfile || Boolean(isSavingAction)} type="button" onClick={onApprove}>
          {isSavingAction === "approve" ? "Approving" : "Approve"}
        </button>
        <button disabled={!activeProfile || Boolean(isSavingAction)} type="button" onClick={profile?.active ? onDisable : onApprove}>
          {profile?.active
            ? isSavingAction === "disable"
              ? "Disabling"
              : "Disable"
            : isSavingAction === "approve"
              ? "Enabling"
              : "Enable"}
        </button>
        <button disabled={!draftProfile || Boolean(isSavingAction)} type="button" onClick={onClearDraft}>
          {isSavingAction === "clearDraft" ? "Clearing" : "Clear draft"}
        </button>
      </div>
    </section>
  );
}

function LearningProfileList({ items, title }: { items: string[]; title: string }) {
  const visibleItems = items.filter(Boolean).slice(0, 4);

  if (!visibleItems.length) {
    return null;
  }

  return (
    <div className="learning-profile-list">
      <strong>{title}</strong>
      <ul>
        {visibleItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function LearningProfileStrategyList({ strategies }: { strategies: StudentLearningTriedStrategy[] }) {
  if (!strategies.length) {
    return null;
  }

  return (
    <div className="learning-profile-list">
      <strong>Strategies being tested</strong>
      <ul>
        {strategies.map((strategy) => (
          <li key={strategy.id}>
            {strategy.strategy}
            {strategy.nextAction ? ` / ${strategy.nextAction}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function isTestingStrategy(strategy: StudentLearningTriedStrategy) {
  return strategy.status === "currently_testing" || strategy.status === "try_next";
}

function buildLearningProfileChanges(
  activeProfile: StudentLearningProfileContent,
  draftProfile: StudentLearningProfileContent
) {
  return [
    ...summaryChange(activeProfile.summary, draftProfile.summary),
    ...arrayProfileChanges("effective support", activeProfile.effectiveSupports, draftProfile.effectiveSupports),
    ...arrayProfileChanges("less effective support", activeProfile.lessEffectiveSupports, draftProfile.lessEffectiveSupports),
    ...arrayProfileChanges("strategy to try", activeProfile.strategiesToTryNext, draftProfile.strategiesToTryNext),
    ...arrayProfileChanges("avoid note", activeProfile.avoid, draftProfile.avoid),
    ...arrayProfileChanges("open question", activeProfile.openQuestions, draftProfile.openQuestions),
    ...arrayProfileChanges("notable improvement", activeProfile.notableImprovements, draftProfile.notableImprovements),
    ...strategyProfileChanges(activeProfile.triedStrategies, draftProfile.triedStrategies)
  ].slice(0, 8);
}

function summaryChange(activeSummary: string, draftSummary: string) {
  if (normalizeProfileComparisonText(activeSummary) === normalizeProfileComparisonText(draftSummary)) {
    return [];
  }

  if (!activeSummary.trim() && draftSummary.trim()) {
    return ["Added summary."];
  }

  if (activeSummary.trim() && !draftSummary.trim()) {
    return ["Removed summary."];
  }

  return ["Updated summary wording."];
}

function arrayProfileChanges(label: string, activeItems: string[], draftItems: string[]) {
  const activeSet = new Set(activeItems.map(normalizeProfileComparisonText));
  const draftSet = new Set(draftItems.map(normalizeProfileComparisonText));
  const added = draftItems
    .filter((item) => item.trim() && !activeSet.has(normalizeProfileComparisonText(item)))
    .map((item) => `Added ${label}: ${item}`);
  const removed = activeItems
    .filter((item) => item.trim() && !draftSet.has(normalizeProfileComparisonText(item)))
    .map((item) => `Removed ${label}: ${item}`);

  return [...added, ...removed];
}

function strategyProfileChanges(
  activeStrategies: StudentLearningTriedStrategy[],
  draftStrategies: StudentLearningTriedStrategy[]
) {
  const activeByKey = new Map(activeStrategies.map((strategy) => [strategyComparisonKey(strategy), strategy]));
  const changes: string[] = [];

  draftStrategies.forEach((strategy) => {
    const activeStrategy = activeByKey.get(strategyComparisonKey(strategy));

    if (!activeStrategy) {
      changes.push(`Added strategy: ${strategy.strategy}`);
      return;
    }

    if (activeStrategy.status !== strategy.status) {
      changes.push(`Changed strategy status: ${strategy.strategy} (${activeStrategy.status} to ${strategy.status})`);
    }
  });

  return changes;
}

function strategyComparisonKey(strategy: StudentLearningTriedStrategy) {
  return normalizeProfileComparisonText(strategy.id || strategy.strategy);
}

function normalizeProfileComparisonText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M7 3.5v3M17 3.5v3M4.5 9h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function BookOpenIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 24 24" width="22">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H7A3 3 0 0 0 4 21.5v-16Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H7A3 3 0 0 0 4 21.5V5.5Zm4 1.5h8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 24 24" width="22">
      <path d="m9 18 6-6-6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24">
      <path
        d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M14 3.5V8h4" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function KnowledgeSourceIcon({ kind }: { kind: TutorKnowledgeKind }) {
  if (kind === "Reading") {
    return <BookOpenIcon />;
  }

  if (kind === "Practice Solutions") {
    return <KeyIcon />;
  }

  return <DocumentIcon />;
}

function KeyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 24 24" width="22">
      <path
        d="M14 10a4.5 4.5 0 1 1-1.3-3.2A4.5 4.5 0 0 1 14 10Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
      <path
        d="m13.2 13.2 7.3 7.3M17 17l1.8-1.8M19.1 19.1l1.4-1.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="m15 18-6-6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M20 6v5h-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M4 18v-5h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M18 9a7 7 0 0 0-11.6-2.6L4 8.8M20 15.2l-2.4 2.4A7 7 0 0 1 6 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
      <path
        d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M10 13.5a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M14 10.5a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 19.6l1.1-1.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M14 4h6v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="m10 14 10-10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path
        d="M20 15v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function StrugglingTopicsIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M12 3.5 21 19H3L12 3.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M12 9v4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M12 17h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}

function LowConfidenceIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M12 3v10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="m7 9 5 5 5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M5 19h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-5 4V6.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M8 9h8M8 12h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M3 6h18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M8 6V4h8v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path
        d="M19 6 18 20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20L5 6"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M19 20a7 7 0 0 0-14 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function UserGroupIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <path
        d="M16.5 19.5a4.5 4.5 0 0 0-9 0M12 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M19 18.5a3.3 3.3 0 0 0-2.9-3.2M16.2 6.2a2.7 2.7 0 0 1 0 5.1M5 18.5a3.3 3.3 0 0 1 2.9-3.2M7.8 6.2a2.7 2.7 0 0 0 0 5.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function TrendLineIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <path d="M4 18 9 12.5l4 3.5 7-9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M15 7h5v5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M4 21h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
    </svg>
  );
}

function ThumbUpIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M7.5 21H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.5M7.5 21V9.5l4.2-6.4A1.6 1.6 0 0 1 14.6 4v5h4.1a2.3 2.3 0 0 1 2.2 2.9l-1.7 6.6A3.3 3.3 0 0 1 16 21H7.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ThumbDownIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M16.5 3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2.5M16.5 3v11.5l-4.2 6.4A1.6 1.6 0 0 1 9.4 20v-5H5.3a2.3 2.3 0 0 1-2.2-2.9l1.7-6.6A3.3 3.3 0 0 1 8 3h8.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="m8 12 2.6 2.6L16.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M5 4.5h14v10.8L14.8 19.5H5v-15Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M14.5 19.5v-4.2H19M8 9h8M8 12.5h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M9 18h6M9.8 21h4.4M8.2 14.2a6 6 0 1 1 7.6 0c-.9.7-1.4 1.7-1.4 2.8H9.6c0-1.1-.5-2.1-1.4-2.8Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function buildStudentActivityByEmail(activity: StudentRosterActivitySummary[]) {
  return new Map(
    activity
      .filter((studentActivity) => studentActivity.studentEmail.trim())
      .map((studentActivity) => [studentActivity.studentEmail.trim().toLowerCase(), studentActivity])
  );
}

function buildConversationReviewRows(
  classConversations: TeacherConversationReviewSummary[],
  activeClassId: string
): ConversationReviewRow[] {
  return classConversations
    .filter((conversation) => conversation.classId === activeClassId)
    .map((conversation) => ({
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      lastMessageLabel: formatConversationDate(conversation.lastMessageAt) || "No messages",
      messageCount: conversation.messageCount,
      modelId: conversation.modelId,
      review: conversation.review,
      sourceAudit: conversation.sourceAudit,
      status: conversation.reviewStatus,
      latestRetrievalConfidence: conversation.latestRetrievalConfidence,
      studentEmail: conversation.studentEmail.trim().toLowerCase(),
      studentId: conversation.studentId,
      studentName: conversation.studentName || "Student",
      title: conversation.title || "Untitled conversation",
      topic: conversation.topic
    }))
    .sort(
      (first, second) =>
        (coerceDate(second.lastMessageAt)?.getTime() ?? 0) - (coerceDate(first.lastMessageAt)?.getTime() ?? 0)
    );
}

function filterConversationReviewRows({
  evidenceConversationIds,
  filter,
  query,
  rows,
  studentEmail,
  topic
}: {
  evidenceConversationIds: string[];
  filter: ConversationFilter;
  query: string;
  rows: ConversationReviewRow[];
  studentEmail: string;
  topic: string;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const evidenceConversationIdSet = new Set(evidenceConversationIds);

  return rows.filter((row) => {
    if (evidenceConversationIdSet.size && !evidenceConversationIdSet.has(row.id)) {
      return false;
    }

    if (studentEmail !== "all" && row.studentEmail !== studentEmail) {
      return false;
    }

    if (topic !== "all" && row.topic !== topic) {
      return false;
    }

    if (
      normalizedQuery &&
      ![row.studentName, row.title, row.topic, formatConversationStatus(row.status)].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      )
    ) {
      return false;
    }

    if (filter === "unreviewed" || filter === "noTeacherReview") {
      return row.status === "new";
    }

    if (filter === "activeToday") {
      return isToday(row.lastMessageAt);
    }

    if (filter === "highMessageCount") {
      return row.messageCount >= 8;
    }

    if (filter === "offTopic") {
      return row.topic.toLowerCase().includes("off-topic");
    }

    if (filter === "lowConfidence") {
      return row.sourceAudit.lowSourceConfidence;
    }

    return true;
  });
}

function buildConversationMetrics(rows: ConversationReviewRow[], rosterRows: RosterRow[]) {
  const total = rows.length || rosterRows.reduce((sum, row) => sum + row.conversationsCount, 0);

  return {
    followUp: rows.filter((row) => row.status === "needs_follow_up").length,
    lowConfidence: rows.filter((row) => row.sourceAudit.lowSourceConfidence).length,
    total,
    unreviewed: rows.filter((row) => row.status === "new").length
  };
}

function buildConversationSourceRows(
  sourceAudit: TeacherConversationSourceAuditSummary | undefined,
  messages: ChatMessage[],
  materials: ClassMaterial[]
) {
  const sourceRows = new Map<
    string,
    {
      citationCount: number;
      confidence: string;
      confidenceClass: "high" | "low";
      detail: string;
      materialType: string;
      pages: Set<string>;
      title: string;
    }
  >();

  if (sourceAudit) {
    const confidenceClass = sourceAudit.lowSourceConfidence ? "low" : "high";

    for (const source of sourceAudit.sources) {
      addConversationSourceRow(sourceRows, {
        confidence: confidenceClass === "high" ? "High confidence" : "Low confidence",
        confidenceClass,
        materialType: source.materialType,
        source
      });
    }

    return finalizeConversationSourceRows(sourceRows);
  }

  for (const message of messages) {
    for (const source of message.sources ?? []) {
      const material = materials.find((currentMaterial) => currentMaterial.title === source.title);
      const confidenceClass = material?.status === "ready" || source.pageNumber || source.problemNumber ? "high" : "low";
      addConversationSourceRow(sourceRows, {
        confidence: confidenceClass === "high" ? "High confidence" : "Low confidence",
        confidenceClass,
        materialType: source.materialType,
        source
      });
    }
  }

  return finalizeConversationSourceRows(sourceRows);
}

function addConversationSourceRow(
  sourceRows: Map<
    string,
    {
      citationCount: number;
      confidence: string;
      confidenceClass: "high" | "low";
      detail: string;
      materialType: string;
      pages: Set<string>;
      title: string;
    }
  >,
  {
    confidence,
    confidenceClass,
    materialType,
    source
  }: {
    confidence: string;
    confidenceClass: "high" | "low";
    materialType: string;
    source: NonNullable<ChatMessage["sources"]>[number];
  }
) {
  const title = source.title || "Class material";
  const sourceKey = `${title}-${materialType || "class-material"}`.toLowerCase();
  const pageLabel = [source.pageNumber ? `p. ${source.pageNumber}` : "", source.problemNumber ? `Problem ${source.problemNumber}` : ""]
    .filter(Boolean)
    .join(" / ");
  const existingRow = sourceRows.get(sourceKey);

  if (existingRow) {
    existingRow.citationCount += 1;
    if (pageLabel) {
      existingRow.pages.add(pageLabel);
    }
    if (confidenceClass === "low") {
      existingRow.confidence = confidence;
      existingRow.confidenceClass = confidenceClass;
    }
    return;
  }

  sourceRows.set(sourceKey, {
    citationCount: 1,
    confidence,
    confidenceClass,
    detail: "",
    materialType: materialType || "Class material",
    pages: new Set(pageLabel ? [pageLabel] : []),
    title
  });
}

function finalizeConversationSourceRows(
  sourceRows: Map<
    string,
    {
      citationCount: number;
      confidence: string;
      confidenceClass: "high" | "low";
      detail: string;
      materialType: string;
      pages: Set<string>;
      title: string;
    }
  >
): ConversationSourceRow[] {
  return Array.from(sourceRows.values()).map((sourceRow) => {
    const pages = Array.from(sourceRow.pages);

    return {
      ...sourceRow,
      detail: pages.length ? pages.join(", ") : sourceRow.materialType,
      pages
    };
  });
}

function formatReferencedMaterials(sourceRows: ConversationSourceRow[]) {
  if (!sourceRows.length) {
    return "No class material cited yet.";
  }

  return sourceRows
    .slice(0, 3)
    .map((source) => source.title)
    .join(", ");
}

function buildStudentTimelineBars(row: RosterRow | null, conversations: ConversationReviewRow[]) {
  const today = startOfLocalDay(new Date());
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    return date;
  });
  const countsByDate = new Map(days.map((date) => [dateKeyFromDate(date), 0]));

  if (row) {
    const studentConversations = conversations.filter(
      (conversation) =>
        conversation.studentId === row.student.id ||
        conversation.studentEmail.trim().toLowerCase() === row.studentEmail.trim().toLowerCase()
    );

    for (const conversation of studentConversations) {
      const date = coerceDate(conversation.lastMessageAt);

      if (!date) {
        continue;
      }

      const dateKey = dateKeyFromDate(date);

      if (!countsByDate.has(dateKey)) {
        continue;
      }

      countsByDate.set(dateKey, (countsByDate.get(dateKey) ?? 0) + Math.max(1, Math.ceil(conversation.messageCount / 2)));
    }

    const todayKey = dateKeyFromDate(today);
    if ((countsByDate.get(todayKey) ?? 0) === 0 && row.questionsToday > 0) {
      countsByDate.set(todayKey, row.questionsToday);
    }
  }

  const maxCount = Math.max(1, ...Array.from(countsByDate.values()));

  return days.map((date, index) => {
    const dateKey = dateKeyFromDate(date);
    const count = countsByDate.get(dateKey) ?? 0;

    return {
      count,
      dateKey,
      fullLabel: formatTimelineFullDate(date),
      height: count ? Math.max(16, Math.round((count / maxCount) * 92)) : 4,
      label: index % 2 === 0 || index === days.length - 1 ? formatTimelineDate(date) : ""
    };
  });
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateKeyFromDate(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatTimelineDate(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimelineFullDate(date: Date) {
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function conversationStatusClass(status: ConversationReviewStatus) {
  if (status === "needs_follow_up" || status === "misunderstanding_spotted") {
    return "follow-up";
  }

  if (status === "reviewed" || status === "good_learning_moment") {
    return "reviewed";
  }

  if (status === "ai_answer_needs_review") {
    return "ai-review";
  }

  return "new";
}

function formatConversationStatus(status: ConversationReviewStatus) {
  switch (status) {
    case "reviewed":
      return "Reviewed";
    case "needs_follow_up":
      return "Needs follow-up";
    case "misunderstanding_spotted":
      return "Misunderstanding spotted";
    case "good_learning_moment":
      return "Good learning moment";
    case "ai_answer_needs_review":
      return "AI answer review";
    case "new":
    default:
      return "New";
  }
}

function formatRetrievalConfidenceLabel(confidence: TeacherConversationReviewSummary["latestRetrievalConfidence"]) {
  if (!confidence) {
    return "Retrieval confidence: pending";
  }

  return `Retrieval confidence: ${confidence}`;
}

function formatConversationMainQuestion(messages: ChatMessage[], row: ConversationReviewRow | null) {
  const studentMessage = messages.find((message) => message.role === "student");

  return trimSummary(studentMessage?.content || row?.title || "No student question recorded.");
}

function formatAssistantHelpSummary(messages: ChatMessage[], row: ConversationReviewRow | null) {
  const assistantMessage = messages.find((message) => message.role === "assistant");

  if (assistantMessage) {
    return trimSummary(assistantMessage.content);
  }

  return row ? `Support around ${row.topic.toLowerCase()}` : "No assistant response recorded.";
}

function formatUnresolvedConfusion(row: ConversationReviewRow | null) {
  if (!row) {
    return "No conversation selected";
  }

  if (row.status === "needs_follow_up" || row.status === "misunderstanding_spotted") {
    return "May need another setup step";
  }

  if (row.status === "ai_answer_needs_review" || row.sourceAudit.lowSourceConfidence) {
    return "Review answer and source fit";
  }

  return "None flagged";
}

function formatSuggestedFollowUp(row: ConversationReviewRow | null) {
  if (!row) {
    return "Select a conversation";
  }

  if (row.status === "reviewed" || row.status === "good_learning_moment") {
    return "No immediate follow-up";
  }

  return "Check problem interpretation tomorrow";
}

function trimSummary(value: string) {
  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length <= 74) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, 71)}...`;
}

function isToday(value: unknown) {
  const date = coerceDate(value);

  if (!date) {
    return false;
  }

  const today = new Date();
  return date.toDateString() === today.toDateString();
}

function buildRosterRows({
  studentActivityByEmail,
  students
}: {
  studentActivityByEmail: Map<string, StudentRosterActivitySummary>;
  students: ClassStudent[];
}): RosterRow[] {
  return students.map((student) => {
    const normalizedEmail = student.email.trim().toLowerCase();
    const activity = studentActivityByEmail.get(normalizedEmail);
    const questionsPerDay = activity?.questionsPerDay ?? 0;
    const conversationsCount = activity?.conversationCount ?? 0;
    const status = activityStatusLabel(activity?.status ?? "no_activity");
    const recentConversations =
      activity?.recentConversations.map((conversation) => ({
        id: conversation.id,
        lastMessageAt: conversation.lastMessageAt,
        messageCount: conversation.messageCount,
        meta: formatConversationDate(conversation.lastMessageAt),
        title: conversation.title
      })) ?? [];

    return {
      activeToday: status === "Active",
      conversationsCount,
      conversationsLabel: formatConversationCount(conversationsCount),
      hasConversations: conversationsCount > 0,
      highQuestions: questionsPerDay >= 3,
      lastActive: formatLastActive(activity?.lastActiveAt),
      lastChatTopic: activity?.lastChatTopic || "No saved topic",
      questionsLabel: `${formatStatNumber(questionsPerDay)}/day`,
      questionsPerDay,
      questionsToday: activity?.questionsToday ?? 0,
      recentConversations,
      status,
      statusTone: status === "Active" ? "active" : status === "Inactive" ? "inactive" : "none",
      student,
      studentEmail: activity?.studentEmail ?? normalizedEmail,
      teacherNotes: activity?.teacherNotes ?? "",
      totalQuestions: activity?.totalQuestions ?? 0
    };
  });
}

function filterRosterRows(rows: RosterRow[], query: string, filter: RosterFilter) {
  const normalizedQuery = query.trim().toLowerCase();

  return rows.filter((row) => {
    const matchesQuery =
      !normalizedQuery ||
      row.student.displayName.toLowerCase().includes(normalizedQuery) ||
      row.student.email.toLowerCase().includes(normalizedQuery);

    if (!matchesQuery) {
      return false;
    }

    if (filter === "active") {
      return row.activeToday;
    }

    if (filter === "inactive") {
      return !row.activeToday;
    }

    if (filter === "highQuestions") {
      return row.highQuestions;
    }

    if (filter === "noConversations") {
      return !row.hasConversations;
    }

    return true;
  });
}

function buildRosterStats(rows: RosterRow[]) {
  const totalQuestions = rows.reduce((sum, row) => sum + row.questionsPerDay, 0);

  return {
    activeToday: rows.filter((row) => row.activeToday).length,
    averageQuestions: rows.length ? totalQuestions / rows.length : 0,
    noActivity: rows.filter((row) => row.status === "No activity").length,
    totalStudents: rows.length
  };
}

function formatStatNumber(value: number) {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: value % 1 ? 1 : 0
  });
}

function formatConversationCount(count: number) {
  return `${count} ${count === 1 ? "conversation" : "conversations"}`;
}

function formatQuestionCount(count: number) {
  return `${count} ${count === 1 ? "question" : "questions"}`;
}

function buildRecentConversationPreviews(row: RosterRow): RosterConversationPreview[] {
  if (row.recentConversations.length) {
    return row.recentConversations;
  }

  return [{ id: "empty", lastMessageAt: "", messageCount: 0, title: "No recent conversations", meta: "" }];
}

function formatLastActive(value: unknown) {
  return formatConversationDate(value) || "Never";
}

function activityStatusLabel(status: StudentRosterActivitySummary["status"]): RosterRow["status"] {
  if (status === "active") {
    return "Active";
  }

  if (status === "inactive") {
    return "Inactive";
  }

  return "No activity";
}

function formatConversationMeta(conversation: StudentConversationSummary) {
  return [
    `${conversation.messageCount} messages`,
    formatConversationDate(conversation.lastMessageAt)
  ].filter(Boolean).join(" / ");
}

function formatLearningProfileStatus(profile: StudentLearningProfileDocument | null) {
  if (!profile) {
    return "No profile";
  }

  if (!profile.active) {
    return profile.draftProfile ? "Draft awaiting review" : "Disabled";
  }

  if (!profile.teacherReviewed) {
    return "Draft awaiting review";
  }

  return `Active / ${profile.confidence} confidence`;
}

function formatLearningProfileUpdateResult(result: { reason?: string } | undefined, forced: boolean) {
  if (result?.reason === "updated") {
    return forced ? "Created a new draft from the past 7 days." : "Created a new draft for teacher review.";
  }

  if (result?.reason === "below_threshold") {
    return "Not enough new data yet. Use Force 7d to draft from the past 7 days.";
  }

  if (result?.reason === "no_recent_data") {
    return "No conversations or student messages found in the past 7 days.";
  }

  if (result?.reason === "model_unavailable") {
    return "The model update was unavailable. Check OPENROUTER_API_KEY.";
  }

  return "";
}

function formatConversationDate(value: unknown) {
  const date = coerceDate(value);

  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatInsightDateOnly(value: unknown) {
  const date = coerceDate(value);

  if (!date) {
    return String(value ?? "").trim();
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(date);
}

function coerceDate(value: unknown) {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate() as Date;
  }

  return null;
}

function formatSourceLabel(source: NonNullable<ChatMessage["sources"]>[number]) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ].filter(Boolean).join(" / ");
}

function formatClassError(caughtError: unknown, fallback: string) {
  const message = caughtError instanceof Error ? caughtError.message : fallback;

  if (message.toLowerCase().includes("permission")) {
    return `${message} Update your Firestore rules to allow the classes collection.`;
  }

  return message;
}

function formatConversationError(caughtError: unknown, fallback: string) {
  return caughtError instanceof Error ? caughtError.message : fallback;
}

function createMaterialJobId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function materialJobToUploadProgress(progress: MaterialJobProgress): MaterialUploadProgress {
  return {
    detail: progress.detail,
    percent: progress.percent,
    step: materialJobStepToUploadStep(progress.step),
    uploadPercent: 100
  };
}

function materialJobStepToUploadStep(step: MaterialJobProgress["step"]): MaterialUploadProgress["step"] {
  if (step === "upload_received" || step === "reading_file") {
    return "read";
  }

  if (step === "chunking_material") {
    return "chunk";
  }

  if (step === "embedding_chunks") {
    return "embed";
  }

  if (step === "saving_to_class" || step === "failed") {
    return "save";
  }

  return "complete";
}

function postTutorKnowledgeForm<TResponse = { error?: string }>({
  completionDetail = "Tutor knowledge is saved and ready for students in this class.",
  formData,
  label,
  onProgress,
  token,
  useBackendProgress = false,
  url
}: {
  completionDetail?: string;
  formData: FormData;
  label: string;
  onProgress: (progress: MaterialUploadProgress | null) => void;
  token: string;
  useBackendProgress?: boolean;
  url: string;
}) {
  return new Promise<TResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let processingPercent = 68;
    let processingTimer: number | undefined;
    const stopProcessingTimer = () => {
      if (processingTimer) {
        window.clearInterval(processingTimer);
      }
    };

    onProgress({
      detail: "Preparing the upload request.",
      percent: 2,
      step: "prepare",
      uploadPercent: 0
    });

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      const uploadPercent = Math.min(100, Math.round((event.loaded / event.total) * 100));

      onProgress({
        detail: `${label}: ${formatBytes(event.loaded)} of ${formatBytes(event.total)} sent.`,
        percent: useBackendProgress
          ? Math.min(12, 2 + Math.round(uploadPercent * 0.1))
          : Math.min(67, 8 + Math.round(uploadPercent * 0.58)),
        step: "upload",
        uploadPercent
      });
    };

    request.upload.onload = () => {
      onProgress({
        detail: useBackendProgress
          ? "Upload complete. Waiting for Chandra to report server-side progress."
          : "Upload complete. Reading the file so Chandra can prepare it for this class.",
        percent: useBackendProgress ? 12 : processingPercent,
        step: useBackendProgress ? "upload" : "read",
        uploadPercent: 100
      });
      if (useBackendProgress) {
        return;
      }

      processingTimer = window.setInterval(() => {
        processingPercent = Math.min(94, processingPercent + (processingPercent < 84 ? 4 : 2));
        const processingStep = progressStepFromPercent(processingPercent);
        onProgress({
          detail: uploadStepDetail(processingStep),
          percent: processingPercent,
          step: processingStep,
          uploadPercent: 100
        });
      }, 900);
    };

    request.onerror = () => {
      stopProcessingTimer();
      reject(new Error("Network error while uploading tutor knowledge."));
    };
    request.onabort = () => {
      stopProcessingTimer();
      reject(new Error("Tutor knowledge upload was canceled."));
    };
    request.onload = () => {
      stopProcessingTimer();
      const data = parseJsonResponse(request.responseText);

      if (request.status < 200 || request.status >= 300) {
        reject(new Error(readResponseError(data) ?? "Tutor knowledge upload failed."));
        return;
      }

      onProgress({
        detail: completionDetail,
        percent: 100,
        step: "complete",
        uploadPercent: 100
      });
      resolve(data as TResponse);
    };

    request.open("POST", url);
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.send(formData);
  });
}

function parseJsonResponse(responseText: string) {
  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return {};
  }
}

function readResponseError(data: unknown) {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error;
  }

  return undefined;
}

function uploadStepLabel(step: MaterialUploadProgress["step"]) {
  if (step === "prepare") {
    return "Preparing";
  }

  if (step === "upload") {
    return "Upload file";
  }

  if (step === "read") {
    return "Read file";
  }

  if (step === "chunk") {
    return "Build tutor chunks";
  }

  if (step === "embed") {
    return "Gemini embeddings";
  }

  if (step === "save") {
    return "Save to class";
  }

  return "Complete";
}

function uploadStepStatus(
  step: Exclude<MaterialUploadProgress["step"], "complete">,
  currentStep: MaterialUploadProgress["step"]
) {
  const stepOrder: MaterialUploadProgress["step"][] = [
    "prepare",
    "upload",
    "read",
    "chunk",
    "embed",
    "save",
    "complete"
  ];
  const stepIndex = stepOrder.indexOf(step);
  const currentStepIndex = stepOrder.indexOf(currentStep);

  if (stepIndex < currentStepIndex || currentStep === "complete") {
    return "done";
  }

  if (stepIndex === currentStepIndex) {
    return "active";
  }

  return "";
}

function progressStepFromPercent(percent: number): MaterialUploadProgress["step"] {
  if (percent < 76) {
    return "read";
  }

  if (percent < 84) {
    return "chunk";
  }

  if (percent < 92) {
    return "embed";
  }

  return "save";
}

function uploadStepDetail(step: MaterialUploadProgress["step"]) {
  if (step === "read") {
    return "Reading the PDF/text and extracting usable class material.";
  }

  if (step === "chunk") {
    return "Splitting the material into focused tutor knowledge chunks.";
  }

  if (step === "embed") {
    return "Calling the Gemini embedding API so students can search this source semantically.";
  }

  if (step === "save") {
    return "Saving metadata, vectors, and source details to this professor's class.";
  }

  return "Working on the tutor knowledge upload.";
}

function validateTutorKnowledgeFile(file: File) {
  const normalizedName = file.name.toLowerCase();
  const supportedExtension = supportedTutorKnowledgeExtensions.some((extension) =>
    normalizedName.endsWith(extension)
  );

  if (!supportedExtension) {
    throw new Error("Only PDF, TXT, MD, and CSV files are supported.");
  }
}
