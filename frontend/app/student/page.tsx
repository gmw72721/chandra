"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChangeEvent, DragEvent, FocusEvent, FormEvent, KeyboardEvent, Suspense, memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { useAuth } from "@/components/AuthProvider";
import { RequireAuth } from "@/components/RequireAuth";
import { apiUrl } from "@/lib/api-client";
import { deleteCurrentAccount, signOutAllSessions, signOutCurrentUser, updateStudentClass, updateUserAccountSettings, updateUserThemePreference } from "@/lib/auth";
import {
  defaultTeacherClassAppearance,
  defaultTeacherClassThemeColor,
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  teacherClassThemeColorOptions,
  type TeacherClassAppearance,
  type TeacherClassThemeColor
} from "@/lib/class-theme";
import {
  defaultBehaviorInstructions,
  type AnswerPolicySettings,
  type ClassModelSettings,
  type ResponseFormatSettings,
  type TutorBehavior,
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeOpeningMessage,
  normalizeResponseFormatSettings,
  normalizeTutorBehavior,
  tutorBehaviorOptions,
  tutorVoiceOptions,
  verboseOptions
} from "@/lib/class-settings";
import {
  type AssistantMessageBlock,
  assistantMessageBlocks,
  normalizeMarkdownMath,
  normalizeStructuredSectionMarkdown
} from "@/lib/chat-message-format";
import { buildChatContextMemory, hasChatContextMemory } from "@/lib/chat-context-memory";
import { subscribeToClass, type TeacherClass } from "@/lib/classes";
import { capitalizeLabel, coerceDate, formatConversationDate } from "@/lib/display-format";
import { knowledgeUiColorToken } from "@/lib/knowledge-memory";
import { buildUnderstandingState } from "@/lib/understanding-state";
import type {
  ChatContextMemory,
  ChatMessage,
  KnowledgeItem,
  KnowledgeUiColorToken,
  MessageAttachment,
  StudentMessageMode,
  StudentAiUsageStatus,
  StudentConversationSummary,
  StudentFeedbackKind,
  StudentFeedbackPromptReason,
  StudentFeedbackRating,
  StudentFeedback,
  TutorApiResponse,
  TutorConfusionChoice,
  TutorInputTokenSection,
  TutorSource,
  UnderstandingState,
  UsageSummary
} from "@/lib/types";

type ChatProgress = {
  message: string;
  searches: ChatProgressSearch[];
};

type ChatProgressSearch = {
  description: string;
  query: string;
  retrievalReason?: string;
  searchNumber?: number;
};

const streamedSectionKeys = [
  "mainText",
  "mainChat",
  "problem",
  "answer",
  "hint",
  "explanation",
  "formula",
  "example",
  "checkWork",
  "sourceNote"
] as const;
type StreamedSectionKey = (typeof streamedSectionKeys)[number];
type StructuredStreamedSectionKey = Exclude<StreamedSectionKey, "mainText">;
type StreamingAssistantState = {
  activeSections: Partial<Record<StreamedSectionKey, boolean>>;
  completedSections: Partial<Record<StreamedSectionKey, boolean>>;
  sectionOrder: StreamedSectionKey[];
};
type StreamingChatMessage = ChatMessage & {
  streamingState?: StreamingAssistantState;
};

type ChatStreamEvent =
  | { message: string; stage: string; type: "step" }
  | {
      debugInfo?: TutorApiResponse["debugInfo"];
      langGraphTrace?: TutorApiResponse["langGraphTrace"];
      message: string;
      stage: string;
      structuredOutput?: TutorApiResponse["structuredOutput"];
      type: "quick_response";
    }
  | {
      description?: string;
      message: string;
      query: string;
      retrievalReason?: string;
      searchNumber: number;
      stage: string;
      type: "search";
    }
  | {
      message: string;
      queries: string[];
      searches?: ChatProgressSearch[];
      searchNumbers?: number[];
      stage: string;
      type: "search_batch";
    }
  | { errorCode?: string; errorId?: string; message: string; stage: string; type: "error" }
  | { call?: "primary_tutor_turn" | "context_grounded_answer"; section: string; type: "section_start" }
  | {
      call?: "primary_tutor_turn" | "context_grounded_answer";
      delta: string;
      section: string;
      type: "section_delta";
    }
  | { call?: "primary_tutor_turn" | "context_grounded_answer"; section: string; type: "section_done" }
  | { payload: TutorApiResponse; type: "final" };

type StudentVisibleClass = {
  appearance?: TeacherClassAppearance;
  chatBlocked?: boolean;
  chatBlockedReason?: string;
  chatBlockedUntil?: string | null;
  id: string;
  joinCode?: string;
  name: string;
  openingMessage?: string;
  section: string;
  studentPromptPlaceholder?: string;
  studentChatEnabled?: boolean;
  themeColor?: TeacherClassThemeColor;
};

type StudentClassSummary = StudentVisibleClass;

type ComposerAttachment = MessageAttachment & {
  dataUrl?: string;
  error?: string;
  localUrl?: string;
  progress: number;
};

const studentComposerTextareaMaxHeight = 156;
const markdownRemarkPlugins = [remarkMath];
const markdownRehypePlugins = [rehypeKatex];
const maxComposerAttachments = 3;
const maxTeacherPreviewAttachmentInlineBytes = 8 * 1024 * 1024;
const allowedComposerAttachmentExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".webp"];
const allowedComposerAttachmentAccept = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
const maxComposerPdfBytes = 25 * 1024 * 1024;
const aiUsageIncreaseRequestComment =
  "Tutoring time request: I am out of tutoring time and would like my professor to allow more time.";
const teacherPreviewTutorDebugOptionsStorageKey = "chandra.teacherPreviewTutorDebugOptions";

const welcomeMessageId = "welcome";

type StudentMainView = "chat" | "settings";
type KnowledgeItemRole = "definition" | "example" | "page" | "problem" | "source" | "student_upload" | "theorem";
type KnowledgeLine = {
  colorToken: KnowledgeUiColorToken;
  key: string;
  role: KnowledgeItemRole;
};
type KnowledgeAnimationLine = {
  colorToken: KnowledgeUiColorToken;
  delayMs: number;
  id: string;
};
type FeedbackModalState = {
  conversationId?: string;
  defaultComment: string;
  kind: "general" | "prompted";
  messageId?: string | null;
  promptReason?: StudentFeedbackPromptReason;
};
type HeaderDropdown = "context" | "feedback" | "understanding" | "usage" | null;
type TutorDebugOptions = {
  forceAiUsageBlocked: boolean;
  forceAiUsageNearLimit: boolean;
  forceConfusionChoices: boolean;
  forceNoRetrieval: boolean;
  forceRetrieval: boolean;
  forceStudentView: boolean;
  showExactSearches: boolean;
  showTutorDecision: boolean;
  showTutorPlan: boolean;
  showUnderstandingState: boolean;
  showSelectedSources: boolean;
};

type TeacherPreviewTutorSettings = {
  answerPolicy: AnswerPolicySettings;
  behaviorInstructions: string;
  behaviorTitle: TutorBehavior;
  modelSettings: ClassModelSettings;
  responseFormat: ResponseFormatSettings;
};

const defaultTutorDebugOptions: TutorDebugOptions = {
  forceAiUsageBlocked: false,
  forceAiUsageNearLimit: false,
  forceConfusionChoices: false,
  forceNoRetrieval: false,
  forceRetrieval: false,
  forceStudentView: false,
  showExactSearches: true,
  showTutorDecision: true,
  showTutorPlan: true,
  showUnderstandingState: true,
  showSelectedSources: true
};

export default function StudentPage() {
  return (
    <main className="student-workspace-page">
      <Suspense
        fallback={
          <section className="auth-state-panel">
            <h1>Preparing student chat.</h1>
          </section>
        }
      >
        <StudentWorkspace />
      </Suspense>
    </main>
  );
}

export function StudentWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { firebaseReady, profile, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(() => buildInitialStudentMessages(null));
  const [draft, setDraft] = useState("");
  const [studentMessageMode, setStudentMessageMode] = useState<StudentMessageMode>("ask");
  const [isMessageModeMenuOpen, setIsMessageModeMenuOpen] = useState(false);
  const messageModeMenuRef = useRef<HTMLDivElement | null>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const sendInFlightRef = useRef(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSendMotionActive, setIsSendMotionActive] = useState(false);
  const [justSentMessageId, setJustSentMessageId] = useState("");
  const sendMotionTimerRef = useRef<number | null>(null);
  const justSentTimerRef = useRef<number | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
  const [classLoadError, setClassLoadError] = useState<{ classId: string; message: string } | null>(null);
  const [loadedClassId, setLoadedClassId] = useState("");
  const [savedClass, setSavedClass] = useState<TeacherClass | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState("");
  const [conversationMessagesError, setConversationMessagesError] = useState("");
  const [themePreferenceError, setThemePreferenceError] = useState("");
  const [isSavingThemePreference, setIsSavingThemePreference] = useState(false);
  const [themePreferencePreview, setThemePreferencePreview] = useState<{
    appearance?: unknown;
    themeColor?: unknown;
  } | null>(null);
  const [accountDisplayName, setAccountDisplayName] = useState<string | null>(null);
  const [accountEmailDraft, setAccountEmailDraft] = useState<string | null>(null);
  const [accountUsername, setAccountUsername] = useState<string | null>(null);
  const [accountSettingsError, setAccountSettingsError] = useState("");
  const [currentAccountPassword, setCurrentAccountPassword] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [confirmAccountPassword, setConfirmAccountPassword] = useState("");
  const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
  const [isSavingAccountSettings, setIsSavingAccountSettings] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isClassDropdownOpen, setIsClassDropdownOpen] = useState(false);
  const [studentMainView, setStudentMainView] = useState<StudentMainView>("chat");
  const [studentClasses, setStudentClasses] = useState<StudentClassSummary[]>([]);
  const [studentClassesError, setStudentClassesError] = useState("");
  const [aiUsageStatus, setAiUsageStatus] = useState<StudentAiUsageStatus | null>(null);
  const [aiUsageError, setAiUsageError] = useState("");
  const [openHeaderDropdown, setOpenHeaderDropdown] = useState<HeaderDropdown>(null);
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const [isSwitchingClass, setIsSwitchingClass] = useState(false);
  const [conversationSummaries, setConversationSummaries] = useState<StudentConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
  const [feedbackModal, setFeedbackModal] = useState<FeedbackModalState | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<StudentFeedbackRating>("helpful");
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [studentFeedbackResponses, setStudentFeedbackResponses] = useState<StudentFeedback[]>([]);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [usageIncreaseRequestMessage, setUsageIncreaseRequestMessage] = useState("");
  const [isRequestingUsageIncrease, setIsRequestingUsageIncrease] = useState(false);
  const [selectedTutorChoiceByMessageId, setSelectedTutorChoiceByMessageId] = useState<Record<string, string>>({});
  const [isTeacherDebugMode, setIsTeacherDebugMode] = useState(false);
  const [isTutorDebugPanelOpen, setIsTutorDebugPanelOpen] = useState(false);
  const [tutorDebugOptions, setTutorDebugOptions] = useState<TutorDebugOptions>(defaultTutorDebugOptions);
  const [isTeacherTutorSettingsOpen, setIsTeacherTutorSettingsOpen] = useState(false);
  const [teacherPreviewTutorSettings, setTeacherPreviewTutorSettings] = useState<TeacherPreviewTutorSettings | null>(null);
  const [isSavingTeacherTutorSettings, setIsSavingTeacherTutorSettings] = useState(false);
  const [teacherTutorSettingsError, setTeacherTutorSettingsError] = useState("");
  const [teacherTutorSettingsMessage, setTeacherTutorSettingsMessage] = useState("");
  const isTeacherPreview = pathname.startsWith("/teacher/student-view");
  const queryClassId = searchParams.get("classId");
  const activeCourseId = isTeacherPreview ? queryClassId ?? "" : profile?.classId ?? "";
  const classLoadMessage = classLoadError?.classId === activeCourseId ? classLoadError.message : "";
  const isLoadingClass = Boolean(
    firebaseReady &&
      activeCourseId &&
      loadedClassId !== activeCourseId &&
      classLoadError?.classId !== activeCourseId
  );

  const activeSelectedConversationId = selectedConversationClassId === activeCourseId ? selectedConversationId : "";

  useEffect(() => {
    if (!firebaseReady || !profile) {
      return;
    }

    if (!isTeacherPreview && queryClassId) {
      router.replace("/student");
      return;
    }

    if (profile.role === "teacher" && !isTeacherPreview) {
      router.replace("/teacher");
      return;
    }

    if (profile.role === "student" && isTeacherPreview) {
      router.replace("/student");
      return;
    }

    if (profile.role === "teacher" && isTeacherPreview && !queryClassId) {
      router.replace("/teacher");
    }
  }, [firebaseReady, isTeacherPreview, profile, queryClassId, router]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !isTeacherPreview) {
      setSavedClass(null);
      return () => {};
    }

    return subscribeToClass(
      activeCourseId,
      (nextClass) => {
        setSavedClass(nextClass);
        setLoadedClassId(activeCourseId);
        setMessages((currentMessages) =>
          isOnlyWelcomeMessage(currentMessages) ? buildInitialStudentMessages(nextClass) : currentMessages
        );
      },
      (caughtError) => {
        setSavedClass(null);
        setClassLoadError(
          {
            classId: activeCourseId,
            message: caughtError.message.toLowerCase().includes("permission")
              ? "You do not have access to that class code yet."
              : caughtError.message
          }
        );
      }
    );
  }, [activeCourseId, firebaseReady, isTeacherPreview]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !user || profile?.role !== "student" || isTeacherPreview) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) => fetchStudentConversationSummaries({ classId: activeCourseId, token }))
      .then((nextConversations) => {
        if (!isCancelled) {
          setConversationSummaries(nextConversations);
          setConversationLoadError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setConversationSummaries([]);
          setConversationLoadError(describeStudentConversationLoadError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, firebaseReady, isTeacherPreview, profile?.role, user]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !user || profile?.role !== "student" || isTeacherPreview) {
      setStudentFeedbackResponses([]);
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) =>
        fetchStudentFeedbackResponses({
          classId: activeCourseId,
          conversationId: activeSelectedConversationId,
          token
        })
      )
      .then((feedback) => {
        if (!isCancelled) {
          setStudentFeedbackResponses(
            feedback.filter((item) => Boolean(item.studentVisibleResponse && item.studentVisibleResponseSentAt))
          );
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setStudentFeedbackResponses([]);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, activeSelectedConversationId, firebaseReady, isTeacherPreview, profile?.role, user]);

  const activeStudentClass = useMemo(
    () => studentClasses.find((studentClass) => studentClass.id === activeCourseId) ?? null,
    [activeCourseId, studentClasses]
  );
  const activeClass: StudentVisibleClass | null = useMemo(() => {
    if (savedClass?.id !== activeCourseId) {
      return activeStudentClass;
    }

    if (!activeStudentClass) {
      return savedClass;
    }

    return {
      ...savedClass,
      chatBlocked: activeStudentClass.chatBlocked,
      chatBlockedReason: activeStudentClass.chatBlockedReason ?? savedClass.chatBlockedReason,
      chatBlockedUntil: activeStudentClass.chatBlockedUntil ?? savedClass.chatBlockedUntil,
      studentChatEnabled:
        savedClass.studentChatEnabled === false || activeStudentClass.studentChatEnabled === false
          ? false
          : savedClass.studentChatEnabled ?? activeStudentClass.studentChatEnabled
    };
  }, [activeCourseId, activeStudentClass, savedClass]);
  const activeAppearance = useMemo(
    () =>
      normalizeTeacherClassAppearance(
        themePreferencePreview?.appearance ?? profile?.appearance ?? activeClass?.appearance ?? defaultTeacherClassAppearance
      ),
    [activeClass?.appearance, profile?.appearance, themePreferencePreview?.appearance]
  );
  const activeThemeColor = useMemo(
    () =>
      normalizeTeacherClassThemeColor(
        themePreferencePreview?.themeColor ?? profile?.themeColor ?? activeClass?.themeColor ?? defaultTeacherClassThemeColor
      ),
    [activeClass?.themeColor, profile?.themeColor, themePreferencePreview?.themeColor]
  );
  const className = activeClass?.name ?? (activeCourseId ? "Saved class" : "Class needed");
  const classSection = activeClass?.section ?? (activeCourseId ? "Student chat" : "Enter your class code");
  const classSectionLabel = formatClassSectionLabel(classSection, Boolean(activeCourseId));
  const studentChatPauseMessage =
    activeCourseId && !isTeacherPreview && activeClass?.chatBlocked
      ? formatStudentChatPauseMessage(activeClass)
      : activeCourseId && !isTeacherPreview && activeClass?.studentChatEnabled === false
        ? "Your teacher has paused chat for this class."
        : "";
  const studentChatPaused = Boolean(studentChatPauseMessage);
  const studentComposerPlaceholder = getStudentComposerPlaceholder(activeClass);
  const compactClassLabel = formatCompactClassLabel(className);
  const visibleClassCode = activeClass?.joinCode || activeClass?.id || activeCourseId;
  const visibleConversationSummaries = useMemo(
    () =>
      conversationSummaries
        .filter((conversation) => conversation.classId === activeCourseId && conversation.studentId === user?.uid)
        .sort(compareConversationSummariesByRecentActivity),
    [activeCourseId, conversationSummaries, user?.uid]
  );
  const visibleStudentClasses = useMemo(
    () => mergeStudentClasses(studentClasses, activeClass),
    [activeClass, studentClasses]
  );
  const accountName = profile?.displayName ?? user?.displayName ?? "Student";
  const accountEmail = profile?.email ?? user?.email ?? "";
  const accountEmailValue = accountEmailDraft ?? accountEmail;
  const accountUsernameValue = profile?.username ?? accountEmail;
  const accountLastSignInAt = user?.metadata.lastSignInTime ?? "";
  const debugAiUsageStatus = isTeacherPreview && isTeacherDebugMode ? forcedTutorDebugAiUsageStatus(tutorDebugOptions) : null;
  const displayedAiUsageStatus = debugAiUsageStatus ?? aiUsageStatus;
  const effectiveTeacherPreviewTutorSettings = useMemo(
    () => teacherPreviewTutorSettings ?? buildTeacherPreviewTutorSettings(savedClass),
    [savedClass, teacherPreviewTutorSettings]
  );
  const showUsageHeader = !isTeacherPreview || (isTeacherDebugMode && Boolean(debugAiUsageStatus));
  const usageSummary = useMemo(() => usageSummaryFromStatus(displayedAiUsageStatus), [displayedAiUsageStatus]);
  const tutoringTimeHeaderText = displayedAiUsageStatus
    ? `Tutoring time · ${usageSummary.todayPercentLeft}% left`
    : aiUsageError
      ? "Tutoring time unavailable"
      : "Loading tutoring time";
  const tutoringTimeHeaderLabel = displayedAiUsageStatus
    ? `Tutoring time: ${usageSummary.todayPercentLeft}% left today`
    : aiUsageError
      ? `Tutoring time unavailable: ${aiUsageError}`
      : "Loading tutoring time";
  const chatContextMemory = useMemo(() => buildChatContextMemory(messages), [messages]);
  const knowledgeLines = useMemo(() => buildKnowledgeLines(messages), [messages]);
  const understandingState = useMemo(() => buildUnderstandingState(messages), [messages]);
  const latestKnowledgeMessageId = useMemo(() => latestKnowledgeAssistantMessageId(messages), [messages]);
  const previousKnowledgeKeysRef = useRef<string[] | null>(null);
  const teacherPreviewConversationIdRef = useRef("");
  const [knowledgeAnimationLines, setKnowledgeAnimationLines] = useState<KnowledgeAnimationLine[]>([]);
  const { isUploadingAttachment, readyComposerAttachments } = useMemo(() => {
    const readyAttachments: ComposerAttachment[] = [];
    let hasUploadInFlight = false;

    for (const attachment of composerAttachments) {
      if (attachment.uploadStatus === "uploading") {
        hasUploadInFlight = true;
      } else if (attachment.uploadStatus === "ready") {
        readyAttachments.push(attachment);
      }
    }

    return { isUploadingAttachment: hasUploadInFlight, readyComposerAttachments: readyAttachments };
  }, [composerAttachments]);

  useEffect(() => {
    const currentKeys = knowledgeLines.map((item) => item.key);
    const previousKeys = previousKnowledgeKeysRef.current;

    if (!previousKeys) {
      previousKnowledgeKeysRef.current = currentKeys;
      return;
    }

    const previousKeySet = new Set(previousKeys);
    const addedItems = knowledgeLines.filter((item) => !previousKeySet.has(item.key));
    previousKnowledgeKeysRef.current = currentKeys;

    if (!addedItems.length) {
      return;
    }

    const animationId = Date.now();
    const lines = addedItems.slice(-5).map((item, index) => ({
      colorToken: item.colorToken,
      delayMs: index * 82,
      id: `${item.key}-${animationId}-${index}`
    }));

    setKnowledgeAnimationLines(lines);
    const timeout = window.setTimeout(() => setKnowledgeAnimationLines([]), 780 + lines.length * 82);

    return () => window.clearTimeout(timeout);
  }, [knowledgeLines]);

  const canSendMessage = Boolean(
    activeCourseId &&
      !isSending &&
      !studentChatPaused &&
      (isTeacherPreview || !aiUsageStatus?.blocked) &&
      !isUploadingAttachment &&
      (draft.trim() || readyComposerAttachments.length)
  );

  useEffect(() => {
    resizeStudentComposerTextarea(draftTextareaRef.current);
  }, [draft]);

  useEffect(() => {
    return () => {
      if (sendMotionTimerRef.current) {
        window.clearTimeout(sendMotionTimerRef.current);
      }
      if (justSentTimerRef.current) {
        window.clearTimeout(justSentTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!openHeaderDropdown) {
      return;
    }

    function closeOpenHeaderDropdown() {
      setOpenHeaderDropdown(null);
      if (openHeaderDropdown === "feedback" && !isSendingFeedback) {
        setFeedbackModal(null);
      }
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      if (headerActionsRef.current?.contains(event.target as Node)) {
        return;
      }

      closeOpenHeaderDropdown();
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        closeOpenHeaderDropdown();
      }
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isSendingFeedback, openHeaderDropdown]);

  useEffect(() => {
    if (!isMessageModeMenuOpen) {
      return;
    }

    function closeMessageModeMenuOnOutsidePointer(event: PointerEvent) {
      if (messageModeMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsMessageModeMenuOpen(false);
    }

    function closeMessageModeMenuOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMessageModeMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeMessageModeMenuOnOutsidePointer);
    document.addEventListener("keydown", closeMessageModeMenuOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeMessageModeMenuOnOutsidePointer);
      document.removeEventListener("keydown", closeMessageModeMenuOnEscape);
    };
  }, [isMessageModeMenuOpen]);

  useEffect(() => {
    if (!isTeacherPreview) {
      setIsTeacherDebugMode(false);
      setIsTutorDebugPanelOpen(false);
      setIsTeacherTutorSettingsOpen(false);
      setTeacherPreviewTutorSettings(null);
      setTeacherTutorSettingsError("");
      setTeacherTutorSettingsMessage("");
      return;
    }

    setIsTeacherDebugMode(false);
    setIsTutorDebugPanelOpen(false);
    setIsTeacherTutorSettingsOpen(false);
    setTeacherPreviewTutorSettings(null);
    setTeacherTutorSettingsError("");
    setTeacherTutorSettingsMessage("");
    setTutorDebugOptions(readStoredTutorDebugOptions());
  }, [activeCourseId, isTeacherPreview]);

  useEffect(() => {
    if (!isTeacherPreview) {
      return;
    }

    if (!isTeacherDebugMode) {
      setIsTutorDebugPanelOpen(false);
    }
  }, [isTeacherDebugMode, isTeacherPreview]);

  useEffect(() => {
    if (!isTeacherPreview) {
      return;
    }

    window.localStorage.setItem(teacherPreviewTutorDebugOptionsStorageKey, JSON.stringify(tutorDebugOptions));
  }, [isTeacherPreview, tutorDebugOptions]);

  useEffect(() => {
    if (!firebaseReady || !user || profile?.role !== "student" || isTeacherPreview) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) => fetchStudentClasses(token))
      .then((nextClasses) => {
        if (!isCancelled) {
          setStudentClasses(nextClasses);
          setStudentClassesError("");
          if (activeCourseId && nextClasses.some((studentClass) => studentClass.id === activeCourseId)) {
            setLoadedClassId(activeCourseId);
            setClassLoadError((currentError) => currentError?.classId === activeCourseId ? null : currentError);
            setMessages((currentMessages) => {
              const nextClass = nextClasses.find((studentClass) => studentClass.id === activeCourseId) ?? null;
              return nextClass && isOnlyWelcomeMessage(currentMessages)
                ? buildInitialStudentMessages(nextClass)
                : currentMessages;
            });
          }
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setStudentClasses([]);
          setStudentClassesError(describeStudentClassesError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, firebaseReady, isTeacherPreview, profile?.role, user]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !user || profile?.role !== "student" || isTeacherPreview) {
      setAiUsageStatus(null);
      setAiUsageError("");
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) => fetchStudentAiUsageStatus({ classId: activeCourseId, token }))
      .then((nextStatus) => {
        if (!isCancelled) {
          setAiUsageStatus(nextStatus);
          setAiUsageError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setAiUsageError(caughtError instanceof Error ? caughtError.message : "AI usage failed to load.");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, firebaseReady, isTeacherPreview, profile?.role, user]);

  useEffect(() => {
    if (!activeClass) {
      return;
    }

    setMessages((currentMessages) =>
      isOnlyWelcomeMessage(currentMessages) ? buildInitialStudentMessages(activeClass) : currentMessages
    );
  }, [activeClass]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !activeSelectedConversationId || !user) {
      return;
    }

    let isCancelled = false;
    const controller = new AbortController();

    user
      .getIdToken()
      .then((token) =>
        fetchStudentConversationMessages({
          classId: activeCourseId,
          conversationId: activeSelectedConversationId,
          signal: controller.signal,
          token
        })
      )
      .then((savedMessages) => {
        if (!isCancelled) {
          setMessages(savedMessages.length ? savedMessages : buildInitialStudentMessages(activeClass));
          setConversationMessagesError("");
        }
      })
      .catch((caughtError) => {
        if (isAbortError(caughtError)) {
          return;
        }

        if (!isCancelled) {
          setConversationMessagesError(describeStudentConversationMessageError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [activeClass, activeCourseId, activeSelectedConversationId, firebaseReady, user]);

  function clearComposerAttachments({ revokeLocalUrls = true }: { revokeLocalUrls?: boolean } = {}) {
    setComposerAttachments((currentAttachments) => {
      if (revokeLocalUrls) {
        currentAttachments.forEach((attachment) => {
          if (attachment.localUrl) {
            URL.revokeObjectURL(attachment.localUrl);
          }
        });
      }
      return [];
    });
    setAttachmentError("");
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    await uploadComposerFiles(selectedFiles);
  }

  async function handleAttachmentDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsDraggingAttachment(false);
    await uploadComposerFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function handleAttachmentDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsDraggingAttachment(true);
  }

  async function uploadComposerFiles(files: File[]) {
    if (!files.length || !user || isSending) {
      return;
    }

    if (!activeCourseId) {
      setAttachmentError("Join a class before uploading homework files.");
      return;
    }

    if (studentChatPaused) {
      return;
    }

    setAttachmentError("");

    const availableSlots = maxComposerAttachments - composerAttachments.length;
    const filesToUpload = files.slice(0, Math.max(availableSlots, 0));

    if (!filesToUpload.length) {
      setAttachmentError(`Attach up to ${maxComposerAttachments} files per message.`);
      return;
    }

    if (files.length > filesToUpload.length) {
      setAttachmentError(`Attach up to ${maxComposerAttachments} files per message.`);
    }

    const invalidFileMessage = filesToUpload.map(validateComposerAttachmentFile).find(Boolean);

    if (invalidFileMessage) {
      setAttachmentError(invalidFileMessage);
      return;
    }

    if (isTeacherPreview && filesToUpload.some((file) => file.size > maxTeacherPreviewAttachmentInlineBytes)) {
      setAttachmentError("Teacher preview attachments must be 8 MB or smaller.");
      return;
    }

    try {
      const token = await user.getIdToken();
      const conversationId = isTeacherPreview ? ensureTeacherPreviewConversationId() : await ensureAttachmentConversation(token);

      await Promise.all(filesToUpload.map((file) => uploadSingleComposerAttachment({ conversationId, file, token })));
    } catch (caughtError) {
      setAttachmentError(caughtError instanceof Error ? caughtError.message : "Homework file upload failed.");
    }
  }

  async function ensureAttachmentConversation(token: string) {
    if (activeSelectedConversationId) {
      return activeSelectedConversationId;
    }

    const conversation = await createStudentConversationForAttachment({
      classId: activeCourseId,
      token
    });

    setSelectedConversationId(conversation.id);
    setSelectedConversationClassId(activeCourseId);
    setConversationSummaries((currentConversations) =>
      currentConversations.some((item) => item.id === conversation.id)
        ? currentConversations
        : [conversation, ...currentConversations]
    );

    return conversation.id;
  }

  function ensureTeacherPreviewConversationId() {
    if (!teacherPreviewConversationIdRef.current) {
      teacherPreviewConversationIdRef.current = crypto.randomUUID();
    }

    return teacherPreviewConversationIdRef.current;
  }

  async function uploadSingleComposerAttachment({
    conversationId,
    file,
    token
  }: {
    conversationId: string;
    file: File;
    token: string;
  }) {
    const temporaryId = crypto.randomUUID();
    const localUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    const temporaryAttachment: ComposerAttachment = {
      classId: activeCourseId,
      conversationId,
      createdAt: new Date().toISOString(),
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
      id: temporaryId,
      localUrl,
      messageId: null,
      mimeType: file.type || contentTypeFromFileName(file.name),
      pageCount: null,
      progress: 0,
      storageKey: "",
      studentId: user?.uid ?? "",
      updatedAt: new Date().toISOString(),
      uploadStatus: "uploading"
    };

    setComposerAttachments((currentAttachments) => [...currentAttachments, temporaryAttachment]);

    try {
      const onProgress = (progress: number) => {
        setComposerAttachments((currentAttachments) =>
          currentAttachments.map((item) => (item.id === temporaryId ? { ...item, progress } : item))
        );
      };
      const attachment = isTeacherPreview
        ? await prepareTeacherPreviewAttachment({
            classId: activeCourseId,
            conversationId,
            file,
            id: temporaryId,
            onProgress
          })
        : await uploadHomeworkAttachmentWithProgress({
            classId: activeCourseId,
            conversationId,
            file,
            token,
            onProgress
          });

      setComposerAttachments((currentAttachments) =>
        currentAttachments.map((item) =>
          item.id === temporaryId
            ? {
                ...attachment,
                localUrl,
                progress: 100
              }
            : item
        )
      );
    } catch (caughtError) {
      setComposerAttachments((currentAttachments) =>
        currentAttachments.map((item) =>
          item.id === temporaryId
            ? {
                ...item,
                error: caughtError instanceof Error ? caughtError.message : "Upload failed.",
                progress: 100,
                uploadStatus: "failed"
              }
            : item
        )
      );
    }
  }

  async function removeComposerAttachment(attachment: ComposerAttachment) {
    if (attachment.localUrl) {
      URL.revokeObjectURL(attachment.localUrl);
    }

    setComposerAttachments((currentAttachments) => currentAttachments.filter((item) => item.id !== attachment.id));

    if (attachment.uploadStatus !== "ready" || !user || isTeacherPreview) {
      return;
    }

    try {
      const token = await user.getIdToken();
      await deleteHomeworkAttachment({
        attachmentId: attachment.id,
        classId: activeCourseId,
        conversationId: attachment.conversationId,
        token
      });
    } catch (caughtError) {
      setAttachmentError(caughtError instanceof Error ? caughtError.message : "Attachment could not be removed.");
    }
  }

  function openFeedbackModal(nextFeedback: FeedbackModalState = { defaultComment: "", kind: "general" }) {
    if (nextFeedback.kind === "prompted" && nextFeedback.conversationId) {
      markFeedbackPromptShown(activeCourseId, nextFeedback.conversationId);
    }
    setFeedbackModal(nextFeedback);
    setOpenHeaderDropdown("feedback");
    setFeedbackRating("helpful");
    setFeedbackComment(nextFeedback.defaultComment);
    setFeedbackMessage("");
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user || !activeCourseId || !feedbackModal || isSendingFeedback) {
      return;
    }

    const comment = feedbackComment.trim();

    if (!comment) {
      setFeedbackMessage("Add a short note before sending feedback.");
      return;
    }

    setIsSendingFeedback(true);
    setFeedbackMessage("");

    try {
      const token = await user.getIdToken();
      let conversationId = feedbackModal.conversationId || activeSelectedConversationId;

      if (!conversationId) {
        const conversation = await createStudentConversationForAttachment({
          classId: activeCourseId,
          token
        });
        conversationId = conversation.id;
        setSelectedConversationId(conversation.id);
        setSelectedConversationClassId(activeCourseId);
      }

      await sendStudentFeedback({
        classId: activeCourseId,
        comment,
        conversationId,
        kind: feedbackModal.kind,
        messageId: feedbackModal.messageId ?? undefined,
        promptReason: feedbackModal.promptReason,
        rating: feedbackRating,
        token
      });

      markFeedbackPromptShown(activeCourseId, conversationId);
      if (!isTeacherPreview) {
        setConversationSummaries(await fetchStudentConversationSummaries({ classId: activeCourseId, token }));
      }
      setFeedbackModal(null);
      setOpenHeaderDropdown(null);
      setFeedbackComment("");
      setFeedbackMessage("Feedback sent.");
    } catch (caughtError) {
      setFeedbackMessage(caughtError instanceof Error ? caughtError.message : "Feedback failed to send.");
    } finally {
      setIsSendingFeedback(false);
    }
  }

  async function requestUsageIncrease() {
    if (!user || !activeCourseId || isTeacherPreview || isRequestingUsageIncrease) {
      return;
    }

    setIsRequestingUsageIncrease(true);
    setUsageIncreaseRequestMessage("");

    try {
      const token = await user.getIdToken();
      let conversationId = activeSelectedConversationId;

      if (!conversationId) {
        const conversation = await createStudentConversationForAttachment({
          classId: activeCourseId,
          token
        });
        conversationId = conversation.id;
        setSelectedConversationId(conversation.id);
        setSelectedConversationClassId(activeCourseId);
      }

      await sendStudentFeedback({
        classId: activeCourseId,
        comment: aiUsageIncreaseRequestComment,
        conversationId,
        kind: "usage_request",
        rating: "other",
        token
      });

      if (!isTeacherPreview) {
        setConversationSummaries(await fetchStudentConversationSummaries({ classId: activeCourseId, token }));
      }
      setUsageIncreaseRequestMessage("Request sent to your professor.");
    } catch (caughtError) {
      setUsageIncreaseRequestMessage(
        caughtError instanceof Error ? caughtError.message : "Usage request failed to send."
      );
    } finally {
      setIsRequestingUsageIncrease(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    const hasPendingAttachment = composerAttachments.some((attachment) => attachment.uploadStatus === "uploading");

    if (hasPendingAttachment) {
      setAttachmentError("Wait for attachments to finish uploading before sending.");
      return;
    }

    if (!canSendMessage || sendInFlightRef.current) {
      return;
    }

    await sendStudentMessage(content || "Can you help me with this attached homework material?", {
      attachments: readyComposerAttachments,
      clearComposer: true,
      studentMessageMode
    });
  }

  function applySafetyBlockedResponse({
    classId,
    error,
    pauseAction,
    pauseUntil
  }: {
    classId: string;
    error?: string;
    pauseAction?: string;
    pauseUntil?: string;
  }) {
    const safetyMessage =
      error ||
      "I can't help with that message. Please rephrase it in a way that stays safe and focused on classwork.";

    setMessages((currentMessages) => {
      const lastMessage = currentMessages[currentMessages.length - 1];

      if (lastMessage?.role === "assistant" && lastMessage.content === safetyMessage) {
        return currentMessages;
      }

      return [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: safetyMessage,
          createdAt: new Date().toISOString()
        }
      ];
    });

    if (pauseAction === "temporary_pause" || pauseAction === "permanent_pause") {
      setStudentClasses((currentClasses) =>
        currentClasses.map((studentClass) =>
          studentClass.id === classId
            ? {
                ...studentClass,
                chatBlocked: true,
                chatBlockedReason: "student_chat_safety",
                chatBlockedUntil: pauseAction === "temporary_pause" ? pauseUntil ?? null : null
              }
            : studentClass
        )
      );
    }
  }

  async function sendStudentMessage(
    content: string,
    options: {
      attachments?: ComposerAttachment[];
      clearComposer?: boolean;
      studentMessageMode?: StudentMessageMode;
    } = {}
  ) {
    const trimmedContent = content.trim();
    const attachments = options.attachments ?? [];

    if (
      !activeCourseId ||
      !trimmedContent ||
      sendInFlightRef.current ||
      studentChatPaused ||
      (!isTeacherPreview && aiUsageStatus?.blocked) ||
      attachments.some((attachment) => attachment.uploadStatus !== "ready")
    ) {
      return;
    }

    if (!user) {
      return;
    }

    const studentMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "student",
      attachments,
      content: trimmedContent,
      createdAt: new Date().toISOString(),
      studentMessageMode: options.studentMessageMode ?? "ask"
    };

    const sentAttachmentIds = attachments.map((attachment) => attachment.id);
    const nextMessages = [...messages, studentMessage];
    if (sendMotionTimerRef.current) {
      window.clearTimeout(sendMotionTimerRef.current);
    }
    if (justSentTimerRef.current) {
      window.clearTimeout(justSentTimerRef.current);
    }
    setIsSendMotionActive(true);
    setJustSentMessageId(studentMessage.id);
    sendMotionTimerRef.current = window.setTimeout(() => setIsSendMotionActive(false), 620);
    justSentTimerRef.current = window.setTimeout(() => setJustSentMessageId(""), 760);
    sendInFlightRef.current = true;
    setIsSending(true);
    setChatProgress({
      message: "Getting ready.",
      searches: []
    });
    let pendingFeedbackPrompt: FeedbackModalState | null = null;
    let quickResponseMessageId = `quick-${studentMessage.id}`;
    const primaryStreamingAssistantMessageId = quickResponseMessageId;
    const contextStreamingAssistantMessageId = `grounded-${studentMessage.id}`;
    let contextGroundedStreamStarted = false;
    let contextGroundedMessageId = primaryStreamingAssistantMessageId;
    let primaryAssistantVisible = false;

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          attachmentIds: sentAttachmentIds,
          attachmentFiles: isTeacherPreview ? buildTeacherPreviewAttachmentFiles(attachments) : undefined,
          conversationId: activeSelectedConversationId || undefined,
          courseId: activeCourseId,
          debugOptions:
            isTeacherPreview && isTeacherDebugMode
              ? {
                  forceAiUsageBlocked: tutorDebugOptions.forceAiUsageBlocked,
                  forceAiUsageNearLimit: tutorDebugOptions.forceAiUsageNearLimit,
                  forceConfusionChoices: tutorDebugOptions.forceConfusionChoices,
                  forceNoRetrieval: tutorDebugOptions.forceNoRetrieval,
                  forceRetrieval: tutorDebugOptions.forceRetrieval,
                  forceStudentView: tutorDebugOptions.forceStudentView
                }
              : undefined,
          messages: nextMessages,
          stream: true,
          teacherPreviewTutorSettings:
            isTeacherPreview && profile?.role === "teacher"
              ? effectiveTeacherPreviewTutorSettings
              : undefined
        })
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          aiUsageStatus?: StudentAiUsageStatus;
          error?: string;
          errorCode?: string;
          safety?: {
            pauseAction?: string;
            pauseUntil?: string;
          };
        };
        if (data.aiUsageStatus) {
          setAiUsageStatus(data.aiUsageStatus);
        }
        if (data.errorCode === "CHAT_SAFETY_BLOCKED") {
          applySafetyBlockedResponse({
            classId: activeCourseId,
            error: data.error,
            pauseAction: data.safety?.pauseAction,
            pauseUntil: data.safety?.pauseUntil
          });
          return;
        }
        throw new Error(data.error ?? "Chat request failed");
      }

      setMessages(nextMessages);
      if (options.clearComposer) {
        setDraft("");
        clearComposerAttachments({ revokeLocalUrls: false });
      }

      const showExactSearches = isTeacherPreview && isTeacherDebugMode;
      const data = await readChatStream(response, (event) => {
        if (event.type === "step") {
          setChatProgress((current) => ({
            message: event.message,
            searches: current?.searches ?? []
          }));
        }

        if (event.type === "section_start" || event.type === "section_delta" || event.type === "section_done") {
          setChatProgress(null);
          if (event.call === "context_grounded_answer" && !contextGroundedStreamStarted) {
            contextGroundedStreamStarted = true;
            contextGroundedMessageId = primaryAssistantVisible
              ? contextStreamingAssistantMessageId
              : primaryStreamingAssistantMessageId;
          }
          if (event.call !== "context_grounded_answer") {
            primaryAssistantVisible = true;
          }
          const streamedMessageId =
            event.call === "context_grounded_answer"
              ? contextGroundedMessageId
              : primaryStreamingAssistantMessageId;
          setMessages((current) =>
            upsertStreamedAssistantSection({
              event,
              messageId: streamedMessageId,
              messages: current
            })
          );
        }

        if (event.type === "quick_response") {
          primaryAssistantVisible = true;
          setChatProgress((current) => ({
            message: "Checking class materials.",
            searches: current?.searches ?? []
          }));
          setMessages((current) =>
            upsertChatMessage(current, {
              id: quickResponseMessageId,
              role: "assistant",
              content: quickResponseContent(event),
              createdAt: new Date().toISOString(),
              debugInfo: event.debugInfo,
              langGraphTrace: event.langGraphTrace,
              sources: [],
              structuredOutput: event.structuredOutput
            })
          );
        }

        if (event.type === "search") {
          setChatProgress((current) =>
            appendProgressSearches(current, event.message, [
              {
                description: showExactSearches
                  ? `Query: ${event.query}`
                  : studentSearchPurposeLabel(event.retrievalReason, event.query, event.description),
                query: event.query,
                retrievalReason: showExactSearches ? undefined : event.retrievalReason,
                searchNumber: event.searchNumber
              }
            ])
          );
        }

        if (event.type === "search_batch") {
          const searches =
            event.searches ??
            event.queries.map((query, index) => ({
              description: showExactSearches ? `Query: ${query}` : studentSearchPurposeLabel(undefined, query),
              query,
              retrievalReason: undefined,
              searchNumber: event.searchNumbers?.[index]
            }));

          setChatProgress((current) =>
            appendProgressSearches(
              current,
              event.message,
              searches.map((search) => ({
                ...search,
                description: showExactSearches
                  ? `Query: ${search.query}`
                  : studentSearchPurposeLabel(search.retrievalReason, search.query, search.description),
                retrievalReason: showExactSearches ? undefined : search.retrievalReason
              }))
            )
          );
        }
      });

      if (data.conversationId && data.conversationId !== activeSelectedConversationId) {
        setSelectedConversationId(data.conversationId);
        setSelectedConversationClassId(activeCourseId);
      }

      if (data.aiUsageStatus) {
        setAiUsageStatus(data.aiUsageStatus);
        setAiUsageError("");
      }

      if (!isTeacherPreview) {
        try {
          setConversationSummaries(await fetchStudentConversationSummaries({ classId: activeCourseId, token }));
          setConversationLoadError("");
        } catch (caughtError) {
          setConversationLoadError(describeStudentConversationLoadError(caughtError));
        }
      }

      const assistantMessage: ChatMessage = {
        id: data.assistantMessageId ?? crypto.randomUUID(),
        role: "assistant",
        content: data.message ?? data.content ?? "I could not generate a response.",
        createdAt: new Date().toISOString(),
        debugInfo: data.debugInfo,
        langGraphTrace: data.langGraphTrace,
        retrievalConfidence: data.retrievalConfidence,
        sources: data.sources ?? [],
        structuredOutput: data.structuredOutput
      };

      const finalHasContextGroundedAnswer = data.langGraphTrace?.stages?.includes("context_grounded_answer") ?? false;
      const finalStreamedMessageId =
        finalHasContextGroundedAnswer && primaryAssistantVisible && !contextGroundedStreamStarted
          ? ""
          : contextGroundedStreamStarted
            ? contextGroundedMessageId
            : primaryStreamingAssistantMessageId;
      setMessages((current) =>
        upsertFinalAssistantMessagePreservingStreamedContent({
          finalMessage: assistantMessage,
          messages: current,
          streamedMessageId: finalStreamedMessageId
        })
      );
      pendingFeedbackPrompt = buildFeedbackPromptCandidate({
        assistantMessage,
        classId: activeCourseId,
        conversationId: data.conversationId ?? activeSelectedConversationId,
        messages: nextMessages
      });
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "I could not reach the tutor service. Try again in a moment.";
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: message,
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
      setChatProgress(null);
      if (pendingFeedbackPrompt) {
        openFeedbackModal(pendingFeedbackPrompt);
      }
    }
  }

  async function updatePersonalThemePreference(nextPreference: {
    appearance?: unknown;
    themeColor?: unknown;
  }) {
    if (!user) {
      return;
    }

    const previousPreview = themePreferencePreview;
    const nextAppearance = normalizeTeacherClassAppearance(nextPreference.appearance ?? activeAppearance);
    const nextThemeColor = normalizeTeacherClassThemeColor(nextPreference.themeColor ?? activeThemeColor);

    setThemePreferenceError("");
    setThemePreferencePreview({
      appearance: nextAppearance,
      themeColor: nextThemeColor
    });
    setIsSavingThemePreference(true);

    try {
      await updateUserThemePreference({
        appearance: nextAppearance,
        themeColor: nextThemeColor,
        uid: user.uid
      });
    } catch (caughtError) {
      setThemePreferencePreview(previousPreview);
      setThemePreferenceError(caughtError instanceof Error ? caughtError.message : "Theme preference failed.");
    } finally {
      setIsSavingThemePreference(false);
    }
  }

  async function saveAccountSettings() {
    if (!user) {
      return;
    }

    setAccountSettingsError("");

    const nextEmail = accountEmailValue.trim().toLowerCase();
    const passwordChanged = Boolean(newAccountPassword);
    const emailChanged = Boolean(nextEmail && nextEmail !== accountEmail.trim().toLowerCase());

    if (!nextEmail) {
      setAccountSettingsError("Enter an email address.");
      return;
    }

    if (passwordChanged && newAccountPassword.length < 6) {
      setAccountSettingsError("New password must be at least 6 characters.");
      return;
    }

    if (passwordChanged && newAccountPassword !== confirmAccountPassword) {
      setAccountSettingsError("New password and confirmation do not match.");
      return;
    }

    if ((emailChanged || passwordChanged) && !currentAccountPassword) {
      setAccountSettingsError("Enter your current password before changing email or password.");
      return;
    }

    setIsSavingAccountSettings(true);

    try {
      const nextUsername =
        !accountUsername && accountUsernameValue === accountEmail && emailChanged
          ? nextEmail
          : accountUsername ?? accountUsernameValue;

      await updateUserAccountSettings({
        appearance: activeAppearance,
        currentPassword: currentAccountPassword,
        displayName: accountDisplayName ?? accountName,
        email: nextEmail,
        newPassword: newAccountPassword,
        themeColor: activeThemeColor,
        uid: user.uid,
        username: nextUsername
      });
      setAccountDisplayName(null);
      setAccountEmailDraft(null);
      setAccountUsername(null);
      setCurrentAccountPassword("");
      setNewAccountPassword("");
      setConfirmAccountPassword("");
    } catch (caughtError) {
      setAccountSettingsError(caughtError instanceof Error ? caughtError.message : "Account settings failed.");
    } finally {
      setIsSavingAccountSettings(false);
    }
  }

  function startNewConversation() {
    setStudentMainView("chat");
    setSelectedConversationId("");
    setSelectedConversationClassId(activeCourseId);
    setMessages(buildInitialStudentMessages(activeClass));
    clearComposerAttachments();
    setConversationMessagesError("");
  }

  async function switchStudentClass(classId: string) {
    if (!user || !classId || classId === activeCourseId || isSwitchingClass) {
      setIsClassDropdownOpen(false);
      return;
    }

    setIsSwitchingClass(true);
    setStudentClassesError("");

    try {
      await updateStudentClass({ classId, uid: user.uid });
      setStudentMainView("chat");
      setSelectedConversationId("");
      setSelectedConversationClassId(classId);
      setMessages(buildInitialStudentMessages(null));
      clearComposerAttachments();
      setConversationMessagesError("");
      setIsClassDropdownOpen(false);
    } catch (caughtError) {
      setStudentClassesError(describeStudentClassesError(caughtError));
    } finally {
      setIsSwitchingClass(false);
    }
  }

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth?mode=signin");
  }

  async function handleSignOutAllSessions() {
    await signOutAllSessions();
    router.push("/auth?mode=signin");
  }

  async function handleDeleteAccount() {
    if (!user) {
      return;
    }

    setAccountSettingsError("");
    setIsDeletingAccount(true);

    try {
      await deleteCurrentAccount({
        currentPassword: deleteAccountPassword,
        uid: user.uid
      });
      router.push("/auth?mode=signin");
    } catch (caughtError) {
      setAccountSettingsError(caughtError instanceof Error ? caughtError.message : "Account deletion failed.");
    } finally {
      setIsDeletingAccount(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const showStarterGuidance = isOnlyWelcomeMessage(messages) && !isSending;

  function chooseStarterPrompt(prompt: string, mode: StudentMessageMode = "ask") {
    setStudentMessageMode(mode);
    setDraft(prompt);
    requestAnimationFrame(() => {
      resizeStudentComposerTextarea(draftTextareaRef.current);
      draftTextareaRef.current?.focus();
    });
  }

  function loadChoiceMessageIntoComposer(messageId: string, choice: TutorConfusionChoice) {
    setSelectedTutorChoiceByMessageId((currentSelections) => ({
      ...currentSelections,
      [messageId]: choice.id
    }));
    const choiceMessage = choice.message;
    setDraft(choiceMessage);
    requestAnimationFrame(() => {
      resizeStudentComposerTextarea(draftTextareaRef.current);
      draftTextareaRef.current?.focus();
    });
  }

  function updateTeacherPreviewTutorSettings(formData: FormData) {
    if (!isTeacherPreview || profile?.role !== "teacher") {
      return;
    }

    const currentSettings = teacherPreviewTutorSettings ?? buildTeacherPreviewTutorSettings(savedClass);
    const currentAnswerPolicy = currentSettings.answerPolicy;
    const currentModelSettings = currentSettings.modelSettings;
    const currentResponseFormat = currentSettings.responseFormat;
    const nextAnswerPolicy = normalizeAnswerPolicySettings({
      ...currentAnswerPolicy,
      allowWorkedExamples: formData.has("answerPolicy.allowWorkedExamples"),
      askGuidingQuestionBeforeExplaining: formData.has("answerPolicy.askGuidingQuestionBeforeExplaining"),
      doNotGiveFinalAnswers: formData.has("answerPolicy.doNotGiveFinalAnswers"),
      requireStudentAttemptFirst: formData.has("answerPolicy.requireStudentAttemptFirst")
    });
    const nextModelSettings = normalizeClassModelSettings({
      ...currentModelSettings,
      verbose: String(formData.get("modelSettings.verbose") ?? currentModelSettings.verbose)
    });
    const nextResponseFormat = normalizeResponseFormatSettings({
      ...currentResponseFormat,
      simpleWording: formData.has("responseFormat.simpleWording"),
      tutorVoice: String(formData.get("responseFormat.tutorVoice") ?? currentResponseFormat.tutorVoice)
    });

    setTeacherPreviewTutorSettings({
      answerPolicy: nextAnswerPolicy,
      behaviorInstructions: String(formData.get("behaviorInstructions") ?? ""),
      behaviorTitle: normalizeTutorBehavior(formData.get("behaviorTitle")),
      modelSettings: nextModelSettings,
      responseFormat: nextResponseFormat
    });
    setTeacherTutorSettingsMessage("");
  }

  async function saveTeacherPreviewTutorSettings() {
    if (!user || !activeCourseId || !isTeacherPreview || profile?.role !== "teacher" || isSavingTeacherTutorSettings) {
      return;
    }

    const settingsToSave = teacherPreviewTutorSettings ?? buildTeacherPreviewTutorSettings(savedClass);
    setIsSavingTeacherTutorSettings(true);
    setTeacherTutorSettingsError("");
    setTeacherTutorSettingsMessage("");

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(activeCourseId)}/settings`), {
        body: JSON.stringify({
          answerPolicy: settingsToSave.answerPolicy,
          behaviorInstructions: settingsToSave.behaviorInstructions,
          behaviorTitle: settingsToSave.behaviorTitle,
          modelSettings: settingsToSave.modelSettings,
          responseFormat: settingsToSave.responseFormat
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "AI tutor settings could not be saved.");
      }

      setTeacherTutorSettingsMessage("Saved to class.");
    } catch (caughtError) {
      setTeacherTutorSettingsError(caughtError instanceof Error ? caughtError.message : "AI tutor settings could not be saved.");
    } finally {
      setIsSavingTeacherTutorSettings(false);
    }
  }

  return (
    <RequireAuth role={isTeacherPreview ? ["student", "teacher"] : "student"}>
      <section
        className="student-workspace-shell"
        data-appearance={activeAppearance}
        data-sidebar-collapsed={isSidebarCollapsed}
        data-student-view={studentMainView}
        data-theme-color={activeThemeColor}
      >
        <aside className="student-workspace-sidebar" aria-label="Student workspace navigation">
          <button
            className="student-sidebar-collapse-toggle"
            type="button"
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={isSidebarCollapsed}
            onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          >
            <span aria-hidden="true" />
          </button>
          <div className="student-sidebar-scroll">
            <section className="student-class-section" aria-label="Current class">
              <h2 className="student-sidebar-title">Classes</h2>
              <div className="student-sidebar-card student-current-class-card">
                <button
                  className="student-class-select-card"
                  type="button"
                  aria-expanded={isClassDropdownOpen}
                  aria-haspopup="listbox"
                  disabled={isTeacherPreview || isSwitchingClass}
                  onClick={() => setIsClassDropdownOpen((isOpen) => !isOpen)}
                >
                  <h3>{className}</h3>
                  {classSectionLabel ? <span>{classSectionLabel}</span> : null}
                  <span className="student-class-compact-label" aria-hidden="true">
                    {compactClassLabel}
                  </span>
                  <span className="student-class-chevron" aria-hidden="true" />
                </button>
                {isClassDropdownOpen && !isTeacherPreview ? (
                  <div className="student-class-dropdown" role="listbox" aria-label="Student classes">
                    {visibleStudentClasses.map((studentClass) => (
                      <button
                        aria-selected={studentClass.id === activeCourseId}
                        className="student-class-option"
                        disabled={isSwitchingClass}
                        key={studentClass.id}
                        role="option"
                        type="button"
                        onClick={() => void switchStudentClass(studentClass.id)}
                      >
                        <span>
                          <strong>{studentClass.name}</strong>
                          <small>{formatClassSectionLabel(studentClass.section, true) || "Class"}</small>
                        </span>
                        {studentClass.id === activeCourseId ? <mark>Active</mark> : null}
                      </button>
                    ))}
                    {!visibleStudentClasses.length ? <p className="sidebar-note">No enrolled classes found.</p> : null}
                  </div>
                ) : null}
                {isLoadingClass ? <p className="sidebar-note">Loading class.</p> : null}
                {classLoadMessage ? <p className="form-error">{classLoadMessage}</p> : null}
                {studentClassesError ? <p className="form-error">{studentClassesError}</p> : null}
                {isTeacherPreview ? (
                  <Link className="student-sidebar-action student-dashboard-link" href="/teacher" aria-label="Back to teacher dashboard">
                    <svg className="student-dashboard-link-icon" aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M10.5 19 3.5 12l7-7" />
                      <path d="M4 12h16" />
                    </svg>
                    <span className="student-dashboard-link-label">Back to dashboard</span>
                  </Link>
                ) : null}

                {profile?.role === "student" && !isTeacherPreview ? (
                  <div className="student-class-code-display" aria-label="Class code">
                    <span>Class code</span>
                    <strong>{visibleClassCode || "No class joined"}</strong>
                  </div>
                ) : null}
              </div>
            </section>

            {profile?.role === "student" && !isTeacherPreview ? (
              <section className="student-conversation-history" aria-label="Saved conversations">
                <div className="sidebar-section-heading">
                  <strong>Conversations</strong>
                  <button
                    className="student-new-mini-button"
                    disabled={studentChatPaused}
                    title={studentChatPaused ? "Chat is paused right now." : "Start a new conversation"}
                    type="button"
                    onClick={startNewConversation}
                  >
                    <span className="student-new-label">New</span>
                    <svg className="student-new-icon" aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
                {!isSidebarCollapsed ? (
                  <>
                    {conversationLoadError ? <p className="form-error">{conversationLoadError}</p> : null}
                    <div className="student-conversation-list">
                      {visibleConversationSummaries.map((conversation) => (
                        <button
                          aria-pressed={conversation.id === activeSelectedConversationId}
                          className="student-conversation-row"
                          key={conversation.id}
                          title={formatConversationHoverTitle(conversation)}
                          type="button"
                          onClick={() => {
                            setStudentMainView("chat");
                            clearComposerAttachments();
                            setSelectedConversationId(conversation.id);
                            setSelectedConversationClassId(activeCourseId);
                          }}
                        >
                          <span className="student-conversation-copy">
                            <strong>{formatConversationDisplayTitle(conversation)}</strong>
                            <span>{formatConversationMeta(conversation)}</span>
                          </span>
                          <span className="student-conversation-compact-label" aria-hidden="true">
                            {formatConversationCompactLabel(formatConversationDisplayTitle(conversation))}
                          </span>
                          <span className="student-row-menu" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                        </button>
                      ))}
                      {!visibleConversationSummaries.length && !conversationLoadError ? (
                        <p className="sidebar-note">No saved conversations.</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="student-sidebar-footer">
            {isTeacherPreview && profile?.role === "teacher" ? (
              <div className="teacher-preview-tutor-settings">
                <button
                  className="teacher-preview-settings-toggle"
                  type="button"
                  aria-expanded={isTeacherTutorSettingsOpen}
                  aria-controls="teacher-preview-tutor-settings-panel"
                  onClick={() => {
                    if (isSidebarCollapsed) {
                      setIsSidebarCollapsed(false);
                      setIsTeacherTutorSettingsOpen(true);
                      return;
                    }

                    setIsTeacherTutorSettingsOpen((isOpen) => !isOpen);
                  }}
                >
                  <span className="teacher-preview-settings-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M5 5.5h14v10H8l-3 3v-13Z" />
                      <path d="M9 9h6M9 12h4" />
                    </svg>
                  </span>
                  <span className="teacher-preview-settings-copy">
                    <strong>AI tutor settings</strong>
                    <small>Preview this chat</small>
                  </span>
                </button>
                {isTeacherTutorSettingsOpen ? (
                  <TeacherPreviewTutorSettingsPanel
                    error={teacherTutorSettingsError}
                    isSaving={isSavingTeacherTutorSettings}
                    message={teacherTutorSettingsMessage}
                    settings={effectiveTeacherPreviewTutorSettings}
                    onClose={() => setIsTeacherTutorSettingsOpen(false)}
                    onPreviewChange={updateTeacherPreviewTutorSettings}
                    onSave={() => void saveTeacherPreviewTutorSettings()}
                  />
                ) : null}
              </div>
            ) : null}

            <section className="student-account-card" aria-label="Signed in account">
              <span className="student-avatar" aria-hidden="true">
                {getInitials(accountName, accountEmail)}
              </span>
              <span className="student-account-copy">
                <strong>{accountName}</strong>
                <span>{accountEmail}</span>
              </span>
              <button className="student-signout-button" type="button" onClick={handleSignOut}>
                Sign out
              </button>
            </section>

            <div className="student-brand-row" aria-label="Chandra">
              <Link className="student-brand" href="/">
                <span className="student-wordmark">Chandra</span>
              </Link>
              <span className="student-brand-divider" aria-hidden="true" />
              <button
                className="student-brand-mode-toggle"
                disabled={isSavingThemePreference}
                type="button"
                aria-label={activeAppearance === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                onClick={() =>
                  updatePersonalThemePreference({
                    appearance: activeAppearance === "dark" ? "light" : "dark"
                  })
                }
              >
                <svg className="student-mode-icon" aria-hidden="true" viewBox="0 0 24 24">
                  {activeAppearance === "dark" ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2.7v2.1M12 19.2v2.1M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2.7 12h2.1M19.2 12h2.1M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
                    </>
                  ) : (
                    <path d="M20.2 15.2A7.6 7.6 0 0 1 8.8 3.8 8.4 8.4 0 1 0 20.2 15.2Z" />
                  )}
                </svg>
              </button>
              <button
                className="student-brand-settings-toggle"
                type="button"
                aria-label={studentMainView === "settings" ? "Back to chat" : "Open settings"}
                aria-pressed={studentMainView === "settings"}
                onClick={() => setStudentMainView((currentView) => (currentView === "settings" ? "chat" : "settings"))}
              >
                <svg className="student-mode-icon" aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z" />
                  <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06a2.2 2.2 0 0 1-3.11 3.11l-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.09 1.65V21.5a2.2 2.2 0 0 1-4.4 0v-.09a1.8 1.8 0 0 0-1.08-1.65 1.8 1.8 0 0 0-2 .36l-.06.06a2.2 2.2 0 0 1-3.11-3.11l.06-.06a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.65-1.09H1.5a2.2 2.2 0 0 1 0-4.4h.09a1.8 1.8 0 0 0 1.65-1.08 1.8 1.8 0 0 0-.36-2l-.06-.06a2.2 2.2 0 1 1 3.11-3.11l.06.06a1.8 1.8 0 0 0 2 .36H8a1.8 1.8 0 0 0 1.08-1.65V1.5a2.2 2.2 0 0 1 4.4 0v.09A1.8 1.8 0 0 0 14.56 3.2a1.8 1.8 0 0 0 2-.36l.06-.06a2.2 2.2 0 0 1 3.11 3.11l-.06.06a1.8 1.8 0 0 0-.36 2v.01a1.8 1.8 0 0 0 1.65 1.08h.09a2.2 2.2 0 0 1 0 4.4h-.09A1.8 1.8 0 0 0 19.4 15Z" />
                </svg>
              </button>
            </div>
            {themePreferenceError ? <p className="form-error">{themePreferenceError}</p> : null}
          </div>
        </aside>

        {studentMainView === "settings" ? (
          <StudentSettingsPanel
            accountEmail={accountEmail}
            accountEmailValue={accountEmailValue}
            accountDisplayName={accountDisplayName ?? accountName}
            accountLastSignInAt={accountLastSignInAt}
            accountUsername={accountUsername ?? accountUsernameValue}
            accountSettingsError={accountSettingsError}
            confirmAccountPassword={confirmAccountPassword}
            currentAccountPassword={currentAccountPassword}
            activeAppearance={activeAppearance}
            activeClass={activeClass}
            activeClassId={activeCourseId}
            activeThemeColor={activeThemeColor}
            classLoadMessage={classLoadMessage}
            classes={visibleStudentClasses}
            isSavingAccountSettings={isSavingAccountSettings}
            isDeletingAccount={isDeletingAccount}
            isSavingThemePreference={isSavingThemePreference}
            isTeacherDebugMode={isTeacherDebugMode}
            isTeacherPreview={isTeacherPreview}
            newAccountPassword={newAccountPassword}
            role={profile?.role ?? "student"}
            themePreferenceError={themePreferenceError}
            onAccountDisplayNameChange={setAccountDisplayName}
            onAccountEmailChange={setAccountEmailDraft}
            onAccountUsernameChange={setAccountUsername}
            onConfirmAccountPasswordChange={setConfirmAccountPassword}
            onCurrentAccountPasswordChange={setCurrentAccountPassword}
            onDeleteAccount={handleDeleteAccount}
            onDeleteAccountPasswordChange={setDeleteAccountPassword}
            onNewAccountPasswordChange={setNewAccountPassword}
            onTeacherDebugModeChange={setIsTeacherDebugMode}
            onSaveAccountSettings={saveAccountSettings}
            onSignOut={handleSignOut}
            onSignOutAllSessions={handleSignOutAllSessions}
            onBackToChat={() => setStudentMainView("chat")}
            onUpdateThemePreference={updatePersonalThemePreference}
            deleteAccountPassword={deleteAccountPassword}
          />
        ) : (
          <section className="student-workspace-main" aria-label="Student tutor chat">
            <header className="student-main-header">
              <div className="student-main-title">
                <h1>
                  <span>{className}</span>
                  {classSectionLabel ? <span>{classSectionLabel}</span> : null}
                </h1>
              </div>
              <div className="student-main-header-actions" ref={headerActionsRef}>
                {showUsageHeader ? (
                  <div className="student-header-control-wrap">
                    <button
                      aria-label={tutoringTimeHeaderLabel}
                      aria-controls="student-usage-popover"
                      aria-expanded={openHeaderDropdown === "usage"}
                      className="student-header-control student-usage-header-control"
                      title={tutoringTimeHeaderLabel}
                      type="button"
                      onClick={() =>
                        setOpenHeaderDropdown((currentDropdown) => (currentDropdown === "usage" ? null : "usage"))
                      }
                    >
                      <HeaderControlIcon kind="tutoringTime" />
                      {displayedAiUsageStatus ? (
                        <span className="student-header-control-label is-always-visible">
                          {usageSummary.todayPercentLeft}% left
                        </span>
                      ) : (
                        <span className="student-header-control-label is-always-visible">{tutoringTimeHeaderText}</span>
                      )}
                    </button>
                    {openHeaderDropdown === "usage" ? (
                      <StudentUsagePopover
                        errorMessage={aiUsageError}
                        id="student-usage-popover"
                        isRequestingMoreUsage={isRequestingUsageIncrease}
                        requestMessage={usageIncreaseRequestMessage}
                        summary={usageSummary}
                        status={displayedAiUsageStatus}
                        onRequestMoreUsage={isTeacherPreview ? undefined : requestUsageIncrease}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className="student-header-control-wrap">
                  <KnowledgeIconButton
                    animationLines={knowledgeAnimationLines}
                    isActive={knowledgeLines.length > 0}
                    isExpanded={openHeaderDropdown === "context"}
                    recentItems={knowledgeLines.slice(-5)}
                    onClick={() =>
                      setOpenHeaderDropdown((currentDropdown) =>
                        currentDropdown === "context" ? null : "context"
                      )
                    }
                  />
                  {openHeaderDropdown === "context" ? (
                    <StudentContextPopover
                      classId={activeCourseId}
                      contextMemory={chatContextMemory}
                      conversationId={activeSelectedConversationId}
                      id="student-context-popover"
                    />
                  ) : null}
                </div>
                <div className="student-header-control-wrap">
                  <UnderstandingLevelButton
                    isExpanded={openHeaderDropdown === "understanding"}
                    state={understandingState}
                    onClick={() =>
                      setOpenHeaderDropdown((currentDropdown) =>
                        currentDropdown === "understanding" ? null : "understanding"
                      )
                    }
                  />
                  {openHeaderDropdown === "understanding" && understandingState ? (
                    <UnderstandingPopover
                      id="student-understanding-popover"
                      state={understandingState}
                    />
                  ) : null}
                </div>
                <div className="student-header-control-wrap">
                  <button
                    aria-label="Feedback"
                    aria-controls="student-feedback-popover"
                    aria-expanded={openHeaderDropdown === "feedback"}
                    className="student-feedback-button student-header-control"
                    disabled={!activeCourseId || isTeacherPreview}
                    title="Feedback"
                    type="button"
                    onClick={() => {
                      if (openHeaderDropdown === "feedback") {
                        if (!isSendingFeedback) {
                          setFeedbackModal(null);
                          setOpenHeaderDropdown(null);
                        }
                        return;
                      }

                      openFeedbackModal();
                    }}
                  >
                    <HeaderControlIcon kind="feedback" />
                    <span className="student-header-control-label">Feedback</span>
                  </button>
                  {feedbackModal && openHeaderDropdown === "feedback" ? (
	                    <StudentFeedbackPopover
	                      comment={feedbackComment}
	                      id="student-feedback-popover"
	                      isSending={isSendingFeedback}
	                      message={feedbackMessage}
	                      rating={feedbackRating}
	                      responses={studentFeedbackResponses}
	                      onClose={() => {
                        if (!isSendingFeedback) {
                          setFeedbackModal(null);
                          setOpenHeaderDropdown(null);
                        }
                      }}
                      onCommentChange={setFeedbackComment}
                      onRatingChange={setFeedbackRating}
                      onSubmit={submitFeedback}
                    />
                  ) : null}
                </div>
              </div>
            </header>
            {conversationMessagesError && !isPausedChatAccessMessage(conversationMessagesError) ? (
              <p className="form-error chat-error">{conversationMessagesError}</p>
            ) : null}
            <div className="message-list student-message-list">
              {showStarterGuidance ? (
                <StudentStarterPanel
                  isDisabled={studentChatPaused || !activeCourseId}
                  onPromptSelect={chooseStarterPrompt}
                />
              ) : null}
              {messages.map((message, messageIndex) => {
                const choicesLocked =
                  message.role === "assistant" &&
                  messages.slice(messageIndex + 1).some((nextMessage) => nextMessage.role === "student");

                return (
                  <StudentChatMessage
                    choicesLocked={choicesLocked}
                    debugEnabled={isTeacherPreview && isTeacherDebugMode}
                    debugOptions={tutorDebugOptions}
                    isJustSent={message.id === justSentMessageId}
                    isLatestKnowledgeMessage={latestKnowledgeMessageId === message.id}
                    isSending={isSending}
                    message={message}
                    key={message.id}
                    selectedChoiceId={selectedTutorChoiceByMessageId[message.id]}
                    onChoiceSelect={loadChoiceMessageIntoComposer}
                  />
                );
              })}
              {isSending && chatProgress ? <ChatProgressMessage progress={chatProgress} /> : null}
            </div>

            <form
              className={`composer student-composer${isDraggingAttachment ? " is-dragging" : ""}${
                studentChatPaused ? " is-paused" : ""
              }${isSendMotionActive ? " is-send-motion" : ""}${
                isSending ? " is-sending" : ""
              }`}
              onDragLeave={() => setIsDraggingAttachment(false)}
              onDragOver={handleAttachmentDragOver}
              onDrop={(event) => void handleAttachmentDrop(event)}
              onSubmit={sendMessage}
            >
              {studentChatPaused ? <p className="student-paused-notice">{studentChatPauseMessage}</p> : null}
              {composerAttachments.length || attachmentError ? (
                <div className="student-composer-attachments" aria-live="polite">
                  {composerAttachments.map((attachment) => (
                    <ComposerAttachmentPreview
                      attachment={attachment}
                      key={attachment.id}
                      onRemove={() => void removeComposerAttachment(attachment)}
                    />
                  ))}
                  {attachmentError ? <p className="form-error student-attachment-error">{attachmentError}</p> : null}
                </div>
              ) : null}
              <input
                ref={attachmentInputRef}
                accept={allowedComposerAttachmentAccept}
                className="student-attachment-input"
                disabled={isSending || studentChatPaused}
                multiple
                type="file"
                onChange={(event) => void handleAttachmentSelection(event)}
              />
              <div className="student-composer-mode-row">
                <MessageModeMenu
                  isDisabled={isSending || studentChatPaused}
                  isOpen={isMessageModeMenuOpen}
                  menuRef={messageModeMenuRef}
                  mode={studentMessageMode}
                  onModeChange={setStudentMessageMode}
                  onOpenChange={setIsMessageModeMenuOpen}
                />
                {isTeacherPreview && isTeacherDebugMode ? (
                  <TutorDebugComposerControl
                    isOpen={isTutorDebugPanelOpen}
                    options={tutorDebugOptions}
                    onOpenChange={setIsTutorDebugPanelOpen}
                    onOptionsChange={setTutorDebugOptions}
                  />
                ) : null}
              </div>
              <button
                className="student-composer-add"
                type="button"
                aria-label="Attach homework file"
                disabled={
                  isSending ||
                  studentChatPaused ||
                  isUploadingAttachment ||
                  composerAttachments.length >= maxComposerAttachments ||
                  !activeCourseId
                }
                onClick={() => attachmentInputRef.current?.click()}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="m8.5 12.8 5.8-5.8a3.4 3.4 0 0 1 4.8 4.8l-7.4 7.4a5 5 0 0 1-7.1-7.1l7.7-7.7" />
                  <path d="m9.6 15 7.1-7.1" />
                </svg>
              </button>
              <textarea
                aria-label="Message Chandra"
                ref={draftTextareaRef}
                value={draft}
                disabled={studentChatPaused}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  studentChatPaused
                    ? studentChatPauseMessage
                    : !isTeacherPreview && aiUsageStatus?.blocked
                    ? "Ask your professor for more tutoring time."
                    : activeCourseId
                      ? studentMessageMode === "work"
                        ? "Paste your attempt or upload work..."
                        : studentComposerPlaceholder
                      : "Join a class to start chatting."
                }
                rows={1}
              />
              <button className="student-send-button" type="submit" disabled={!canSendMessage}>
                <span className="student-send-label">{isSending ? "Sending" : isUploadingAttachment ? "Uploading" : "Send"}</span>
                {isSending ? <span className="student-send-motion-dot" aria-hidden="true" /> : null}
              </button>
            </form>
          </section>
        )}
      </section>
    </RequireAuth>
  );
}

function resizeStudentComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }

  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, studentComposerTextareaMaxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > studentComposerTextareaMaxHeight ? "auto" : "hidden";
}

function StudentStarterPanel({
  isDisabled,
  onPromptSelect
}: {
  isDisabled: boolean;
  onPromptSelect: (prompt: string, mode?: StudentMessageMode) => void;
}) {
  const starterPrompts: Array<{ label: string; mode?: StudentMessageMode; prompt: string }> = [
    {
      label: "Ask about a problem",
      prompt: "Can you help me understand where to start on this problem?"
    },
    {
      label: "Check my work",
      mode: "work",
      prompt: "Can you check my work and tell me what I should revisit?"
    },
    {
      label: "Explain a concept",
      prompt: "Can you explain this concept using my class materials?"
    }
  ];

  return (
    <section className="student-starter-panel" aria-labelledby="student-starter-heading">
      <span className="student-starter-kicker">Tutoring workspace</span>
      <h2 id="student-starter-heading">Start with the problem or step you want to work on.</h2>
      <p>
        Paste a prompt, upload a worksheet image or PDF, or ask Chandra to check an attempt. Short questions are fine.
      </p>
      <div className="student-starter-actions" aria-label="Starter prompts">
        {starterPrompts.map((starterPrompt) => (
          <button
            disabled={isDisabled}
            key={starterPrompt.label}
            type="button"
            onClick={() => onPromptSelect(starterPrompt.prompt, starterPrompt.mode)}
          >
            {starterPrompt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function MessageModeMenu({
  isDisabled,
  isOpen,
  menuRef,
  mode,
  onModeChange,
  onOpenChange
}: {
  isDisabled: boolean;
  isOpen: boolean;
  menuRef: { current: HTMLDivElement | null };
  mode: StudentMessageMode;
  onModeChange: (mode: StudentMessageMode) => void;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const selectedOption = studentMessageModeOptions.find((option) => option.mode === mode) ?? studentMessageModeOptions[0];

  function closeOnBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onOpenChange(false);
    }
  }

  return (
    <div
      className="student-message-mode-menu"
      ref={menuRef}
      onBlur={closeOnBlur}
      onFocus={() => onOpenChange(true)}
      onMouseEnter={() => onOpenChange(true)}
    >
      <button
        aria-controls="student-message-mode-options"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="student-message-mode-trigger"
        disabled={isDisabled}
        type="button"
        onClick={() => onOpenChange(!isOpen)}
      >
        <StudentMessageModeIcon mode={selectedOption.mode} />
        <span>{selectedOption.label}</span>
        <svg className="student-message-mode-chevron" aria-hidden="true" viewBox="0 0 16 16">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {isOpen && !isDisabled ? (
        <div
          className="student-message-mode-options"
          id="student-message-mode-options"
          role="menu"
          aria-label="Message type"
        >
          {studentMessageModeOptions.map((option) => (
            <button
              aria-checked={mode === option.mode}
              className={mode === option.mode ? "is-active" : ""}
              key={option.mode}
              role="menuitemradio"
              type="button"
              onClick={() => {
                onModeChange(option.mode);
                onOpenChange(false);
              }}
            >
              <StudentMessageModeIcon mode={option.mode} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const studentMessageModeOptions: Array<{ label: string; mode: StudentMessageMode }> = [
  { label: "Ask", mode: "ask" },
  { label: "Check my work", mode: "work" }
];

function StudentMessageModeIcon({ mode }: { mode: StudentMessageMode }) {
  return (
    <svg className="student-message-mode-icon" aria-hidden="true" viewBox="0 0 20 20">
      {mode === "work" ? (
        <>
          <path d="M6.2 3.2h6.6l2 2v11.6H6.2z" />
          <path d="M12.8 3.2v2h2" />
          <path d="m7.9 11 1.5 1.5 3.1-3.2" />
          <path d="M8 7.4h3.2" />
        </>
      ) : (
        <>
          <path d="M4 5.1h12v8H9.2L5.1 16v-2.9H4z" />
          <path d="M8.1 8.1a2 2 0 0 1 3.8.8c0 1.5-1.8 1.5-1.8 2.8" />
          <path d="M10.1 14h.01" />
        </>
      )}
    </svg>
  );
}

function StudentFeedbackPopover({
  comment,
  id,
  isSending,
  message,
  rating,
  responses,
  onClose,
  onCommentChange,
  onRatingChange,
  onSubmit
}: {
  comment: string;
  id: string;
  isSending: boolean;
  message: string;
  rating: StudentFeedbackRating;
  responses: StudentFeedback[];
  onClose: () => void;
  onCommentChange: (comment: string) => void;
  onRatingChange: (rating: StudentFeedbackRating) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const ratingOptions: Array<{ label: string; value: StudentFeedbackRating }> = [
    { label: "Helpful", value: "helpful" },
    { label: "Not helpful", value: "not_helpful" },
    { label: "Confusing", value: "confusing" },
    { label: "Incorrect", value: "incorrect" },
    { label: "Other", value: "other" }
  ];

  return (
    <form
      className="student-header-popover student-feedback-popover"
      id={id}
      aria-label="Send feedback about Chandra"
      onSubmit={onSubmit}
    >
      <div className="student-feedback-popover-heading">
        <h2>Feedback</h2>
        <button className="student-feedback-close" aria-label="Close feedback" disabled={isSending} type="button" onClick={onClose}>
          <span aria-hidden="true">x</span>
        </button>
      </div>
      {responses.length ? (
        <div className="student-popover-section student-feedback-responses">
          <h3>Teacher responses</h3>
          {responses.slice(0, 3).map((response) => (
            <article key={response.id}>
              <span>{formatConversationDate(response.studentVisibleResponseSentAt) || "Sent"}</span>
              <p>{response.studentVisibleResponse}</p>
            </article>
          ))}
        </div>
      ) : null}
      <div className="student-popover-section">
        <h3>Rating</h3>
        <div className="student-feedback-rating-grid" role="radiogroup" aria-label="Feedback rating">
          {ratingOptions.map((option) => (
            <button
              aria-pressed={rating === option.value}
              key={option.value}
              type="button"
              onClick={() => onRatingChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="student-popover-section">
        <label htmlFor="student-feedback-comment">Note</label>
        <textarea
          id="student-feedback-comment"
          maxLength={1000}
          placeholder="What should your teacher know?"
          rows={4}
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
        />
      </div>
      {message ? <p className="student-feedback-message">{message}</p> : null}
      <div className="student-feedback-popover-actions">
        <button disabled={isSending} type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="student-feedback-submit" disabled={isSending || !comment.trim()} type="submit">
          {isSending ? "Sending" : "Send feedback"}
        </button>
      </div>
    </form>
  );
}

const StudentChatMessage = memo(function StudentChatMessage({
  choicesLocked,
  debugEnabled,
  debugOptions,
  isJustSent,
  isLatestKnowledgeMessage,
  isSending,
  onChoiceSelect,
  selectedChoiceId,
  message
}: {
  choicesLocked: boolean;
  debugEnabled: boolean;
  debugOptions: TutorDebugOptions;
  isJustSent: boolean;
  isLatestKnowledgeMessage: boolean;
  isSending: boolean;
  message: ChatMessage;
  onChoiceSelect: (messageId: string, choice: TutorConfusionChoice) => void;
  selectedChoiceId?: string;
}) {
  if (message.role === "student") {
    return (
      <article className={`student-workspace-message student${isJustSent ? " is-just-sent" : ""}`}>
        <div className="student-message-stack">
          <div className="message-meta-row">
            <div className="message-meta">You</div>
            <StudentMessageModeBadge mode={message.studentMessageMode} />
            {debugEnabled ? <MessageDebugDetails message={message} options={debugOptions} /> : null}
          </div>
          <div className="student-message-bubble">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(message.content)}
            </ReactMarkdown>
          </div>
          {message.attachments?.length ? <MessageAttachmentList attachments={message.attachments} /> : null}
        </div>
      </article>
    );
  }

  if (message.role === "system") {
    return (
      <article className="student-workspace-message teacher-note">
        <div className="assistant-message-stack">
          <div className="message-meta-row">
            <div className="message-meta">Teacher note</div>
          </div>
          <div className="teacher-note-message-bubble">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(message.content)}
            </ReactMarkdown>
          </div>
        </div>
      </article>
    );
  }

  const streamingState = (message as StreamingChatMessage).streamingState;
  const messageBlocks = streamingState
    ? orderStreamingAssistantBlocks(assistantMessageBlocks(message), streamingState, message)
    : assistantMessageBlocks(message);
  const isStreaming = Boolean(
    streamingState && Object.values(streamingState.activeSections).some(Boolean)
  );
  const sourceChips = message.sources?.length ? sourceChipDetails(message) : [];
  const confusionChoices = message.structuredOutput?.confusionChoices;
  const confusionPrompt = message.structuredOutput?.confusionPrompt?.trim();
  const isProblemSelectionPrompt = message.structuredOutput?.metadata.choiceDisplay === "problem_selection";
  const isSupportPathChoicePrompt = message.structuredOutput?.metadata.choiceDisplay === "support_path_choice";
  const visibleConfusionPrompt =
    confusionPrompt && !messageBlocks.some((block) => sameDisplayedText(block.content, confusionPrompt))
      ? confusionPrompt
      : undefined;

  return (
    <article
      className={`student-workspace-message assistant${isLatestKnowledgeMessage ? " has-new-knowledge" : ""}${
        streamingState ? " is-streaming" : ""
      }`}
    >
      <span className="chandra-message-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack">
        <div className="message-meta-row">
          <div className="message-meta">Chandra</div>
          {isStreaming ? <div className="message-meta streaming-meta">Writing...</div> : null}
          {debugEnabled ? <MessageDebugDetails message={message} options={debugOptions} /> : null}
        </div>
        {!messageBlocks.length && streamingState ? (
          <div className="assistant-message-bubble streaming active-section">
            <span className="streaming-placeholder">Writing</span>
            <span className="streaming-caret" aria-hidden="true" />
          </div>
        ) : null}
        {messageBlocks.map((block) => {
          const sectionKey = streamedSectionKeyFromBlock(block.kind, streamingState);
          const isActiveSection = Boolean(sectionKey && streamingState?.activeSections[sectionKey]);
          const isCompletedSection = Boolean(sectionKey && streamingState?.completedSections[sectionKey]);

          return block.kind === "answer" ? (
            <div
              className={`assistant-message-bubble${isActiveSection ? " streaming active-section" : ""}`}
              key={block.kind}
            >
              {isActiveSection ? (
                <StreamingPlainText content={block.content} />
              ) : (
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                  {normalizeMarkdownMath(block.content)}
                </ReactMarkdown>
              )}
              {isActiveSection ? <span className="streaming-caret" aria-hidden="true" /> : null}
            </div>
          ) : (
            <div
              className={`assistant-structured-section ${block.kind}${isActiveSection ? " streaming active-section" : ""}${
                isCompletedSection ? " streaming-complete" : ""
              }`}
              key={block.kind}
            >
              <strong>
                {block.kind === "problem" || block.kind === "example" || block.kind === "formula" ? (
                  <KnowledgeItemTypeIcon
                    isEmphasized={isLatestKnowledgeMessage}
                    role={knowledgeRoleFromSectionKind(block.kind)}
                  />
                ) : null}
                {block.label}
              </strong>
              {isActiveSection ? (
                <StreamingPlainText content={block.content} />
              ) : (
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                  {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(block.content, block.kind))}
                </ReactMarkdown>
              )}
              {isActiveSection ? <span className="streaming-caret" aria-hidden="true" /> : null}
            </div>
          );
        })}
        {confusionChoices?.length ? (
          <TutorConfusionChoices
            choices={confusionChoices}
            disabled={isSending || choicesLocked}
            isProblemSelection={isProblemSelectionPrompt}
            isSupportPathChoice={isSupportPathChoicePrompt}
            prompt={visibleConfusionPrompt}
            selectedChoiceId={selectedChoiceId}
            sourceMessageId={message.id}
            onChoiceSelect={onChoiceSelect}
          />
        ) : null}
        {sourceChips.length ? (
          <div className="message-sources" aria-label="Sources used">
            <strong>{sourceChips.length === 1 ? "Source" : "Sources"}</strong>
            {sourceChips.map((source) => (
              <span
                aria-label={`${source.label}. ${source.why}`}
                className="message-source-chip"
                key={source.key}
                tabIndex={0}
                title={`${source.what}\n${source.why}`}
              >
                <KnowledgeItemTypeIcon isEmphasized={isLatestKnowledgeMessage} role="source" />
                {source.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
});

function sameDisplayedText(left: string, right: string) {
  return compactDisplayedText(left) === compactDisplayedText(right);
}

function compactDisplayedText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function StreamingPlainText({ content }: { content: string }) {
  return <p className="streaming-plain-text">{content || "\u00a0"}</p>;
}

function orderStreamingAssistantBlocks(
  blocks: AssistantMessageBlock[],
  streamingState: StreamingAssistantState,
  message: ChatMessage
) {
  const blockBySection = new Map<StreamedSectionKey, (typeof blocks)[number]>();

  for (const block of blocks) {
    const section = streamedSectionKeyFromBlock(block.kind, streamingState);
    if (section && !blockBySection.has(section)) {
      blockBySection.set(section, block);
    }
  }

  const orderedBlocks = streamingState.sectionOrder
    .map((section) => blockBySection.get(section) ?? streamingPlaceholderBlockForSection(section, message, streamingState))
    .filter((block): block is (typeof blocks)[number] => Boolean(block));
  const orderedSections = new Set(
    orderedBlocks
      .map((block) => streamedSectionKeyFromBlock(block.kind, streamingState))
      .filter((section): section is StreamedSectionKey => Boolean(section))
  );

  return [
    ...orderedBlocks,
    ...blocks.filter((block) => {
      const section = streamedSectionKeyFromBlock(block.kind, streamingState);
      return !section || !orderedSections.has(section);
    })
  ].filter((block, index, allBlocks) => allBlocks.indexOf(block) === index);
}

function streamingPlaceholderBlockForSection(
  section: StreamedSectionKey,
  message: ChatMessage,
  streamingState: StreamingAssistantState
): AssistantMessageBlock | undefined {
  const content = streamingSectionText(message, section);
  if (section === "mainText" || section === "mainChat") {
    return { content, kind: "answer" };
  }

  if (section === "answer") {
    const hasMainTextBlock = streamingState.sectionOrder.includes("mainText") || streamingState.sectionOrder.includes("mainChat") || Boolean(message.content);
    return hasMainTextBlock
      ? { content, kind: "section-answer", label: "Answer" }
      : { content, kind: "answer" };
  }

  const labels: Record<StructuredStreamedSectionKey, { kind: string; label: string }> = {
    answer: { kind: "section-answer", label: "Answer" },
    checkWork: { kind: "check-work", label: "Check your work" },
    example: { kind: "example", label: "Similar example" },
    explanation: { kind: "explanation", label: "Why this works" },
    formula: { kind: "formula", label: "Formula" },
    hint: { kind: "hint", label: "Hint" },
    mainChat: { kind: "section-answer", label: "Answer" },
    problem: { kind: "problem", label: "Problem" },
    sourceNote: { kind: "source-note", label: "Source" }
  };
  return { content, ...labels[section] };
}

function streamingSectionText(message: ChatMessage, section: StreamedSectionKey) {
  if (section === "mainText") {
    return message.content;
  }

  return String(message.structuredOutput?.sections[section] ?? "");
}

function streamedSectionKeyFromBlock(kind: string, streamingState?: StreamingAssistantState): StreamedSectionKey | undefined {
  if (kind === "answer") {
    if (streamingState?.activeSections.mainText || streamingState?.completedSections.mainText) {
      return "mainText";
    }
    return streamingState?.activeSections.mainChat || streamingState?.completedSections.mainChat ? "mainChat" : "answer";
  }

  const blockToSection: Record<string, StructuredStreamedSectionKey> = {
    "check-work": "checkWork",
    example: "example",
    explanation: "explanation",
    formula: "formula",
    "section-answer": "mainChat",
    hint: "hint",
    problem: "problem",
    "source-note": "sourceNote"
  };
  return blockToSection[kind];
}

function TutorConfusionChoices({
  choices,
  disabled,
  isProblemSelection,
  isSupportPathChoice,
  prompt,
  selectedChoiceId,
  sourceMessageId,
  onChoiceSelect
}: {
  choices: TutorConfusionChoice[];
  disabled: boolean;
  isProblemSelection?: boolean;
  isSupportPathChoice?: boolean;
  prompt?: string;
  selectedChoiceId?: string;
  sourceMessageId: string;
  onChoiceSelect: (messageId: string, choice: TutorConfusionChoice) => void;
}) {
  return (
    <div
      className={`assistant-confusion-choice-panel${isProblemSelection ? " problem-selection" : ""}${
        isSupportPathChoice ? " support-path-choice" : ""
      }`}
    >
      {prompt ? <p>{prompt}</p> : null}
      <div className="assistant-confusion-choice-grid" aria-label="Choose what Chandra should focus on">
        {choices.map((choice) => (
          <button
            aria-label={`Use: ${choice.message}`}
            aria-pressed={selectedChoiceId === choice.id}
            disabled={disabled}
            key={choice.id}
            type="button"
            onClick={() => onChoiceSelect(sourceMessageId, choice)}
          >
            <span className="assistant-confusion-choice-label">{choice.label}</span>
            {!isProblemSelection && !sameDisplayedText(choice.label, choice.description ?? choice.message) ? (
              <span className="assistant-confusion-choice-description">{choice.description ?? choice.message}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

type SourceChipDetail = {
  key: string;
  label: string;
  what: string;
  why: string;
};

function sourceChipDetails(message: ChatMessage): SourceChipDetail[] {
  const sources = message.sources ?? [];
  const groupedSources = new Map<string, { pages: Set<number>; source: TutorSource }>();

  for (const source of sources) {
    const key = [
      source.sourceId ?? source.pdfId ?? source.id ?? source.title,
      source.materialType,
      source.problemNumber ?? source.problemNumbers?.join(",") ?? ""
    ].join("|");
    const existing = groupedSources.get(key) ?? { pages: new Set<number>(), source };

    if (source.pageNumber) {
      existing.pages.add(source.pageNumber);
    }

    groupedSources.set(key, existing);
  }

  const details = Array.from(groupedSources.values()).map(({ pages, source }, index) => {
    const pageNumbers = Array.from(pages);
    const representativeSource = pageNumbers.length ? { ...source, pageNumber: undefined } : source;
    const matchedKnowledge = matchingKnowledgeItemForSource(source, message.langGraphTrace?.knowledgeItems ?? []);
    const label = formatTutorSourceLabel(representativeSource) + formatSourcePageRange(pageNumbers);

    return {
      key: `${source.sourceId ?? source.pdfId ?? source.id ?? source.title}-${source.pageNumber ?? index}`,
      label,
      what: formatSourceWhat(source, pageNumbers, matchedKnowledge),
      why: matchedKnowledge?.reason || source.reason || fallbackSourceReason(source, matchedKnowledge)
    };
  });
  const visibleDetails = details.slice(0, 3);

  if (details.length <= visibleDetails.length) {
    return visibleDetails;
  }

  const hiddenDetails = details.slice(visibleDetails.length);
  return [
    ...visibleDetails,
    {
      key: "additional-sources",
      label: `+${hiddenDetails.length} more`,
      what: hiddenDetails.map((source) => source.label).join(", "),
      why: "Chandra also used these retrieved knowledge pages while composing this response."
    }
  ];
}

function matchingKnowledgeItemForSource(source: TutorSource, items: KnowledgeItem[]) {
  return items.find((item) => {
    const sourceIds = [source.sourceId, source.pdfId, source.id].filter(Boolean);
    const itemIds = [item.sourceId, item.pdfId, item.id].filter(Boolean);
    const idsMatch = sourceIds.length > 0 && sourceIds.some((id) => itemIds.includes(id));
    const namesMatch = item.sourceName.trim().toLowerCase() === source.title.trim().toLowerCase();
    const pagesMatch = !source.pageNumber || !item.page || source.pageNumber === item.page;
    const sourceProblem = source.problemNumber ?? source.problemNumbers?.[0];
    const problemsMatch = !sourceProblem || !item.problemId || sourceProblem === item.problemId;

    return (idsMatch || namesMatch) && pagesMatch && problemsMatch;
  });
}

function formatTutorSourceLabel(source: TutorSource) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ].filter(Boolean).join(" · ");
}

function formatSourcePageRange(pages: number[]) {
  const sortedPages = [...new Set(pages)].sort((first, second) => first - second);

  if (!sortedPages.length) {
    return "";
  }

  const ranges: string[] = [];
  let rangeStart = sortedPages[0];
  let previousPage = sortedPages[0];

  for (const page of sortedPages.slice(1)) {
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);
    rangeStart = page;
    previousPage = page;
  }

  ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);
  return ` · p. ${ranges.join(", ")}`;
}

function formatSourceWhat(source: TutorSource, pages: number[], knowledgeItem?: KnowledgeItem) {
  const sourceType = readableSourceType(source.materialType || knowledgeItem?.kind || "class material");
  const usageText = readableKnowledgeUsage(source.usedAs || knowledgeItem?.usedAs);
  const pageText = formatSourcePageRange(pages.length ? pages : source.pageNumber ? [source.pageNumber] : []).replace(
    /^ · /,
    ""
  );
  const problemText = source.problemNumber
    ? `Problem ${source.problemNumber}`
    : source.problemNumbers?.length
      ? `Problems ${source.problemNumbers.join(", ")}`
      : knowledgeItem?.problemId
        ? `Problem ${knowledgeItem.problemId}`
        : "";

  return [source.title || knowledgeItem?.sourceName || "Class material", usageText || sourceType, pageText, problemText]
    .filter(Boolean)
    .join(" · ");
}

function readableKnowledgeUsage(value?: string) {
  if (value === "active_problem" || value === "problem_source") {
    return "Problem source";
  }
  if (value === "example_reference") {
    return "Example reference";
  }
  if (value === "theorem_reference") {
    return "Theorem reference";
  }
  if (value === "definition_reference") {
    return "Definition reference";
  }
  if (value === "student_attempt") {
    return "Student work";
  }
  if (value === "supporting_context") {
    return "Supporting context";
  }
  return "";
}

function readableSourceType(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\bpdf\b/i, "PDF")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fallbackSourceReason(source: TutorSource, knowledgeItem?: KnowledgeItem) {
  const usedAs = source.usedAs || knowledgeItem?.usedAs;

  if (usedAs === "problem_source" || usedAs === "active_problem") {
    return "Chandra used this page as the source for the active problem.";
  }

  if (usedAs === "example_reference") {
    return "Chandra used this page as an example reference.";
  }

  if (usedAs === "definition_reference" || usedAs === "theorem_reference") {
    return "Chandra used this page for the definition, theorem, or rule needed in the response.";
  }

  return "Chandra used this retrieved class material as source context for the response.";
}

function StudentMessageModeBadge({ mode }: { mode?: StudentMessageMode }) {
  if (!mode) {
    return null;
  }

  return (
    <span className="student-message-mode-badge" data-mode={mode}>
      {mode === "work" ? "Check my work" : "Question"}
    </span>
  );
}

function MessageDebugDetails({ message, options }: { message: ChatMessage; options: TutorDebugOptions }) {
  const debug = buildMessageDebugDisplay(message);
  const [selectedInputSectionId, setSelectedInputSectionId] = useState(
    debug.inputTokenBreakdown[0]?.id ?? ""
  );
  const selectedInputSection =
    debug.inputTokenBreakdown.find((section) => section.id === selectedInputSectionId) ??
    debug.inputTokenBreakdown[0];

  const revealTraceDebug = message.role === "assistant" && hasEnabledTutorTraceDebugOption(options);

  return (
    <details className="message-debug-details" open={revealTraceDebug ? true : undefined}>
      <summary aria-label={`Show debug details for ${message.role} message`}>
        Debug · {debug.summary}
      </summary>
      <div className="message-debug-panel">
        <div className="message-debug-panel-header">
          <strong>{message.role === "assistant" ? "Tutor debug" : "Message debug"}</strong>
          <span>{debug.summary}</span>
        </div>
        <dl className="message-debug-metrics">
          {debug.featuredRows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {message.role === "assistant" ? <TutorTraceDebugSections message={message} options={options} /> : null}
        {debug.modelCallUsage.length ? (
          <section className="message-debug-section" aria-labelledby={`debug-model-calls-${message.id}`}>
            <h3 id={`debug-model-calls-${message.id}`}>Model calls</h3>
            <div className="message-debug-calls" aria-label="Model call token usage">
              {debug.modelCallUsage.map((call, index) => (
                <div className="message-debug-call" key={`${call.stage}-${call.purpose}-${index}`}>
                  <strong>{call.purpose || call.stage || `Call ${index + 1}`}</strong>
                  <span>{call.stage || "unknown stage"} · {call.model || "unknown model"}</span>
                  <span>Reasoning: {call.reasoningEffort || "default"}</span>
                  <span>In {formatInteger(call.inputTokens)} · R {formatInteger(call.reasoningTokens)} · Out {formatInteger(call.outputTokens)} · Total {formatInteger(call.totalTokens)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {debug.advancedRows.length || debug.stages.length || debug.inputTokenBreakdown.length ? (
          <details className="message-debug-advanced">
            <summary>Advanced telemetry</summary>
            <dl className="message-debug-metrics message-debug-advanced-metrics">
              {debug.advancedRows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {debug.stages.length ? (
              <section className="message-debug-section" aria-labelledby={`debug-stages-${message.id}`}>
                <h3 id={`debug-stages-${message.id}`}>Stages</h3>
                <div className="message-debug-stages" aria-label="Debug stages">
                  {debug.stages.map((stage, index) => (
                    <span key={`${stage}-${index}`}>{stage}</span>
                  ))}
                </div>
              </section>
            ) : null}
            {debug.inputTokenBreakdown.length ? (
              <section className="message-debug-section message-debug-input-breakdown" aria-labelledby={`debug-input-${message.id}`}>
                <div className="message-debug-section-heading">
                  <h3 id={`debug-input-${message.id}`}>Input sections</h3>
                  <span>{formatInteger(debug.inputBreakdownTotal)} estimated tokens</span>
                </div>
                <label>
                  <span>Inspect section</span>
                  <select
                    value={selectedInputSection?.id ?? ""}
                    onChange={(event) => setSelectedInputSectionId(event.target.value)}
                  >
                    {debug.inputTokenBreakdown.map((section) => (
                      <option key={section.id} value={section.id}>
                        {formatInteger(section.estimatedTokens)} · {section.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedInputSection ? (
                  <div className="message-debug-selected-section">
                    <strong>{selectedInputSection.label}</strong>
                    <span>Estimated input tokens: {formatInteger(selectedInputSection.estimatedTokens)}</span>
                    <span>Characters: {formatInteger(selectedInputSection.characters ?? 0)}</span>
                    <span>Stage: {selectedInputSection.stage || "not recorded"}</span>
                    <span>Kind: {selectedInputSection.kind || "not recorded"}</span>
                    {selectedInputSection.detail ? <p>{selectedInputSection.detail}</p> : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </details>
        ) : null}
      </div>
    </details>
  );
}

function TutorTraceDebugSections({ message, options }: { message: ChatMessage; options: TutorDebugOptions }) {
  const trace = message.langGraphTrace;

  if (!trace) {
    return null;
  }

  const sections = [
    options.showExactSearches
      ? {
          content: trace.searchQueries?.length
            ? trace.searchQueries.map((query, index) => `${index + 1}. ${query}`).join("\n")
            : "No retrieval queries were recorded for this message.",
          label: "Exact searches"
        }
      : null,
    options.showTutorDecision
      ? {
          content: hasDebugValue(trace.retrievalDecision)
            ? formatDebugJson(trace.retrievalDecision)
            : "No primary tutor turn was recorded for this message.",
          label: "Primary tutor turn"
        }
      : null,
    options.showTutorPlan
      ? {
          content: hasDebugValue(trace.tutorPlan) ? formatDebugJson(trace.tutorPlan) : "No tutor plan was recorded for this message.",
          label: "Tutor plan"
        }
      : null,
    options.showUnderstandingState
      ? {
          content: hasDebugValue(trace.problemUnderstandingState)
            ? formatDebugJson(trace.problemUnderstandingState)
            : "No understanding state was recorded for this message.",
          label: "Understanding state"
        }
      : null,
    options.showSelectedSources
      ? {
          content: trace.selectedPages?.length ? formatDebugJson(trace.selectedPages) : "No selected source pages were recorded for this message.",
          label: "Selected pages"
        }
      : null,
    options.showSelectedSources
      ? {
          content: trace.selectedMetadataRecords?.length
            ? formatDebugJson(trace.selectedMetadataRecords)
            : "No selected metadata records were recorded for this message.",
          label: "Selected metadata records"
        }
      : null
  ].filter((section): section is { content: string; label: string } => Boolean(section));

  if (!sections.length) {
    return null;
  }

  return (
    <div className="message-debug-trace-sections" aria-label="Tutor behavior debug data">
      {sections.map((section) => (
        <details className="message-debug-trace-section" key={section.label}>
          <summary>{section.label}</summary>
          <pre>{section.content}</pre>
        </details>
      ))}
    </div>
  );
}

function hasEnabledTutorTraceDebugOption(options: TutorDebugOptions) {
  return (
    options.showExactSearches ||
    options.showTutorDecision ||
    options.showTutorPlan ||
    options.showUnderstandingState ||
    options.showSelectedSources
  );
}

function hasDebugValue(value: unknown) {
  if (!value) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return typeof value !== "object" || Object.keys(value).length > 0;
}

function buildMessageDebugDisplay(message: ChatMessage) {
  const estimatedMessageTokens = estimateMessageDisplayTokens(message);

  if (message.role === "assistant") {
    const debugInfo = message.debugInfo;
    const actualTokens = debugInfo?.actualTokens;
    const displayTokens = actualTokens?.totalTokens || estimatedMessageTokens;
    const requestCount = debugInfo?.totalRequestCount ?? inferMessageRequestCount(message);
    const modelCallUsage = debugInfo?.modelCallUsage ?? message.langGraphTrace?.modelCallUsage ?? [];
    const inputTokenBreakdown = sortInputTokenBreakdown(
      debugInfo?.inputTokenBreakdown ?? message.langGraphTrace?.inputTokenBreakdown ?? []
    );
    const inputBreakdownTotal = inputTokenBreakdown.reduce((total, section) => total + section.estimatedTokens, 0);
    const rows = [
      { label: "Actual input tokens", value: formatInteger(actualTokens?.inputTokens ?? 0) },
      { label: "Actual reasoning tokens", value: formatInteger(actualTokens?.reasoningTokens ?? 0) },
      { label: "Actual output tokens", value: formatInteger(actualTokens?.outputTokens ?? 0) },
      { label: "Actual total tokens", value: formatInteger(actualTokens?.totalTokens ?? 0) },
      { label: "Total requests", value: formatInteger(requestCount) },
      { label: "Backend requests", value: formatInteger(debugInfo?.backendRequestCount ?? 1) },
      { label: "Model requests", value: formatInteger(debugInfo?.providerRequestCount ?? inferProviderRequestCount(message)) },
      { label: "Tool calls", value: formatInteger(debugInfo?.toolCallCount ?? message.langGraphTrace?.toolCallCount ?? 0) },
      { label: "Search queries", value: formatInteger(debugInfo?.searchQueryCount ?? message.langGraphTrace?.searchQueries?.length ?? 0) },
      { label: "Selected pages", value: formatInteger(debugInfo?.selectedPageCount ?? message.langGraphTrace?.selectedPages?.length ?? 0) },
      { label: "Input breakdown sections", value: formatInteger(inputTokenBreakdown.length) },
      { label: "Input breakdown estimate", value: formatInteger(inputBreakdownTotal) },
      { label: "Estimated total tokens", value: formatInteger(debugInfo?.estimatedTokens.totalTokens ?? estimatedMessageTokens) },
      { label: "Duration", value: debugInfo ? formatDuration(debugInfo.durationMs) : "Not recorded" },
      { label: "Model", value: debugInfo?.modelId || "Not recorded" },
      { label: "Request ID", value: debugInfo?.requestId || "Not recorded" },
      { label: "Finish reason", value: debugInfo?.finishReason || message.langGraphTrace?.finishReason || "Not recorded" }
    ];
    const featuredRows = [
      { label: "Tokens", value: formatInteger(displayTokens) },
      { label: "Requests", value: formatInteger(requestCount) },
      { label: "Duration", value: debugInfo ? formatDuration(debugInfo.durationMs) : "Not recorded" },
      { label: "Model", value: debugInfo?.modelId || modelCallUsage[0]?.model || "Not recorded" }
    ];

    return {
      advancedRows: rows,
      featuredRows,
      inputBreakdownTotal,
      inputTokenBreakdown,
      modelCallUsage,
      stages: debugInfo?.stages ?? message.langGraphTrace?.stages ?? [],
      summary: `${formatInteger(displayTokens)} tokens · ${formatInteger(requestCount)} req`
    };
  }

  const rows = [
    { label: "Message tokens", value: formatInteger(estimatedMessageTokens) },
    { label: "Characters", value: formatInteger(message.content.length) },
    { label: "Attachments", value: formatInteger(message.attachments?.length ?? 0) },
    { label: "Created", value: formatAccountActivityTime(message.createdAt) }
  ];

  return {
    advancedRows: rows.slice(2),
    featuredRows: rows.slice(0, 2),
    inputBreakdownTotal: 0,
    inputTokenBreakdown: [],
    modelCallUsage: [],
    stages: [],
    summary: `${formatInteger(estimatedMessageTokens)} tokens`
  };
}

function estimateMessageDisplayTokens(message: ChatMessage) {
  const attachmentTokens = (message.attachments?.length ?? 0) * 375;
  return Math.max(1, Math.ceil(message.content.length / 4) + attachmentTokens);
}

function sortInputTokenBreakdown(sections: TutorInputTokenSection[]) {
  return [...sections].sort((first, second) => {
    const tokenDifference = second.estimatedTokens - first.estimatedTokens;

    if (tokenDifference !== 0) {
      return tokenDifference;
    }

    return first.label.localeCompare(second.label);
  });
}

function inferMessageRequestCount(message: ChatMessage) {
  return 1 + inferProviderRequestCount(message) + (message.langGraphTrace?.toolCallCount ?? 0);
}

function inferProviderRequestCount(message: ChatMessage) {
  const providerStages = message.langGraphTrace?.stages?.filter((stage) => stage.startsWith("openrouter_")).length ?? 0;
  return Math.max(providerStages, message.role === "assistant" ? 1 : 0);
}

function formatDebugJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStoredTutorDebugOptions(): TutorDebugOptions {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(teacherPreviewTutorDebugOptionsStorageKey) ?? "{}") as Partial<TutorDebugOptions>;

    return {
      forceAiUsageBlocked: false,
      forceAiUsageNearLimit: false,
      forceConfusionChoices: parsed.forceConfusionChoices === true,
      forceNoRetrieval: parsed.forceNoRetrieval === true && parsed.forceRetrieval !== true,
      forceRetrieval: parsed.forceRetrieval === true,
      forceStudentView: false,
      showExactSearches: true,
      showTutorDecision: true,
      showTutorPlan: true,
      showUnderstandingState: true,
      showSelectedSources: true
    };
  } catch {
    return defaultTutorDebugOptions;
  }
}

function buildTeacherPreviewTutorSettings(classSettings: TeacherClass | null): TeacherPreviewTutorSettings {
  return {
    answerPolicy: normalizeAnswerPolicySettings(classSettings?.answerPolicy),
    behaviorInstructions: classSettings?.behaviorInstructions ?? defaultBehaviorInstructions,
    behaviorTitle: normalizeTutorBehavior(classSettings?.behaviorTitle),
    modelSettings: normalizeClassModelSettings(classSettings?.modelSettings),
    responseFormat: normalizeResponseFormatSettings(classSettings?.responseFormat)
  };
}

function TeacherPreviewTutorSettingsPanel({
  error,
  isSaving,
  message,
  settings,
  onClose,
  onPreviewChange,
  onSave
}: {
  error: string;
  isSaving: boolean;
  message: string;
  settings: TeacherPreviewTutorSettings;
  onClose: () => void;
  onPreviewChange: (formData: FormData) => void;
  onSave: () => void;
}) {
  function previewChanged(event: FormEvent<HTMLFormElement>) {
    onPreviewChange(new FormData(event.currentTarget));
  }

  return (
    <form
      className="teacher-preview-settings-panel"
      id="teacher-preview-tutor-settings-panel"
      aria-label="Teacher AI tutor settings"
      onChange={previewChanged}
      onInput={previewChanged}
    >
      <div className="teacher-preview-settings-panel-heading">
        <div>
          <h2>AI tutor settings</h2>
          <p>Changes affect new replies now. Save to make them class defaults.</p>
        </div>
        <button type="button" aria-label="Close AI tutor settings" onClick={onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <label className="teacher-preview-settings-field">
        <span>Tutor mode</span>
        <select name="behaviorTitle" value={settings.behaviorTitle} onChange={() => {}}>
          {tutorBehaviorOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="teacher-preview-settings-field">
        <span>Chandra voice</span>
        <select name="responseFormat.tutorVoice" value={settings.responseFormat.tutorVoice} onChange={() => {}}>
          {tutorVoiceOptions.map((voice) => (
            <option key={voice} value={voice}>
              {formatStudentTutorVoiceLabel(voice)}
            </option>
          ))}
        </select>
      </label>

      <label className="teacher-preview-settings-field">
        <span>Response detail</span>
        <select name="modelSettings.verbose" value={settings.modelSettings.verbose} onChange={() => {}}>
          {verboseOptions.map((verbose) => (
            <option key={verbose} value={verbose}>
              {formatStudentVerboseLabel(verbose)}
            </option>
          ))}
        </select>
      </label>

      <div className="teacher-preview-settings-checks" aria-label="Help rules">
        <CompactTutorSettingCheckbox
          checked={settings.answerPolicy.doNotGiveFinalAnswers}
          name="answerPolicy.doNotGiveFinalAnswers"
          title="No final answers"
        />
        <CompactTutorSettingCheckbox
          checked={settings.answerPolicy.requireStudentAttemptFirst}
          name="answerPolicy.requireStudentAttemptFirst"
          title="Require attempt"
        />
        <CompactTutorSettingCheckbox
          checked={settings.answerPolicy.askGuidingQuestionBeforeExplaining}
          name="answerPolicy.askGuidingQuestionBeforeExplaining"
          title="Guide with questions"
        />
        <CompactTutorSettingCheckbox
          checked={settings.answerPolicy.allowWorkedExamples}
          name="answerPolicy.allowWorkedExamples"
          title="Worked examples"
        />
        <CompactTutorSettingCheckbox
          checked={settings.responseFormat.simpleWording}
          name="responseFormat.simpleWording"
          title="Simpler wording"
        />
      </div>

      <label className="teacher-preview-settings-field">
        <span>Hidden tutor instructions</span>
        <textarea name="behaviorInstructions" rows={4} value={settings.behaviorInstructions} onChange={() => {}} />
      </label>

      {error ? <p className="teacher-preview-settings-error">{error}</p> : null}
      {message ? <p className="teacher-preview-settings-message">{message}</p> : null}
      <p className="teacher-preview-settings-note">Preview applies immediately to this chat.</p>
      <button className="teacher-preview-settings-save" disabled={isSaving} type="button" onClick={onSave}>
        {isSaving ? "Saving" : "Save to class"}
      </button>
    </form>
  );
}

function CompactTutorSettingCheckbox({
  checked,
  name,
  title
}: {
  checked: boolean;
  name: string;
  title: string;
}) {
  return (
    <label>
      <input checked={checked} name={name} type="checkbox" onChange={() => {}} />
      <span>{title}</span>
    </label>
  );
}

function formatStudentTutorVoiceLabel(value: string) {
  if (value === "friendlyUpbeat") {
    return "Friendly and upbeat";
  }

  if (value === "directConcise") {
    return "Direct and concise";
  }

  if (value === "formalAcademic") {
    return "Formal and academic";
  }

  if (value === "gentlePatient") {
    return "Gentle and patient";
  }

  return "Calm and clear";
}

function formatStudentVerboseLabel(value: string) {
  if (value === "brief") {
    return "Short";
  }

  if (value === "detailed") {
    return "Detailed";
  }

  if (value === "veryDetailed") {
    return "Very detailed";
  }

  return "Balanced";
}

function formatInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.round(numberValue)).toLocaleString() : "0";
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0 ms";
  }

  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)} s` : `${Math.round(durationMs)} ms`;
}

function StudentSettingsPanel({
  accountEmail,
  accountEmailValue,
  accountDisplayName,
  accountLastSignInAt,
  accountUsername,
  accountSettingsError,
  confirmAccountPassword,
  currentAccountPassword,
  deleteAccountPassword,
  activeAppearance,
  activeClass,
  activeClassId,
  activeThemeColor,
  classLoadMessage,
  classes,
  isSavingAccountSettings,
  isDeletingAccount,
  isSavingThemePreference,
  isTeacherDebugMode,
  isTeacherPreview,
  newAccountPassword,
  role,
  themePreferenceError,
  onAccountDisplayNameChange,
  onAccountEmailChange,
  onAccountUsernameChange,
  onConfirmAccountPasswordChange,
  onCurrentAccountPasswordChange,
  onDeleteAccount,
  onDeleteAccountPasswordChange,
  onNewAccountPasswordChange,
  onTeacherDebugModeChange,
  onSaveAccountSettings,
  onSignOut,
  onSignOutAllSessions,
  onBackToChat,
  onUpdateThemePreference
}: {
  accountEmail: string;
  accountEmailValue: string;
  accountDisplayName: string;
  accountLastSignInAt: string;
  accountUsername: string;
  accountSettingsError: string;
  confirmAccountPassword: string;
  currentAccountPassword: string;
  deleteAccountPassword: string;
  activeAppearance: TeacherClassAppearance;
  activeClass: StudentVisibleClass | null;
  activeClassId: string;
  activeThemeColor: TeacherClassThemeColor;
  classLoadMessage: string;
  classes: StudentClassSummary[];
  isSavingAccountSettings: boolean;
  isDeletingAccount: boolean;
  isSavingThemePreference: boolean;
  isTeacherDebugMode: boolean;
  isTeacherPreview: boolean;
  newAccountPassword: string;
  role: string;
  themePreferenceError: string;
  onAccountDisplayNameChange: (displayName: string) => void;
  onAccountEmailChange: (email: string) => void;
  onAccountUsernameChange: (username: string) => void;
  onConfirmAccountPasswordChange: (password: string) => void;
  onCurrentAccountPasswordChange: (password: string) => void;
  onDeleteAccount: () => Promise<void>;
  onDeleteAccountPasswordChange: (password: string) => void;
  onNewAccountPasswordChange: (password: string) => void;
  onTeacherDebugModeChange: (enabled: boolean) => void;
  onSaveAccountSettings: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onSignOutAllSessions: () => Promise<void>;
  onBackToChat: () => void;
  onUpdateThemePreference: (nextPreference: {
    appearance?: unknown;
    themeColor?: unknown;
  }) => Promise<void>;
}) {
  return (
    <section className="student-workspace-main student-settings-main" aria-label="Student settings">
      <header className="student-settings-heading">
        <h1>Settings</h1>
        <p>Manage your account, appearance, and class memberships.</p>
        <div className="student-settings-heading-actions">
          <button className="student-settings-back-button" type="button" onClick={onBackToChat}>
            Back to chat
          </button>
          <button
            className="student-settings-save-button"
            disabled={isSavingAccountSettings || isSavingThemePreference}
            type="button"
            onClick={() => void onSaveAccountSettings()}
          >
            {isSavingAccountSettings ? "Saving" : "Save changes"}
          </button>
        </div>
      </header>

      <div className="student-settings-stack">
        <section className="student-settings-card student-account-settings-card" aria-labelledby="student-account-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-account-settings">Account</h2>
            <p>Update your student profile information.</p>
          </div>
          <div className="student-account-field-list">
            <div>
              <label className="student-settings-control-label" htmlFor="student-account-name">
                Name
              </label>
              <input
                id="student-account-name"
                maxLength={80}
                value={accountDisplayName}
                onChange={(event) => onAccountDisplayNameChange(event.target.value)}
              />
            </div>
            <div>
              <label className="student-settings-control-label" htmlFor="student-account-username">
                Username
              </label>
              <input
                id="student-account-username"
                autoCapitalize="none"
                autoComplete="username"
                maxLength={120}
                value={accountUsername}
                onChange={(event) => onAccountUsernameChange(event.target.value)}
              />
            </div>
          </div>
          <dl className="student-settings-data-list">
            <div>
              <dt>Email</dt>
              <dd>{accountEmail || "No email on file"}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{capitalizeLabel(role)}</dd>
            </div>
            <div>
              <dt>Last sign-in</dt>
              <dd>{formatAccountActivityTime(accountLastSignInAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="student-settings-card student-credentials-card" aria-labelledby="student-email-password-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-email-password-settings">Email &amp; Password</h2>
          </div>
          <div className="student-credentials-grid">
            <dl className="student-settings-data-list">
              <div>
                <dt>Current email</dt>
                <dd>{accountEmail || "No email on file"}</dd>
              </div>
              <div>
                <dt>Password</dt>
                <dd aria-label="Password hidden">**********</dd>
              </div>
            </dl>
            <div className="student-account-field-list student-credential-field-list">
              <div>
                <label className="student-settings-control-label" htmlFor="student-account-email">
                  Email
                </label>
                <input
                  id="student-account-email"
                  autoCapitalize="none"
                  autoComplete="email"
                  inputMode="email"
                  type="email"
                  value={accountEmailValue}
                  onChange={(event) => onAccountEmailChange(event.target.value)}
                />
              </div>
              <div>
                <label className="student-settings-control-label" htmlFor="student-current-password">
                  Current password
                </label>
                <input
                  id="student-current-password"
                  autoComplete="current-password"
                  type="password"
                  value={currentAccountPassword}
                  onChange={(event) => onCurrentAccountPasswordChange(event.target.value)}
                />
              </div>
              <div>
                <label className="student-settings-control-label" htmlFor="student-new-password">
                  New password
                </label>
                <input
                  id="student-new-password"
                  autoComplete="new-password"
                  minLength={6}
                  type="password"
                  value={newAccountPassword}
                  onChange={(event) => onNewAccountPasswordChange(event.target.value)}
                />
              </div>
              <div>
                <label className="student-settings-control-label" htmlFor="student-confirm-password">
                  Confirm new password
                </label>
                <input
                  id="student-confirm-password"
                  autoComplete="new-password"
                  minLength={6}
                  type="password"
                  value={confirmAccountPassword}
                  onChange={(event) => onConfirmAccountPasswordChange(event.target.value)}
                />
              </div>
            </div>
            {accountSettingsError ? <p className="form-error student-credentials-error">{accountSettingsError}</p> : null}
            <div className="student-credentials-actions">
              <button
                className="student-settings-save-button student-credentials-save-button"
                disabled={isSavingAccountSettings || isSavingThemePreference}
                type="button"
                onClick={() => void onSaveAccountSettings()}
              >
                {isSavingAccountSettings ? "Saving" : "Change password"}
              </button>
            </div>
          </div>
        </section>

        <section className="student-settings-card student-theme-settings-card" aria-labelledby="student-theme-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-theme-settings">Theme</h2>
            <p>Choose how Chandra looks for you.</p>
          </div>
          <div className="student-settings-control-row">
            <span className="student-settings-control-label">Appearance</span>
            <div className="student-settings-pill-group compact" role="radiogroup" aria-label="Appearance">
              <button
                aria-label={`Switch to ${activeAppearance === "dark" ? "light" : "dark"} mode`}
                aria-pressed={activeAppearance === "dark"}
                className="student-settings-pill"
                disabled={isSavingThemePreference}
                type="button"
                onClick={() =>
                  void onUpdateThemePreference({
                    appearance: activeAppearance === "dark" ? "light" : "dark"
                  })
                }
              >
                <StudentSettingsAppearanceIcon appearance={activeAppearance} />
                <span>{activeAppearance === "dark" ? "Dark mode" : "Light mode"}</span>
              </button>
            </div>
          </div>
          <div className="student-settings-control-row">
            <span className="student-settings-control-label">Accent color</span>
            <div className="student-settings-pill-group wide" role="radiogroup" aria-label="Accent color">
              {teacherClassThemeColorOptions.map((option) => (
                <button
                  aria-pressed={activeThemeColor === option.id}
                  className="student-settings-pill"
                  disabled={isSavingThemePreference}
                  key={option.id}
                  type="button"
                  onClick={() => void onUpdateThemePreference({ themeColor: option.id })}
                >
                  <span className="student-settings-color-dot" style={{ backgroundColor: option.color }} aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
          {themePreferenceError ? <p className="form-error">{themePreferenceError}</p> : null}
        </section>

        {isTeacherPreview ? (
          <section className="student-settings-card student-debug-settings-card" aria-labelledby="student-debug-settings">
            <div className="student-settings-card-heading">
              <h2 id="student-debug-settings">Debug Mode</h2>
              <p>Show teacher-only request and token diagnostics beside chat messages.</p>
            </div>
            <label className="student-debug-toggle">
              <input
                checked={isTeacherDebugMode}
                type="checkbox"
                onChange={(event) => onTeacherDebugModeChange(event.target.checked)}
              />
              <span aria-hidden="true" />
              <strong>{isTeacherDebugMode ? "Debug on" : "Debug off"}</strong>
            </label>
          </section>
        ) : null}

        <section className="student-settings-card student-membership-settings-card" aria-labelledby="student-class-membership-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-class-membership-settings">Class Memberships</h2>
            <p>Manage the classes you are enrolled in.</p>
          </div>
          <div className="student-membership-list">
            {classes.length ? (
              classes.map((studentClass) => (
                <div className="student-membership-row" key={studentClass.id}>
                  <strong>{studentClass.name}</strong>
                  <span>{formatClassSectionLabel(studentClass.section, true) || "Section"}</span>
                  {studentClass.id === activeClassId ? <mark>Active</mark> : <span />}
                  <span className="student-row-menu" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              ))
            ) : activeClass ? (
              <div className="student-membership-row" key={activeClass.id}>
                <strong>{activeClass.name}</strong>
                <span>{formatClassSectionLabel(activeClass.section, true) || "Section"}</span>
                <mark>Active</mark>
                <span className="student-row-menu" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : (
              <p className="sidebar-note">{classLoadMessage || "No active class membership."}</p>
            )}
          </div>
        </section>

        <section className="student-settings-card student-session-card student-danger-zone-card" aria-labelledby="student-session-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-session-settings">Session</h2>
            <p>Sign out of this device or revoke refresh tokens for every device.</p>
          </div>
          <div className="student-session-actions">
            <button className="student-settings-danger-button" type="button" onClick={() => void onSignOut()}>
              Sign out
            </button>
            <button className="student-settings-danger-button wide" type="button" onClick={() => void onSignOutAllSessions()}>
              Sign out all sessions
            </button>
          </div>
        </section>

        <section className="student-settings-card student-delete-account-card student-danger-zone-card" aria-labelledby="student-delete-account-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-delete-account-settings">Delete Account</h2>
            <p>Remove your profile and anonymize class conversation ownership.</p>
          </div>
          <div className="student-delete-account-controls">
            <label className="student-settings-control-label" htmlFor="student-delete-password">
              Current password
            </label>
            <input
              id="student-delete-password"
              autoComplete="current-password"
              type="password"
              value={deleteAccountPassword}
              onChange={(event) => onDeleteAccountPasswordChange(event.target.value)}
            />
            <button
              className="student-settings-danger-button"
              disabled={isDeletingAccount}
              type="button"
              onClick={() => void onDeleteAccount()}
            >
              {isDeletingAccount ? "Deleting" : "Delete account"}
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

function StudentSettingsAppearanceIcon({ appearance }: { appearance: TeacherClassAppearance }) {
  if (appearance === "dark") {
    return (
      <svg className="student-settings-pill-icon" aria-hidden="true" viewBox="0 0 24 24">
        <path d="M20.2 15.2A7.6 7.6 0 0 1 8.8 3.8 8.4 8.4 0 1 0 20.2 15.2Z" />
      </svg>
    );
  }

  return (
    <svg className="student-settings-pill-icon" aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.7v2.1M12 19.2v2.1M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2.7 12h2.1M19.2 12h2.1M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
    </svg>
  );
}

function ComposerAttachmentPreview({
  attachment,
  onRemove
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const thumbnailUrl = attachment.fileType === "image" ? attachment.localUrl || attachment.dataUrl : "";

  if (attachment.fileType === "image" && thumbnailUrl) {
    return (
      <div className="student-attachment-preview is-image" data-status={attachment.uploadStatus}>
        <div className="student-attachment-image-frame">
          <span className="student-attachment-image" style={{ backgroundImage: `url(${thumbnailUrl})` }} aria-hidden="true" />
          <button className="student-attachment-remove" type="button" aria-label={`Remove ${attachment.fileName}`} onClick={onRemove}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          {attachment.uploadStatus === "uploading" ? (
            <span className="student-attachment-progress" aria-label={`Upload ${attachment.progress}% complete`}>
              <span style={{ width: `${attachment.progress}%` }} />
            </span>
          ) : null}
        </div>
        {attachment.error ? <small className="student-attachment-error-text">{attachment.error}</small> : null}
      </div>
    );
  }

  return (
    <div className="student-attachment-preview" data-status={attachment.uploadStatus}>
      <AttachmentVisual attachment={attachment} />
      <span className="student-attachment-copy">
        <strong>{attachment.fileName}</strong>
        <span>{formatAttachmentMeta(attachment)}</span>
        {attachment.uploadStatus === "uploading" ? (
          <span className="student-attachment-progress" aria-label={`Upload ${attachment.progress}% complete`}>
            <span style={{ width: `${attachment.progress}%` }} />
          </span>
        ) : null}
        {attachment.error ? <small>{attachment.error}</small> : null}
      </span>
      <button className="student-attachment-remove" type="button" aria-label={`Remove ${attachment.fileName}`} onClick={onRemove}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

function MessageAttachmentList({ attachments }: { attachments: Array<MessageAttachment & { localUrl?: string }> }) {
  return (
    <div className="student-message-attachments" aria-label="Message attachments">
      {attachments.map((attachment) => (
        <div
          aria-label={attachment.fileType === "image" ? `Uploaded image ${attachment.fileName}` : undefined}
          className={`student-message-attachment${attachment.fileType === "image" ? " is-image-only" : ""}`}
          key={attachment.id}
        >
          <AttachmentVisual attachment={attachment} />
          {attachment.fileType === "pdf" ? (
            <span>
              <strong>{attachment.fileName}</strong>
              <small>{formatAttachmentMeta(attachment)}</small>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TutorDebugComposerControl({
  isOpen,
  options,
  onOpenChange,
  onOptionsChange
}: {
  isOpen: boolean;
  options: TutorDebugOptions;
  onOpenChange: (isOpen: boolean) => void;
  onOptionsChange: (options: TutorDebugOptions) => void;
}) {
  return (
    <div className="student-tutor-debug-control">
      <button
        aria-controls="student-tutor-debug-popover"
        aria-expanded={isOpen}
        className="student-tutor-debug-button"
        type="button"
        onClick={() => onOpenChange(!isOpen)}
      >
        Tutor debug
      </button>
      {isOpen ? (
        <div className="student-tutor-debug-popover" id="student-tutor-debug-popover">
          <section className="student-tutor-debug-section" aria-labelledby="student-tutor-debug-answer">
            <h3 id="student-tutor-debug-answer">Next answer</h3>
            <TutorDebugToggle
              checked={options.forceConfusionChoices}
              description="Add sample uncertainty choices to the next tutor answer."
              label="Force confusion choices"
              onChange={(checked) => onOptionsChange({ ...options, forceConfusionChoices: checked })}
            />
            <TutorDebugToggle
              checked={options.forceRetrieval}
              description="Make the next primary tutor turn search class materials."
              label="Force retrieval"
              onChange={(checked) =>
                onOptionsChange({
                  ...options,
                  forceNoRetrieval: checked ? false : options.forceNoRetrieval,
                  forceRetrieval: checked
                })
              }
            />
            <TutorDebugToggle
              checked={options.forceNoRetrieval}
              description="Make the next tutor answer from visible context only."
              label="Force no retrieval"
              onChange={(checked) =>
                onOptionsChange({
                  ...options,
                  forceNoRetrieval: checked,
                  forceRetrieval: checked ? false : options.forceRetrieval
                })
              }
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function TutorDebugToggle({
  checked,
  description,
  label,
  onChange
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="student-tutor-debug-toggle">
      <input checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function AttachmentVisual({ attachment }: { attachment: Partial<ComposerAttachment> & Pick<MessageAttachment, "fileType" | "fileName"> }) {
  const { user } = useAuth();
  const [downloadedThumbnailUrl, setDownloadedThumbnailUrl] = useState("");
  const attachmentClassId = attachment.classId;
  const attachmentConversationId = attachment.conversationId;
  const attachmentFileType = attachment.fileType;
  const attachmentId = attachment.id;
  const attachmentLocalUrl = attachment.localUrl;

  useEffect(() => {
    if (
      attachmentFileType !== "image" ||
      attachmentLocalUrl ||
      !attachmentId ||
      !attachmentConversationId ||
      !attachmentClassId ||
      !user
    ) {
      return;
    }

    let isCancelled = false;
    let objectUrl = "";
    const controller = new AbortController();

    user
      .getIdToken()
      .then((token) =>
        fetch(attachmentContentUrl({
          classId: attachmentClassId,
          conversationId: attachmentConversationId,
          id: attachmentId
        }), {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal
        })
      )
      .then((response) => {
        if (!response.ok) {
          throw new Error("Attachment thumbnail failed to load.");
        }

        return response.blob();
      })
      .then((blob) => {
        if (isCancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setDownloadedThumbnailUrl(objectUrl);
      })
      .catch(() => {
        if (!isCancelled) {
          setDownloadedThumbnailUrl("");
        }
      });

    return () => {
      isCancelled = true;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachmentClassId, attachmentConversationId, attachmentFileType, attachmentId, attachmentLocalUrl, user]);

  const thumbnailUrl = attachment.localUrl || downloadedThumbnailUrl;

  if (attachment.fileType === "image" && thumbnailUrl) {
    return (
      <span
        className="student-attachment-thumbnail"
        style={{ backgroundImage: `url(${thumbnailUrl})` }}
        aria-hidden="true"
      />
    );
  }

  return (
    <span className="student-attachment-file-icon" data-file-type={attachment.fileType} aria-hidden="true">
      {attachment.fileType === "pdf" ? "PDF" : "IMG"}
    </span>
  );
}

function attachmentContentUrl(attachment: Pick<MessageAttachment, "classId" | "conversationId" | "id">) {
  return apiUrl(
    `/api/student/conversations/${encodeURIComponent(String(attachment.conversationId))}/attachments/${encodeURIComponent(
      String(attachment.id)
    )}/content?courseId=${encodeURIComponent(String(attachment.classId))}`
  );
}

const ChatProgressMessage = memo(function ChatProgressMessage({ progress }: { progress: ChatProgress }) {
  const display = chatProgressDisplay(progress);

  return (
    <article className="student-workspace-message assistant progress-message" aria-live="polite">
      <span className="chandra-message-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack">
        <div className="message-meta">Chandra</div>
        <div className="assistant-message-bubble">
          <div className="progress-row">
            <div className="progress-copy">
              <p className="progress-main">{display.main}</p>
              {display.secondary ? <p className="progress-secondary">{display.secondary}</p> : null}
            </div>
          </div>
          {display.searchRows.length ? (
            <ul className="progress-search-list" aria-label="Class material checks">
              {display.searchRows.map((row) => (
                <li key={row.key} className="progress-search-item">
                  <span className="progress-search-dot" aria-hidden="true" />
                  <span>{row.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {display.isSearching ? (
            <span className="progress-scan-line" aria-hidden="true">
              <span />
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
});

function chatProgressDisplay(progress: ChatProgress) {
  const normalizedMessage = progress.message.trim().toLowerCase();
  const hasMaterialSignal = /\b(search|checking|looking|locating|retriev|source|page|pdf|class material|materials)\b/.test(
    normalizedMessage
  );
  const searchRows = progress.searches.map((search) => ({
    key: normalizeSearchQuery(`${search.retrievalReason ?? ""} ${search.query}`) || search.description,
    label: studentSearchPurposeLabel(search.retrievalReason, search.query, search.description)
  }));
  const isSearching = hasMaterialSignal;

  if (isSearching) {
    return {
      isSearching: true,
      main: "Chandra is checking class materials",
      searchRows,
      secondary: searchRows.length ? "" : "Looking for the most relevant page..."
    };
  }

  return {
    isSearching: false,
    main: "Chandra is thinking",
    searchRows,
    secondary: searchRows.length ? "Using the material it found..." : "Reading your question..."
  };
}

function KnowledgeIconButton({
  animationLines,
  isActive,
  isExpanded,
  recentItems,
  onClick
}: {
  animationLines: KnowledgeAnimationLine[];
  isActive: boolean;
  isExpanded: boolean;
  recentItems: KnowledgeLine[];
  onClick: () => void;
}) {
  return (
    <button
      aria-label="Knowledge"
      aria-controls="student-context-popover"
      aria-expanded={isExpanded}
      className={`student-header-control student-knowledge-control${isActive ? " is-active" : ""}${
        animationLines.length ? " is-inserting" : ""
      }`}
      title="Knowledge"
      type="button"
      onClick={onClick}
    >
      <KnowledgeStackIcon animationLines={animationLines} isActive={isActive} recentItems={recentItems} />
      <span className="student-header-control-label">Knowledge</span>
    </button>
  );
}

function KnowledgeStackIcon({
  animationLines,
  isActive,
  recentItems
}: {
  animationLines: KnowledgeAnimationLine[];
  isActive: boolean;
  recentItems: KnowledgeLine[];
}) {
  const visibleItems = recentItems.slice(-5);

  return (
    <svg
      aria-hidden="true"
      className="student-header-control-icon knowledge-stack-icon"
      data-active={isActive ? "true" : "false"}
      viewBox="0 0 32 32"
    >
      <g className="knowledge-stack-pages">
        <path d="M10.5 7.25h12.25a3.25 3.25 0 0 1 3.25 3.25v14.25H12a3 3 0 0 1-3-3V8.75a1.5 1.5 0 0 1 1.5-1.5Z" />
        <path d="M7 9.5h2.75v15.25H7.8A2.8 2.8 0 0 1 5 21.95V11.5a2 2 0 0 1 2-2Z" />
      </g>
      <path className="knowledge-stack-cover" d="M10.5 5.75h11.75a3.25 3.25 0 0 1 3.25 3.25v14.25H12a3 3 0 0 1-3-3V7.25a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path className="knowledge-stack-spine" d="M12 23.25V8.25" />
      {visibleItems.map((item, index) => (
        <line
          className="knowledge-stack-line"
          data-color={item.colorToken}
          key={item.key}
          x1="15"
          x2={24 - Math.min(index, 2)}
          y1={11.25 + index * 2.45}
          y2={11.25 + index * 2.45}
        />
      ))}
      {animationLines.map((line, index) => (
        <line
          className="knowledge-stack-line knowledge-stack-insert-line"
          data-color={line.colorToken}
          key={line.id}
          style={
            {
              "--knowledge-insert-delay": `${line.delayMs}ms`
            } as Record<string, string>
          }
          x1="15"
          x2={24 - Math.min(index, 2)}
          y1={11.25 + Math.min(index, 4) * 2.45}
          y2={11.25 + Math.min(index, 4) * 2.45}
        />
      ))}
    </svg>
  );
}

function UnderstandingLevelButton({
  isExpanded,
  onClick,
  state
}: {
  isExpanded: boolean;
  onClick: () => void;
  state: UnderstandingState | null;
}) {
  const hasState = Boolean(state);
  const emptyTooltipId = "student-understanding-empty-tooltip";
  const emptyTooltip = "Understanding starts once a problem is loaded.";

  return (
    <>
      <button
        aria-label="Understanding"
        aria-controls="student-understanding-popover"
        aria-describedby={hasState ? undefined : emptyTooltipId}
        aria-disabled={!hasState}
        aria-expanded={hasState ? isExpanded : false}
        className={`student-header-control student-understanding-control${hasState ? " is-active" : ""}`}
        data-understanding-level={state?.level}
        title={hasState ? "Understanding" : undefined}
        type="button"
        onClick={() => {
          if (hasState) {
            onClick();
          }
        }}
      >
        <span aria-hidden="true" className="student-understanding-level">
          {state?.level ?? ""}
        </span>
        <span className="student-header-control-label">Understanding</span>
      </button>
      {!hasState ? (
        <section
          aria-label="Understanding"
          className="student-header-popover student-understanding-popover student-understanding-empty-tooltip"
          id={emptyTooltipId}
          role="tooltip"
        >
          <div className="student-context-popover-heading">
            <h2>Understanding</h2>
          </div>
          <p className="student-popover-empty">{emptyTooltip}</p>
        </section>
      ) : null}
    </>
  );
}

const UnderstandingPopover = memo(function UnderstandingPopover({
  id,
  state
}: {
  id: string;
  state: UnderstandingState;
}) {
  return (
    <section
      aria-label="Understanding"
      className="student-header-popover student-understanding-popover"
      id={id}
      role="region"
    >
      <div className="student-context-popover-heading">
        <h2>Understanding</h2>
        <span>Level {state.level}</span>
      </div>
      <p className="student-understanding-subtitle">
        Chandra estimates how much support you need for this problem.
      </p>
      <div className="student-popover-section">
        <h3>Updates</h3>
        <ul className="student-understanding-reasons">
          {state.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      <p className="student-understanding-note">This is not a grade.</p>
    </section>
  );
});

function knowledgeRoleFromSectionKind(kind: string): KnowledgeItemRole {
  if (kind === "example") {
    return "example";
  }

  if (kind === "formula") {
    return "theorem";
  }

  return "problem";
}

function KnowledgeItemTypeIcon({
  isEmphasized = false,
  role
}: {
  isEmphasized?: boolean;
  role: KnowledgeItemRole;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`knowledge-item-type-icon${isEmphasized ? " is-emphasized" : ""}`}
      viewBox="0 0 16 16"
    >
      {role === "problem" ? (
        <>
          <path d="M4.1 2.6h7.8v10.8H4.1z" />
          <path d="M5.8 5.2h4.4M5.8 7.8h3.3M5.8 10.4h2.2" />
        </>
      ) : role === "definition" || role === "theorem" ? (
        <>
          <path d="M3.4 3.2h7.1a2.1 2.1 0 0 1 2.1 2.1v7.5H5.1a1.7 1.7 0 0 1-1.7-1.7Z" />
          <path d="M5.3 6.1h5.1M5.3 8.4h4" />
        </>
      ) : role === "example" ? (
        <>
          <path d="M3.1 10.9 6 8l2 2 4.9-5" />
          <path d="M10 5h2.9v2.9" />
        </>
      ) : role === "student_upload" ? (
        <>
          <path d="M8 12.6V3.4" />
          <path d="M4.8 6.3 8 3.1l3.2 3.2" />
          <path d="M3.4 12.8h9.2" />
        </>
      ) : (
        <>
          <path d="M3.4 3.2h7.2a2 2 0 0 1 2 2v7.6H4.9a1.5 1.5 0 0 1-1.5-1.5Z" />
          <path d="M5.2 6.2h5.1M5.2 8.5h3.7" />
        </>
      )}
    </svg>
  );
}

function HeaderControlIcon({ kind }: { kind: "feedback" | "tutoringTime" }) {
  return (
    <svg className="student-header-control-icon" aria-hidden="true" viewBox="0 0 24 24">
      {kind === "tutoringTime" ? (
        <>
          <circle cx="12" cy="13" r="7" />
          <path d="M12 9v4l2.8 1.7" />
          <path d="M9 3h6" />
          <path d="M12 3v3" />
        </>
      ) : (
        <>
          <path d="M5 5.5h14v9.5H9l-4 4v-13.5Z" />
          <path d="M8.5 9h7M8.5 12h4" />
        </>
      )}
    </svg>
  );
}

const StudentContextPopover = memo(function StudentContextPopover({
  classId,
  contextMemory,
  conversationId,
  id
}: {
  classId?: string;
  contextMemory: ChatContextMemory;
  conversationId?: string;
  id: string;
}) {
  const hasContext = hasChatContextMemory(contextMemory);
  const savedProblems = contextMemory.savedProblems?.length
    ? contextMemory.savedProblems
    : contextMemory.currentProblem
      ? [contextMemory.currentProblem]
      : [];
  const sourceCount = contextMemory.sourcesUsed?.length ?? 0;

  return (
    <section className="student-header-popover student-context-popover" id={id} role="region" aria-label="Knowledge">
      <div className="student-context-popover-heading">
        <h2>Knowledge</h2>
        {hasContext ? (
          <span>
            {savedProblems.length} {savedProblems.length === 1 ? "problem" : "problems"} · {sourceCount}{" "}
            {sourceCount === 1 ? "source" : "sources"}
          </span>
        ) : null}
      </div>
      {!hasContext ? (
        <p className="student-popover-empty">
          No course material is being referenced yet. When Chandra uses a problem, page, or source, it will appear here.
        </p>
      ) : (
        <>
          {savedProblems.length ? (
            <div className="student-popover-section">
              <h3>Problems saved</h3>
              <div className="student-context-problem-list">
                {savedProblems.map((problem, index) => (
                  <details
                    className="student-context-problem-card"
                    key={`${problem.sourceName ?? "problem"}-${problem.problemNumber ?? problem.pageNumber ?? index}`}
                    open={index === 0}
                  >
                    <summary>
                      <span>
                        <strong>{formatProblemLabel(problem)}</strong>
                        <small>{formatProblemMeta(problem)}</small>
                      </span>
                      {index === 0 ? <em>Current</em> : null}
                    </summary>
                    {problem.problemText ? (
                      <div className="student-context-problem-text">
                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                          {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(problem.problemText, "problem"))}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="student-context-problem-text is-muted">
                        Full problem text is not available yet. Chandra is using the saved source page below.
                      </p>
                    )}
                    <dl className="student-context-details">
                      <ContextDetail label="Source" value={problem.sourceName} />
                      <ContextDetail label="Page" value={formatPageNumber(problem.pageNumber)} />
                      <ContextDetail label="Section" value={problem.sectionTitle} />
                    </dl>
                  </details>
                ))}
              </div>
            </div>
          ) : null}

          {contextMemory.sourcesUsed?.length ? (
            <div className="student-popover-section">
              <h3>Sources</h3>
              <ul className="student-context-source-list">
                {contextMemory.sourcesUsed.map((source, index) => (
                  <StudentContextSourceItem
                    classId={classId}
                    conversationId={conversationId}
                    index={index}
                    key={`${source.id ?? source.sourceName ?? "source"}-${source.pageNumber ?? index}`}
                    source={source}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {contextMemory.failedSearches?.length ? (
            <div className="student-popover-section">
              <h3>Failed searches</h3>
              <ul className="student-context-source-list">
                {contextMemory.failedSearches.map((search, index) => (
                  <li key={`${search.query}-${index}`}>
                    {search.query}
                    {search.reason ? ` - ${search.reason}` : " - no useful page found"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});

function StudentContextSourceItem({
  classId,
  conversationId,
  index,
  source
}: {
  classId?: string;
  conversationId?: string;
  index: number;
  source: NonNullable<ChatContextMemory["sourcesUsed"]>[number];
}) {
  const sourceLabel = formatKnowledgeSourceListLabel(source);
  const shouldShowImage = source.sourceType === "student_upload" && isImageContextSource(source);

  return (
    <li className={shouldShowImage ? "is-image-source" : undefined}>
      {shouldShowImage ? (
        <span className="student-context-source-image" title={sourceLabel}>
          <AttachmentVisual
            attachment={{
              classId,
              conversationId,
              fileName: source.sourceName || sourceLabel || `Upload ${index + 1}`,
              fileType: "image",
              id: source.id
            }}
          />
          <span className="sr-only">{sourceLabel}</span>
        </span>
      ) : (
        <span className="student-context-source-label">{sourceLabel}</span>
      )}
      {!source.label && source.sourceType === "class_material" && formatPageNumber(source.pageNumber) ? (
        <strong>{formatPageNumber(source.pageNumber)}</strong>
      ) : null}
      {!source.label && source.problemNumber ? <small>Problem {source.problemNumber}</small> : null}
      {source.sourceType === "student_upload" || source.sourceType === "pasted_problem" ? (
        <small>{studentProvidedSourceLabel(source.sourceType)}</small>
      ) : null}
    </li>
  );
}

function ContextDetail({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function studentProvidedSourceLabel(sourceType: NonNullable<ChatContextMemory["sourcesUsed"]>[number]["sourceType"]) {
  return sourceType === "student_upload" ? "Student-provided" : "Pasted";
}

function isImageContextSource(source: NonNullable<ChatContextMemory["sourcesUsed"]>[number]) {
  if (source.fileType === "image") {
    return true;
  }

  return /\.(?:png|jpe?g|webp)$/i.test(source.sourceName ?? "");
}

const StudentUsagePopover = memo(function StudentUsagePopover({
  errorMessage,
  id,
  isRequestingMoreUsage,
  onRequestMoreUsage,
  requestMessage,
  status,
  summary
}: {
  errorMessage?: string;
  id: string;
  isRequestingMoreUsage: boolean;
  onRequestMoreUsage?: () => void;
  requestMessage: string;
  status: StudentAiUsageStatus | null;
  summary: UsageSummary;
}) {
  const isLoading = !status;
  const mainMessage = isLoading
    ? errorMessage || "Loading tutoring time"
    : status.blocked
      ? "You're out of tutoring time for today. Ask your professor for more."
      : status.nearLimit
        ? "You're almost out of today's tutoring time."
        : `You have ${summary.todayPercentLeft}% of today's tutoring time left.`;

  return (
    <section className="student-header-popover student-usage-popover" id={id} role="region" aria-label="Tutoring time">
      <h2>Tutoring time</h2>
      <p className="student-usage-message">{mainMessage}</p>
      {!isLoading ? (
        <TutoringTimeMeter
          label="Today"
          percentLeft={summary.todayPercentLeft}
          resetAt={status.dailyResetAt}
        />
      ) : null}
      <div className="student-popover-section">
        <h3>What uses tutoring time</h3>
        <ul className="student-usage-costs">
          <li>Uploads use more tutoring time.</li>
          <li>Long explanations use more tutoring time.</li>
          <li>Asking many follow-up questions uses more tutoring time.</li>
        </ul>
      </div>
      <div className="student-popover-section">
        <h3>Weekly</h3>
        {!isLoading ? (
          <TutoringTimeMeter
            isSecondary
            label="This week"
            percentLeft={summary.weekPercentLeft}
            resetAt={status.weeklyResetAt}
          />
        ) : errorMessage ? (
          <p>Tutoring time is unavailable right now.</p>
        ) : (
          <p>Loading weekly tutoring time</p>
        )}
      </div>
      {status?.blocked || status?.nearLimit ? (
        <div className="student-usage-request">
          <p>
            {status.blocked
              ? "You're out of tutoring time for today. Ask your professor for more."
              : "You're almost out of today's tutoring time."}
          </p>
          {status.blocked && onRequestMoreUsage ? (
            <button type="button" disabled={isRequestingMoreUsage} onClick={onRequestMoreUsage}>
              {isRequestingMoreUsage ? "Sending request" : "Ask professor for more time"}
            </button>
          ) : null}
          {requestMessage ? <span>{requestMessage}</span> : null}
        </div>
      ) : null}
    </section>
  );
});

function TutoringTimeMeter({
  isSecondary = false,
  label,
  percentLeft,
  resetAt
}: {
  isSecondary?: boolean;
  label: string;
  percentLeft: number;
  resetAt?: string;
}) {
  const cleanPercentLeft = clampPercent(percentLeft);
  const resetLabel = formatTutoringResetLabel(resetAt);

  return (
    <div className={isSecondary ? "student-usage-popover-meter is-secondary" : "student-usage-popover-meter"}>
      <span>
        <strong>{label} · {cleanPercentLeft}% left</strong>
      </span>
      {resetLabel ? <em>{resetLabel}</em> : null}
      <div
        aria-label={`${label} tutoring time remaining`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={cleanPercentLeft}
        role="meter"
      >
        <span style={{ width: `${cleanPercentLeft}%` }} />
      </div>
    </div>
  );
}

function formatTutoringResetLabel(resetAt?: string) {
  if (!resetAt) {
    return "";
  }

  const resetDate = new Date(resetAt);

  if (!Number.isFinite(resetDate.getTime())) {
    return "";
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const resetDayStart = new Date(resetDate.getFullYear(), resetDate.getMonth(), resetDate.getDate()).getTime();
  const daysUntilReset = Math.round((resetDayStart - todayStart) / (24 * 60 * 60 * 1000));
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(resetDate);
  let dayLabel: string;

  if (daysUntilReset === 0) {
    dayLabel = "today";
  } else if (daysUntilReset === 1) {
    dayLabel = "tomorrow";
  } else if (daysUntilReset >= 2 && daysUntilReset <= 6) {
    dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(resetDate);
  } else if (daysUntilReset >= 7 && daysUntilReset <= 13) {
    dayLabel = `next ${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(resetDate)}`;
  } else {
    dayLabel = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short"
    }).format(resetDate);
  }

  return `Resets ${dayLabel} at ${timeLabel}`;
}

function usageSummaryFromStatus(status: StudentAiUsageStatus | null): UsageSummary {
  return {
    dailyUsed: nonnegativeNumber(status?.dailyUsed, 0),
    dailyLimit: positiveNumber(status?.dailyLimit, 100),
    weeklyUsed: nonnegativeNumber(status?.weeklyUsed, 0),
    weeklyLimit: positiveNumber(status?.weeklyLimit, 400),
    todayPercentLeft: status ? clampPercent(status.todayPercentRemaining) : 0,
    weekPercentLeft: status ? clampPercent(status.weekPercentRemaining) : 0
  };
}

function forcedTutorDebugAiUsageStatus(options: TutorDebugOptions): StudentAiUsageStatus | null {
  if (options.forceAiUsageBlocked) {
    return {
      blocked: true,
      dailyLimit: 100,
      dailyUsed: 100,
      nearLimit: false,
      resetHint: "today",
      todayPercentRemaining: 0,
      weekPercentRemaining: 0,
      weeklyLimit: 400,
      weeklyUsed: 400
    };
  }

  if (options.forceAiUsageNearLimit) {
    return {
      blocked: false,
      dailyLimit: 100,
      dailyUsed: 92,
      nearLimit: true,
      resetHint: "today",
      todayPercentRemaining: 8,
      weekPercentRemaining: 12,
      weeklyLimit: 400,
      weeklyUsed: 352
    };
  }

  return null;
}

function buildKnowledgeLines(messages: ChatMessage[]): KnowledgeLine[] {
  const lines: KnowledgeLine[] = [];
  const seen = new Set<string>();

  function addLine(line: KnowledgeLine) {
    if (seen.has(line.key)) {
      const existingIndex = lines.findIndex((currentLine) => currentLine.key === line.key);

      if (existingIndex >= 0) {
        lines.splice(existingIndex, 1);
      }
    } else {
      seen.add(line.key);
    }

    lines.push(line);
  }

  for (const message of messages) {
    for (const item of message.langGraphTrace?.knowledgeItems ?? []) {
      addLine(knowledgeLineFromBackendItem(item));
    }
  }

  return lines.slice(-5);
}

function knowledgeLineFromBackendItem(item: KnowledgeItem): KnowledgeLine {
  return {
    colorToken: item.uiColor ?? knowledgeUiColorToken(item.usedAs),
    key: item.id,
    role: knowledgeRoleFromBackendItem(item)
  };
}

function knowledgeRoleFromBackendItem(item: KnowledgeItem): KnowledgeItemRole {
  if (item.kind === "student_upload" || item.usedAs === "student_attempt") {
    return "student_upload";
  }

  if (item.usedAs === "definition_reference") {
    return "definition";
  }

  if (item.usedAs === "theorem_reference") {
    return "theorem";
  }

  if (item.usedAs === "example_reference") {
    return "example";
  }

  if (item.kind === "problem" || item.usedAs === "active_problem" || item.usedAs === "problem_source" || item.problemId) {
    return "problem";
  }

  if (item.kind === "pdf_page") {
    return "page";
  }

  return "source";
}

function latestKnowledgeAssistantMessageId(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (
      message?.role === "assistant" &&
      message.langGraphTrace?.knowledgeItems?.length
    ) {
      return message.id;
    }
  }

  return "";
}

function formatProblemLabel(problem: NonNullable<ChatContextMemory["currentProblem"]>) {
  return [problem.problemNumber ? `Problem ${problem.problemNumber}` : problem.label, problem.title]
    .filter(Boolean)
    .join(" - ") || "Saved problem";
}

function formatProblemMeta(problem: NonNullable<ChatContextMemory["currentProblem"]>) {
  return [problem.sourceName, formatPageNumber(problem.pageNumber), problem.sectionTitle].filter(Boolean).join(" · ");
}

function formatKnowledgeSourceListLabel(source: NonNullable<ChatContextMemory["sourcesUsed"]>[number]) {
  if (source.sourceType === "student_upload") {
    return stripStudentUploadLabelPrefix(source.label || source.sourceName || "Student upload");
  }

  if (source.sourceType !== "class_material") {
    return source.label || source.sourceName || "Class material";
  }

  return (
    [
      formatPageNumber(source.pageNumber),
      source.problemNumber ? `Problem ${source.problemNumber}` : undefined
    ]
      .filter(Boolean)
      .join(" · ") ||
    source.label ||
    source.sourceName ||
    "Class material"
  );
}

function stripStudentUploadLabelPrefix(label: string) {
  return label.replace(/^Student upload\s*[\u00b7\u2022-]\s*/i, "") || label;
}

function formatRetrievalReason(reason: string) {
  const labels: Record<string, string> = {
    student_requested_problem: "Student requested this problem",
    needed_supporting_page: "Needed supporting page",
    needed_example_page: "Needed helpful page",
    student_changed_problem: "Student changed problem",
    previous_search_failed: "Previous search failed"
  };

  return labels[reason] ?? reason.replaceAll("_", " ");
}

function formatPageNumber(pageNumber?: number) {
  return typeof pageNumber === "number" && Number.isFinite(pageNumber) && pageNumber > 0 ? `p. ${pageNumber}` : undefined;
}

function formatOcrConfidence(confidence?: number) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return undefined;
  }

  return confidence <= 1 ? `${Math.round(confidence * 100)}%` : `${Math.round(confidence)}%`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function nonnegativeNumber(value: unknown, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function positiveNumber(value: unknown, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

async function readChatStream(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("The tutor service did not return a stream.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: TutorApiResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as ChatStreamEvent;

      if (event.type === "error") {
        throw new Error(event.message);
      }

      if (event.type === "final") {
        finalPayload = event.payload;
      } else {
        onEvent(event);
      }
    }
  }

  if (!finalPayload) {
    throw new Error("The tutor service ended before sending an answer.");
  }

  return finalPayload;
}

function upsertChatMessage(messages: ChatMessage[], message: ChatMessage) {
  const existingIndex = messages.findIndex((currentMessage) => currentMessage.id === message.id);

  if (existingIndex === -1) {
    return [...messages, message];
  }

  return messages.map((currentMessage, index) => (index === existingIndex ? message : currentMessage));
}

function removeChatMessageById(messages: ChatMessage[], messageId: string) {
  return messages.filter((message) => message.id !== messageId);
}

function upsertStreamedAssistantSection({
  event,
  messageId,
  messages
}: {
  event: Extract<ChatStreamEvent, { type: "section_delta" | "section_done" | "section_start" }>;
  messageId: string;
  messages: ChatMessage[];
}) {
  const section = normalizeStreamedSectionKey(event.section);
  if (!section) {
    return messages;
  }

  const existing = messages.find((message) => message.id === messageId) as StreamingChatMessage | undefined;
  const existingStructuredOutput = existing?.structuredOutput;
  const existingSections = existingStructuredOutput?.sections ?? {};
  const existingStreamingState = existing?.streamingState ?? {
    activeSections: {},
    completedSections: {},
    sectionOrder: []
  };
  const streamingSectionOrder = existingStreamingState.sectionOrder.includes(section)
    ? existingStreamingState.sectionOrder
    : [...existingStreamingState.sectionOrder, section];
  const structuredSectionOrder = streamingSectionOrder.filter(
    (orderedSection): orderedSection is StructuredStreamedSectionKey => orderedSection !== "mainText"
  );
  const currentContent = existing?.content ?? "";
  const structuredSection = section === "mainText" ? undefined : section;
  const currentSectionText =
    section === "mainText" || section === "mainChat" ? currentContent : structuredSectionText(existingSections, structuredSection);
  const nextText =
    event.type === "section_delta" ? `${currentSectionText}${event.delta}` : currentSectionText;
  const activeSections = {
    ...existingStreamingState.activeSections,
    [section]: event.type !== "section_done"
  };
  const completedSections = {
    ...existingStreamingState.completedSections,
    ...(event.type === "section_done" ? { [section]: true } : {})
  };
  const nextMessage: StreamingChatMessage = {
    id: messageId,
    role: "assistant",
    content: section === "mainText" || section === "mainChat" ? nextText : currentContent,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    debugInfo: existing?.debugInfo,
    langGraphTrace: existing?.langGraphTrace,
    retrievalConfidence: existing?.retrievalConfidence,
    sources: existing?.sources ?? [],
    structuredOutput: {
      sections:
        structuredSection === undefined
          ? existingSections
          : {
              ...existingSections,
              [structuredSection]: nextText
            },
      sectionOrder: structuredSectionOrder,
      metadata: existingStructuredOutput?.metadata ?? {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    },
    streamingState: {
      activeSections,
      completedSections,
      sectionOrder: streamingSectionOrder
    }
  };

  return upsertChatMessage(messages, nextMessage);
}

function normalizeStreamedSectionKey(section: string): StreamedSectionKey | undefined {
  return streamedSectionKeys.find((candidate) => candidate === section);
}

function structuredSectionText(
  sections: NonNullable<ChatMessage["structuredOutput"]>["sections"],
  section: StructuredStreamedSectionKey | undefined
) {
  return section ? String(sections[section] ?? "") : "";
}

function upsertFinalAssistantMessage(messages: ChatMessage[], message: ChatMessage) {
  const existingIndex = messages.findIndex((currentMessage) => currentMessage.id === message.id);

  if (existingIndex !== -1) {
    return messages.map((currentMessage, index) => (index === existingIndex ? message : currentMessage));
  }

  return [...messages, message];
}

function upsertFinalAssistantMessagePreservingStreamedContent({
  finalMessage,
  messages,
  streamedMessageId
}: {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  streamedMessageId: string;
}) {
  const streamedIndex = messages.findIndex((message) => message.id === streamedMessageId);

  if (streamedIndex === -1) {
    return upsertFinalAssistantMessage(messages, finalMessage);
  }

  const streamedMessage = messages[streamedIndex] as StreamingChatMessage;
  const enrichedMessage = enrichStreamedAssistantMessage(streamedMessage, finalMessage);

  return messages
    .filter((message, index) => index === streamedIndex || message.id !== finalMessage.id)
    .map((message) => (message.id === streamedMessageId ? enrichedMessage : message));
}

function enrichStreamedAssistantMessage(streamedMessage: StreamingChatMessage, finalMessage: ChatMessage): ChatMessage {
  const preservedStructuredOutput = mergeFinalStructuredOutputPreservingStreamedSections(
    streamedMessage.structuredOutput,
    finalMessage.structuredOutput,
    streamedMessage.streamingState
  );
  const preservedContent = streamedMessage.content.trim() ? streamedMessage.content : finalMessage.content;
  const { streamingState: _streamingState, ...baseMessage } = streamedMessage;

  return {
    ...baseMessage,
    id: finalMessage.id,
    content: preservedContent,
    debugInfo: finalMessage.debugInfo,
    langGraphTrace: finalMessage.langGraphTrace,
    retrievalConfidence: finalMessage.retrievalConfidence,
    sources: finalMessage.sources ?? streamedMessage.sources ?? [],
    structuredOutput: preservedStructuredOutput
  };
}

function mergeFinalStructuredOutputPreservingStreamedSections(
  streamedStructuredOutput: ChatMessage["structuredOutput"],
  finalStructuredOutput: ChatMessage["structuredOutput"],
  streamingState?: StreamingAssistantState
): ChatMessage["structuredOutput"] {
  if (!streamedStructuredOutput) {
    return finalStructuredOutput;
  }

  if (!finalStructuredOutput) {
    return streamedStructuredOutput;
  }

  const streamedSections = nonEmptyStructuredSections(streamedStructuredOutput.sections ?? {});
  const finalSections = finalStructuredOutput?.sections ?? {};
  const finalSectionKeys = new Set(Object.keys(finalSections));
  const finalAuthoritativeStreamedSections = Object.fromEntries(
    Object.entries(streamedSections).filter(([section]) => finalSectionKeys.has(section))
  );
  const mergedSections = {
    ...finalAuthoritativeStreamedSections,
    ...finalSections
  };
  const streamedOrder = (streamingState?.sectionOrder ?? streamedStructuredOutput.sectionOrder ?? []).filter(
    (section): section is StructuredStreamedSectionKey => section !== "mainText" && finalSectionKeys.has(section)
  );

  return {
    ...streamedStructuredOutput,
    ...finalStructuredOutput,
    sections: mergedSections,
    sectionOrder: mergeStructuredSectionOrder(streamedOrder, finalStructuredOutput?.sectionOrder),
    metadata: {
      ...(streamedStructuredOutput.metadata ?? finalStructuredOutput?.metadata),
      ...(finalStructuredOutput?.metadata ?? {})
    }
  };
}

function mergeStructuredSectionOrder(
  streamedOrder: StructuredStreamedSectionKey[],
  finalOrder?: StructuredStreamedSectionKey[]
) {
  const finalSectionOrder = Array.isArray(finalOrder) ? finalOrder : [];
  const mergedOrder = [...finalSectionOrder];

  for (const section of streamedOrder) {
    if (!mergedOrder.includes(section)) {
      mergedOrder.push(section);
    }
  }

  return mergedOrder;
}

function nonEmptyStructuredSections(sections: NonNullable<ChatMessage["structuredOutput"]>["sections"]) {
  return Object.fromEntries(Object.entries(sections).filter(([, value]) => String(value ?? "").trim()));
}

async function fetchStudentAiUsageStatus({
  classId,
  token
}: {
  classId: string;
  token: string;
}) {
  const response = await fetch(apiUrl(`/api/student/ai-usage?courseId=${encodeURIComponent(classId)}`), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json()) as { aiUsageStatus?: StudentAiUsageStatus; error?: string };

  if (!response.ok || !data.aiUsageStatus) {
    throw new Error(data.error ?? "AI usage failed to load.");
  }

  return data.aiUsageStatus;
}

async function fetchStudentConversationSummaries({
  classId,
  token
}: {
  classId: string;
  token: string;
}) {
  const response = await fetch(apiUrl(`/api/student/conversations?courseId=${encodeURIComponent(classId)}`), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json()) as { conversations?: StudentConversationSummary[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Saved conversations failed to load.");
  }

  return data.conversations ?? [];
}

async function fetchStudentConversationMessages({
  classId,
  conversationId,
  signal,
  token
}: {
  classId: string;
  conversationId: string;
  signal?: AbortSignal;
  token: string;
}) {
  const response = await fetch(
    apiUrl(
      `/api/student/conversations/${encodeURIComponent(conversationId)}/messages?courseId=${encodeURIComponent(
        classId
      )}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal
    }
  );
  const data = (await response.json()) as { messages?: ChatMessage[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Conversation messages failed to load.");
  }

  return data.messages ?? [];
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function createStudentConversationForAttachment({
  classId,
  token
}: {
  classId: string;
  token: string;
}) {
  const response = await fetch(apiUrl("/api/student/conversations"), {
    body: JSON.stringify({
      courseId: classId,
      title: "New conversation"
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const data = (await response.json()) as { conversation?: StudentConversationSummary; error?: string };

  if (!response.ok || !data.conversation) {
    throw new Error(data.error ?? "Conversation failed to start.");
  }

  return data.conversation;
}

async function sendStudentFeedback({
  classId,
  comment,
  conversationId,
  kind,
  messageId,
  promptReason,
  rating,
  token
}: {
  classId: string;
  comment: string;
  conversationId: string;
  kind: StudentFeedbackKind;
  messageId?: string;
  promptReason?: StudentFeedbackPromptReason;
  rating: StudentFeedbackRating;
  token: string;
}) {
  const response = await fetch(apiUrl("/api/student/feedback"), {
    body: JSON.stringify({
      comment,
      conversationId,
      courseId: classId,
      kind,
      messageId,
      promptReason,
      rating
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const data = (await response.json()) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Feedback failed to send.");
  }
}

async function fetchStudentFeedbackResponses({
  classId,
  conversationId,
  token
}: {
  classId: string;
  conversationId?: string;
  token: string;
}) {
  const query = new URLSearchParams({ courseId: classId });

  if (conversationId) {
    query.set("conversationId", conversationId);
  }

  const response = await fetch(apiUrl(`/api/student/feedback?${query.toString()}`), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json()) as { error?: string; feedback?: StudentFeedback[] };

  if (!response.ok) {
    throw new Error(data.error ?? "Feedback failed to load.");
  }

  return data.feedback ?? [];
}

function buildFeedbackPromptCandidate({
  assistantMessage,
  classId,
  conversationId,
  messages
}: {
  assistantMessage: ChatMessage;
  classId: string;
  conversationId?: string;
  messages: ChatMessage[];
}): FeedbackModalState | null {
  if (!conversationId || feedbackPromptShownToday(classId, conversationId)) {
    return null;
  }

  const assistantReplyCount =
    messages.filter((message) => message.role === "assistant").length + Number(assistantMessage.role === "assistant");
  const latestStudentMessage = [...messages].reverse().find((message) => message.role === "student");
  const promptReason =
    confusionSignalPattern.test(latestStudentMessage?.content ?? "")
      ? "confusion_signal"
      : assistantMessage.retrievalConfidence === "low"
        ? "low_confidence"
        : (assistantMessage.sources?.length ?? 0) >= 3
          ? "source_heavy"
          : assistantReplyCount >= 4
            ? "assistant_count"
            : null;

  if (!promptReason) {
    return null;
  }

  return {
    conversationId,
    defaultComment: "",
    kind: "prompted",
    messageId: assistantMessage.id,
    promptReason
  };
}

const confusionSignalPattern = /\b(confused|confusing|stuck|wrong|doesn'?t make sense|lost|not helpful|i don'?t get|i do not get)\b/i;

function feedbackPromptShownToday(classId: string, conversationId: string) {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(feedbackPromptStorageKey(classId, conversationId)) === todayFeedbackPromptKey();
  } catch {
    return false;
  }
}

function markFeedbackPromptShown(classId: string, conversationId: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(feedbackPromptStorageKey(classId, conversationId), todayFeedbackPromptKey());
  } catch {
    return;
  }
}

function feedbackPromptStorageKey(classId: string, conversationId: string) {
  return `studentFeedbackPrompt:${classId}:${conversationId}`;
}

function todayFeedbackPromptKey() {
  return new Date().toISOString().slice(0, 10);
}

function uploadHomeworkAttachmentWithProgress({
  classId,
  conversationId,
  file,
  onProgress,
  token
}: {
  classId: string;
  conversationId: string;
  file: File;
  onProgress: (progress: number) => void;
  token: string;
}) {
  return new Promise<MessageAttachment>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);

    request.open(
      "POST",
      apiUrl(
        `/api/student/conversations/${encodeURIComponent(conversationId)}/attachments?courseId=${encodeURIComponent(
          classId
        )}`
      )
    );
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      onProgress(Math.min(99, Math.round((event.loaded / Math.max(event.total, 1)) * 100)));
    };
    request.onerror = () => reject(new Error("Network error while uploading homework file."));
    request.onabort = () => reject(new Error("Homework file upload was canceled."));
    request.onload = () => {
      const data = request.response as { attachment?: MessageAttachment; error?: string } | null;

      if (request.status < 200 || request.status >= 300 || !data?.attachment) {
        reject(new Error(data?.error ?? "Homework file upload failed."));
        return;
      }

      resolve(data.attachment);
    };
    request.send(formData);
  });
}

async function prepareTeacherPreviewAttachment({
  classId,
  conversationId,
  file,
  id,
  onProgress
}: {
  classId: string;
  conversationId: string;
  file: File;
  id: string;
  onProgress: (progress: number) => void;
}): Promise<ComposerAttachment> {
  if (file.size > maxTeacherPreviewAttachmentInlineBytes) {
    throw new Error("Teacher preview attachments must be 8 MB or smaller.");
  }

  const dataUrl = await readFileAsDataUrl(file, onProgress);
  const now = new Date().toISOString();
  const fileType = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "image";

  return {
    classId,
    conversationId,
    createdAt: now,
    dataUrl,
    fileName: file.name,
    fileSize: file.size,
    fileType,
    id,
    messageId: null,
    mimeType: file.type || contentTypeFromFileName(file.name),
    pageCount: null,
    progress: 100,
    storageKey: "",
    studentId: "",
    updatedAt: now,
    uploadStatus: "ready"
  };
}

function readFileAsDataUrl(file: File, onProgress: (progress: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      onProgress(Math.min(99, Math.round((event.loaded / Math.max(event.total, 1)) * 100)));
    };
    reader.onerror = () => reject(new Error("Teacher preview attachment could not be read."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Teacher preview attachment could not be read."));
        return;
      }

      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function buildTeacherPreviewAttachmentFiles(attachments: ComposerAttachment[]) {
  return attachments
    .filter((attachment) => attachment.uploadStatus === "ready" && attachment.dataUrl)
    .map((attachment) => ({
      dataUrl: attachment.dataUrl,
      fileName: attachment.fileName,
      fileSize: attachment.fileSize,
      fileType: attachment.fileType,
      id: attachment.id,
      mimeType: attachment.mimeType || contentTypeFromFileName(attachment.fileName)
    }));
}

async function deleteHomeworkAttachment({
  attachmentId,
  classId,
  conversationId,
  token
}: {
  attachmentId: string;
  classId: string;
  conversationId: string;
  token: string;
}) {
  const response = await fetch(
    apiUrl(
      `/api/student/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(
        attachmentId
      )}?courseId=${encodeURIComponent(classId)}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      method: "DELETE"
    }
  );
  const data = (await response.json()) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Attachment could not be removed.");
  }
}

async function fetchStudentClasses(token: string) {
  const response = await fetch(apiUrl("/api/student/classes"), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json()) as { classes?: StudentClassSummary[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Classes failed to load.");
  }

  return data.classes ?? [];
}

function mergeStudentClasses(classes: StudentClassSummary[], activeClass: StudentVisibleClass | null) {
  const classMap = new Map<string, StudentClassSummary>();

  for (const studentClass of classes) {
    classMap.set(studentClass.id, studentClass);
  }

  if (activeClass) {
    classMap.set(activeClass.id, {
      chatBlocked: activeClass.chatBlocked,
      chatBlockedReason: activeClass.chatBlockedReason,
      chatBlockedUntil: activeClass.chatBlockedUntil,
      id: activeClass.id,
      joinCode: activeClass.joinCode,
      name: activeClass.name,
      section: activeClass.section,
      studentPromptPlaceholder: activeClass.studentPromptPlaceholder,
      studentChatEnabled: activeClass.studentChatEnabled
    });
  }

  return Array.from(classMap.values()).sort((firstClass, secondClass) =>
    [firstClass.name, firstClass.section].join(" ").localeCompare([secondClass.name, secondClass.section].join(" "))
  );
}

function getStudentComposerPlaceholder(activeClass: StudentVisibleClass | null) {
  return (
    activeClass?.studentPromptPlaceholder?.trim() ||
    "Ask about a concept, assignment, reading, or homework question..."
  );
}

function formatStudentChatPauseMessage(activeClass: StudentVisibleClass) {
  if (activeClass.chatBlockedReason === "student_chat_safety" && activeClass.chatBlockedUntil) {
    return `Chat is paused for this account until ${formatConversationDate(activeClass.chatBlockedUntil)}.`;
  }

  if (activeClass.chatBlockedReason === "student_chat_safety") {
    return "Chat is paused for this account. Ask your teacher to turn it back on.";
  }

  return "Chat is paused for this account.";
}

function describeStudentClassesError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Classes failed to load.";
}

function describeStudentConversationLoadError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Saved conversations failed to load.";
}

function describeStudentConversationMessageError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Conversation messages failed to load.";
}

function isPausedChatAccessMessage(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("chat is paused") || normalized.includes("teacher has paused chat");
}

function validateComposerAttachmentFile(file: File) {
  const extension = fileExtension(file.name);

  if (!allowedComposerAttachmentExtensions.includes(extension)) {
    return "Upload a PDF, PNG, JPG, JPEG, or WEBP homework file.";
  }

  if (file.size > maxComposerPdfBytes) {
    return `Homework files must be ${Math.floor(maxComposerPdfBytes / 1024 / 1024)} MB or smaller.`;
  }

  const expectedContentType = contentTypeFromFileName(file.name);

  const providedContentType = normalizeComposerAttachmentMimeType(file.type);

  if (providedContentType && providedContentType !== expectedContentType) {
    return "That file type does not match the selected homework file.";
  }

  return "";
}

function contentTypeFromFileName(fileName: string) {
  const extension = fileExtension(fileName);

  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "";
}

function normalizeComposerAttachmentMimeType(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return "image/jpeg";
  }

  if (normalized === "application/x-pdf") {
    return "application/pdf";
  }

  return normalized;
}

function fileExtension(fileName: string) {
  return fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
}

function formatAttachmentMeta(attachment: Pick<MessageAttachment, "fileSize" | "fileType" | "pageCount" | "uploadStatus">) {
  return [
    attachment.fileType === "pdf" ? "PDF" : "Image",
    formatFileSize(attachment.fileSize),
    attachment.pageCount ? `${attachment.pageCount} page${attachment.pageCount === 1 ? "" : "s"}` : "",
    attachment.uploadStatus === "uploading" ? "Uploading" : attachment.uploadStatus === "failed" ? "Failed" : ""
  ].filter(Boolean).join(" / ");
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Unknown size";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${Math.ceil(bytes / 1024)} KB`;
}

function appendProgressSearches(
  current: ChatProgress | null,
  message: string,
  searches: ChatProgressSearch[]
): ChatProgress {
  const existingSearches = current?.searches ?? [];
  const seenQueries = new Set(existingSearches.map((search) => normalizeSearchQuery(search.query)));
  const nextSearches = [...existingSearches];

  for (const search of searches) {
    const normalizedQuery = normalizeSearchQuery(search.query);

    if (!normalizedQuery || seenQueries.has(normalizedQuery)) {
      continue;
    }

    seenQueries.add(normalizedQuery);
    nextSearches.push(search);
  }

  return {
    message,
    searches: nextSearches
  };
}

function quickResponseContent(event: Extract<ChatStreamEvent, { type: "quick_response" }>) {
  const answer = event.structuredOutput?.sections?.mainChat?.trim() || event.structuredOutput?.sections?.answer?.trim();

  if (answer) {
    return answer;
  }

  if (/^\s*[\{\[]/.test(event.message)) {
    return "I'm checking the class materials for that problem.";
  }

  return event.message.replace(/^(?:\*\*)?(?:your next step|next step)(?:\*\*)?\s*:\s*/i, "");
}

function studentSearchPurposeLabel(retrievalReason: string | undefined, query: string, fallback?: string) {
  const normalizedReason = retrievalReason?.trim();

  if (normalizedReason === "student_requested_problem" || normalizedReason === "student_changed_problem") {
    return "Finding the exact problem";
  }

  if (normalizedReason === "needed_supporting_page") {
    return "Looking for a method or rule";
  }

  if (normalizedReason === "needed_example_page") {
    return "Looking for a similar example";
  }

  return fallback || describeSearchQueryForUi(query);
}

function describeSearchQueryForUi(query: string) {
  const normalizedQuery = query.toLowerCase();

  if (/(problem|page|worksheet|section|chapter|exercise|quiz|exam|number)/.test(normalizedQuery)) {
    return "Finding the exact problem";
  }

  if (/(worked|example|similar)/.test(normalizedQuery)) {
    return "Looking for a similar example";
  }

  if (/(method|formula|theorem|definition|rule|substitution|derivative|integral|solve)/.test(normalizedQuery)) {
    return "Looking for a method or rule";
  }

  return "Searching class PDFs for support";
}

function normalizeSearchQuery(query: string) {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatConversationMeta(conversation: StudentConversationSummary) {
  return [
    `${conversation.messageCount} messages`,
    formatConversationDate(conversation.lastMessageAt)
  ].filter(Boolean).join(" / ");
}

function formatConversationDisplayTitle(conversation: StudentConversationSummary) {
  const problemLabel = conversation.problemLabel?.trim() ?? "";
  const title = conversation.title.trim();

  if (problemLabel && !hasInternalProblemIdentifier(problemLabel)) {
    return problemLabel;
  }

  if (hasInternalProblemIdentifier(title)) {
    return conversation.problemSummary?.trim() ? sentenceCaseDisplayTitle(conversation.problemSummary) : "Conversation";
  }

  return title || "Conversation";
}

function formatConversationHoverTitle(conversation: StudentConversationSummary) {
  const displayTitle = formatConversationDisplayTitle(conversation);
  const problemSummary = conversation.problemSummary?.trim();

  if (!problemSummary || displayTitle.toLowerCase() === problemSummary.toLowerCase()) {
    return displayTitle;
  }

  return [displayTitle, problemSummary].join(": ");
}

function hasInternalProblemIdentifier(value: string) {
  return /\b(?:problem|knowledge)_[a-z0-9_-]+\b/i.test(value);
}

function sentenceCaseDisplayTitle(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Conversation";
}

function formatConversationCompactLabel(title: string) {
  const compactLabel = title
    .split(/\s+/)
    .map((word) => word.match(/[A-Za-z0-9]/)?.[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return compactLabel || "C";
}

function compareConversationSummariesByRecentActivity(
  firstConversation: StudentConversationSummary,
  secondConversation: StudentConversationSummary
) {
  return conversationActivityMillis(secondConversation) - conversationActivityMillis(firstConversation);
}

function conversationActivityMillis(conversation: StudentConversationSummary) {
  return Math.max(
    coerceDate(conversation.lastMessageAt)?.getTime() ?? 0,
    coerceDate(conversation.updatedAt)?.getTime() ?? 0,
    coerceDate(conversation.createdAt)?.getTime() ?? 0
  );
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

function formatCompactClassLabel(className: string) {
  const trimmedName = className.trim();
  const firstLetter = trimmedName.match(/[A-Za-z]/)?.[0]?.toUpperCase() ?? "C";
  const trailingNumber = trimmedName.match(/\d{1,3}/)?.[0] ?? "";
  return `${firstLetter}${trailingNumber}`.slice(0, 4);
}

function formatClassSectionLabel(classSection: string, hasClass: boolean) {
  if (!hasClass || !classSection || classSection === "Enter your class code" || classSection === "Student chat") {
    return "";
  }

  return `Section ${classSection}`;
}

function buildInitialStudentMessages(teacherClass: StudentVisibleClass | null): ChatMessage[] {
  return [
    {
      id: welcomeMessageId,
      role: "assistant",
      content: normalizeOpeningMessage(teacherClass?.openingMessage, teacherClass ?? undefined),
      createdAt: new Date().toISOString()
    }
  ];
}

function isOnlyWelcomeMessage(messages: ChatMessage[]) {
  return messages.length === 1 && messages[0]?.id === welcomeMessageId && messages[0]?.role === "assistant";
}

function getInitials(name: string, email: string) {
  const source = name.trim() || email.trim();
  const parts = source
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);

  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2)).toUpperCase();
}
