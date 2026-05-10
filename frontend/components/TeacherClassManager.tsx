"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { FormEvent, memo, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { apiUrl } from "@/lib/api-client";
import { deleteCurrentAccount, signOutAllSessions, signOutCurrentUser, updateUserAccountSettings, updateUserThemePreference } from "@/lib/auth";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  teacherClassThemeColorOptions
} from "@/lib/class-theme";
import {
  defaultRefusalStyle,
  mathNotationOptions,
  normalizeAnswerPolicySettings,
  normalizeClassCoTeachers,
  normalizeClassModelSettings,
  normalizeNotificationSettings,
  normalizeOpeningMessage,
  normalizePrivacySettings,
  normalizeResponseFormatSettings,
  normalizeSourceDefaultsSettings,
  normalizeSourceUsageSettings,
  normalizeStudentFacingInstructions,
  normalizeTutorAccessSettings,
  normalizeTutorBehavior,
  conversationRetentionOptions,
  materialSourceTypeKeys,
  materialSourceTypePreferenceOptions,
  preferredSourceTypeOptions,
  readingLevelOptions,
  reasoningEffortOptions,
  responseLengthOptions,
  tutorBehaviorOptions,
  type AnswerPolicySettings,
  type ClassAccessRole,
  type ClassCoTeacher,
  type AiTokenLimitSettings,
  type AiRequestLimitSettings,
  type ClassPrivacySettings,
  type NotificationSettings,
  type ResponseFormatSettings,
  type SourceDefaultsSettings,
  type SourceUsageSettings,
  type TutorAccessSettings
} from "@/lib/class-settings";
import {
  assistantMessageAnswerContent,
  assistantStructuredSections,
  condensedSourceLabels,
  normalizeMarkdownMath,
  normalizeStructuredSectionMarkdown
} from "@/lib/chat-message-format";
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
import { capitalizeLabel, coerceDate, formatConversationDate } from "@/lib/display-format";
import { storage } from "@/lib/firebase";
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
  StudentFeedback,
  StudentFeedbackStatus,
  StudentFeedbackSummary,
  StudentLearningProfileDocument,
  StudentRosterActivitySummary,
  TeacherClassOverview,
  TeacherConversationReviewSummary,
  TeacherConversationSourceAuditSummary,
  TeacherOverviewStatusTone
} from "@/lib/types";
import { useAuth } from "./AuthProvider";
import { TeacherAnalyticsDashboardContent } from "./TeacherAnalyticsDashboard";
import { formatLearningProfileUpdateResult, StudentLearningProfileCard } from "./StudentLearningProfileCard";
import { StudentProfilePage } from "./StudentProfilePage";

type MaterialUploadProgress = {
  detail: string;
  percent: number;
  step: "prepare" | "upload" | "read" | "chunk" | "embed" | "save" | "complete";
  uploadPercent: number;
};

type TeacherTab = "overview" | "roster" | "settings" | "knowledge" | "conversations";
type SettingsPane =
  | "general"
  | "classAccess"
  | "privacy"
  | "sourceDefaults"
  | "notifications"
  | "guidance"
  | "answerPolicy"
  | "model"
  | "response"
  | "sources"
  | "invites"
  | "account"
  | "appearance";
type AiTutorSection = "sources" | "access" | "behavior" | "answerPolicy" | "response" | "model";
type KnowledgeFilter = "All" | "Assignments" | "Textbook" | "Notes" | "Worked Examples" | "Rubrics" | "Answer Keys";
type RosterFilter = "all" | "active" | "inactive" | "highQuestions" | "noConversations";
type RosterDetailFocus = "activity" | "notes";
type ConversationFilter =
  | "all"
  | "unreviewed"
  | "activeToday"
  | "highMessageCount"
  | "noTeacherReview"
  | "needsFollowUp"
  | "offTopic"
  | "lowConfidence"
  | "feedback"
  | "reviewed";
type RosterConversationPreview = {
  id: string;
  lastMessageAt: unknown;
  messageCount: number;
  meta: string;
  title: string;
};
type ConversationReviewRow = {
  feedback: StudentFeedback[];
  feedbackSummary: StudentFeedbackSummary;
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
  chatBlocked: boolean;
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

type TeacherInviteStatus = "active" | "expired" | "revoked" | "used";
type TeacherInviteFilter = "all" | TeacherInviteStatus;

type TeacherInviteSummary = {
  createdAt: string;
  expiresAt: string;
  inviteId: string;
  inviteUrl: string;
  revokedAt: string;
  status: TeacherInviteStatus;
  usedAt: string;
  usedByEmail: string;
  usedByUid: string;
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

type TeacherPrimaryNavItem = {
  href?: string;
  icon: ReactNode;
  id: TeacherTab | "studentView";
  label: string;
};

const settingsPanes: Array<{
  description: string;
  icon: ReactNode;
  id: SettingsPane;
  label: string;
}> = [
  {
    description: "Name, section, opening copy",
    icon: <BookOpenIcon />,
    id: "general",
    label: "General"
  },
  {
    description: "Invite codes and co-teachers",
    icon: <UserGroupIcon />,
    id: "classAccess",
    label: "Class Access"
  },
  {
    description: "Retention, export, deletion",
    icon: <ShieldIcon />,
    id: "privacy",
    label: "Privacy & Data"
  },
  {
    description: "New material defaults",
    icon: <DocumentIcon />,
    id: "sourceDefaults",
    label: "Source Defaults"
  },
  {
    description: "Saved notification preferences",
    icon: <BellIcon />,
    id: "notifications",
    label: "Notifications"
  },
  {
    description: "Teacher invite links",
    icon: <LinkIcon />,
    id: "invites",
    label: "Teacher Invites"
  },
  {
    description: "Name and login",
    icon: <UserIcon />,
    id: "account",
    label: "Account"
  },
  {
    description: "Theme and display",
    icon: <EyeIcon />,
    id: "appearance",
    label: "Appearance"
  }
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

const aiTutorSections: Array<{
  icon: ReactNode;
  id: AiTutorSection;
  label: string;
}> = [
  { icon: <DocumentIcon />, id: "sources", label: "Sources" },
  { icon: <ShieldIcon />, id: "access", label: "Access" },
  { icon: <ChatIcon />, id: "behavior", label: "Behavior" },
  { icon: <CheckCircleIcon />, id: "answerPolicy", label: "Answer Policy" },
  { icon: <NoteIcon />, id: "response", label: "Response" },
  { icon: <SettingsIcon />, id: "model", label: "Model" }
];

const defaultAiTutorHiddenInstructions = [
  "Ask students to explain their thinking before giving hints.",
  "Do not provide final answers unless the student has already shown the main reasoning.",
  "Use course materials before generic explanations when relevant."
].join("\n");

const defaultDirectAnswerRedirect =
  "If a student asks for a direct answer, redirect them toward the next useful step and ask a checking question.";

const fallbackKnowledgeSourceSettings: KnowledgeSourceSettings = {
  activeForStudents: true,
  citationsRequired: true,
  priority: "Primary",
  teacherOnly: false
};

const conversationReviewActions: Array<{ label: string; status: ConversationReviewStatus }> = [
  { label: "Reviewed", status: "reviewed" },
  { label: "Needs follow-up", status: "needs_follow_up" },
  { label: "Misunderstanding spotted", status: "misunderstanding_spotted" },
  { label: "Good learning moment", status: "good_learning_moment" },
  { label: "AI answer needs review", status: "ai_answer_needs_review" }
];

const markdownRemarkPlugins = [remarkMath];
const markdownRehypePlugins = [rehypeKatex];

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
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDateFormatter = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });
const overviewDateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const knowledgeFilterKinds: Record<Exclude<KnowledgeFilter, "All">, TutorKnowledgeKind[]> = {
  Assignments: ["Assignment", "Practice Problems"],
  "Answer Keys": ["Practice Solutions"],
  Notes: ["Notes"],
  Rubrics: ["Rubric"],
  Textbook: ["Reading"],
  "Worked Examples": ["Example"]
};
const knowledgePriorityApiValues: Record<KnowledgeSourceSettings["priority"], NonNullable<ClassMaterial["priority"]>> = {
  Low: "low",
  Normal: "normal",
  Primary: "primary"
};
const apiKnowledgePriorityValues: Record<NonNullable<ClassMaterial["priority"]>, KnowledgeSourceSettings["priority"]> = {
  low: "Low",
  normal: "Normal",
  primary: "Primary"
};
const knowledgeStatusLabels: Record<ClassMaterial["status"], string> = {
  processing: "Processing",
  ready: "Ready",
  uploaded: "Needs review"
};
const knowledgeStatusClasses: Record<ClassMaterial["status"], string> = {
  processing: "processing",
  ready: "ready",
  uploaded: "review"
};
const conversationReviewRequiredStatuses = new Set<ConversationReviewStatus>([
  "ai_answer_needs_review",
  "misunderstanding_spotted",
  "needs_follow_up",
  "new"
]);
const reviewedConversationStatuses = new Set<ConversationReviewStatus>(["good_learning_moment", "reviewed"]);
const conversationStatusClasses: Record<ConversationReviewStatus, string> = {
  ai_answer_needs_review: "ai-review",
  good_learning_moment: "reviewed",
  misunderstanding_spotted: "follow-up",
  needs_follow_up: "follow-up",
  new: "new",
  reviewed: "reviewed"
};
const conversationStatusLabels: Record<ConversationReviewStatus, string> = {
  ai_answer_needs_review: "AI answer review",
  good_learning_moment: "Good learning moment",
  misunderstanding_spotted: "Misunderstanding spotted",
  needs_follow_up: "Needs follow-up",
  new: "New",
  reviewed: "Reviewed"
};
const teacherInviteFilterOptions: Array<{ id: TeacherInviteFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "used", label: "Used" },
  { id: "expired", label: "Expired" },
  { id: "revoked", label: "Revoked" }
];
const teacherInviteEmptyMessages: Record<TeacherInviteFilter, string> = {
  active: "No active invite links.",
  all: "No teacher invites yet.",
  expired: "No expired invites.",
  revoked: "No revoked invites.",
  used: "No used invites yet."
};

export function TeacherClassManager({
  studentProfileRoute
}: {
  studentProfileRoute?: {
    classId: string;
    studentId: string;
  };
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [settingsCreativityPreview, setSettingsCreativityPreview] = useState<{
    classId: string;
    value: number;
  } | null>(null);
  const [className, setClassName] = useState("");
  const [classSection, setClassSection] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [studentName, setStudentName] = useState("");
  const [accountDisplayName, setAccountDisplayName] = useState<string | null>(null);
  const [accountEmailDraft, setAccountEmailDraft] = useState<string | null>(null);
  const [accountUsername, setAccountUsername] = useState<string | null>(null);
  const [currentAccountPassword, setCurrentAccountPassword] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [confirmAccountPassword, setConfirmAccountPassword] = useState("");
  const [accountSettingsMessage, setAccountSettingsMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TeacherTab>("overview");
  const [activeSettingsPane, setActiveSettingsPane] = useState<SettingsPane>("general");
  const [coTeacherEmail, setCoTeacherEmail] = useState("");
  const [coTeacherRole, setCoTeacherRole] = useState<Exclude<ClassAccessRole, "owner">>("co-teacher");
  const [classAccessMessage, setClassAccessMessage] = useState("");
  const [savingClassAccessAction, setSavingClassAccessAction] = useState("");
  const [privacyDataMessage, setPrivacyDataMessage] = useState("");
  const [privacyStudentSearchQuery, setPrivacyStudentSearchQuery] = useState("");
  const [selectedPrivacyStudentId, setSelectedPrivacyStudentId] = useState("");
  const [savingPrivacyDataAction, setSavingPrivacyDataAction] = useState("");
  const [activeAiTutorSection, setActiveAiTutorSection] = useState<AiTutorSection>("sources");
  const [isSidebarDrawerOpen, setIsSidebarDrawerOpen] = useState(false);
  const [isClassSwitcherOpen, setIsClassSwitcherOpen] = useState(false);
  const [isSecondarySidebarOpen, setIsSecondarySidebarOpen] = useState(false);
  const [aiTutorResponseLengthPreview, setAiTutorResponseLengthPreview] = useState<{
    classId: string;
    value: string;
  } | null>(null);
  const [rosterSearchQuery, setRosterSearchQuery] = useState("");
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>("all");
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationStudentFilter, setConversationStudentFilter] = useState("all");
  const [conversationTopicFilter, setConversationTopicFilter] = useState("all");
  const [checkedStudentIds, setCheckedStudentIds] = useState<string[]>([]);
  const [chatBlockedByStudentId, setChatBlockedByStudentId] = useState<Record<string, boolean>>({});
  const [isRosterDetailOpen, setIsRosterDetailOpen] = useState(true);
  const [rosterDetailFocus, setRosterDetailFocus] = useState<RosterDetailFocus>("activity");
  const [isProfessorReviewOpen, setIsProfessorReviewOpen] = useState(false);
  const [teacherNotesByStudentId, setTeacherNotesByStudentId] = useState<Record<string, string>>({});
  const [conversationNotesById, setConversationNotesById] = useState<Record<string, string>>({});
  const [feedbackTeacherNotesById, setFeedbackTeacherNotesById] = useState<Record<string, string>>({});
  const [feedbackUsageAllowanceById, setFeedbackUsageAllowanceById] = useState<Record<string, string>>({});
  const [savingNotesStudentId, setSavingNotesStudentId] = useState("");
  const [savingReviewConversationId, setSavingReviewConversationId] = useState("");
  const [savingFeedbackId, setSavingFeedbackId] = useState("");
  const [reviewSaveMessage, setReviewSaveMessage] = useState("");
  const [highlightedNoteConversationId, setHighlightedNoteConversationId] = useState("");
  const [expandedSourceConversationId, setExpandedSourceConversationId] = useState("");
  const [savingLearningProfileAction, setSavingLearningProfileAction] = useState("");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialKind, setMaterialKind] = useState<TutorKnowledgeKind>("Assignment");
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialSourceUrl, setMaterialSourceUrl] = useState("");
  const [materialText, setMaterialText] = useState("");
  const [materialUploadProgress, setMaterialUploadProgress] = useState<MaterialUploadProgress | null>(null);
  const [materialSuccess, setMaterialSuccess] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [error, setError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [teacherInvites, setTeacherInvites] = useState<TeacherInviteSummary[]>([]);
  const [teacherInviteFilter, setTeacherInviteFilter] = useState<TeacherInviteFilter>("all");
  const [teacherInviteCopyResult, setTeacherInviteCopyResult] = useState<{
    inviteId: string;
    status: "copied" | "failed";
  } | null>(null);
  const [teacherInvitesMessage, setTeacherInvitesMessage] = useState("");
  const [revokingTeacherInviteId, setRevokingTeacherInviteId] = useState("");
  const [classInviteCopyResult, setClassInviteCopyResult] = useState<{
    classId: string;
    kind: "code" | "link";
    status: "copied" | "failed";
  } | null>(null);
  const [loadedTeacherId, setLoadedTeacherId] = useState("");
  const [loadedDetailsClassId, setLoadedDetailsClassId] = useState("");
  const [isSavingClass, setIsSavingClass] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingStudent, setIsSavingStudent] = useState(false);
  const [isSavingMaterial, setIsSavingMaterial] = useState(false);
  const [isSavingThemePreference, setIsSavingThemePreference] = useState(false);
  const [isSavingAccountSettings, setIsSavingAccountSettings] = useState(false);
  const [isCreatingTeacherInvite, setIsCreatingTeacherInvite] = useState(false);
  const [isLoadingTeacherInvites, setIsLoadingTeacherInvites] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [isStudentDialogOpen, setIsStudentDialogOpen] = useState(false);
  const [isKnowledgeDialogOpen, setIsKnowledgeDialogOpen] = useState(false);
  const [isMaterialDetailDrawerOpen, setIsMaterialDetailDrawerOpen] = useState(false);
  const [materialDetailsById, setMaterialDetailsById] = useState<Record<string, MaterialDetail>>({});
  const [materialDetailLoadingId, setMaterialDetailLoadingId] = useState("");
  const [materialDetailError, setMaterialDetailError] = useState("");
  const [deletingMaterialId, setDeletingMaterialId] = useState("");
  const isLoadingClasses = Boolean(user && loadedTeacherId !== user.uid);
  const filteredTeacherInvites = useMemo(
    () =>
      teacherInviteFilter === "all"
        ? teacherInvites
        : teacherInvites.filter((invite) => invite.status === teacherInviteFilter),
    [teacherInviteFilter, teacherInvites]
  );
  const teacherInviteEmptyMessage = teacherInviteEmptyMessages[teacherInviteFilter];

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
  const studentProfileEmail = studentProfileRoute?.studentId
    ? decodeURIComponent(studentProfileRoute.studentId).trim().toLowerCase()
    : "";

  useEffect(() => {
    const classId = searchParams.get("classId")?.trim();
    const tab = searchParams.get("tab");
    const student = searchParams.get("student")?.trim();

    const syncQueryStateTimer = window.setTimeout(() => {
      if (classId) {
        setSelectedClassId(classId);
      }

      if (tab === "overview" || tab === "roster" || tab === "settings" || tab === "knowledge" || tab === "conversations") {
        setActiveTab(tab);
        setIsSecondarySidebarOpen(tab === "settings" || tab === "knowledge" || tab === "conversations");
      }

      if (student) {
        const decodedStudent = decodeURIComponent(student);
        setSelectedStudentId(decodedStudent.includes("@") ? encodeURIComponent(decodedStudent.toLowerCase()) : decodedStudent);
        setSelectedStudentClassId(classId || activeClassId);
        setIsRosterDetailOpen(true);
        setRosterDetailFocus("activity");
        setConversationStudentFilter(decodedStudent.includes("@") ? decodedStudent.toLowerCase() : decodedStudent);
      }
    }, 0);

    return () => window.clearTimeout(syncQueryStateTimer);
  }, [activeClassId, searchParams]);

  useEffect(() => {
    if (!studentProfileRoute) {
      return;
    }

    const syncProfileRouteTimer = window.setTimeout(() => {
      setSelectedClassId(studentProfileRoute.classId);
      setActiveTab("roster");
      setIsSecondarySidebarOpen(true);
      if (studentProfileEmail) {
        setSelectedStudentId(encodeURIComponent(studentProfileEmail));
        setSelectedStudentClassId(studentProfileRoute.classId);
        setConversationStudentFilter(studentProfileEmail);
      }
    }, 0);

    return () => window.clearTimeout(syncProfileRouteTimer);
  }, [studentProfileEmail, studentProfileRoute]);
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
        chatBlockedByStudentId,
        studentActivityByEmail,
        students: rosterStudents
      }),
    [chatBlockedByStudentId, rosterStudents, studentActivityByEmail]
  );
  const filteredRosterRows = useMemo(
    () => filterRosterRows(rosterRows, rosterSearchQuery, rosterFilter),
    [rosterFilter, rosterRows, rosterSearchQuery]
  );
  const selectedRosterRow = useMemo(
    () =>
      isRosterDetailOpen
        ? rosterRows.find((row) => row.student.id === displaySelectedStudentId) ?? rosterRows[0] ?? null
        : null,
    [displaySelectedStudentId, isRosterDetailOpen, rosterRows]
  );
  const currentRosterStudentIds = useMemo(() => new Set(rosterStudents.map((student) => student.id)), [rosterStudents]);
  const availableCheckedStudentIds = useMemo(
    () => checkedStudentIds.filter((studentId) => currentRosterStudentIds.has(studentId)),
    [checkedStudentIds, currentRosterStudentIds]
  );
  const checkedStudentIdSet = useMemo(() => new Set(availableCheckedStudentIds), [availableCheckedStudentIds]);
  const checkedVisibleStudentIds = useMemo(
    () =>
      filteredRosterRows
        .map((row) => row.student.id)
        .filter((studentId) => checkedStudentIdSet.has(studentId)),
    [checkedStudentIdSet, filteredRosterRows]
  );
  const allVisibleStudentsChecked =
    filteredRosterRows.length > 0 && checkedVisibleStudentIds.length === filteredRosterRows.length;
  const someVisibleStudentsChecked = checkedVisibleStudentIds.length > 0;
  const conversationReviewRows = useMemo(
    () => buildConversationReviewRows(classConversations, activeClassId),
    [activeClassId, classConversations]
  );
  const conversationReviewRowById = useMemo(
    () => new Map(conversationReviewRows.map((conversation) => [conversation.id, conversation])),
    [conversationReviewRows]
  );
  const visibleStudentConversations = useMemo(
    () =>
      studentConversations.filter(
        (conversation) =>
          conversation.classId === activeClassId &&
          conversation.studentEmail === selectedStudent?.email.trim().toLowerCase()
      ),
    [activeClassId, selectedStudent?.email, studentConversations]
  );
  const filteredConversationReviewRows = useMemo(
    () =>
      filterConversationReviewRows({
        evidenceConversationIds: [],
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
      conversationStudentFilter,
      conversationTopicFilter
    ]
  );
  const activeSelectedConversationId = useMemo(
    () => {
      if (activeTab === "conversations") {
        return selectedConversationClassId === activeClassId &&
          filteredConversationReviewRows.some((conversation) => conversation.id === selectedConversationId)
          ? selectedConversationId
          : filteredConversationReviewRows[0]?.id ?? "";
      }

      return selectedConversationClassId === activeClassId &&
        (conversationReviewRows.some((conversation) => conversation.id === selectedConversationId) ||
          visibleStudentConversations.some((conversation) => conversation.id === selectedConversationId))
        ? selectedConversationId
        : visibleStudentConversations[0]?.id ?? "";
    },
    [
      activeClassId,
      activeTab,
      filteredConversationReviewRows,
      conversationReviewRows,
      selectedConversationClassId,
      selectedConversationId,
      visibleStudentConversations
    ]
  );
  const selectedConversation = useMemo(
    () => visibleStudentConversations.find((conversation) => conversation.id === activeSelectedConversationId) ?? null,
    [activeSelectedConversationId, visibleStudentConversations]
  );
  const selectedConversationReviewRow = useMemo(
    () => conversationReviewRows.find((conversation) => conversation.id === activeSelectedConversationId) ?? null,
    [activeSelectedConversationId, conversationReviewRows]
  );
  const selectedConversationRosterRow = useMemo(
    () =>
      rosterRows.find((row) => row.student.id === selectedConversationReviewRow?.studentId) ??
      rosterRows.find((row) => row.student.email.trim().toLowerCase() === selectedConversationReviewRow?.studentEmail) ??
      null,
    [rosterRows, selectedConversationReviewRow?.studentEmail, selectedConversationReviewRow?.studentId]
  );
  const transcriptMessages = useMemo(
    () =>
      selectedConversationReviewRow?.id === activeSelectedConversationId
        ? conversationMessages.filter((message) => message.role === "student" || message.role === "assistant")
        : [],
    [activeSelectedConversationId, conversationMessages, selectedConversationReviewRow?.id]
  );
  const conversationMetrics = useMemo(
    () => classConversationMetrics ?? buildConversationMetrics(conversationReviewRows, rosterRows),
    [classConversationMetrics, conversationReviewRows, rosterRows]
  );
  const conversationSourceRows = useMemo(
    () => buildConversationSourceRows(selectedConversationReviewRow?.sourceAudit, transcriptMessages, materials),
    [materials, selectedConversationReviewRow?.sourceAudit, transcriptMessages]
  );
  const hasSourceWarning = Boolean(selectedConversationReviewRow?.sourceAudit.noSourceUsedWarning);
  const isSourceAuditExpanded = Boolean(
    selectedConversationReviewRow && expandedSourceConversationId === selectedConversationReviewRow.id
  );
  const visibleConversationSourceRows = useMemo(
    () => (isSourceAuditExpanded ? conversationSourceRows : conversationSourceRows.slice(0, 3)),
    [conversationSourceRows, isSourceAuditExpanded]
  );
  const conversationCitationCount = useMemo(
    () => conversationSourceRows.reduce((sum, source) => sum + source.citationCount, 0),
    [conversationSourceRows]
  );
  const selectedConversationPrivateNote = selectedConversationReviewRow
    ? conversationNotesById[selectedConversationReviewRow.id] ?? selectedConversationReviewRow.review.privateNote
    : "";
  const isConversationNoteHighlighted = Boolean(
    selectedConversationReviewRow && highlightedNoteConversationId === selectedConversationReviewRow.id
  );
  const studentTimelineBars = useMemo(
    () => buildStudentTimelineBars(selectedConversationRosterRow, conversationReviewRows),
    [conversationReviewRows, selectedConversationRosterRow]
  );
  const displayedStudentLearningProfile =
    selectedStudentLearningProfile?.studentEmail === selectedStudent?.email.trim().toLowerCase()
      ? selectedStudentLearningProfile
      : null;
  const filteredMaterials = useMemo(
    () => materials.filter((material) => knowledgeFilterMatchesMaterial(knowledgeFilter, material)),
    [knowledgeFilter, materials]
  );
  const selectedMaterial = useMemo(
    () =>
      filteredMaterials.find((material) => material.id === selectedMaterialId) ??
      filteredMaterials[0] ??
      null,
    [filteredMaterials, selectedMaterialId]
  );
  const selectedMaterialSettings = useMemo(
    () =>
      selectedMaterial
        ? sourceSettingsByMaterialId[selectedMaterial.id] ?? defaultKnowledgeSourceSettings(selectedMaterial)
        : null,
    [selectedMaterial, sourceSettingsByMaterialId]
  );
  const selectedMaterialDetail = selectedMaterial ? materialDetailsById[selectedMaterial.id] ?? null : null;
  const selectedAnswerPolicy = normalizeAnswerPolicySettings(selectedClass?.answerPolicy);
  const selectedSourceUsage = normalizeSourceUsageSettings(selectedClass?.sourceUsage);
  const selectedModelSettings = normalizeClassModelSettings(selectedClass?.modelSettings);
  const selectedResponseFormat = normalizeResponseFormatSettings(selectedClass?.responseFormat);
  const selectedCoTeachers = normalizeClassCoTeachers(selectedClass?.coTeachers);
  const selectedPrivacySettings = normalizePrivacySettings(selectedClass?.privacySettings);
  const selectedSourceDefaults = normalizeSourceDefaultsSettings(selectedClass?.sourceDefaults);
  const selectedNotificationSettings = normalizeNotificationSettings(selectedClass?.notificationSettings);
  const selectedTutorAccess = normalizeTutorAccessSettings(selectedClass?.tutorAccess ?? {
    enabled: selectedClass?.studentChatEnabled
  });
  const selectedTutorBehavior = normalizeTutorBehavior(selectedClass?.behaviorTitle);
  const selectedBehaviorInstructions =
    selectedClass?.behaviorInstructions?.trim() ? selectedClass.behaviorInstructions : defaultAiTutorHiddenInstructions;
  const selectedRefusalStyle =
    selectedClass?.refusalStyle?.trim() ? selectedClass.refusalStyle : defaultDirectAnswerRedirect;
  const selectedOpeningMessage = normalizeOpeningMessage(selectedClass?.openingMessage, selectedClass ?? undefined);
  const selectedStudentFacingInstructions = normalizeStudentFacingInstructions(
    selectedClass?.studentFacingInstructions,
    selectedClass ?? undefined
  );
  const selectedClassAppearance = normalizeTeacherClassAppearance(selectedClass?.appearance);
  const selectedClassThemeColor = normalizeTeacherClassThemeColor(selectedClass?.themeColor);
  const selectedAppearance = normalizeTeacherClassAppearance(profile?.appearance ?? selectedClass?.appearance);
  const selectedThemeColor = normalizeTeacherClassThemeColor(profile?.themeColor ?? selectedClass?.themeColor);
  const displayedCreativity =
    settingsCreativityPreview?.classId === activeClassId
      ? settingsCreativityPreview.value
      : selectedModelSettings.creativity;
  const displayedResponseLength =
    aiTutorResponseLengthPreview?.classId === activeClassId
      ? aiTutorResponseLengthPreview.value
      : selectedModelSettings.responseLength;
  const displayedSourceSettings = selectedMaterialSettings ?? fallbackKnowledgeSourceSettings;
  const activeSettingsSection =
    settingsPanes.find((settingsPane) => settingsPane.id === activeSettingsPane) ?? settingsPanes[0];
  const isLoadingClassDetails = Boolean(activeClassId && loadedDetailsClassId !== activeClassId);
  const hasTutorKnowledgeSource = Boolean(materialFile || materialSourceUrl.trim() || materialText.trim());
  const accountName = profile?.displayName ?? user?.displayName ?? "Teacher";
  const accountEmail = profile?.email ?? user?.email ?? "";
  const accountUsernameValue = profile?.username ?? accountEmail;
  const accountLastSignInAt = user?.metadata.lastSignInTime ?? "";
  const accountEmailValue = accountEmailDraft ?? accountEmail;
  const selectedPrivacyStudent = useMemo(
    () => students.find((student) => student.id === selectedPrivacyStudentId) ?? null,
    [selectedPrivacyStudentId, students]
  );
  const privacyStudentSearchResults = useMemo(() => {
    const query = privacyStudentSearchQuery.trim().toLowerCase();

    if (!query) {
      return [];
    }

    return students
      .filter((student) =>
        `${student.displayName} ${student.email}`.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [privacyStudentSearchQuery, students]);
  const totalConversationCount = useMemo(
    () => rosterRows.reduce((sum, row) => sum + row.conversationsCount, 0),
    [rosterRows]
  );
  const overviewDateLabel = classOverview?.dateLabel ?? overviewDateFormatter.format(new Date());
  const overviewKnowledgeStats = classOverview?.knowledgeStatus ?? buildOverviewKnowledgeStats(materials);
  const overviewReviewQueueRows = classOverview?.reviewQueueRows ?? [];
  const overviewNextActions = classOverview?.nextActions ?? [];
  const overviewSummary = classOverview?.summary ?? null;
  const overviewTopTopics = overviewSummary?.topTopics ?? [];
  const overviewReadySourceCount = overviewKnowledgeStats.find((stat) => stat.label === "Ready")?.value ?? 0;
  const overviewActiveSourceCount =
    overviewKnowledgeStats.find((stat) => stat.label === "Active for students")?.value ?? overviewReadySourceCount;
  const activeSourceLabel = `${overviewActiveSourceCount} active ${overviewActiveSourceCount === 1 ? "source" : "sources"}`;

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
    const resetPrivacyStudentSearchTimer = window.setTimeout(() => {
      setPrivacyStudentSearchQuery("");
      setSelectedPrivacyStudentId("");
      setPrivacyDataMessage("");
    }, 0);

    return () => window.clearTimeout(resetPrivacyStudentSearchTimer);
  }, [activeClassId]);

  useEffect(() => {
    if (!isSidebarDrawerOpen && !isSecondarySidebarOpen) {
      return () => {};
    }

    function handleSidebarKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSidebarDrawerOpen(false);
        setIsClassSwitcherOpen(false);
        setIsSecondarySidebarOpen(false);
      }
    }

    window.addEventListener("keydown", handleSidebarKeyDown);

    return () => window.removeEventListener("keydown", handleSidebarKeyDown);
  }, [isSecondarySidebarOpen, isSidebarDrawerOpen]);

  useEffect(() => {
    if (!activeClassId || !user) {
      return;
    }

    let isCancelled = false;
    let isLoadingRosterActivity = false;
    let refreshTimer: number | undefined;

    async function loadRosterActivity() {
      if (isLoadingRosterActivity || document.visibilityState === "hidden") {
        return;
      }

      isLoadingRosterActivity = true;

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
      } finally {
        isLoadingRosterActivity = false;
      }
    }

    function handleRosterActivityVisibilityChange() {
      if (document.visibilityState === "visible") {
        void loadRosterActivity();
      }
    }

    void loadRosterActivity();
    refreshTimer = window.setInterval(loadRosterActivity, 15000);
    document.addEventListener("visibilitychange", handleRosterActivityVisibilityChange);

    return () => {
      isCancelled = true;
      document.removeEventListener("visibilitychange", handleRosterActivityVisibilityChange);
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
      const clearTimer = window.setTimeout(() => setStudentConversations([]), 0);
      return () => window.clearTimeout(clearTimer);
    }

    let isCancelled = false;
    const controller = new AbortController();

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
            },
            signal: controller.signal
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
        if (isAbortError(caughtError)) {
          return;
        }

        if (!isCancelled) {
          setStudentConversations([]);
          setConversationError(formatConversationError(caughtError, "Conversation load failed."));
        }
      });

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [activeClassId, selectedStudent, user]);

  useEffect(() => {
    if (!activeClassId || !user) {
      const clearTimer = window.setTimeout(() => {
        setClassConversations([]);
        setClassConversationMetrics(null);
      }, 0);
      return () => window.clearTimeout(clearTimer);
    }

    let isCancelled = false;
    const controller = new AbortController();

    user
      .getIdToken()
      .then(async (token) => {
        const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/conversations`), {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal
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
        if (isAbortError(caughtError)) {
          return;
        }

        if (!isCancelled) {
          setClassConversations([]);
          setClassConversationMetrics(null);
          setConversationError(formatConversationError(caughtError, "Class conversations load failed."));
        }
      });

    return () => {
      isCancelled = true;
      controller.abort();
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
      const clearTimer = window.setTimeout(() => setConversationMessages([]), 0);
      return () => window.clearTimeout(clearTimer);
    }

    let isCancelled = false;
    const controller = new AbortController();

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
            },
            signal: controller.signal
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
        if (isAbortError(caughtError)) {
          return;
        }

        if (!isCancelled) {
          setConversationMessages([]);
          setConversationError(formatConversationError(caughtError, "Conversation messages failed."));
        }
      });

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [activeClassId, activeSelectedConversationId, user]);

  useEffect(() => {
    if (activeTab !== "conversations" || !activeClassId || activeSelectedConversationId || !filteredConversationReviewRows.length) {
      return;
    }

    const firstConversation = filteredConversationReviewRows[0];
    const selectionTimer = window.setTimeout(() => {
      setSelectedStudentId(firstConversation.studentId);
      setSelectedStudentClassId(activeClassId);
      setSelectedConversationId(firstConversation.id);
      setSelectedConversationClassId(activeClassId);
    }, 0);

    return () => window.clearTimeout(selectionTimer);
  }, [activeClassId, activeSelectedConversationId, activeTab, filteredConversationReviewRows]);

  useEffect(() => {
    if (activeTab !== "settings") {
      return;
    }

    document.querySelector<HTMLElement>(".teacher-main")?.scrollTo({ top: 0 });
  }, [activeClassId, activeSettingsPane, activeTab]);

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
    const formValue = (name: string) => String(formData.get(name) ?? "");

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
      const privacySettings: ClassPrivacySettings = normalizePrivacySettings({
        conversationRetention: String(formData.get("privacySettings.conversationRetention") ?? "")
      });
      const sourceDefaults: SourceDefaultsSettings = normalizeSourceDefaultsSettings({
        activeForStudents: formData.has("sourceDefaults.activeForStudents"),
        teacherOnly: formData.has("sourceDefaults.teacherOnly"),
        citationsRequired: formData.has("sourceDefaults.citationsRequired"),
        priority: String(formData.get("sourceDefaults.priority") ?? ""),
        answerKeysTeacherReviewOnly: formData.has("sourceDefaults.answerKeysTeacherReviewOnly"),
        sourceTypePreferences: Object.fromEntries(
          materialSourceTypeKeys.map((kind) => [
            kind,
            String(formData.get(`sourceDefaults.sourceTypePreferences.${kind}`) ?? "")
          ])
        )
      });
      const notificationSettings: NotificationSettings = normalizeNotificationSettings({
        weeklyDigest: formData.has("notificationSettings.weeklyDigest"),
        followUpReminders: formData.has("notificationSettings.followUpReminders"),
        newStudentJoinedClass: formData.has("notificationSettings.newStudentJoinedClass")
      });
      const tutorAccess: TutorAccessSettings = normalizeTutorAccessSettings({
        enabled: formData.has("tutorAccess.enabled")
      });

      await updateTeacherClassSettings({
        answerPolicy,
        appearance: selectedClassAppearance,
        behaviorInstructions: String(formData.get("behaviorInstructions") ?? ""),
        behaviorTitle: normalizeTutorBehavior(formData.get("behaviorTitle")),
        classId: activeClassId,
        defaultAssignmentContext: formValue("defaultAssignmentContext"),
        modelSettings: normalizeClassModelSettings({
          creativity: formValue("modelSettings.creativity"),
          modelId: formValue("modelSettings.modelId"),
          reasoningEffort: formValue("modelSettings.reasoningEffort"),
          responseLength: formValue("modelSettings.responseLength"),
          requestLimits: {
            perClassDaily: formValue("modelSettings.requestLimits.perClassDaily"),
            perStudentDaily: formValue("modelSettings.requestLimits.perStudentDaily"),
            teacherPreviewDaily: formValue("modelSettings.requestLimits.teacherPreviewDaily")
          },
          tokenLimits: {
            perDay: formValue("modelSettings.tokenLimits.perDay"),
            perHour: formValue("modelSettings.tokenLimits.perHour"),
            perWeek: formValue("modelSettings.tokenLimits.perWeek")
          }
        }),
        name: formValue("name"),
        notificationSettings,
        openingMessage: formValue("openingMessage"),
        privacySettings,
        refusalStyle: formValue("refusalStyle").trim() || defaultRefusalStyle,
        responseFormat,
        section: formValue("section"),
        sourceDefaults,
        sourceUsage,
        studentFacingInstructions: formValue("studentFacingInstructions"),
        tutorAccess,
        themeColor: selectedClassThemeColor
      });
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Class settings failed."));
    } finally {
      setIsSavingSettings(false);
    }
  }

  const loadTeacherInvites = useCallback(async () => {
    if (!user) {
      return;
    }

    setTeacherInvitesMessage("");
    setIsLoadingTeacherInvites(true);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/teacher-invites"), {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        invites?: TeacherInviteSummary[];
      };

      if (!response.ok || !Array.isArray(data.invites)) {
        throw new Error(data.error ?? "Teacher invite list failed.");
      }

      setTeacherInvites(data.invites);
    } catch (caughtError) {
      setTeacherInvitesMessage(formatClassError(caughtError, "Teacher invite list failed."));
    } finally {
      setIsLoadingTeacherInvites(false);
    }
  }, [user]);

  async function createTeacherInviteLink() {
    if (!user) {
      return;
    }

    setError("");
    setTeacherInviteCopyResult(null);
    setIsCreatingTeacherInvite(true);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/teacher-invites"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = (await response.json()) as {
        error?: string;
        expiresAt?: string;
        inviteId?: string;
        inviteUrl?: string;
      };

      if (!response.ok || !data.inviteId || !data.inviteUrl) {
        throw new Error(data.error ?? "Teacher invite creation failed.");
      }

      setTeacherInviteFilter("active");
      await loadTeacherInvites();

      try {
        await copyTextToClipboard(data.inviteUrl);
        setTeacherInviteCopyResult({ inviteId: data.inviteId, status: "copied" });
      } catch {
        setTeacherInviteCopyResult({ inviteId: data.inviteId, status: "failed" });
      }
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Teacher invite creation failed."));
    } finally {
      setIsCreatingTeacherInvite(false);
    }
  }

  async function revokeTeacherInvite(inviteId: string) {
    if (!user) {
      return;
    }

    setTeacherInvitesMessage("");
    setRevokingTeacherInviteId(inviteId);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/teacher-invites"), {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inviteId })
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; revoked?: boolean };

      if (!response.ok || !data.revoked) {
        throw new Error(data.error ?? "Teacher invite revoke failed.");
      }

      setTeacherInvites((currentInvites) =>
        currentInvites.map((invite) =>
          invite.inviteId === inviteId
            ? { ...invite, inviteUrl: "", revokedAt: new Date().toISOString(), status: "revoked" }
            : invite
        )
      );
      setTeacherInvitesMessage("Teacher invite revoked.");
    } catch (caughtError) {
      setTeacherInvitesMessage(formatClassError(caughtError, "Teacher invite revoke failed."));
    } finally {
      setRevokingTeacherInviteId("");
    }
  }

  useEffect(() => {
    if (!user || activeSettingsPane !== "invites") {
      return;
    }

    void Promise.resolve().then(loadTeacherInvites);
  }, [activeSettingsPane, loadTeacherInvites, user]);

  useEffect(() => {
    if (!teacherInviteCopyResult) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setTeacherInviteCopyResult(null);
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [teacherInviteCopyResult]);

  async function copyTeacherInviteLink(invite: TeacherInviteSummary) {
    const inviteUrl = invite.inviteUrl || buildTeacherInviteUrl(invite.inviteId);

    setTeacherInvitesMessage("");
    setTeacherInviteCopyResult(null);

    try {
      await copyTextToClipboard(inviteUrl);
      setTeacherInviteCopyResult({ inviteId: invite.inviteId, status: "copied" });
    } catch {
      setTeacherInviteCopyResult({ inviteId: invite.inviteId, status: "failed" });
    }
  }

  async function copyClassInvite(teacherClass: TeacherClass, kind: "code" | "link") {
    setError("");
    setClassInviteCopyResult(null);

    try {
      const classCode = teacherClass.joinCode?.trim() || (await ensureClassJoinCode(teacherClass.id));
      const textToCopy = kind === "code" ? classCode : buildClassInviteUrl(classCode);

      await copyTextToClipboard(textToCopy);
      setClassInviteCopyResult({ classId: teacherClass.id, kind, status: "copied" });
    } catch (caughtError) {
      setClassInviteCopyResult({ classId: teacherClass.id, kind, status: "failed" });
      setError(formatClassError(caughtError, "Class invite copy failed."));
    }
  }

  async function resetClassInviteCode(teacherClass: TeacherClass) {
    if (!teacherClass.id || !user) {
      return;
    }

    const confirmed = window.confirm(
      `Reset the student class invite code for ${teacherClass.name}? Existing student invite links using the old code will stop working.`
    );

    if (!confirmed) {
      return;
    }

    setError("");
    setClassAccessMessage("");
    setSavingClassAccessAction(`reset-code:${teacherClass.id}`);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(teacherClass.id)}/invite-code`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = (await response.json()) as { error?: string; joinCode?: string };

      if (!response.ok || !data.joinCode) {
        throw new Error(data.error ?? "Class invite code reset failed.");
      }

      setClassAccessMessage(`${teacherClass.name} invite code reset to ${data.joinCode}.`);
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Class invite code reset failed."));
    } finally {
      setSavingClassAccessAction("");
    }
  }

  async function addCoTeacher() {
    if (!activeClassId || !user || !coTeacherEmail.trim()) {
      return;
    }

    setError("");
    setClassAccessMessage("");
    setSavingClassAccessAction("add-co-teacher");

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/co-teachers`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: coTeacherEmail,
          role: coTeacherRole
        })
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Co-teacher update failed.");
      }

      setCoTeacherEmail("");
      setClassAccessMessage("Co-teacher access saved.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Co-teacher update failed."));
    } finally {
      setSavingClassAccessAction("");
    }
  }

  async function updateCoTeacherRole(coTeacher: ClassCoTeacher, role: Exclude<ClassAccessRole, "owner">) {
    if (!activeClassId || !user) {
      return;
    }

    setError("");
    setClassAccessMessage("");
    setSavingClassAccessAction(`role:${coTeacher.uid}`);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/co-teachers`), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          role,
          uid: coTeacher.uid
        })
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Co-teacher update failed.");
      }

      setClassAccessMessage("Co-teacher permission saved.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Co-teacher update failed."));
    } finally {
      setSavingClassAccessAction("");
    }
  }

  async function removeCoTeacher(coTeacher: ClassCoTeacher) {
    if (!activeClassId || !user) {
      return;
    }

    const confirmed = window.confirm(`Remove ${coTeacher.displayName || coTeacher.email || "this teacher"} from this class?`);

    if (!confirmed) {
      return;
    }

    setError("");
    setClassAccessMessage("");
    setSavingClassAccessAction(`remove:${coTeacher.uid}`);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/co-teachers`), {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ uid: coTeacher.uid })
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Co-teacher removal failed.");
      }

      setClassAccessMessage("Co-teacher removed.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Co-teacher removal failed."));
    } finally {
      setSavingClassAccessAction("");
    }
  }

  async function exportStudentClassData(student: ClassStudent) {
    if (!activeClassId || !user) {
      return;
    }

    setError("");
    setPrivacyDataMessage("");
    setSavingPrivacyDataAction(`export:${student.id}`);

    try {
      const token = await user.getIdToken();
      const studentDataId = encodeURIComponent(student.email || student.id);
      const response = await fetch(
        apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/students/${studentDataId}/data`),
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Student data export failed.");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `${activeClassId}-${student.email || student.id}-export.json`;
      anchor.click();
      URL.revokeObjectURL(downloadUrl);
      setPrivacyDataMessage("Student data export downloaded.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Student data export failed."));
    } finally {
      setSavingPrivacyDataAction("");
    }
  }

  async function deleteStudentClassData(student: ClassStudent) {
    if (!activeClassId || !user) {
      return;
    }

    const confirmed = window.confirm(`Delete all class data for ${student.displayName || student.email}? This removes the roster row, conversations, messages, attachments, learning profiles, support notes, and class usage records for this student.`);

    if (!confirmed) {
      return;
    }

    setError("");
    setPrivacyDataMessage("");
    setSavingPrivacyDataAction(`delete:${student.id}`);

    try {
      const token = await user.getIdToken();
      const studentDataId = encodeURIComponent(student.email || student.id);
      const response = await fetch(
        apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/students/${studentDataId}/data`),
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ confirm: "DELETE_STUDENT_CLASS_DATA" })
        }
      );
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Student data deletion failed.");
      }

      setSelectedStudentId("");
      setPrivacyDataMessage("Student class data deleted.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Student data deletion failed."));
    } finally {
      setSavingPrivacyDataAction("");
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

  async function saveAccountSettings() {
    if (!user) {
      return;
    }

    setError("");
    setAccountSettingsMessage("");

    const nextEmail = accountEmailValue.trim().toLowerCase();
    const passwordChanged = Boolean(newAccountPassword);
    const emailChanged = Boolean(nextEmail && nextEmail !== accountEmail.trim().toLowerCase());

    if (!nextEmail) {
      setError("Enter an email address.");
      return;
    }

    if (passwordChanged && newAccountPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }

    if (passwordChanged && newAccountPassword !== confirmAccountPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    if ((emailChanged || passwordChanged) && !currentAccountPassword) {
      setError("Enter your current password before changing email or password.");
      return;
    }

    setIsSavingAccountSettings(true);

    try {
      const nextUsername =
        !accountUsername && accountUsernameValue === accountEmail && emailChanged
          ? nextEmail
          : accountUsername ?? accountUsernameValue;

      await updateUserAccountSettings({
        appearance: selectedAppearance,
        currentPassword: currentAccountPassword,
        displayName: accountDisplayName ?? accountName,
        email: nextEmail,
        newPassword: newAccountPassword,
        themeColor: selectedThemeColor,
        uid: user.uid,
        username: nextUsername
      });
      setAccountDisplayName(null);
      setAccountEmailDraft(null);
      setAccountUsername(null);
      setCurrentAccountPassword("");
      setNewAccountPassword("");
      setConfirmAccountPassword("");
      setAccountSettingsMessage("Account settings saved.");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Account settings failed."));
    } finally {
      setIsSavingAccountSettings(false);
    }
  }

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth");
  }

  async function handleSignOutAllSessions() {
    await signOutAllSessions();
    router.push("/auth");
  }

  async function handleDeleteAccount() {
    if (!user) {
      return;
    }

    setError("");
    setAccountSettingsMessage("");
    setIsDeletingAccount(true);

    try {
      await deleteCurrentAccount({
        currentPassword: currentAccountPassword,
        uid: user.uid
      });
      router.push("/auth");
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Account deletion failed."));
    } finally {
      setIsDeletingAccount(false);
    }
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
          )}/chat-access`
        ),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ chatBlocked: row.chatBlocked, teacherNotes })
        }
      );
      const data = (await response.json()) as { chatBlocked?: boolean; teacherNotes?: string; error?: string };

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
          activity.studentEmail === row.studentEmail
            ? { ...activity, chatBlocked: data.chatBlocked ?? row.chatBlocked, teacherNotes: savedNotes }
            : activity
        )
      );
    } catch (caughtError) {
      setError(formatClassError(caughtError, "Student notes save failed."));
    } finally {
      setSavingNotesStudentId("");
    }
  }

  async function saveStudentChatBlocked(row: RosterRow, chatBlocked: boolean) {
    if (!activeClassId || !user || savingNotesStudentId) {
      return;
    }

    setChatBlockedByStudentId((current) => ({
      ...current,
      [row.student.id]: chatBlocked
    }));
    setRosterActivity((currentActivity) =>
      currentActivity.map((activity) =>
        activity.studentEmail === row.studentEmail ? { ...activity, chatBlocked } : activity
      )
    );
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
          body: JSON.stringify({ chatBlocked })
        }
      );
      const data = (await response.json()) as { chatBlocked?: boolean; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Student chat access save failed.");
      }

      const savedBlocked = data.chatBlocked ?? chatBlocked;
      setChatBlockedByStudentId((current) => ({
        ...current,
        [row.student.id]: savedBlocked
      }));
      setRosterActivity((currentActivity) =>
        currentActivity.map((activity) =>
          activity.studentEmail === row.studentEmail ? { ...activity, chatBlocked: savedBlocked } : activity
        )
      );
    } catch (caughtError) {
      setChatBlockedByStudentId((current) => ({
        ...current,
        [row.student.id]: row.chatBlocked
      }));
      setRosterActivity((currentActivity) =>
        currentActivity.map((activity) =>
          activity.studentEmail === row.studentEmail ? { ...activity, chatBlocked: row.chatBlocked } : activity
        )
      );
      setError(formatClassError(caughtError, "Student chat access save failed."));
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
      const updatedRow = {
        ...row,
        review: data.review!,
        status: data.review!.status
      };
      if (!conversationNeedsTeacherReview(updatedRow)) {
        setClassOverview((currentOverview) =>
          currentOverview
            ? {
                ...currentOverview,
                nextActions: currentOverview.nextActions.filter((action) => action.conversationId !== row.id),
                reviewQueueRows: currentOverview.reviewQueueRows.filter((queueRow) => queueRow.conversationId !== row.id)
              }
            : currentOverview
        );
      }
      if (
        !conversationMatchesFilter({
          evidenceConversationIds: [],
        filter: conversationFilter,
          query: conversationSearchQuery,
          row: updatedRow,
          studentEmail: conversationStudentFilter,
          topic: conversationTopicFilter
        })
      ) {
        const nextConversation = filteredConversationReviewRows.find((conversation) => conversation.id !== row.id);
        setSelectedConversationId(nextConversation?.id ?? "");
        setSelectedConversationClassId(activeClassId);
      }
      setReviewSaveMessage(status === row.status ? "Note saved" : `Marked ${formatConversationStatus(data.review.status)}`);
      setClassConversationMetrics(null);
    } catch (caughtError) {
      setReviewSaveMessage("");
      setError(formatClassError(caughtError, "Conversation review save failed."));
    } finally {
      setSavingReviewConversationId("");
    }
  }

  async function saveStudentFeedbackReview(feedback: StudentFeedback, status: StudentFeedbackStatus) {
    if (!activeClassId || !user || savingFeedbackId) {
      return;
    }

    const teacherNote = feedbackTeacherNotesById[feedback.id] ?? feedback.teacherNote ?? "";
    const rawUsageAllowancePercent = Number(
      feedbackUsageAllowanceById[feedback.id] ?? feedback.usageAllowancePercent ?? 25
    );
    const usageAllowancePercent =
      feedback.kind === "usage_request"
        ? Number.isFinite(rawUsageAllowancePercent) && rawUsageAllowancePercent > 0
          ? rawUsageAllowancePercent
          : 25
        : undefined;

    setSavingFeedbackId(feedback.id);
    setReviewSaveMessage(
      feedback.kind === "usage_request" && status === "resolved"
        ? "Approving usage request..."
        : status === "resolved"
          ? "Resolving feedback..."
          : "Marking feedback reviewed..."
    );
    setError("");

    try {
      const token = await getTeacherToken();
      const response = await fetch(
        apiUrl(`/api/classes/${encodeURIComponent(activeClassId)}/feedback/${encodeURIComponent(feedback.id)}`),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            status,
            teacherNote,
            usageAllowancePercent
          })
        }
      );
      const data = (await response.json()) as {
        error?: string;
        feedback?: StudentFeedback;
      };

      if (!response.ok || !data.feedback) {
        throw new Error(data.error ?? "Feedback update failed.");
      }

      const savedFeedback = data.feedback;
      setClassConversations((currentConversations) =>
        currentConversations.map((conversation) => {
          if (conversation.id !== savedFeedback.conversationId) {
            return conversation;
          }

          const feedback = conversation.feedback.map((item) =>
            item.id === savedFeedback.id ? savedFeedback : item
          );

          return {
            ...conversation,
            feedback,
            feedbackSummary: summarizeStudentFeedback(feedback)
          };
        })
      );
      setFeedbackTeacherNotesById((currentNotes) => ({
        ...currentNotes,
        [savedFeedback.id]: savedFeedback.teacherNote ?? ""
      }));
      setFeedbackUsageAllowanceById((currentAllowances) => ({
        ...currentAllowances,
        [savedFeedback.id]: String(savedFeedback.usageAllowancePercent || usageAllowancePercent || 25)
      }));
      setClassOverview(null);
      setClassConversationMetrics(null);
      setReviewSaveMessage(
        savedFeedback.kind === "usage_request" && savedFeedback.usageAllowancePercent
          ? `Usage request approved: +${savedFeedback.usageAllowancePercent}% today`
          : status === "resolved"
            ? "Feedback resolved"
            : "Feedback reviewed"
      );
    } catch (caughtError) {
      setReviewSaveMessage("");
      setError(formatClassError(caughtError, "Feedback update failed."));
    } finally {
      setSavingFeedbackId("");
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
      const jobId = createMaterialJobId();
      const storageUpload = materialFile
        ? await uploadTutorKnowledgeFileToStorage({
            classId: activeClassId,
            file: materialFile,
            materialId: jobId,
            onProgress: setMaterialUploadProgress
          })
        : null;
      const formData = buildTutorKnowledgeFormData(activeClassId, {
        materialId: storageUpload ? jobId : undefined,
        storagePath: storageUpload?.storagePath
      });
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
      setMaterialSourceUrl("");
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

    const confirmed = window.confirm(`Delete "${material.title}" and its indexed pages?`);

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

  function buildTutorKnowledgeFormData(
    classId: string,
    storageUpload?: {
      materialId?: string;
      storagePath?: string;
    }
  ) {
    if (!materialFile && !materialSourceUrl.trim() && !materialText.trim()) {
      throw new Error("Add a supported file, paste a URL, or paste tutor knowledge text before previewing.");
    }

    const formData = new FormData();
    formData.append("classId", classId);
    formData.append("title", materialTitle);
    formData.append("kind", materialKind);
    formData.append("text", materialText);
    formData.append("sourceUrl", materialSourceUrl.trim());

    if (storageUpload?.materialId && storageUpload.storagePath) {
      formData.append("materialId", storageUpload.materialId);
      formData.append("storagePath", storageUpload.storagePath);
    } else if (materialFile) {
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

  function handleMaterialSourceUrlChange(sourceUrl: string) {
    setMaterialSourceUrl(sourceUrl);
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
    setMaterialSourceUrl("");
    setMaterialText("");
    setMaterialKind("Assignment");
    setMaterialUploadProgress(null);
    setFileInputKey((currentKey) => currentKey + 1);
    setIsKnowledgeDialogOpen(false);
  }

  function openMaterialDetail(material: ClassMaterial) {
    setSelectedMaterialId(material.id);
    setRetrievalResults([]);
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
      setRosterDetailFocus("activity");
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
      setRosterDetailFocus("activity");
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
      setRosterDetailFocus("activity");
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

    if (action.action === "openStudentView") {
      window.location.assign(selectedClass ? `/student?classId=${selectedClass.id}&preview=teacher` : "/student");
    }
  }

  function selectTeacherClass(teacherClassId: string) {
    setSelectedClassId(teacherClassId);
    setSelectedStudentId("");
    setSelectedStudentClassId(teacherClassId);
    setSelectedConversationId("");
    setSelectedConversationClassId(teacherClassId);
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
    setRosterDetailFocus("activity");
    setIsProfessorReviewOpen(false);
    setRosterSearchQuery("");
    setRosterFilter("all");
    setConversationFilter("all");
    setConversationSearchQuery("");
    setConversationStudentFilter("all");
    setConversationTopicFilter("all");
    setIsSidebarDrawerOpen(false);
    setIsClassSwitcherOpen(false);
    setIsSecondarySidebarOpen(false);
  }

  const teacherPrimaryNavItems: TeacherPrimaryNavItem[] = [
    { icon: <HomeIcon />, id: "overview", label: "Overview" },
    { icon: <UserGroupIcon />, id: "roster", label: "Roster" },
    { icon: <BookOpenIcon />, id: "knowledge", label: "Tutor" },
    { icon: <ChatIcon />, id: "conversations", label: "Conversations" },
    {
      href: selectedClass ? `/student?classId=${selectedClass.id}&preview=teacher` : "/student",
      icon: <MonitorIcon />,
      id: "studentView",
      label: "Student View"
    },
    { icon: <SettingsIcon />, id: "settings", label: "Settings" }
  ];
  const conversationSecondaryItems: Array<{
    count?: number;
    icon: ReactNode;
    id: ConversationFilter | "students";
    label: string;
  }> = [
    { count: conversationMetrics.unreviewed, icon: <StrugglingTopicsIcon />, id: "all", label: "Needs Review" },
    { count: conversationMetrics.followUp, icon: <FlagIcon />, id: "needsFollowUp", label: "Follow-Ups" },
    { count: conversationReviewRows.reduce((sum, row) => sum + row.feedbackSummary.openCount, 0), icon: <ChatIcon />, id: "feedback", label: "Feedback" },
    { icon: <CheckCircleIcon />, id: "reviewed", label: "Reviewed" },
    { icon: <UserGroupIcon />, id: "students", label: "Students" }
  ];
  const aiTutorSecondaryItems = aiTutorSections.map((section) => ({
    ...section,
    active: activeAiTutorSection === section.id,
    onClick: () => setActiveAiTutorSection(section.id)
  }));
  const settingsSecondaryItems = settingsPanes.map((settingsPane) => ({
    icon: settingsPane.icon,
    label: settingsPane.label,
    active: activeSettingsPane === settingsPane.id,
    onClick: () => setActiveSettingsPane(settingsPane.id)
  }));
  const isStudentProfileRoute = Boolean(studentProfileRoute);
  const secondarySidebarContent =
    isStudentProfileRoute && studentProfileRoute
      ? {
          description: selectedClass?.name ?? "Roster",
          items: [
            {
              active: false,
              icon: <ChevronLeftIcon />,
              label: "Back to roster",
              onClick: () => {
                router.push(
                  `/teacher?classId=${encodeURIComponent(studentProfileRoute.classId)}&tab=roster&student=${encodeURIComponent(studentProfileEmail)}`
                );
              }
            },
            {
              active: true,
              icon: <UserIcon />,
              label: "Student Profile",
              onClick: () => {}
            },
            {
              active: false,
              icon: <ChatIcon />,
              label: "Conversations",
              onClick: () => {
                router.push(
                  `/teacher?classId=${encodeURIComponent(studentProfileRoute.classId)}&tab=conversations&student=${encodeURIComponent(studentProfileEmail)}`
                );
              }
            }
          ],
          title: "Roster"
        }
      : activeTab === "knowledge"
      ? {
          description: "Tutor controls",
          items: aiTutorSecondaryItems,
          title: "AI Tutor"
        }
      : activeTab === "conversations"
      ? {
          description: "Review center",
          items: conversationSecondaryItems.map((item) => ({
            ...item,
            active: item.id !== "students" && conversationFilter === item.id,
            onClick: () => {
              if (item.id === "students") {
                setActiveTab("roster");
                setIsSecondarySidebarOpen(false);
                return;
              }
              setConversationFilter(item.id as ConversationFilter);
            }
          })),
          title: "Conversations"
        }
      : activeTab === "settings"
        ? {
            description: selectedClass?.name ?? "Class preferences",
            items: settingsSecondaryItems,
            title: "Settings"
          }
      : null;
  const hasSecondarySidebar = Boolean((isSecondarySidebarOpen || isStudentProfileRoute) && secondarySidebarContent);
  const renderLegacyOverview = false;
  const nextAppearance = selectedAppearance === "dark" ? "light" : "dark";
  const handlePrimaryNavigate = (tab: TeacherTab) => {
    if (studentProfileRoute) {
      router.push(`/teacher?classId=${encodeURIComponent(studentProfileRoute.classId)}&tab=${tab}`);
      return;
    }

    const tabSupportsSecondary = tab === "knowledge" || tab === "conversations" || tab === "settings";
    const shouldToggleSecondary = tabSupportsSecondary && activeTab === tab;

    setActiveTab(tab);
    setIsSecondarySidebarOpen(tabSupportsSecondary ? (shouldToggleSecondary ? !isSecondarySidebarOpen : true) : false);
    setIsSidebarDrawerOpen(false);
    setIsClassSwitcherOpen(false);
  };

  return (
    <>
      <section
        className={`teacher-dashboard ${hasSecondarySidebar ? "has-secondary-sidebar" : ""}`}
        data-active-tab={activeTab}
        data-appearance={selectedAppearance}
        data-theme-color={selectedThemeColor}
        aria-label="Teacher dashboard"
      >
        <div
          aria-hidden="true"
          className="sidebar-edge-trigger"
          onMouseEnter={() => setIsSidebarDrawerOpen(true)}
        />
        <PrimaryIconRail
          accountEmail={accountEmail}
          accountName={accountName}
          activeTab={activeTab}
          isSavingThemePreference={isSavingThemePreference}
          navItems={teacherPrimaryNavItems}
          nextAppearance={nextAppearance}
          onNavigate={handlePrimaryNavigate}
          onOpenDrawer={() => setIsSidebarDrawerOpen(true)}
          onToggleTheme={() => void updatePersonalThemePreference({ appearance: nextAppearance })}
        />

        <SidebarDrawer
          accountEmail={accountEmail}
          accountName={accountName}
          activeClassId={activeClassId}
          activeTab={activeTab}
          classes={classes}
          isClassSwitcherOpen={isClassSwitcherOpen}
          isLoadingClasses={isLoadingClasses}
          isOpen={isSidebarDrawerOpen}
          isSavingThemePreference={isSavingThemePreference}
          navItems={teacherPrimaryNavItems}
          nextAppearance={nextAppearance}
          selectedClass={selectedClass}
          onClose={() => {
            setIsSidebarDrawerOpen(false);
            setIsClassSwitcherOpen(false);
          }}
          onCreateClass={() => {
            setIsClassDialogOpen(true);
            setIsSidebarDrawerOpen(false);
            setIsClassSwitcherOpen(false);
          }}
          onNavigate={handlePrimaryNavigate}
          onSelectClass={selectTeacherClass}
          onToggleClassSwitcher={() => setIsClassSwitcherOpen((isOpen) => !isOpen)}
          onToggleTheme={() => void updatePersonalThemePreference({ appearance: nextAppearance })}
          onSignOut={handleSignOut}
        />

        {hasSecondarySidebar && secondarySidebarContent ? (
          <TeacherSecondarySidebar
            description={secondarySidebarContent.description}
            title={secondarySidebarContent.title}
            items={secondarySidebarContent.items}
            onClose={() => {
              if (studentProfileRoute) {
                router.push(
                  `/teacher?classId=${encodeURIComponent(studentProfileRoute.classId)}&tab=roster&student=${encodeURIComponent(studentProfileEmail)}`
                );
                return;
              }
              setIsSecondarySidebarOpen(false);
            }}
          />
        ) : null}

        <section className="teacher-main" aria-label="Class workspace">
          <div className="teacher-main-inner">
            {!selectedClass || activeTab === "knowledge" || activeTab === "settings" || error ? (
              <div className={selectedClass ? "teacher-sticky-chrome" : undefined}>
                {!selectedClass || activeTab === "knowledge" || activeTab === "settings" ? (
                  <header
                    className={`teacher-main-header ${
                      activeTab === "knowledge" || activeTab === "settings" ? "ai-tutor-main-header" : ""
                    }`}
                  >
                    <div>
                      <h1>
                        {selectedClass && activeTab === "knowledge"
                          ? "AI Tutor"
                          : selectedClass && activeTab === "settings"
                            ? "Settings"
                            : "Create a class"}
                      </h1>
                      <p>
                        {selectedClass && activeTab === "knowledge"
                          ? "Control how Chandra teaches, answers, and uses your class materials."
                          : selectedClass && activeTab === "settings"
                            ? "Manage class details, invites, account, and display preferences."
                          : "Add your first class from the sidebar."}
                      </p>
                      {selectedClass && (activeTab === "knowledge" || activeTab === "settings") ? (
                        <span className="ai-tutor-class-context">
                          {selectedClass.name} · {formatSectionLabel(selectedClass.section)}
                        </span>
                      ) : null}
                    </div>
                    {selectedClass && (activeTab === "knowledge" || activeTab === "settings") ? (
                      <div className="ai-tutor-header-actions">
                        {activeTab === "settings" && activeSettingsPane === "account" ? (
                          <button
                            className="primary-button teacher-primary-button compact"
                            disabled={isSavingAccountSettings}
                            type="button"
                            onClick={() => void saveAccountSettings()}
                          >
                            {isSavingAccountSettings ? "Saving" : "Save account"}
                          </button>
                        ) : (
                          <button
                            className="primary-button teacher-primary-button compact"
                            disabled={isSavingSettings}
                            form={activeTab === "knowledge" ? "ai-tutor-settings-form" : "class-settings-form"}
                            type="submit"
                          >
                            {isSavingSettings ? "Saving" : "Save changes"}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </header>
                ) : null}

                {error ? <p className="form-error teacher-alert">{error}</p> : null}
              </div>
            ) : null}

            {selectedClass ? (
              <>
                {isLoadingClassDetails ? (
                  <div className="empty-state detail-loading">
                    <strong>Loading class details</strong>
                    <span>Fetching roster and tutor knowledge.</span>
                  </div>
                ) : null}

                {studentProfileRoute ? (
                  <StudentProfilePage
                    embedded
                    classId={studentProfileRoute.classId}
                    studentId={studentProfileRoute.studentId}
                  />
                ) : (
                  <>
                {activeTab === "overview" ? (
                  <TeacherAnalyticsDashboardContent
                    classLabel={`${selectedClass.name} - ${formatSectionLabel(selectedClass.section)}`}
                    overview={classOverview}
                    priorityRows={classOverview?.priorityRows ?? []}
                    reviewRows={conversationReviewRows}
                    studentCount={rosterRows.length || students.length}
                    onOpenPriorityStudent={(row) => openOverviewRoster(row.studentName, row.studentId, row.studentEmail)}
                    onReviewConversation={(row) => openOverviewConversation(row.title, row.studentName, row.id)}
                    onReviewProfiles={() => {
                      setActiveTab("roster");
                      setIsRosterDetailOpen(true);
                      setRosterDetailFocus("activity");
                    }}
                  />
                ) : null}

                {renderLegacyOverview && activeTab === "overview" ? (
                  <div className="overview-workspace teacher-content-block" role="tabpanel" aria-busy={isLoadingClassOverview}>
                    <div className="overview-heading-row">
                      <div className="overview-title-block">
                        <h2>Today&apos;s Teacher Dashboard</h2>
                      </div>
                      <div className="overview-header-actions" aria-label="Overview actions">
                        <span className="overview-date-button" aria-label="Overview date">
                          <CalendarIcon />
                          {overviewDateLabel}
                        </span>
                        <button
                          className="overview-primary-action"
                          type="button"
                          onClick={() => openOverviewConversation()}
                        >
                          Review today
                        </button>
                        <Link
                          className="overview-student-view-action"
                          href={`/student?classId=${selectedClass.id}&preview=teacher`}
                        >
                          <UserIcon />
                          Student view
                        </Link>
                      </div>
                    </div>

                    <div className="overview-command-grid">
                      <div className="overview-command-column">
                        <section className="overview-panel overview-trend-panel" aria-labelledby="overview-summary-title">
                          <div className="overview-trend-copy">
                            <p className="overview-panel-eyebrow">Today&apos;s summary</p>
                            <h3 id="overview-summary-title">{overviewSummary?.title ?? "No overview data yet"}</h3>
                            <p>{overviewSummary?.body ?? "Student activity will appear here after students use Chandra."}</p>
                            {overviewTopTopics.length ? (
                              <div className="overview-topic-list" aria-label="Top topics">
                                {overviewTopTopics.map((topic) => (
                                  <span key={topic}>{topic}</span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="overview-chart-card" aria-label="Overview metrics">
                            <span>Today</span>
                            <dl className="overview-metric-list">
                              <div>
                                <dt>Questions</dt>
                                <dd>{overviewSummary?.questionsToday ?? 0}</dd>
                              </div>
                              <div>
                                <dt>Conversations</dt>
                                <dd>{overviewSummary?.conversationCountToday ?? 0}</dd>
                              </div>
                              <div>
                                <dt>Active students</dt>
                                <dd>{overviewSummary?.activeStudentsToday ?? 0}</dd>
                              </div>
                            </dl>
                          </div>
                        </section>

                        <section className="overview-panel overview-review-panel" aria-labelledby="overview-review-title">
                          <div className="overview-review-panel-heading">
                            <div>
                              <h3 id="overview-review-title">Student review queue</h3>
                              <p>Teacher checks that are ready for a quick decision.</p>
                            </div>
                            {overviewReviewQueueRows.length ? (
                              <em>{overviewReviewQueueRows.length} waiting</em>
                            ) : null}
                          </div>
                          <div className="overview-review-list" role="list" aria-label="Student review queue">
                            {overviewReviewQueueRows.map((row) => (
                              <div className={`overview-review-card ${overviewStatusToneClass(row.tone)}`} role="listitem" key={row.id}>
                                <span className="overview-review-main">
                                  <span className="overview-student-icon" aria-hidden="true"><UserIcon /></span>
                                  <span className="overview-review-copy">
                                    <span className="overview-review-student-line">
                                      <strong>{row.studentName}</strong>
                                      <span>{row.title}</span>
                                    </span>
                                    <span className="overview-review-heading">
                                      <strong>{row.issue}</strong>
                                      <span className="overview-review-badges">
                                        <span className={`overview-status-pill ${overviewStatusToneClass(row.tone)}`}>
                                          {formatOverviewAttention(row.tone)}
                                        </span>
                                        <span className="overview-status-pill neutral">
                                          {row.status}
                                        </span>
                                      </span>
                                    </span>
                                    <small>{row.suggestedAction}</small>
                                  </span>
                                </span>
                                <span className="overview-review-meta">
                                  <em>{row.sourceLabel}</em>
                                  <em>{row.lastMessageLabel}</em>
                                </span>
                                <span className="overview-review-actions">
                                  <button
                                    className="overview-small-action"
                                    type="button"
                                    onClick={() => openOverviewConversation(row.title, row.studentName, row.conversationId)}
                                  >
                                    Review chat
                                  </button>
                                  <button
                                    className="overview-link-action compact"
                                    type="button"
                                    onClick={() => openOverviewRoster(row.studentName, row.studentId)}
                                  >
                                    Open roster
                                  </button>
                                </span>
                              </div>
                            ))}
                            {!overviewReviewQueueRows.length ? (
                              <div className="empty-state overview-empty-state">
                                <strong>No conversations need review</strong>
                                <span>New review items will appear here when saved chats require teacher attention.</span>
                              </div>
                            ) : null}
                          </div>
                          <button className="overview-link-action" type="button" onClick={() => setActiveTab("conversations")}>
                            View full activity log
                            <ChevronRightIcon />
                          </button>
                        </section>
                      </div>

                      <div className="overview-command-column">
                        <section className="overview-panel overview-actions-panel" aria-labelledby="overview-next-title">
                          <h3 id="overview-next-title">Next best actions</h3>
                          {overviewNextActions.length ? (
                            <div className="overview-next-action-list">
                              {overviewNextActions.map((action, index) => (
                                <div className="overview-next-action-row" key={action.id}>
                                  <span className="overview-action-number">{index + 1}</span>
                                  <span className="overview-next-action-copy">
                                    <span className="overview-next-action-heading">
                                      <strong>{action.label}</strong>
                                      <em className={`overview-action-priority ${action.priority}`}>
                                        {formatOverviewActionPriority(action.priority)}
                                      </em>
                                    </span>
                                    <small>{action.detail}</small>
                                    {action.rationale[0] ? (
                                      <span className="overview-next-action-reason">
                                        Why: {action.rationale[0]}
                                      </span>
                                    ) : null}
                                  </span>
                                  <button
                                    className="overview-small-action"
                                    type="button"
                                    onClick={() => handleOverviewNextAction(action)}
                                  >
                                    {formatOverviewNextActionButton(action.action)}
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="empty-state overview-empty-state">
                              <strong>No actions right now</strong>
                              <span>Chandra will surface follow-ups after roster, source, or conversation activity changes.</span>
                            </div>
                          )}
                        </section>

                        <section className="overview-panel overview-knowledge-panel" aria-labelledby="overview-knowledge-title">
                          <h3 id="overview-knowledge-title">Knowledge status</h3>
                          <div className="overview-knowledge-strip" aria-label="Knowledge source status">
                            <span>
                              <CheckCircleIcon />
                              Ready
                            </span>
                            <span>
                              <BookOpenIcon />
                              {activeSourceLabel}
                            </span>
                            <span>
                              <DatabaseIcon />
                              {overviewActiveSourceCount ? "Retrieval available" : "No active retrieval sources"}
                            </span>
                          </div>
                          <div className="overview-knowledge-actions">
                            <button
                              className="overview-small-action"
                              type="button"
                              onClick={() => setIsKnowledgeDialogOpen(true)}
                            >
                              Add knowledge
                            </button>
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeTab === "settings" ? (
                  <form
                    className="class-settings-form settings-workspace ai-tutor-workspace teacher-content-block"
                    id="class-settings-form"
                    key={selectedClass.id}
                    onSubmit={submitSettings}
                  >
                    <section className="settings-detail ai-tutor-section-panel" aria-labelledby="settings-detail-title">
                      <div className="ai-tutor-section-heading settings-page-heading">
                        <div>
                          <h2 id="settings-detail-title">{activeSettingsSection.label}</h2>
                          <span>{activeSettingsSection.description}</span>
                        </div>
                      </div>

                      <div className="settings-pane-stack">
                        <div className="settings-pane" hidden={activeSettingsPane !== "general"}>
                          <section className="settings-group" aria-labelledby="settings-class-details">
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

                            <label className="field-label" htmlFor="opening-message">
                              Student opening message
                            </label>
                            <textarea
                              id="opening-message"
                              name="openingMessage"
                              rows={3}
                              defaultValue={selectedOpeningMessage}
                              placeholder="Hi. I can help with Algebra step by step. What problem are you on?"
                            />

                            <label className="field-label" htmlFor="student-facing-instructions">
                              Student-facing instructions
                            </label>
                            <textarea
                              id="student-facing-instructions"
                              name="studentFacingInstructions"
                              rows={4}
                              defaultValue={selectedStudentFacingInstructions}
                              placeholder="Show your work. Use exact values unless asked for decimals."
                            />

                            <div className="settings-toggle-list">
                              <SettingsToggle
                                defaultChecked={selectedTutorAccess.enabled}
                                description={
                                  selectedTutorAccess.enabled
                                    ? "Students can send messages. Teacher preview remains available if paused."
                                    : "Students see that chat is paused. Teacher preview remains available."
                                }
                                name="tutorAccess.enabled"
                                title={selectedTutorAccess.enabled ? "Student chat enabled" : "Student chat paused"}
                              />
                            </div>
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "classAccess"}>
                          <section className="settings-group settings-class-access-card" aria-labelledby="settings-class-access">
                            <h3 id="settings-class-access">Student Invites</h3>
                            <p>Share a class code or student invite link for any class you teach.</p>
                            <div className="class-invite-list">
                              {classes.map((teacherClass) => {
                                const classCode = teacherClass.joinCode?.trim() || teacherClass.id;
                                const isSelectedInviteClass = teacherClass.id === activeClassId;
                                const isResettingInviteCode = savingClassAccessAction === `reset-code:${teacherClass.id}`;
                                const codeCopyStatus =
                                  classInviteCopyResult?.classId === teacherClass.id &&
                                  classInviteCopyResult.kind === "code"
                                    ? classInviteCopyResult.status
                                    : "";
                                const linkCopyStatus =
                                  classInviteCopyResult?.classId === teacherClass.id &&
                                  classInviteCopyResult.kind === "link"
                                    ? classInviteCopyResult.status
                                    : "";

                                return (
                                  <article
                                    className="class-invite-row"
                                    data-current={isSelectedInviteClass ? "true" : undefined}
                                    key={teacherClass.id}
                                  >
                                    <div className="class-invite-details">
                                      <strong>{teacherClass.name}</strong>
                                      <span>{formatSectionLabel(teacherClass.section)}</span>
                                    </div>
                                    <div className="class-invite-share">
                                      <div className="class-invite-code" aria-label={`${teacherClass.name} class code`}>
                                        <span>Class code</span>
                                        <code>{classCode}</code>
                                      </div>
                                      <div className="class-invite-actions">
                                        <button
                                          className="teacher-action-button"
                                          type="button"
                                          onClick={() => void copyClassInvite(teacherClass, "code")}
                                        >
                                          <CopyIcon />
                                          {codeCopyStatus === "copied"
                                            ? "Copied"
                                            : codeCopyStatus === "failed"
                                              ? "Copy failed"
                                              : "Copy code"}
                                        </button>
                                        <button
                                          className="teacher-action-button"
                                          type="button"
                                          onClick={() => void copyClassInvite(teacherClass, "link")}
                                        >
                                          <LinkIcon />
                                          {linkCopyStatus === "copied"
                                            ? "Copied"
                                            : linkCopyStatus === "failed"
                                              ? "Copy failed"
                                              : "Copy link"}
                                        </button>
                                        <button
                                          className="teacher-action-button"
                                          disabled={isResettingInviteCode}
                                          type="button"
                                          onClick={() => void resetClassInviteCode(teacherClass)}
                                        >
                                          <RefreshIcon />
                                          {isResettingInviteCode ? "Resetting" : "Reset code"}
                                        </button>
                                      </div>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                            {classAccessMessage ? <p className="settings-status-message">{classAccessMessage}</p> : null}
                          </section>

                          <section className="settings-group settings-co-teachers-card" aria-labelledby="settings-co-teachers">
                            <h3 id="settings-co-teachers">Co-teachers</h3>
                            <p>Owner access belongs to the primary class teacher. Added teachers can help manage or view the class.</p>
                            <div className="settings-field-pair">
                              <div>
                                <label className="field-label" htmlFor="co-teacher-email">
                                  Teacher email
                                </label>
                                <input
                                  id="co-teacher-email"
                                  type="email"
                                  value={coTeacherEmail}
                                  onChange={(event) => setCoTeacherEmail(event.target.value)}
                                  placeholder="teacher@example.com"
                                />
                              </div>
                              <div>
                                <label className="field-label" htmlFor="co-teacher-role">
                                  Permission
                                </label>
                                <select
                                  id="co-teacher-role"
                                  value={coTeacherRole}
                                  onChange={(event) => setCoTeacherRole(event.target.value as Exclude<ClassAccessRole, "owner">)}
                                >
                                  <option value="co-teacher">Co-teacher</option>
                                  <option value="viewer">Viewer</option>
                                </select>
                              </div>
                            </div>
                            <button
                              className="teacher-action-button"
                              disabled={!coTeacherEmail.trim() || savingClassAccessAction === "add-co-teacher"}
                              type="button"
                              onClick={() => void addCoTeacher()}
                            >
                              <UserPlusIcon />
                              {savingClassAccessAction === "add-co-teacher" ? "Adding" : "Add co-teacher"}
                            </button>

                            <div className="class-invite-list">
                              <CoTeacherRow
                                displayName={selectedClass.teacherName}
                                email=""
                                role="Owner"
                              />
                              {Object.values(selectedCoTeachers).map((coTeacher) => (
                                <CoTeacherRow
                                  coTeacher={coTeacher}
                                  disabled={savingClassAccessAction.includes(coTeacher.uid)}
                                  key={coTeacher.uid}
                                  onRemove={() => void removeCoTeacher(coTeacher)}
                                  onRoleChange={(role) => void updateCoTeacherRole(coTeacher, role)}
                                  role={coTeacher.role === "co-teacher" ? "Co-teacher" : "Viewer"}
                                />
                              ))}
                            </div>
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "privacy"}>
                          <section className="settings-group" aria-labelledby="settings-privacy">
                            <h3 id="settings-privacy">Conversation Retention</h3>
                            <p>Saved as a class policy. Conversations older than the selected window are deleted when the protected server retention job runs; choosing a shorter window does not delete existing conversations immediately.</p>
                            <label className="settings-control-label" htmlFor="conversation-retention">
                              Retention policy
                            </label>
                            <select
                              id="conversation-retention"
                              name="privacySettings.conversationRetention"
                              defaultValue={selectedPrivacySettings.conversationRetention}
                            >
                              {conversationRetentionOptions.map((option) => (
                                <option key={option} value={option}>
                                  {formatConversationRetention(option)}
                                </option>
                              ))}
                            </select>
                          </section>

                          <section className="settings-group" aria-labelledby="settings-student-data">
                            <h3 id="settings-student-data">Student Data</h3>
                            <p>Search for a student, select the matching record, then export or permanently delete all class-scoped data stored for that student.</p>
                            <label className="settings-search-field" htmlFor="privacy-student-search">
                              <SearchIcon />
                              <input
                                id="privacy-student-search"
                                placeholder="Search students by name or email"
                                type="search"
                                value={privacyStudentSearchQuery}
                                onChange={(event) => {
                                  setPrivacyStudentSearchQuery(event.target.value);
                                  setPrivacyDataMessage("");
                                }}
                              />
                            </label>

                            {privacyStudentSearchQuery.trim() ? (
                              <div className="privacy-student-results" aria-label="Student search results">
                                {privacyStudentSearchResults.map((student) => (
                                  <button
                                    aria-pressed={selectedPrivacyStudentId === student.id}
                                    className="privacy-student-result"
                                    key={student.id}
                                    type="button"
                                    onClick={() => {
                                      setSelectedPrivacyStudentId(student.id);
                                      setPrivacyDataMessage("");
                                    }}
                                  >
                                    <strong>{student.displayName || "Unnamed student"}</strong>
                                    <span>{student.email}</span>
                                  </button>
                                ))}
                                {!privacyStudentSearchResults.length ? (
                                  <p className="settings-empty-message">No matching students found.</p>
                                ) : null}
                              </div>
                            ) : (
                              <p className="settings-empty-message">Enter a name or email to find a student.</p>
                            )}

                            {selectedPrivacyStudent ? (
                              <div className="class-invite-list">
                                <article className="class-invite-row privacy-selected-student">
                                  <div className="class-invite-details">
                                    <strong>{selectedPrivacyStudent.displayName || "Unnamed student"}</strong>
                                    <span>{selectedPrivacyStudent.email}</span>
                                  </div>
                                  <div className="class-invite-actions">
                                    <button
                                      className="teacher-action-button"
                                      disabled={savingPrivacyDataAction === `export:${selectedPrivacyStudent.id}`}
                                      type="button"
                                      onClick={() => void exportStudentClassData(selectedPrivacyStudent)}
                                    >
                                      <DownloadIcon />
                                      {savingPrivacyDataAction === `export:${selectedPrivacyStudent.id}` ? "Exporting" : "Export JSON"}
                                    </button>
                                    <button
                                      className="teacher-danger-button"
                                      disabled={savingPrivacyDataAction === `delete:${selectedPrivacyStudent.id}`}
                                      type="button"
                                      onClick={() => void deleteStudentClassData(selectedPrivacyStudent)}
                                    >
                                      <TrashIcon />
                                      {savingPrivacyDataAction === `delete:${selectedPrivacyStudent.id}` ? "Deleting" : "Delete class data"}
                                    </button>
                                  </div>
                                </article>
                              </div>
                            ) : null}
                            {privacyDataMessage ? <p className="settings-status-message">{privacyDataMessage}</p> : null}
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "sourceDefaults"}>
                          <section className="settings-group" aria-labelledby="settings-source-defaults">
                            <h3 id="settings-source-defaults">New Material Defaults</h3>
                            <p>Uploads inherit these defaults unless a material-specific setting overrides them later.</p>
                            <div className="settings-toggle-list">
                              <SettingsToggle
                                defaultChecked={selectedSourceDefaults.activeForStudents}
                                description="New sources are visible to students after processing unless teacher-only is enabled."
                                name="sourceDefaults.activeForStudents"
                                title="Active for students"
                              />
                              <SettingsToggle
                                defaultChecked={selectedSourceDefaults.teacherOnly}
                                description="New sources are saved for teacher review and hidden from student retrieval."
                                name="sourceDefaults.teacherOnly"
                                title="Teacher only"
                              />
                              <SettingsToggle
                                defaultChecked={selectedSourceDefaults.citationsRequired}
                                description="New sources should require citations when Chandra uses them."
                                name="sourceDefaults.citationsRequired"
                                title="Citations required"
                              />
                              <SettingsToggle
                                defaultChecked={selectedSourceDefaults.answerKeysTeacherReviewOnly}
                                description="Answer keys and solution materials default to teacher review only."
                                name="sourceDefaults.answerKeysTeacherReviewOnly"
                                title="Use answer keys only for teacher review"
                              />
                            </div>

                            <label className="settings-control-label" htmlFor="source-default-priority">
                              Default priority
                            </label>
                            <select
                              id="source-default-priority"
                              name="sourceDefaults.priority"
                              defaultValue={selectedSourceDefaults.priority}
                            >
                              <option value="primary">Primary</option>
                              <option value="normal">Normal</option>
                              <option value="low">Low</option>
                            </select>
                          </section>

                          <section className="settings-group" aria-labelledby="settings-source-type-preferences">
                            <h3 id="settings-source-type-preferences">Source-type Preferences</h3>
                            <p>Choose whether common source types should inherit the defaults or use a stricter visibility preference.</p>
                            <div className="settings-field-pair">
                              {materialSourceTypeKeys.map((kind) => (
                                <div key={kind}>
                                  <label className="field-label" htmlFor={`source-type-${kind}`}>
                                    {kind}
                                  </label>
                                  <select
                                    id={`source-type-${kind}`}
                                    name={`sourceDefaults.sourceTypePreferences.${kind}`}
                                    defaultValue={selectedSourceDefaults.sourceTypePreferences[kind]}
                                  >
                                    {materialSourceTypePreferenceOptions.map((preference) => (
                                      <option key={preference} value={preference}>
                                        {formatSourceTypePreference(preference)}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "notifications"}>
                          <section className="settings-group" aria-labelledby="settings-notifications">
                            <h3 id="settings-notifications">Notification Preferences</h3>
                            <p>Preferences are saved for future notification jobs. Email or push delivery is not sent from this settings screen.</p>
                            <div className="settings-toggle-list">
                              <SettingsToggle
                                defaultChecked={selectedNotificationSettings.weeklyDigest}
                                description="Include this class in future weekly teacher digest jobs."
                                name="notificationSettings.weeklyDigest"
                                title="Weekly digest"
                              />
                              <SettingsToggle
                                defaultChecked={selectedNotificationSettings.followUpReminders}
                                description="Allow future jobs to remind you about conversations marked for follow-up."
                                name="notificationSettings.followUpReminders"
                                title="Follow-up reminders"
                              />
                              <SettingsToggle
                                defaultChecked={selectedNotificationSettings.newStudentJoinedClass}
                                description="Allow future jobs to notify you when a student joins this class."
                                name="notificationSettings.newStudentJoinedClass"
                                title="New student joined class"
                              />
                            </div>
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "guidance"}>
                          <section className="settings-group compact-settings-group" aria-labelledby="settings-tutor-behavior">
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

                          <section className="settings-group" aria-labelledby="settings-hidden-instructions">
                            <h3 id="settings-hidden-instructions">Hidden Tutor Instructions</h3>
                            <p>Teacher-only instructions not shown to students.</p>
                            <textarea
                              id="behavior-instructions"
                              name="behaviorInstructions"
                              rows={6}
                              defaultValue={selectedClass.behaviorInstructions ?? ""}
                            />
                          </section>

                          <section className="settings-group" aria-labelledby="settings-refusal-style">
                            <h3 id="settings-refusal-style">Direct-answer Redirect</h3>
                            <p>Tell Chandra how to respond when students ask for answers only.</p>
                            <textarea
                              id="refusal-style"
                              name="refusalStyle"
                              rows={5}
                              defaultValue={selectedClass.refusalStyle ?? defaultRefusalStyle}
                            />
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "answerPolicy"}>
                          <section className="settings-group" aria-labelledby="settings-answer-policy">
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
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "model"}>
                          <section className="settings-group" aria-labelledby="settings-model">
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
                              style={{ "--settings-slider-fill": `${displayedCreativity}%` } as CSSProperties}
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

                            <div className="ai-tutor-control-grid">
                              <TokenLimitInputs
                                idPrefix="settings-token-limit"
                                labelClassName="settings-control-label"
                                requestLimits={selectedModelSettings.requestLimits}
                                tokenLimits={selectedModelSettings.tokenLimits}
                              />
                            </div>
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "response"}>
                          <section className="settings-group" aria-labelledby="settings-response-format">
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
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "sources"}>
                          <section className="settings-group" aria-labelledby="settings-source-usage">
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

                        <div className="settings-pane" hidden={activeSettingsPane !== "invites"}>
                          <section className="settings-group" aria-labelledby="settings-teacher-invites">
                            <h3 id="settings-teacher-invites">Teacher Invites</h3>
                            <p>Create a one-use link for another teacher to join Chandra.</p>
                            <div className="teacher-invite-actions">
                              <button
                                className="teacher-action-button"
                                disabled={isCreatingTeacherInvite}
                                title="Create a one-use teacher invite link"
                                type="button"
                                onClick={createTeacherInviteLink}
                              >
                                <LinkIcon />
                                {isCreatingTeacherInvite ? "Creating" : "Create teacher invite"}
                              </button>
                            </div>
                            <div className="teacher-invite-filter" aria-label="Filter teacher invites by status">
                              {teacherInviteFilterOptions.map((filterOption) => (
                                <button
                                  aria-pressed={teacherInviteFilter === filterOption.id}
                                  key={filterOption.id}
                                  title={`Show ${filterOption.label.toLowerCase()} teacher invites`}
                                  type="button"
                                  onClick={() => setTeacherInviteFilter(filterOption.id)}
                                >
                                  {filterOption.label}
                                </button>
                              ))}
                            </div>
                            <div className="teacher-invite-list" aria-live="polite">
                              {isLoadingTeacherInvites ? (
                                <p className="settings-empty-message">Loading teacher invites.</p>
                              ) : filteredTeacherInvites.length ? (
                                filteredTeacherInvites.map((invite) => {
                                  const copyStatus =
                                    teacherInviteCopyResult?.inviteId === invite.inviteId
                                      ? teacherInviteCopyResult.status
                                      : "";
                                  const detailText = teacherInviteDetailText(invite);
                                  const isActiveInvite = invite.status === "active";

                                  return (
                                    <article
                                      className="teacher-invite-row"
                                      data-status={invite.status}
                                      key={invite.inviteId}
                                    >
                                      <div className="teacher-invite-row-main">
                                        <span className="teacher-invite-status-badge">{teacherInviteStatusLabel(invite)}</span>
                                        <span>Created {formatInviteDate(invite.createdAt)}</span>
                                        {detailText ? <strong>{detailText}</strong> : null}
                                        <span>{teacherInviteDateText(invite)}</span>
                                      </div>
                                      {isActiveInvite ? (
                                        <div className="teacher-invite-row-actions">
                                          <button
                                            className="teacher-action-button"
                                            title="Copy this teacher invite link"
                                            type="button"
                                            onClick={() => void copyTeacherInviteLink(invite)}
                                          >
                                            <CopyIcon />
                                            {copyStatus === "copied"
                                              ? "Copied"
                                              : copyStatus === "failed"
                                                ? "Copy failed"
                                                : "Copy link"}
                                          </button>
                                          <button
                                            className="teacher-danger-button"
                                            disabled={revokingTeacherInviteId === invite.inviteId}
                                            title="Revoke this teacher invite link"
                                            type="button"
                                            onClick={() => void revokeTeacherInvite(invite.inviteId)}
                                          >
                                            <TrashIcon />
                                            {revokingTeacherInviteId === invite.inviteId ? "Revoking" : "Revoke"}
                                          </button>
                                        </div>
                                      ) : null}
                                    </article>
                                  );
                                })
                              ) : (
                                <p className="settings-empty-message">{teacherInviteEmptyMessage}</p>
                              )}
                            </div>
                            {teacherInvitesMessage ? <p className="settings-status-message">{teacherInvitesMessage}</p> : null}
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "account"}>
                          <section className="settings-group" aria-labelledby="settings-account">
                            <h3 id="settings-account">Account</h3>
                            <p>Manage the profile information attached to your teacher account.</p>
                            <div className="teacher-account-settings-summary">
                              <span className="teacher-avatar" aria-hidden="true">
                                {getInitials(accountName, accountEmail)}
                              </span>
                              <dl>
                                <div>
                                  <dt>Email</dt>
                                  <dd>{accountEmail || "No email on file"}</dd>
                                </div>
                                <div>
                                  <dt>Username</dt>
                                  <dd>{accountUsernameValue || "No username on file"}</dd>
                                </div>
                                <div>
                                  <dt>Role</dt>
                                  <dd>Teacher</dd>
                                </div>
                                <div>
                                  <dt>Last sign-in</dt>
                                  <dd>{formatAccountActivityTime(accountLastSignInAt)}</dd>
                                </div>
                              </dl>
                            </div>
                            <label className="field-label" htmlFor="teacher-account-name">
                              Display name
                            </label>
                            <input
                              id="teacher-account-name"
                              maxLength={80}
                              value={accountDisplayName ?? accountName}
                              onChange={(event) => {
                                setAccountDisplayName(event.target.value);
                                setAccountSettingsMessage("");
                              }}
                            />
                            <label className="field-label" htmlFor="teacher-account-email">
                              Email
                            </label>
                            <input
                              id="teacher-account-email"
                              autoCapitalize="none"
                              autoComplete="email"
                              inputMode="email"
                              value={accountEmailValue}
                              onChange={(event) => {
                                setAccountEmailDraft(event.target.value);
                                setAccountSettingsMessage("");
                              }}
                            />
                            <label className="field-label" htmlFor="teacher-account-username">
                              Username
                            </label>
                            <input
                              id="teacher-account-username"
                              autoCapitalize="none"
                              autoComplete="username"
                              maxLength={120}
                              value={accountUsername ?? accountUsernameValue}
                              onChange={(event) => {
                                setAccountUsername(event.target.value);
                                setAccountSettingsMessage("");
                              }}
                            />
                            <div className="account-password-grid">
                              <div>
                                <label className="field-label" htmlFor="teacher-current-password">
                                  Current password
                                </label>
                                <input
                                  id="teacher-current-password"
                                  autoComplete="current-password"
                                  type="password"
                                  value={currentAccountPassword}
                                  onChange={(event) => {
                                    setCurrentAccountPassword(event.target.value);
                                    setAccountSettingsMessage("");
                                  }}
                                />
                              </div>
                              <div>
                                <label className="field-label" htmlFor="teacher-new-password">
                                  New password
                                </label>
                                <input
                                  id="teacher-new-password"
                                  autoComplete="new-password"
                                  minLength={6}
                                  type="password"
                                  value={newAccountPassword}
                                  onChange={(event) => {
                                    setNewAccountPassword(event.target.value);
                                    setAccountSettingsMessage("");
                                  }}
                                />
                              </div>
                              <div>
                                <label className="field-label" htmlFor="teacher-confirm-password">
                                  Confirm new password
                                </label>
                                <input
                                  id="teacher-confirm-password"
                                  autoComplete="new-password"
                                  minLength={6}
                                  type="password"
                                  value={confirmAccountPassword}
                                  onChange={(event) => {
                                    setConfirmAccountPassword(event.target.value);
                                    setAccountSettingsMessage("");
                                  }}
                                />
                              </div>
                            </div>
                            <button
                              className="teacher-action-button teacher-account-save-button"
                              disabled={isSavingAccountSettings}
                              type="button"
                              onClick={() => void saveAccountSettings()}
                            >
                              <UserIcon />
                              {isSavingAccountSettings ? "Saving" : "Save account"}
                            </button>
                            <button
                              className="teacher-action-button teacher-account-save-button"
                              type="button"
                              onClick={() => void handleSignOutAllSessions()}
                            >
                              <UserIcon />
                              Sign out all sessions
                            </button>
                            <button
                              className="teacher-danger-button teacher-account-save-button"
                              disabled={isDeletingAccount}
                              type="button"
                              onClick={() => void handleDeleteAccount()}
                            >
                              <TrashIcon />
                              {isDeletingAccount ? "Deleting account" : "Delete account"}
                            </button>
                            {accountSettingsMessage ? <p className="settings-status-message">{accountSettingsMessage}</p> : null}
                          </section>
                        </div>

                        <div className="settings-pane" hidden={activeSettingsPane !== "appearance"}>
                          <section className="settings-group" aria-labelledby="settings-appearance">
                            <h3 id="settings-appearance">Appearance</h3>
                            <p>These display preferences are personal to your teacher account.</p>
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
                        </div>
                      </div>
                    </section>
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
                              conversationMessages
                                .filter((message) => message.role === "student" || message.role === "assistant")
                                .map((message) => (
                                  <TeacherTranscriptMessage
                                    key={message.id}
                                    message={message}
                                    studentName={selectedStudent.displayName}
                                  />
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
                                      router.push(
                                        `/teacher/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(row.studentEmail)}`
                                      );
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
                                          setRosterDetailFocus("activity");
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
                                        aria-label={`View conversations for ${row.student.displayName}`}
                                        className="student-icon-button"
                                        title="View conversations"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSelectedStudentId(row.student.id);
                                          setSelectedStudentClassId(activeClassId);
                                          setIsRosterDetailOpen(true);
                                          setRosterDetailFocus("activity");
                                          setSelectedConversationId("");
                                          setSelectedConversationClassId(activeClassId);
                                          setConversationMessages([]);
                                          setIsProfessorReviewOpen(true);
                                        }}
                                      >
                                        <ChatIcon />
                                      </button>
                                      <button
                                        aria-label={`${row.chatBlocked ? "Allow" : "Pause"} chat for ${row.student.displayName}`}
                                        className={`student-icon-button student-chat-access-button${row.chatBlocked ? " is-paused" : ""}`}
                                        disabled={savingNotesStudentId === row.student.id}
                                        title={row.chatBlocked ? "AI paused for student" : "Pause student chat"}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void saveStudentChatBlocked(row, !row.chatBlocked);
                                        }}
                                      >
                                        <ShieldIcon />
                                      </button>
                                      <Link
                                        aria-label={`Open profile for ${row.student.displayName}`}
                                        className="student-icon-button student-profile-link"
                                        href={`/teacher/classes/${encodeURIComponent(activeClassId)}/students/${encodeURIComponent(row.studentEmail)}`}
                                        title="Open profile"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        <UserIcon />
                                      </Link>
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

                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {activeTab === "knowledge" ? (
                  <form
                    className="ai-tutor-workspace teacher-content-block"
                    id="ai-tutor-settings-form"
                    key={`ai-tutor-${selectedClass.id}`}
                    onSubmit={submitSettings}
                  >
                    <input name="name" type="hidden" defaultValue={selectedClass.name} />
                    <input name="section" type="hidden" defaultValue={selectedClass.section} />
                    <input
                      name="defaultAssignmentContext"
                      type="hidden"
                      defaultValue={selectedClass.defaultAssignmentContext ?? ""}
                    />
                    <input name="openingMessage" type="hidden" defaultValue={selectedOpeningMessage} />
                    <input
                      name="studentFacingInstructions"
                      type="hidden"
                      defaultValue={selectedStudentFacingInstructions}
                    />
                    <div hidden>
                      {sourceUsageSettings.map((setting) =>
                        selectedSourceUsage[setting.id] ? (
                          <input
                            defaultChecked
                            key={setting.id}
                            name={`sourceUsage.${setting.id}`}
                            type="checkbox"
                          />
                        ) : null
                      )}
                      <select name="sourceUsage.preferredSourceType" defaultValue={selectedSourceUsage.preferredSourceType}>
                        {preferredSourceTypeOptions.map((sourceType) => (
                          <option key={sourceType} value={sourceType}>
                            {sourceType}
                          </option>
                        ))}
                      </select>
                    </div>

                    {materialSuccess ? <p className="form-success">{materialSuccess}</p> : null}

                    <div className="ai-tutor-layout">
                      <nav className="ai-tutor-section-nav" aria-label="AI Tutor sections">
                        {aiTutorSections.map((section) => (
                          <button
                            aria-current={section.id === activeAiTutorSection ? "page" : undefined}
                            key={section.id}
                            type="button"
                            onClick={() => setActiveAiTutorSection(section.id)}
                          >
                            <span aria-hidden="true">{section.icon}</span>
                            {section.label}
                          </button>
                        ))}
                      </nav>

                      <div className="ai-tutor-panel-stack">
                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "sources"}
                          aria-labelledby="ai-tutor-sources-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-sources-title">Sources</h2>
                              <span>Upload and manage the materials Chandra can use when helping students.</span>
                            </div>
                            <button
                              className="primary-button teacher-primary-button compact"
                              type="button"
                              onClick={() => setIsKnowledgeDialogOpen(true)}
                            >
                              Add source
                            </button>
                          </div>

                          <section className="knowledge-library-card" aria-labelledby="knowledge-library-title">
                            <div className="knowledge-library-heading">
                              <h3 id="knowledge-library-title">Source Library</h3>
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
                                <span role="columnheader">Type</span>
                                <span role="columnheader">Visibility</span>
                                <span role="columnheader">Status</span>
                                <span role="columnheader">Pages</span>
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
                                      {formatKnowledgeType(material)}
                                    </span>
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
                                        aria-label={`Open settings for ${material.title}`}
                                        className="knowledge-icon-button"
                                        title="Source settings"
                                        type="button"
                                        onClick={() => openMaterialDetail(material)}
                                      >
                                        <SettingsIcon />
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
                                  <strong>No sources</strong>
                                  <span>Add a source for this class to make it available to Chandra.</span>
                                </div>
                              ) : null}
                            </div>
                          </section>

                        </section>

                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "access"}
                          aria-labelledby="ai-tutor-access-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-access-title">Access</h2>
                              <span>Pause or allow student access to Chandra for this class.</span>
                            </div>
                          </div>
                          <section className="ai-tutor-card" aria-labelledby="ai-tutor-access-card-title">
                            <h3 id="ai-tutor-access-card-title">
                              {selectedTutorAccess.enabled ? "Student chat is on" : "Student chat is paused"}
                            </h3>
                            <div className="settings-toggle-list">
                              <SettingsToggle
                                defaultChecked={selectedTutorAccess.enabled}
                                description="When paused, students can read saved chats but cannot send new messages. Teacher preview still works."
                                name="tutorAccess.enabled"
                                title="Allow students to use AI chat"
                              />
                            </div>
                          </section>
                        </section>

                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "behavior"}
                          aria-labelledby="ai-tutor-behavior-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-behavior-title">Behavior</h2>
                              <span>Choose how Chandra should guide students.</span>
                            </div>
                          </div>
                          <section className="ai-tutor-card" aria-labelledby="ai-tutor-behavior-card-title">
                            <h3 id="ai-tutor-behavior-card-title">Tutor Behavior</h3>
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

                            <label className="ai-tutor-control-label" htmlFor="ai-behavior-instructions">
                              Hidden tutor instructions
                            </label>
                            <p>Teacher-only instructions not shown to students.</p>
                            <textarea
                              id="ai-behavior-instructions"
                              name="behaviorInstructions"
                              rows={7}
                              defaultValue={selectedBehaviorInstructions}
                            />

                            <label className="ai-tutor-control-label" htmlFor="ai-refusal-style">
                              Direct-answer redirect
                            </label>
                            <p>Tell Chandra how to respond when students ask for answers only.</p>
                            <textarea
                              id="ai-refusal-style"
                              name="refusalStyle"
                              rows={4}
                              defaultValue={selectedRefusalStyle}
                            />
                          </section>
                        </section>

                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "answerPolicy"}
                          aria-labelledby="ai-tutor-answer-policy-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-answer-policy-title">Answer Policy</h2>
                              <span>Set guardrails for how Chandra responds to student questions.</span>
                            </div>
                          </div>
                          <section className="ai-tutor-card" aria-labelledby="ai-tutor-answer-policy-card-title">
                            <h3 id="ai-tutor-answer-policy-card-title">Guardrails</h3>
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
                        </section>

                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "response"}
                          aria-labelledby="ai-tutor-response-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-response-title">Response</h2>
                              <span>Control the structure and reading style of tutoring replies.</span>
                            </div>
                          </div>
                          <section className="ai-tutor-card" aria-labelledby="ai-tutor-response-card-title">
                            <h3 id="ai-tutor-response-card-title">Response Format</h3>
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

                            <div className="ai-tutor-control-grid">
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-reading-level">
                                  Reading level
                                </label>
                                <select
                                  id="ai-reading-level"
                                  name="responseFormat.readingLevel"
                                  defaultValue={selectedResponseFormat.readingLevel}
                                >
                                  {readingLevelOptions.map((readingLevel) => (
                                    <option key={readingLevel} value={readingLevel}>
                                      {capitalizeLabel(readingLevel)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-math-notation">
                                  Math notation
                                </label>
                                <select
                                  id="ai-math-notation"
                                  name="responseFormat.mathNotation"
                                  defaultValue={selectedResponseFormat.mathNotation}
                                >
                                  {mathNotationOptions.map((notation) => (
                                    <option key={notation} value={notation}>
                                      {formatMathNotationLabel(notation)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-response-length">
                                  Max response length
                                </label>
                                <select
                                  id="ai-response-length"
                                  name="modelSettings.responseLength"
                                  value={displayedResponseLength}
                                  onChange={(event) =>
                                    setAiTutorResponseLengthPreview({
                                      classId: activeClassId,
                                      value: event.target.value
                                    })
                                  }
                                >
                                  {responseLengthOptions.map((responseLength) => (
                                    <option key={responseLength} value={responseLength}>
                                      {formatResponseLengthLabel(responseLength)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </section>
                        </section>

                        <section
                          className="ai-tutor-section-panel"
                          hidden={activeAiTutorSection !== "model"}
                          aria-labelledby="ai-tutor-model-title"
                        >
                          <div className="ai-tutor-section-heading">
                            <div>
                              <h2 id="ai-tutor-model-title">Model</h2>
                              <span>Configure the model behavior for this class.</span>
                            </div>
                          </div>
                          <section className="ai-tutor-card ai-tutor-model-card" aria-labelledby="ai-tutor-model-card-title">
                            <h3 id="ai-tutor-model-card-title">Model Behavior</h3>
                            <div className="ai-tutor-control-grid">
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-class-model">
                                  Model
                                </label>
                                <select id="ai-class-model" name="modelSettings.modelId" defaultValue={selectedModelSettings.modelId}>
                                  {selectableModelOptions.map((modelOption) => (
                                    <option key={modelOption.id} value={modelOption.id}>
                                      {modelOption.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-reasoning-effort">
                                  Thinking time
                                </label>
                                <select
                                  id="ai-reasoning-effort"
                                  name="modelSettings.reasoningEffort"
                                  defaultValue={selectedModelSettings.reasoningEffort}
                                >
                                  {reasoningEffortOptions.map((effort) => (
                                    <option key={effort} value={effort}>
                                      {formatThinkingTimeLabel(effort)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="ai-tutor-control-label" htmlFor="ai-model-response-length">
                                  Max response length
                                </label>
                                <select
                                  id="ai-model-response-length"
                                  value={displayedResponseLength}
                                  onChange={(event) =>
                                    setAiTutorResponseLengthPreview({
                                      classId: activeClassId,
                                      value: event.target.value
                                    })
                                  }
                                >
                                  {responseLengthOptions.map((responseLength) => (
                                    <option key={responseLength} value={responseLength}>
                                      {formatResponseLengthLabel(responseLength)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

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
                              style={{ "--settings-slider-fill": `${displayedCreativity}%` } as CSSProperties}
                              onChange={(event) =>
                                setSettingsCreativityPreview({
                                  classId: activeClassId,
                                  value: Number(event.target.value)
                                })
                              }
                            />

                            <div className="ai-tutor-control-grid">
                              <TokenLimitInputs
                                idPrefix="ai-token-limit"
                                labelClassName="ai-tutor-control-label"
                                requestLimits={selectedModelSettings.requestLimits}
                                tokenLimits={selectedModelSettings.tokenLimits}
                              />
                            </div>
                          </section>
                        </section>

                      </div>
                    </div>
                  </form>
                ) : null}

                {activeTab === "conversations" ? (
                  <div className="conversation-review-page teacher-content-block">
                    <div className="teacher-section-heading conversation-review-heading">
                      <div>
                        <h2>Conversation Review</h2>
                        <span>
                          Review student chats, source usage, and follow-up opportunities across {selectedClass.name}.
                        </span>
                      </div>
                    </div>

                    {conversationError ? <p className="form-error">{conversationError}</p> : null}

                    <div className="conversation-review-grid">
                      <section className="conversation-inbox-panel" aria-label="Conversation Inbox">
                        <div className="conversation-panel-heading">
                          <h3>Conversation Inbox</h3>
                        </div>
                        <label className="conversation-search conversation-inbox-search" htmlFor="conversation-search-input">
                          <SearchIcon />
                          <input
                            id="conversation-search-input"
                            placeholder="Search conversations"
                            type="search"
                            value={conversationSearchQuery}
                            onChange={(event) => setConversationSearchQuery(event.target.value)}
                          />
                        </label>
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
                                {conversation.feedbackSummary.openCount > 0 ? (
                                  <span className="conversation-status-pill feedback">
                                    {conversation.feedbackSummary.openCount} feedback
                                  </span>
                                ) : null}
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
                              <span>
                                {conversationReviewRows.length
                                  ? "Try a different review category or search term."
                                  : "Saved student chats will appear here after students use Chandra."}
                              </span>
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
                            transcriptMessages.map((message) => (
                              <TeacherTranscriptMessage
                                key={message.id}
                                message={message}
                                studentName={selectedConversationReviewRow?.studentName ?? "Student"}
                              />
                            ))
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
                        <section className="review-side-panel" aria-labelledby="student-feedback-title">
                          <div className="conversation-panel-heading">
                            <h3 id="student-feedback-title">Student Feedback</h3>
                            <span>
                              {selectedConversationReviewRow
                                ? `${selectedConversationReviewRow.feedbackSummary.openCount} open`
                                : "Select a conversation"}
                            </span>
                          </div>
                          {selectedConversationReviewRow?.feedback.length ? (
                            <div className="student-feedback-list">
                              {selectedConversationReviewRow.feedback.map((feedback) => (
                                <article className="student-feedback-card" key={feedback.id}>
                                  <div className="student-feedback-card-heading">
                                    <strong>
                                      {feedback.kind === "usage_request"
                                        ? formatStudentFeedbackKind(feedback.kind)
                                        : formatStudentFeedbackRating(feedback.rating)}
                                    </strong>
                                    <span className={`conversation-status-pill feedback-${feedback.status}`}>
                                      {formatStudentFeedbackStatus(feedback.status)}
                                    </span>
                                  </div>
                                  <p>{feedback.comment}</p>
                                  <div className="student-feedback-meta">
                                    <span>{formatConversationDate(feedback.createdAt) || "No date"}</span>
                                    {feedback.messageId ? <span>Message {feedback.messageId.slice(0, 8)}</span> : null}
                                    {feedback.promptReason ? <span>{formatStudentFeedbackPromptReason(feedback.promptReason)}</span> : null}
                                    {feedback.usageAllowancePercent ? <span>+{feedback.usageAllowancePercent}% approved</span> : null}
                                  </div>
                                  {feedback.kind === "usage_request" && feedback.status !== "resolved" ? (
                                    <label className="student-feedback-usage-allowance">
                                      <span>Extra usage today</span>
                                      <input
                                        max={500}
                                        min={1}
                                        step={1}
                                        type="number"
                                        value={feedbackUsageAllowanceById[feedback.id] ?? "25"}
                                        onChange={(event) =>
                                          setFeedbackUsageAllowanceById((currentAllowances) => ({
                                            ...currentAllowances,
                                            [feedback.id]: event.target.value
                                          }))
                                        }
                                      />
                                      <em>%</em>
                                    </label>
                                  ) : null}
                                  <label className="sr-only" htmlFor={`feedback-teacher-note-${feedback.id}`}>
                                    Teacher-only note
                                  </label>
                                  <textarea
                                    id={`feedback-teacher-note-${feedback.id}`}
                                    maxLength={1000}
                                    placeholder="Teacher-only feedback note..."
                                    rows={2}
                                    value={feedbackTeacherNotesById[feedback.id] ?? feedback.teacherNote ?? ""}
                                    onChange={(event) =>
                                      setFeedbackTeacherNotesById((currentNotes) => ({
                                        ...currentNotes,
                                        [feedback.id]: event.target.value
                                      }))
                                    }
                                  />
                                  <div className="student-feedback-actions">
                                    <button
                                      disabled={savingFeedbackId === feedback.id || feedback.status === "reviewed"}
                                      type="button"
                                      onClick={() => void saveStudentFeedbackReview(feedback, "reviewed")}
                                    >
                                      Reviewed
                                    </button>
                                    <button
                                      disabled={savingFeedbackId === feedback.id || feedback.status === "resolved"}
                                      type="button"
                                      onClick={() => void saveStudentFeedbackReview(feedback, "resolved")}
                                    >
                                      {feedback.kind === "usage_request" ? "Approve usage" : "Resolve"}
                                    </button>
                                  </div>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <p className="review-panel-empty-copy">
                              Student feedback for the selected conversation will appear here.
                            </p>
                          )}
                        </section>

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
                )}
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
                <dt>Pages</dt>
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
              <div className="material-detail-section-heading">
                <h4 id="material-detail-visibility">Visibility &amp; Priority</h4>
                {selectedMaterialSettings ? (
                  <span className={`knowledge-badge ${knowledgeVisibilityClass(selectedMaterialSettings)}`}>
                    {formatKnowledgeVisibility(selectedMaterialSettings)}
                  </span>
                ) : null}
              </div>
              <div className="material-detail-settings-grid">
                <div className="knowledge-toggle-list">
                  <KnowledgeToggle
                    checked={displayedSourceSettings.activeForStudents}
                    disabled={!selectedMaterial}
                    label="Active for students"
                    onChange={(checked) => updateKnowledgeSourceSetting(selectedMaterial.id, { activeForStudents: checked })}
                  />
                  <KnowledgeToggle
                    checked={displayedSourceSettings.teacherOnly}
                    disabled={!selectedMaterial}
                    label="Teacher-only material"
                    onChange={(checked) => updateKnowledgeSourceSetting(selectedMaterial.id, { teacherOnly: checked })}
                  />
                  <KnowledgeToggle
                    checked={displayedSourceSettings.citationsRequired}
                    disabled={!selectedMaterial}
                    label="Require citations"
                    onChange={(checked) => updateKnowledgeSourceSetting(selectedMaterial.id, { citationsRequired: checked })}
                  />
                </div>

                <div className="knowledge-priority-control">
                  <label className="field-label" htmlFor="material-detail-priority">
                    Priority
                  </label>
                  <select
                    disabled={!selectedMaterial}
                    id="material-detail-priority"
                    value={displayedSourceSettings.priority}
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
                </div>
              </div>
            </section>

            <section className="material-detail-section" aria-labelledby="material-detail-retrieval">
              <div className="material-detail-section-heading">
                <div>
                  <h4 id="material-detail-retrieval">Retrieval Test</h4>
                  <span>Check what Chandra finds before students see it.</span>
                </div>
              </div>
              <div className="retrieval-test-form">
                <label className="sr-only" htmlFor="material-detail-retrieval-query">
                  Retrieval test query
                </label>
                <div className="retrieval-search-row">
                  <span aria-hidden="true">
                    <SearchIcon />
                  </span>
                  <input
                    id="material-detail-retrieval-query"
                    placeholder="Try a student question or problem number"
                    value={retrievalQuery}
                    onChange={(event) => setRetrievalQuery(event.target.value)}
                  />
                  <button
                    className="secondary-button compact"
                    disabled={isTestingRetrieval || !selectedMaterial}
                    type="button"
                    onClick={() => void runRetrievalTest()}
                  >
                    {isTestingRetrieval ? "Testing" : "Test search"}
                  </button>
                </div>
              </div>
              <div className="retrieval-results">
                <div className="retrieval-results-heading">
                  <span>Source</span>
                  <span>Page</span>
                  <span>Confidence</span>
                </div>
                {retrievalResults.map((result) => (
                  <div className="retrieval-result-row" key={`${result.title}-${result.chunkId}`}>
                    <strong>{result.title}</strong>
                    <span>{formatRetrievalPageLabel(result.chunkLabel)}</span>
                    <strong>{formatRetrievalConfidence(result.confidence)}</strong>
                  </div>
                ))}
                {!retrievalResults.length ? (
                  <div className="empty-state retrieval-empty-state">
                    <strong>No retrieval results yet</strong>
                    <span>Run a test search to see live ranked pages from this source.</span>
                  </div>
                ) : null}
              </div>
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
                    ? "Detecting topics from indexed pages."
                    : "No related topics detected yet."}
                </p>
              )}
            </section>

            <section className="material-detail-section" aria-labelledby="material-detail-pages">
              <div className="material-detail-section-heading">
                <h4 id="material-detail-pages">Sample pages</h4>
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
                  <strong>{materialDetailLoadingId === selectedMaterial.id ? "Loading pages" : "No sample pages"}</strong>
                  <span>
                    {materialDetailLoadingId === selectedMaterial.id
                      ? "Reading indexed excerpts for this source."
                      : "No indexed page previews are available for this source yet."}
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

              <label className="field-label" htmlFor="material-source-url">
                Paste URL
              </label>
              <input
                id="material-source-url"
                inputMode="url"
                placeholder="https://example.edu/reading.pdf"
                type="url"
                value={materialSourceUrl}
                onChange={(event) => handleMaterialSourceUrlChange(event.target.value)}
              />
              <p className="field-hint">Public PDF, HTML, TXT, MD, or CSV URLs only.</p>

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

function TokenLimitInputs({
  idPrefix,
  labelClassName,
  requestLimits,
  tokenLimits
}: {
  idPrefix: string;
  labelClassName: string;
  requestLimits: AiRequestLimitSettings;
  tokenLimits: AiTokenLimitSettings;
}) {
  return (
    <>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-student-requests`}>
          Requests per student per day
        </label>
        <input
          id={`${idPrefix}-student-requests`}
          min={1}
          name="modelSettings.requestLimits.perStudentDaily"
          step={1}
          type="number"
          defaultValue={requestLimits.perStudentDaily}
        />
      </div>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-class-requests`}>
          Requests per class per day
        </label>
        <input
          id={`${idPrefix}-class-requests`}
          min={1}
          name="modelSettings.requestLimits.perClassDaily"
          step={1}
          type="number"
          defaultValue={requestLimits.perClassDaily}
        />
      </div>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-preview-requests`}>
          Teacher preview requests per day
        </label>
        <input
          id={`${idPrefix}-preview-requests`}
          min={0}
          name="modelSettings.requestLimits.teacherPreviewDaily"
          step={1}
          type="number"
          defaultValue={requestLimits.teacherPreviewDaily ?? 0}
        />
      </div>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-hour`}>
          Tokens per student per hour
        </label>
        <input
          id={`${idPrefix}-hour`}
          min={1000}
          name="modelSettings.tokenLimits.perHour"
          step={1000}
          type="number"
          defaultValue={tokenLimits.perHour}
        />
      </div>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-day`}>
          Tokens per student per day
        </label>
        <input
          id={`${idPrefix}-day`}
          min={1000}
          name="modelSettings.tokenLimits.perDay"
          step={1000}
          type="number"
          defaultValue={tokenLimits.perDay}
        />
      </div>
      <div>
        <label className={labelClassName} htmlFor={`${idPrefix}-week`}>
          Tokens per student per week
        </label>
        <input
          id={`${idPrefix}-week`}
          min={1000}
          name="modelSettings.tokenLimits.perWeek"
          step={1000}
          type="number"
          defaultValue={tokenLimits.perWeek}
        />
      </div>
    </>
  );
}

function CoTeacherRow({
  coTeacher,
  disabled = false,
  displayName,
  email,
  onRemove,
  onRoleChange,
  role
}: {
  coTeacher?: ClassCoTeacher;
  disabled?: boolean;
  displayName?: string;
  email?: string;
  onRemove?: () => void;
  onRoleChange?: (role: Exclude<ClassAccessRole, "owner">) => void;
  role: "Owner" | "Co-teacher" | "Viewer";
}) {
  return (
    <article className="class-invite-row">
      <div className="class-invite-details">
        <strong>{displayName || coTeacher?.displayName || coTeacher?.email || "Teacher"}</strong>
        <span>{email || coTeacher?.email || "Primary class owner"}</span>
      </div>
      <div className="class-invite-code">
        <span>Permission</span>
        {coTeacher ? (
          <select
            aria-label="Co-teacher permission"
            disabled={disabled}
            value={coTeacher.role}
            onChange={(event) => onRoleChange?.(event.target.value as Exclude<ClassAccessRole, "owner">)}
          >
            <option value="co-teacher">Co-teacher</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          <code>{role}</code>
        )}
      </div>
      {coTeacher ? (
        <div className="class-invite-actions">
          <button className="teacher-danger-button" disabled={disabled} type="button" onClick={onRemove}>
            <TrashIcon />
            Remove
          </button>
        </div>
      ) : null}
    </article>
  );
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

function formatResponseLengthLabel(value: string) {
  if (value === "long") {
    return "Detailed";
  }

  return capitalizeLabel(value);
}

function formatThinkingTimeLabel(value: string) {
  if (value === "low") {
    return "Fast";
  }

  if (value === "high") {
    return "Deep";
  }

  return "Medium";
}

function formatConversationRetention(value: string) {
  if (value === "30-days") {
    return "30 days";
  }

  if (value === "90-days") {
    return "90 days";
  }

  if (value === "1-year") {
    return "1 year";
  }

  return "Forever";
}

function formatSourceTypePreference(value: string) {
  if (value === "student-visible") {
    return "Student-visible";
  }

  if (value === "teacher-review") {
    return "Teacher review";
  }

  if (value === "hidden") {
    return "Hidden";
  }

  return "Inherit defaults";
}

function KnowledgeToggle({
  checked,
  disabled = false,
  label,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="knowledge-toggle-row">
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
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

function formatKnowledgeType(material: ClassMaterial) {
  if (material.kind === "Reading") {
    return "Textbook";
  }

  if (material.kind === "Example") {
    return "Worked Examples";
  }

  if (material.kind === "Practice Solutions") {
    return "Answer Key";
  }

  return material.kind;
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
  return filter === "All" || knowledgeFilterKinds[filter].includes(material.kind);
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
  const stats = materials.reduce(
    (currentStats, material) => {
      const settings = defaultKnowledgeSourceSettings(material);

      currentStats.ready += Number(material.status === "ready");
      currentStats.processing += Number(material.status === "processing");
      currentStats.needsReview += Number(material.status !== "ready" && material.status !== "processing");
      currentStats.teacherOnly += Number(settings.teacherOnly);
      currentStats.activeForStudents += Number(settings.activeForStudents);
      return currentStats;
    },
    { activeForStudents: 0, needsReview: 0, processing: 0, ready: 0, teacherOnly: 0 }
  );

  return [
    { label: "Total uploaded", tone: "ink", value: materials.length },
    { label: "Ready", tone: "ready", value: stats.ready },
    { label: "Processing", tone: "processing", value: stats.processing },
    { label: "Failed / needs review", tone: "failed", value: stats.needsReview },
    { label: "Teacher-only", tone: "teacher-only", value: stats.teacherOnly },
    { label: "Active for students", tone: "ready", value: stats.activeForStudents }
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
  return knowledgeStatusLabels[material.status];
}

function knowledgeStatusClass(material: ClassMaterial) {
  return knowledgeStatusClasses[material.status];
}

function formatMaterialChunkCount(material: ClassMaterial) {
  return material.chunkCount ?? "-";
}

function formatRetrievalPageLabel(label: string) {
  const normalizedLabel = label.trim();
  const pageNumber = normalizedLabel.match(/^(?:Chunk|Page)\s+(\d+)/i)?.[1] ??
    normalizedLabel.match(/^\d+$/)?.[0];

  return pageNumber ? `Page ${pageNumber}` : normalizedLabel.replace(/^Chunk\b/i, "Page");
}

function formatRetrievalConfidence(confidence: number) {
  return confidence.toFixed(2);
}

function knowledgePriorityToApi(priority: KnowledgeSourceSettings["priority"]) {
  return knowledgePriorityApiValues[priority];
}

function knowledgePriorityFromApi(priority: ClassMaterial["priority"]): KnowledgeSourceSettings["priority"] | null {
  return priority ? apiKnowledgePriorityValues[priority] : null;
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

function PrimaryIconRail({
  accountEmail,
  accountName,
  activeTab,
  isSavingThemePreference,
  navItems,
  nextAppearance,
  onNavigate,
  onOpenDrawer,
  onToggleTheme
}: {
  accountEmail: string;
  accountName: string;
  activeTab: TeacherTab;
  isSavingThemePreference: boolean;
  navItems: TeacherPrimaryNavItem[];
  nextAppearance: string;
  onNavigate: (tab: TeacherTab) => void;
  onOpenDrawer: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <aside className="primary-icon-rail" aria-label="Primary navigation">
      <button
        aria-label="Open navigation"
        className="rail-mark-button"
        title="Open navigation"
        type="button"
        onClick={onOpenDrawer}
      >
        C
      </button>

      <nav className="rail-nav" aria-label="Dashboard sections">
        <SidebarNavItem
          compact
          icon={<BookOpenIcon />}
          label="Class"
          onClick={onOpenDrawer}
        />
        {navItems.map((item) => (
          <SidebarNavItem
            active={activeTab === item.id}
            compact
            href={item.href}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onClick={() => {
              if (!item.href) {
                onNavigate(item.id as TeacherTab);
              }
            }}
          />
        ))}
      </nav>

      <div className="rail-bottom">
        <span className="teacher-avatar rail-avatar" aria-label={accountName || accountEmail || "Teacher account"} title={accountEmail}>
          {getInitials(accountName, accountEmail)}
        </span>
        <button
          aria-label={`Switch to ${nextAppearance} theme`}
          className="sidebar-theme-icon-button"
          disabled={isSavingThemePreference}
          title={`Switch to ${nextAppearance} theme`}
          type="button"
          onClick={onToggleTheme}
        >
          <MoonIcon />
        </button>
      </div>
    </aside>
  );
}

function SidebarDrawer({
  accountEmail,
  accountName,
  activeClassId,
  activeTab,
  classes,
  isClassSwitcherOpen,
  isLoadingClasses,
  isOpen,
  isSavingThemePreference,
  navItems,
  nextAppearance,
  selectedClass,
  onClose,
  onCreateClass,
  onNavigate,
  onSelectClass,
  onSignOut,
  onToggleClassSwitcher,
  onToggleTheme
}: {
  accountEmail: string;
  accountName: string;
  activeClassId: string;
  activeTab: TeacherTab;
  classes: TeacherClass[];
  isClassSwitcherOpen: boolean;
  isLoadingClasses: boolean;
  isOpen: boolean;
  isSavingThemePreference: boolean;
  navItems: TeacherPrimaryNavItem[];
  nextAppearance: string;
  selectedClass: TeacherClass | null;
  onClose: () => void;
  onCreateClass: () => void;
  onNavigate: (tab: TeacherTab) => void;
  onSelectClass: (classId: string) => void;
  onSignOut: () => void;
  onToggleClassSwitcher: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <div className={`sidebar-drawer-system ${isOpen ? "open" : ""}`} aria-hidden={!isOpen} inert={!isOpen}>
      <button
        aria-label="Close navigation overlay"
        className="sidebar-drawer-overlay"
        tabIndex={isOpen ? 0 : -1}
        type="button"
        onClick={onClose}
      />
      <aside
        aria-label="Expanded primary navigation"
        aria-modal="true"
        className="sidebar-drawer"
        role="dialog"
      >
        <div className="sidebar-drawer-header">
          <Link className="drawer-wordmark" href="/" onClick={onClose}>
            Chandra
          </Link>
          <button aria-label="Close navigation" className="drawer-close-button" type="button" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-primary-stack">
          <div className="drawer-class-switcher-row">
            <span className="drawer-class-rail-icon" aria-hidden="true">
              <BookOpenIcon />
            </span>
            <ClassSwitcher
              activeClassId={activeClassId}
              classes={classes}
              isLoadingClasses={isLoadingClasses}
              isOpen={isClassSwitcherOpen}
              selectedClass={selectedClass}
              onCreateClass={onCreateClass}
              onSelectClass={onSelectClass}
              onToggle={onToggleClassSwitcher}
            />
          </div>

          <nav className="drawer-nav" aria-label="Dashboard sections">
            {navItems.map((item) => (
              <SidebarNavItem
                active={activeTab === item.id}
                href={item.href}
                icon={item.icon}
                key={item.id}
                label={item.label}
                onClick={() => {
                  if (item.href) {
                    onClose();
                    return;
                  }
                  onNavigate(item.id as TeacherTab);
                }}
              />
            ))}
          </nav>
        </div>

        <section className="drawer-account" aria-label="Account">
          <div className="drawer-account-row">
            <span className="teacher-avatar" aria-hidden="true">
              {getInitials(accountName, accountEmail)}
            </span>
            <span className="teacher-account-copy">
              <strong>{accountName}</strong>
              {accountEmail ? <span>{accountEmail}</span> : null}
            </span>
            <button
              aria-label={`Switch to ${nextAppearance} theme`}
              className="sidebar-theme-icon-button"
              disabled={isSavingThemePreference}
              title={`Switch to ${nextAppearance} theme`}
              type="button"
              onClick={onToggleTheme}
            >
              <MoonIcon />
            </button>
          </div>
          <button className="sidebar-signout-button drawer-signout-button" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </section>
      </aside>
    </div>
  );
}

function ClassSwitcher({
  activeClassId,
  classes,
  isLoadingClasses,
  isOpen,
  selectedClass,
  onCreateClass,
  onSelectClass,
  onToggle
}: {
  activeClassId: string;
  classes: TeacherClass[];
  isLoadingClasses: boolean;
  isOpen: boolean;
  selectedClass: TeacherClass | null;
  onCreateClass: () => void;
  onSelectClass: (classId: string) => void;
  onToggle: () => void;
}) {
  const selectedClassName = selectedClass?.name || "Calc AB";
  const selectedSection = selectedClass ? formatSectionLabel(selectedClass.section) : "Section 5";

  return (
    <section className="class-switcher" aria-label="Class switcher">
      <button
        aria-expanded={isOpen}
        className="class-switcher-button"
        type="button"
        onClick={onToggle}
      >
        <span className="class-switcher-icon" aria-hidden="true">
          <BookOpenIcon />
        </span>
        <span className="class-switcher-copy">
          <strong>{selectedClassName}</strong>
          <span>{selectedSection}</span>
        </span>
        <ChevronDownIcon />
      </button>

      {isOpen ? (
        <div className="class-switcher-menu" role="menu">
          {classes.map((teacherClass) => (
            <button
              aria-checked={teacherClass.id === activeClassId}
              className="class-switcher-option"
              key={teacherClass.id}
              role="menuitemradio"
              type="button"
              onClick={() => onSelectClass(teacherClass.id)}
            >
              <span>
                <strong>{teacherClass.name}</strong>
                <em>{formatSectionLabel(teacherClass.section)}</em>
              </span>
              {teacherClass.id === activeClassId ? <CheckCircleIcon /> : null}
            </button>
          ))}
          {isLoadingClasses ? (
            <span className="class-switcher-status">Loading classes</span>
          ) : null}
          {!isLoadingClasses && !classes.length ? (
            <span className="class-switcher-status">No classes yet</span>
          ) : null}
          <button className="class-switcher-create" role="menuitem" type="button" onClick={onCreateClass}>
            <PlusIcon />
            Create class
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SidebarNavItem({
  active,
  compact = false,
  href,
  icon,
  label,
  onClick
}: {
  active?: boolean;
  compact?: boolean;
  href?: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const className = compact ? "sidebar-nav-item compact" : "sidebar-nav-item";
  const content = (
    <>
      <span className="sidebar-nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sidebar-nav-label">{label}</span>
    </>
  );

  if (href) {
    return (
      <a className={className} href={href} title={label} onClick={onClick}>
        {content}
      </a>
    );
  }

  return (
    <button
      aria-current={active ? "page" : undefined}
      className={className}
      title={label}
      type="button"
      onClick={onClick}
    >
      {content}
    </button>
  );
}

function TeacherSecondarySidebar({
  description,
  items,
  onClose,
  title
}: {
  description: string;
  items: Array<{
    active?: boolean;
    count?: number;
    icon: ReactNode;
    label: string;
    onClick: () => void;
  }>;
  onClose: () => void;
  title: string;
}) {
  return (
    <aside className="teacher-secondary-sidebar" aria-label={`${title} navigation`}>
      <div className="secondary-sidebar-heading">
        <div>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
        <button aria-label={`Close ${title} navigation`} className="secondary-sidebar-close" type="button" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <nav className="secondary-nav" aria-label={`${title} sections`}>
        {items.map((item) => (
          <button
            aria-current={item.active ? "page" : undefined}
            className="secondary-nav-row"
            key={item.label}
            type="button"
            onClick={item.onClick}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
            {typeof item.count === "number" ? <em>{item.count}</em> : null}
          </button>
        ))}
      </nav>
    </aside>
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

function formatOverviewNextActionButton(action: TeacherClassOverview["nextActions"][number]["action"]) {
  if (action === "addStudent" || action === "addKnowledge") {
    return "Add";
  }

  if (action === "reviewConversations" || action === "reviewLearningProfiles") {
    return "Review";
  }

  if (action === "viewStudentChats") {
    return "View";
  }

  return "Open";
}

function formatOverviewActionPriority(priority: TeacherClassOverview["nextActions"][number]["priority"]) {
  if (priority === "critical") {
    return "Critical";
  }

  if (priority === "high") {
    return "High";
  }

  if (priority === "medium") {
    return "Medium";
  }

  return "Low";
}

function overviewStatusToneClass(tone: TeacherOverviewStatusTone) {
  if (tone === "high" || tone === "ai-review") {
    return "high";
  }

  if (tone === "follow-up" || tone === "note") {
    return "new";
  }

  return tone;
}

function formatOverviewAttention(tone: TeacherOverviewStatusTone) {
  if (tone === "high") {
    return "High";
  }

  if (tone === "ai-review") {
    return "AI review";
  }

  if (tone === "follow-up") {
    return "Follow-up";
  }

  if (tone === "note") {
    return "Note";
  }

  return capitalizeLabel(tone);
}

const TeacherTranscriptMessage = memo(function TeacherTranscriptMessage({
  message,
  studentName
}: {
  message: ChatMessage;
  studentName: string;
}) {
  if (message.role === "student") {
    return (
      <article className="student-workspace-message teacher-transcript-message student">
        <div className="student-message-stack teacher-transcript-stack">
          <div className="message-meta">{studentName || "Student"}</div>
          <div className="student-message-bubble teacher-transcript-bubble">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(message.content)}
            </ReactMarkdown>
          </div>
          <time className="teacher-transcript-time">{formatConversationDate(message.createdAt)}</time>
        </div>
      </article>
    );
  }

  const answerContent = assistantMessageAnswerContent(message);
  const structuredSections = assistantStructuredSections(message);
  const sourceLabels = message.sources?.length ? condensedSourceLabels(message.sources) : [];

  return (
    <article className="student-workspace-message teacher-transcript-message assistant">
      <span className="chandra-message-avatar teacher-transcript-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack teacher-transcript-stack">
        <div className="message-meta">Chandra</div>
        {answerContent ? (
          <div className="assistant-message-bubble teacher-transcript-bubble">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(answerContent)}
            </ReactMarkdown>
          </div>
        ) : null}
        {structuredSections.map((section) => (
          <div className={`assistant-structured-section ${section.kind}`} key={section.kind}>
            <strong>{section.label}</strong>
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(section.content, section.kind))}
            </ReactMarkdown>
          </div>
        ))}
        {sourceLabels.length ? (
          <div className="message-sources teacher-transcript-sources" aria-label="Sources used">
            <strong>Sources:</strong>
            {sourceLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
        ) : null}
        <time className="teacher-transcript-time">{formatConversationDate(message.createdAt)}</time>
      </div>
    </article>
  );
});

function PlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.5 10.4 11.2 6 9.6 10.4 8 12 3.5Z" fill="currentColor" />
      <path d="M5 14.5 5.8 17 8.3 17.8 5.8 18.7 5 21 4.2 18.7 1.8 17.8 4.2 17 5 14.5Z" fill="currentColor" />
      <path d="M19 14 19.8 16.2 22 17 19.8 17.8 19 20 18.2 17.8 16 17 18.2 16.2 19 14Z" fill="currentColor" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
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

function HomeIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="m3.5 11 8.5-7 8.5 7v8.5A1.5 1.5 0 0 1 19 21h-4.5v-6h-5v6H5a1.5 1.5 0 0 1-1.5-1.5V11Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M14 5.25v3.5M8 15.25v3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M4.5 5h15A1.5 1.5 0 0 1 21 6.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M9 21h6M12 17v4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M20 14.6A7.9 7.9 0 0 1 9.4 4 8 8 0 1 0 20 14.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M6 21V4.5c3-1.4 5.3 1.4 8.4 0 1.1-.5 2-.6 3.6-.2v8.5c-1.6-.4-2.5-.3-3.6.2-3.1 1.4-5.4-1.4-8.4 0"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
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

function ShieldIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M12 3.4 19 6v5.1c0 4.4-2.7 7.9-7 9.5-4.3-1.6-7-5.1-7-9.5V6l7-2.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="m9.3 12 1.8 1.8 3.9-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M18 10.4c0-3.4-2.1-5.6-6-5.6s-6 2.2-6 5.6v3.8l-1.4 2.3h14.8L18 14.2v-3.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M9.5 18.8a2.7 2.7 0 0 0 5 0" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
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

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <rect
        height="13"
        rx="2"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
        width="13"
        x="8"
        y="8"
      />
      <path
        d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M20 6v5h-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M4 18v-5h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path
        d="M6.2 9A7 7 0 0 1 18.7 7.8L20 11M4 13l1.3 3.2A7 7 0 0 0 17.8 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function UserPlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M15 19a6 6 0 0 0-12 0" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeWidth="2" />
      <path d="M19 8v6M16 11h6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 3v12" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="m7 10 5 5 5-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M5 20h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
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
      feedback: conversation.feedback ?? [],
      feedbackSummary: conversation.feedbackSummary ?? emptyStudentFeedbackSummary(),
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

  return rows.filter((row) =>
    conversationMatchesFilter({
      evidenceConversationIdSet,
      filter,
      normalizedQuery,
      row,
      studentEmail,
      topic
    })
  );
}

function conversationMatchesFilter({
  evidenceConversationIds,
  evidenceConversationIdSet,
  filter,
  normalizedQuery,
  query,
  row,
  studentEmail,
  topic
}: {
  evidenceConversationIds?: string[];
  evidenceConversationIdSet?: Set<string>;
  filter: ConversationFilter;
  normalizedQuery?: string;
  query?: string;
  row: ConversationReviewRow;
  studentEmail: string;
  topic: string;
}) {
  const evidenceIds = evidenceConversationIdSet ?? new Set(evidenceConversationIds ?? []);
  const normalizedSearchQuery = normalizedQuery ?? query?.trim().toLowerCase() ?? "";

  if (evidenceIds.size && !evidenceIds.has(row.id)) {
    return false;
  }

  if (studentEmail !== "all" && row.studentEmail !== studentEmail) {
    return false;
  }

  if (topic !== "all" && row.topic !== topic) {
    return false;
  }

  if (
    normalizedSearchQuery &&
    ![row.studentName, row.title, row.topic, formatConversationStatus(row.status)].some((value) =>
      value.toLowerCase().includes(normalizedSearchQuery)
    )
  ) {
    return false;
  }

  if (filter === "reviewed") {
    return conversationIsReviewed(row);
  }

  if (!conversationNeedsTeacherReview(row)) {
    return false;
  }

  if (filter === "unreviewed" || filter === "noTeacherReview") {
    return row.status === "new";
  }

  if (filter === "needsFollowUp") {
    return row.status === "needs_follow_up";
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

  if (filter === "feedback") {
    return row.feedbackSummary.openCount > 0;
  }

  return true;
}

function conversationNeedsTeacherReview(row: Pick<ConversationReviewRow, "feedbackSummary" | "status">) {
  return conversationReviewRequiredStatuses.has(row.status) || row.feedbackSummary.openCount > 0;
}

function conversationIsReviewed(row: Pick<ConversationReviewRow, "feedbackSummary" | "status">) {
  return reviewedConversationStatuses.has(row.status) && row.feedbackSummary.openCount === 0;
}

function emptyStudentFeedbackSummary(): StudentFeedbackSummary {
  return {
    latestCreatedAt: "",
    openCount: 0,
    totalCount: 0
  };
}

function summarizeStudentFeedback(feedback: StudentFeedback[]): StudentFeedbackSummary {
  const sortedFeedback = [...feedback].sort(
    (first, second) => (coerceDate(second.createdAt)?.getTime() ?? 0) - (coerceDate(first.createdAt)?.getTime() ?? 0)
  );
  const latestFeedback = sortedFeedback[0];

  return {
    latestCreatedAt: latestFeedback?.createdAt ?? "",
    latestRating: latestFeedback?.rating,
    latestStatus: latestFeedback?.status,
    openCount: feedback.filter((item) => item.status !== "resolved").length,
    totalCount: feedback.length
  };
}

function buildConversationMetrics(rows: ConversationReviewRow[], rosterRows: RosterRow[]) {
  const total = rows.length || rosterRows.reduce((sum, row) => sum + row.conversationsCount, 0);
  const metrics = rows.reduce(
    (currentMetrics, row) => {
      if (!conversationNeedsTeacherReview(row)) {
        return currentMetrics;
      }

      currentMetrics.followUp += Number(row.status === "needs_follow_up" || row.status === "misunderstanding_spotted");
      currentMetrics.lowConfidence += Number(row.sourceAudit.lowSourceConfidence);
      currentMetrics.unreviewed += Number(row.status === "new" || row.feedbackSummary.openCount > 0);
      return currentMetrics;
    },
    { followUp: 0, lowConfidence: 0, unreviewed: 0 }
  );

  return { ...metrics, total };
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
  return shortDateFormatter.format(date);
}

function formatTimelineFullDate(date: Date) {
  return longDateFormatter.format(date);
}

function conversationStatusClass(status: ConversationReviewStatus) {
  return conversationStatusClasses[status];
}

function formatConversationStatus(status: ConversationReviewStatus) {
  return conversationStatusLabels[status];
}

function formatStudentFeedbackRating(rating: StudentFeedback["rating"]) {
  if (rating === "not_helpful") {
    return "Not helpful";
  }

  if (rating === "confusing") {
    return "Confusing";
  }

  if (rating === "incorrect") {
    return "Incorrect";
  }

  if (rating === "helpful") {
    return "Helpful";
  }

  return "Feedback";
}

function formatStudentFeedbackKind(kind: StudentFeedback["kind"]) {
  if (kind === "usage_request") {
    return "Usage request";
  }

  if (kind === "prompted") {
    return "Prompted feedback";
  }

  return "Student feedback";
}

function formatStudentFeedbackStatus(status: StudentFeedback["status"]) {
  if (status === "resolved") {
    return "Resolved";
  }

  if (status === "reviewed") {
    return "Reviewed";
  }

  return "New";
}

function formatStudentFeedbackPromptReason(reason: StudentFeedback["promptReason"]) {
  if (reason === "assistant_count") {
    return "After several replies";
  }

  if (reason === "confusion_signal") {
    return "Confusion signal";
  }

  if (reason === "low_confidence") {
    return "Low confidence";
  }

  if (reason === "source_heavy") {
    return "Source-heavy";
  }

  return "Student opened feedback";
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
  chatBlockedByStudentId,
  studentActivityByEmail,
  students
}: {
  chatBlockedByStudentId: Record<string, boolean>;
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
      chatBlocked: chatBlockedByStudentId[student.id] ?? activity?.chatBlocked ?? student.chatBlocked === true,
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

function formatAccountActivityTime(value: string) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleString();
}

function formatInviteDate(value: string) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function teacherInviteStatusLabel(invite: TeacherInviteSummary) {
  return invite.status === "used" ? "Used" : capitalizeLabel(invite.status);
}

function teacherInviteDetailText(invite: TeacherInviteSummary) {
  if (invite.status === "used") {
    return `Used by ${invite.usedByEmail || "teacher"}`;
  }

  if (invite.status === "active") {
    return "Unused";
  }

  return "";
}

function teacherInviteDateText(invite: TeacherInviteSummary) {
  if (invite.status === "used") {
    return invite.usedAt ? `Accepted ${formatInviteDate(invite.usedAt)}` : `Expires ${formatInviteDate(invite.expiresAt)}`;
  }

  if (invite.status === "revoked") {
    return `Revoked ${formatInviteDate(invite.revokedAt)}`;
  }

  if (invite.status === "expired") {
    return `Expired ${formatInviteDate(invite.expiresAt)}`;
  }

  return `Expires ${formatInviteDate(invite.expiresAt)}`;
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

function buildClassInviteUrl(classCode: string) {
  const inviteUrl = new URL("/auth", window.location.origin);
  inviteUrl.searchParams.set("role", "student");
  inviteUrl.searchParams.set("classId", classCode);

  return inviteUrl.toString();
}

function buildTeacherInviteUrl(inviteId: string) {
  const inviteUrl = new URL("/auth", window.location.origin);
  inviteUrl.searchParams.set("role", "teacher");
  inviteUrl.searchParams.set("teacherInvite", inviteId);

  return inviteUrl.toString();
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

function uploadTutorKnowledgeFileToStorage({
  classId,
  file,
  materialId,
  onProgress
}: {
  classId: string;
  file: File;
  materialId: string;
  onProgress: (progress: MaterialUploadProgress | null) => void;
}) {
  if (!storage) {
    throw new Error("Firebase Storage is not configured for direct tutor knowledge upload.");
  }

  validateTutorKnowledgeFile(file);
  const safeFileName = sanitizeStorageFileName(file.name);
  const storagePath = `classes/${classId}/materials/${materialId}/original/${safeFileName}`;
  const uploadTask = uploadBytesResumable(storageRef(storage, storagePath), file, {
    contentType: file.type || contentTypeFromFileName(file.name)
  });

  onProgress({
    detail: "Uploading the original file directly to Firebase Storage.",
    percent: 2,
    step: "upload",
    uploadPercent: 0
  });

  return new Promise<{ storagePath: string }>((resolve, reject) => {
    uploadTask.on(
      "state_changed",
      (snapshot) => {
        const uploadPercent = Math.round((snapshot.bytesTransferred / Math.max(snapshot.totalBytes, 1)) * 100);

        onProgress({
          detail: `Uploading source: ${formatBytes(snapshot.bytesTransferred)} of ${formatBytes(snapshot.totalBytes)} sent.`,
          percent: Math.min(12, 2 + Math.round(uploadPercent * 0.1)),
          step: "upload",
          uploadPercent
        });
      },
      (caughtError) => {
        reject(new Error(caughtError instanceof Error ? caughtError.message : "Firebase Storage upload failed."));
      },
      () => {
        onProgress({
          detail: "Upload complete. Waiting for Chandra to process the stored source.",
          percent: 12,
          step: "upload",
          uploadPercent: 100
        });
        resolve({ storagePath });
      }
    );
  });
}

function sanitizeStorageFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "tutor-knowledge-file";
}

function contentTypeFromFileName(fileName: string) {
  const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";

  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".md") {
    return "text/markdown";
  }

  if (extension === ".csv") {
    return "text/csv";
  }

  return "text/plain";
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
    return "Build tutor pages";
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
    return "Splitting the material into focused tutor knowledge pages.";
  }

  if (step === "embed") {
    return "Calling the Gemini embedding API so students can search this source semantically.";
  }

  if (step === "save") {
    return "Saving metadata, vectors, and source details to this professor's class.";
  }

  return "Working on the tutor knowledge upload.";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
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
