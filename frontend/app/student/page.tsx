"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, Suspense, memo, useEffect, useMemo, useRef, useState } from "react";
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
import { normalizeOpeningMessage } from "@/lib/class-settings";
import {
  assistantMessageAnswerContent,
  assistantStructuredSections,
  condensedSourceLabels,
  normalizeMarkdownMath,
  normalizeStructuredSectionMarkdown
} from "@/lib/chat-message-format";
import { subscribeToClass, type TeacherClass } from "@/lib/classes";
import { capitalizeLabel, coerceDate, formatConversationDate } from "@/lib/display-format";
import type {
  ChatMessage,
  MessageAttachment,
  StudentAiUsageStatus,
  StudentConversationSummary,
  StudentFeedbackKind,
  StudentFeedbackPromptReason,
  StudentFeedbackRating,
  TutorApiResponse,
  TutorInputTokenSection
} from "@/lib/types";

type ChatProgress = {
  message: string;
  searches: ChatProgressSearch[];
};

type ChatProgressSearch = {
  description: string;
  query: string;
  searchNumber?: number;
};

type ChatStreamEvent =
  | { message: string; stage: string; type: "step" }
  | { description?: string; message: string; query: string; searchNumber: number; stage: string; type: "search" }
  | {
      message: string;
      queries: string[];
      searches?: ChatProgressSearch[];
      searchNumbers?: number[];
      stage: string;
      type: "search_batch";
    }
  | { errorCode?: string; errorId?: string; message: string; stage: string; type: "error" }
  | { payload: TutorApiResponse; type: "final" };

type StudentVisibleClass = {
  appearance?: TeacherClassAppearance;
  id: string;
  joinCode?: string;
  name: string;
  openingMessage?: string;
  section: string;
  studentChatEnabled?: boolean;
  themeColor?: TeacherClassThemeColor;
};

type StudentClassSummary = StudentVisibleClass;

type ComposerAttachment = MessageAttachment & {
  error?: string;
  localUrl?: string;
  progress: number;
};

const studentComposerTextareaMaxHeight = 156;
const markdownRemarkPlugins = [remarkMath];
const markdownRehypePlugins = [rehypeKatex];
const maxComposerAttachments = 3;
const allowedComposerAttachmentExtensions = [".pdf"];
const allowedComposerAttachmentAccept = ".pdf,application/pdf";
const maxComposerPdfBytes = 25 * 1024 * 1024;
const aiUsageLimitMessage =
  "Sorry, you have reached your Chandra usage limit.";
const aiUsageIncreaseRequestComment =
  "Usage increase request: I reached my Chandra usage limit and would like my professor to allow more usage.";
const teacherPreviewDebugStorageKey = "chandra.teacherPreviewDebugMode";

const welcomeMessageId = "welcome";

type StudentMainView = "chat" | "settings";
type FeedbackModalState = {
  conversationId?: string;
  defaultComment: string;
  kind: "general" | "prompted";
  messageId?: string | null;
  promptReason?: StudentFeedbackPromptReason;
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

function StudentWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { firebaseReady, profile, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(() => buildInitialStudentMessages(null));
  const [draft, setDraft] = useState("");
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const sendInFlightRef = useRef(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
  const [classLoadError, setClassLoadError] = useState<{ classId: string; message: string } | null>(null);
  const [loadedClassId, setLoadedClassId] = useState("");
  const [savedClass, setSavedClass] = useState<TeacherClass | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState("");
  const [conversationMessagesError, setConversationMessagesError] = useState("");
  const [themePreferenceError, setThemePreferenceError] = useState("");
  const [isSavingThemePreference, setIsSavingThemePreference] = useState(false);
  const [accountDisplayName, setAccountDisplayName] = useState<string | null>(null);
  const [accountUsername, setAccountUsername] = useState<string | null>(null);
  const [accountSettingsError, setAccountSettingsError] = useState("");
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
  const [isSwitchingClass, setIsSwitchingClass] = useState(false);
  const [conversationSummaries, setConversationSummaries] = useState<StudentConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
  const [feedbackModal, setFeedbackModal] = useState<FeedbackModalState | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<StudentFeedbackRating>("helpful");
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [usageIncreaseRequestMessage, setUsageIncreaseRequestMessage] = useState("");
  const [isRequestingUsageIncrease, setIsRequestingUsageIncrease] = useState(false);
  const [isTeacherDebugMode, setIsTeacherDebugMode] = useState(false);
  const isTeacherPreview = searchParams.get("preview") === "teacher";
  const queryClassId = searchParams.get("classId");
  const activeCourseId = isTeacherPreview ? queryClassId ?? "" : profile?.classId ?? "";
  const classLoadMessage = classLoadError?.classId === activeCourseId ? classLoadError.message : "";
  const isLoadingClass = Boolean(
    firebaseReady &&
      activeCourseId &&
      loadedClassId !== activeCourseId &&
      classLoadError?.classId !== activeCourseId
  );

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

  const activeStudentClass = useMemo(
    () => studentClasses.find((studentClass) => studentClass.id === activeCourseId) ?? null,
    [activeCourseId, studentClasses]
  );
  const activeClass: StudentVisibleClass | null = useMemo(
    () => (savedClass?.id === activeCourseId ? savedClass : activeStudentClass),
    [activeCourseId, activeStudentClass, savedClass]
  );
  const activeAppearance = useMemo(
    () =>
      normalizeTeacherClassAppearance(profile?.appearance ?? activeClass?.appearance ?? defaultTeacherClassAppearance),
    [activeClass?.appearance, profile?.appearance]
  );
  const activeThemeColor = useMemo(
    () =>
      normalizeTeacherClassThemeColor(profile?.themeColor ?? activeClass?.themeColor ?? defaultTeacherClassThemeColor),
    [activeClass?.themeColor, profile?.themeColor]
  );
  const className = activeClass?.name ?? (activeCourseId ? "Saved class" : "Class needed");
  const classSection = activeClass?.section ?? (activeCourseId ? "Student chat" : "Enter your class code");
  const classSectionLabel = formatClassSectionLabel(classSection, Boolean(activeCourseId));
  const studentChatPaused = Boolean(activeCourseId && !isTeacherPreview && activeClass?.studentChatEnabled === false);
  const compactClassLabel = formatCompactClassLabel(className);
  const visibleClassCode = activeClass?.joinCode || activeClass?.id || activeCourseId;
  const visibleConversationSummaries = useMemo(
    () =>
      conversationSummaries
        .filter((conversation) => conversation.classId === activeCourseId && conversation.studentId === user?.uid)
        .sort(compareConversationSummariesByRecentActivity),
    [activeCourseId, conversationSummaries, user?.uid]
  );
  const activeSelectedConversationId = selectedConversationClassId === activeCourseId ? selectedConversationId : "";
  const visibleStudentClasses = useMemo(
    () => mergeStudentClasses(studentClasses, activeClass),
    [activeClass, studentClasses]
  );
  const accountName = profile?.displayName ?? user?.displayName ?? "Student";
  const accountEmail = profile?.email ?? user?.email ?? "";
  const accountUsernameValue = profile?.username ?? accountEmail;
  const accountLastSignInAt = user?.metadata.lastSignInTime ?? "";
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
  const canSendMessage = Boolean(
    activeCourseId &&
      !isSending &&
      !studentChatPaused &&
      !aiUsageStatus?.blocked &&
      !isUploadingAttachment &&
      (draft.trim() || readyComposerAttachments.length)
  );

  useEffect(() => {
    resizeStudentComposerTextarea(draftTextareaRef.current);
  }, [draft]);

  useEffect(() => {
    if (!isTeacherPreview) {
      setIsTeacherDebugMode(false);
      return;
    }

    setIsTeacherDebugMode(window.localStorage.getItem(teacherPreviewDebugStorageKey) === "true");
  }, [isTeacherPreview]);

  useEffect(() => {
    if (!isTeacherPreview) {
      return;
    }

    window.localStorage.setItem(teacherPreviewDebugStorageKey, String(isTeacherDebugMode));
  }, [isTeacherDebugMode, isTeacherPreview]);

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

    try {
      const token = await user.getIdToken();
      const conversationId = await ensureAttachmentConversation(token);

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
      const attachment = await uploadHomeworkAttachmentWithProgress({
        classId: activeCourseId,
        conversationId,
        file,
        token,
        onProgress: (progress) => {
          setComposerAttachments((currentAttachments) =>
            currentAttachments.map((item) => (item.id === temporaryId ? { ...item, progress } : item))
          );
        }
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

    if (attachment.uploadStatus !== "ready" || !user) {
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

    if (!canSendMessage || sendInFlightRef.current) {
      return;
    }

    if (!user) {
      return;
    }

    const studentMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "student",
      attachments: readyComposerAttachments,
      content: content || "Can you help me with this attached homework material?",
      createdAt: new Date().toISOString()
    };

    const sentAttachmentIds = readyComposerAttachments.map((attachment) => attachment.id);
    const nextMessages = [...messages, studentMessage];
    setMessages(nextMessages);
    setDraft("");
    clearComposerAttachments({ revokeLocalUrls: false });
    sendInFlightRef.current = true;
    setIsSending(true);
    setChatProgress({
      message: "Getting ready.",
      searches: []
    });
    let pendingFeedbackPrompt: FeedbackModalState | null = null;

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
          conversationId: activeSelectedConversationId || undefined,
          courseId: activeCourseId,
          messages: nextMessages,
          stream: true
        })
      });

      if (!response.ok) {
        const data = (await response.json()) as { aiUsageStatus?: StudentAiUsageStatus; error?: string };
        if (data.aiUsageStatus) {
          setAiUsageStatus(data.aiUsageStatus);
        }
        throw new Error(data.error ?? "Chat request failed");
      }

      const data = await readChatStream(response, (event) => {
        if (event.type === "step") {
          setChatProgress((current) => ({
            message: event.message,
            searches: current?.searches ?? []
          }));
        }

        if (event.type === "search") {
          setChatProgress((current) =>
            appendProgressSearches(current, event.message, [
              {
                description: coerceFiveWordSearchReason(event.description, event.query),
                query: event.query,
                searchNumber: event.searchNumber
              }
            ])
          );
        }

        if (event.type === "search_batch") {
          const searches =
            event.searches ??
            event.queries.map((query, index) => ({
              description: describeSearchQueryForUi(query),
              query,
              searchNumber: event.searchNumbers?.[index]
            }));

          setChatProgress((current) => appendProgressSearches(current, event.message, searches));
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

      setMessages((current) => upsertChatMessage(current, assistantMessage));
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

    setThemePreferenceError("");
    setIsSavingThemePreference(true);

    try {
      await updateUserThemePreference({
        appearance: normalizeTeacherClassAppearance(nextPreference.appearance ?? activeAppearance),
        themeColor: normalizeTeacherClassThemeColor(nextPreference.themeColor ?? activeThemeColor),
        uid: user.uid
      });
    } catch (caughtError) {
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
    setIsSavingAccountSettings(true);

    try {
      await updateUserAccountSettings({
        appearance: activeAppearance,
        displayName: accountDisplayName ?? accountName,
        themeColor: activeThemeColor,
        uid: user.uid,
        username: accountUsername ?? accountUsernameValue
      });
      setAccountDisplayName(null);
      setAccountUsername(null);
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

    setAccountSettingsError("");
    setIsDeletingAccount(true);

    try {
      await deleteCurrentAccount({
        currentPassword: deleteAccountPassword,
        uid: user.uid
      });
      router.push("/auth");
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
                  <button className="student-new-mini-button" type="button" onClick={startNewConversation}>
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
                          type="button"
                          onClick={() => {
                            setStudentMainView("chat");
                            clearComposerAttachments();
                            setSelectedConversationId(conversation.id);
                            setSelectedConversationClassId(activeCourseId);
                          }}
                        >
                          <span className="student-conversation-icon" aria-hidden="true" />
                          <span className="student-conversation-copy">
                            <strong>{conversation.title}</strong>
                            <span>{formatConversationMeta(conversation)}</span>
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
            accountDisplayName={accountDisplayName ?? accountName}
            accountLastSignInAt={accountLastSignInAt}
            accountUsername={accountUsername ?? accountUsernameValue}
            accountSettingsError={accountSettingsError}
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
            role={profile?.role ?? "student"}
            themePreferenceError={themePreferenceError}
            onAccountDisplayNameChange={setAccountDisplayName}
            onAccountUsernameChange={setAccountUsername}
            onDeleteAccount={handleDeleteAccount}
            onDeleteAccountPasswordChange={setDeleteAccountPassword}
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
              <div className="student-main-header-actions">
                {aiUsageStatus ? (
                  <StudentAiUsagePanel
                    isRequestingMoreUsage={isRequestingUsageIncrease}
                    requestMessage={usageIncreaseRequestMessage}
                    status={aiUsageStatus}
                    onRequestMoreUsage={isTeacherPreview ? undefined : requestUsageIncrease}
                  />
                ) : null}
                <button
                  className="student-feedback-button"
                  disabled={!activeCourseId || isTeacherPreview}
                  type="button"
                  onClick={() => openFeedbackModal()}
                >
                  Feedback
                </button>
              </div>
            </header>
            {studentChatPaused ? (
              <p className="form-error chat-error">Your teacher has paused chat for this class.</p>
            ) : null}
            {aiUsageError ? <p className="form-error chat-error">{aiUsageError}</p> : null}

            {conversationMessagesError ? <p className="form-error chat-error">{conversationMessagesError}</p> : null}
            <div className="message-list student-message-list">
              {messages.map((message) => (
                <StudentChatMessage
                  debugEnabled={isTeacherPreview && isTeacherDebugMode}
                  message={message}
                  key={message.id}
                />
              ))}
              {isSending && chatProgress ? <ChatProgressMessage progress={chatProgress} /> : null}
            </div>

            <form
              className={`composer student-composer${isDraggingAttachment ? " is-dragging" : ""}`}
              onDragLeave={() => setIsDraggingAttachment(false)}
              onDragOver={handleAttachmentDragOver}
              onDrop={(event) => void handleAttachmentDrop(event)}
              onSubmit={sendMessage}
            >
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
                multiple
                type="file"
                onChange={(event) => void handleAttachmentSelection(event)}
              />
              <button
                className="student-composer-add"
                type="button"
                aria-label="Attach homework file"
                disabled={isSending || isUploadingAttachment || composerAttachments.length >= maxComposerAttachments || !activeCourseId}
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
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  studentChatPaused
                    ? "Your teacher has paused chat for this class."
                    : aiUsageStatus?.blocked
                    ? "Ask your professor for more Chandra usage."
                    : activeCourseId
                      ? "Ask about a problem, step, or equation..."
                      : "Join a class to start chatting."
                }
                rows={1}
              />
              <button className="student-send-button" type="submit" disabled={!canSendMessage}>
                {isSending ? "Sending" : isUploadingAttachment ? "Uploading" : "Send"}
              </button>
            </form>
          </section>
        )}
        {feedbackModal ? (
          <StudentFeedbackModal
            comment={feedbackComment}
            isSending={isSendingFeedback}
            message={feedbackMessage}
            rating={feedbackRating}
            onClose={() => {
              if (!isSendingFeedback) {
                setFeedbackModal(null);
              }
            }}
            onCommentChange={setFeedbackComment}
            onRatingChange={setFeedbackRating}
            onSubmit={submitFeedback}
          />
        ) : null}
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

function StudentFeedbackModal({
  comment,
  isSending,
  message,
  rating,
  onClose,
  onCommentChange,
  onRatingChange,
  onSubmit
}: {
  comment: string;
  isSending: boolean;
  message: string;
  rating: StudentFeedbackRating;
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
    <div className="student-feedback-modal-backdrop" role="presentation">
      <form className="student-feedback-modal" aria-label="Send feedback about Chandra" onSubmit={onSubmit}>
        <div className="student-feedback-modal-heading">
          <h2>Feedback about Chandra</h2>
          <button aria-label="Close feedback" disabled={isSending} type="button" onClick={onClose}>
            x
          </button>
        </div>
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
        <label className="sr-only" htmlFor="student-feedback-comment">
          Feedback note
        </label>
        <textarea
          id="student-feedback-comment"
          maxLength={1000}
          placeholder="What should your teacher know about this Chandra response?"
          rows={4}
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
        />
        {message ? <p className="student-feedback-message">{message}</p> : null}
        <div className="student-feedback-modal-actions">
          <button disabled={isSending} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="student-feedback-submit" disabled={isSending || !comment.trim()} type="submit">
            {isSending ? "Sending" : "Send feedback"}
          </button>
        </div>
      </form>
    </div>
  );
}

const StudentChatMessage = memo(function StudentChatMessage({
  debugEnabled,
  message
}: {
  debugEnabled: boolean;
  message: ChatMessage;
}) {
  if (message.role === "student") {
    return (
      <article className="student-workspace-message student">
        <div className="student-message-stack">
          <div className="message-meta-row">
            <div className="message-meta">You</div>
            {debugEnabled ? <MessageDebugDetails message={message} /> : null}
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

  const answerContent = assistantMessageAnswerContent(message);
  const structuredSections = assistantStructuredSections(message);
  const problemSection = structuredSections.find((section) => section.kind === "problem");
  const remainingStructuredSections = structuredSections.filter((section) => section.kind !== "problem");
  const sourceLabels = message.sources?.length ? condensedSourceLabels(message.sources) : [];

  return (
    <article className="student-workspace-message assistant">
      <span className="chandra-message-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack">
        <div className="message-meta-row">
          <div className="message-meta">Chandra</div>
          {debugEnabled ? <MessageDebugDetails message={message} /> : null}
        </div>
        {problemSection ? (
          <div className={`assistant-structured-section ${problemSection.kind}`} key={problemSection.kind}>
            <strong>{problemSection.label}</strong>
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(problemSection.content, problemSection.kind))}
            </ReactMarkdown>
          </div>
        ) : null}
        {answerContent ? (
          <div className="assistant-message-bubble">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(answerContent)}
            </ReactMarkdown>
          </div>
        ) : null}
        {remainingStructuredSections.map((section) => (
          <div className={`assistant-structured-section ${section.kind}`} key={section.kind}>
            <strong>{section.label}</strong>
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
              {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(section.content, section.kind))}
            </ReactMarkdown>
          </div>
        ))}
        {sourceLabels.length ? (
          <div className="message-sources" aria-label="Sources used">
            <strong>Sources:</strong>
            {sourceLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
});

function MessageDebugDetails({ message }: { message: ChatMessage }) {
  const debug = buildMessageDebugDisplay(message);
  const [selectedInputSectionId, setSelectedInputSectionId] = useState(
    debug.inputTokenBreakdown[0]?.id ?? ""
  );
  const selectedInputSection =
    debug.inputTokenBreakdown.find((section) => section.id === selectedInputSectionId) ??
    debug.inputTokenBreakdown[0];

  return (
    <details className="message-debug-details">
      <summary aria-label={`Show debug details for ${message.role} message`}>
        Debug · {debug.summary}
      </summary>
      <div className="message-debug-panel">
        <dl>
          {debug.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {debug.stages.length ? (
          <div className="message-debug-stages" aria-label="Debug stages">
            {debug.stages.map((stage, index) => (
              <span key={`${stage}-${index}`}>{stage}</span>
            ))}
          </div>
        ) : null}
        {debug.modelCallUsage.length ? (
          <div className="message-debug-calls" aria-label="Model call token usage">
            {debug.modelCallUsage.map((call, index) => (
              <div className="message-debug-call" key={`${call.stage}-${call.purpose}-${index}`}>
                <strong>{call.purpose || call.stage || `Call ${index + 1}`}</strong>
                <span>{call.stage || "unknown stage"}</span>
                <span>{call.model || "unknown model"}</span>
                <span>Reasoning: {call.reasoningEffort || "default"}</span>
                <span>In {formatInteger(call.inputTokens)} · Reasoning {formatInteger(call.reasoningTokens)} · Out {formatInteger(call.outputTokens)} · Total {formatInteger(call.totalTokens)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {debug.inputTokenBreakdown.length ? (
          <div className="message-debug-input-breakdown" aria-label="Estimated input token breakdown">
            <div className="message-debug-section-heading">
              <strong>Input token sections</strong>
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
          </div>
        ) : null}
      </div>
    </details>
  );
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

    return {
      inputBreakdownTotal,
      inputTokenBreakdown,
      modelCallUsage,
      rows,
      stages: debugInfo?.stages ?? message.langGraphTrace?.stages ?? [],
      summary: `${formatInteger(displayTokens)} tokens · ${formatInteger(requestCount)} req`
    };
  }

  return {
    inputBreakdownTotal: 0,
    inputTokenBreakdown: [],
    modelCallUsage: [],
    rows: [
      { label: "Message tokens", value: formatInteger(estimatedMessageTokens) },
      { label: "Characters", value: formatInteger(message.content.length) },
      { label: "Attachments", value: formatInteger(message.attachments?.length ?? 0) },
      { label: "Created", value: formatAccountActivityTime(message.createdAt) }
    ],
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
  accountDisplayName,
  accountLastSignInAt,
  accountUsername,
  accountSettingsError,
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
  role,
  themePreferenceError,
  onAccountDisplayNameChange,
  onAccountUsernameChange,
  onDeleteAccount,
  onDeleteAccountPasswordChange,
  onTeacherDebugModeChange,
  onSaveAccountSettings,
  onSignOut,
  onSignOutAllSessions,
  onBackToChat,
  onUpdateThemePreference
}: {
  accountEmail: string;
  accountDisplayName: string;
  accountLastSignInAt: string;
  accountUsername: string;
  accountSettingsError: string;
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
  role: string;
  themePreferenceError: string;
  onAccountDisplayNameChange: (displayName: string) => void;
  onAccountUsernameChange: (username: string) => void;
  onDeleteAccount: () => Promise<void>;
  onDeleteAccountPasswordChange: (password: string) => void;
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
          {accountSettingsError ? <p className="form-error">{accountSettingsError}</p> : null}
        </section>

        <section className="student-settings-card student-credentials-card" aria-labelledby="student-email-password-settings">
          <div className="student-settings-card-heading">
            <h2 id="student-email-password-settings">Email &amp; Password</h2>
          </div>
          <div className="student-credentials-grid">
            <dl className="student-settings-data-list">
              <div>
                <dt>Email address</dt>
                <dd>{accountEmail || "No email on file"}</dd>
              </div>
              <div>
                <dt>Password</dt>
                <dd aria-label="Password hidden">**********</dd>
              </div>
            </dl>
            <div className="student-settings-action-stack">
              <button className="student-settings-secondary-button" disabled type="button">
                Change email
              </button>
              <button className="student-settings-secondary-button" disabled type="button">
                Change password
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
        <div className="student-message-attachment" key={attachment.id}>
          <AttachmentVisual attachment={attachment} />
          <span>
            <strong>{attachment.fileName}</strong>
            <small>{formatAttachmentMeta(attachment)}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function AttachmentVisual({ attachment }: { attachment: Partial<ComposerAttachment> & Pick<MessageAttachment, "fileType" | "fileName"> }) {
  if (attachment.fileType === "image" && attachment.localUrl) {
    return (
      <span
        className="student-attachment-thumbnail"
        style={{ backgroundImage: `url(${attachment.localUrl})` }}
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

const ChatProgressMessage = memo(function ChatProgressMessage({ progress }: { progress: ChatProgress }) {
  return (
    <article className="student-workspace-message assistant progress-message" aria-live="polite">
      <span className="chandra-message-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack">
        <div className="message-meta">Chandra</div>
        <div className="assistant-message-bubble">
          <div className="progress-row">
            <span className="thinking-dot" aria-hidden="true" />
            <p>{progress.message}</p>
          </div>
          {progress.searches.length ? (
            <ol className="progress-searches" aria-label="Searches Chandra has tried">
              {progress.searches.map((search, index) => (
                <li key={`${search.query}-${index}`}>
                  <strong>{search.description}</strong>
                  <span>{search.query}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </article>
  );
});

const StudentAiUsagePanel = memo(function StudentAiUsagePanel({
  isRequestingMoreUsage,
  onRequestMoreUsage,
  requestMessage,
  status
}: {
  isRequestingMoreUsage: boolean;
  onRequestMoreUsage?: () => void;
  requestMessage: string;
  status: StudentAiUsageStatus;
}) {
  return (
    <section
      className={`student-ai-usage${status.nearLimit ? " near-limit" : ""}${status.blocked ? " blocked" : ""}`}
      aria-label="AI usage remaining"
    >
      <div className="student-ai-usage-meters">
        <StudentAiUsageMeter label="Today" percent={status.todayPercentRemaining} />
        <StudentAiUsageMeter label="Week" percent={status.weekPercentRemaining} />
      </div>
      {status.blocked ? (
        <div className="student-ai-usage-request">
          <p>{formatAiUsageLimitMessage(status)}</p>
          {onRequestMoreUsage ? (
            <button type="button" disabled={isRequestingMoreUsage} onClick={onRequestMoreUsage}>
              {isRequestingMoreUsage ? "Sending request" : "Ask professor for more usage"}
            </button>
          ) : null}
          {requestMessage ? <span>{requestMessage}</span> : null}
        </div>
      ) : status.nearLimit ? (
        <p>AI usage is almost used up.</p>
      ) : null}
    </section>
  );
});

function formatAiUsageLimitMessage(status: StudentAiUsageStatus) {
  const resetHint = status.resetHint?.trim();

  return resetHint ? `${aiUsageLimitMessage} It resets ${resetHint}.` : aiUsageLimitMessage;
}

function StudentAiUsageMeter({ label, percent }: { label: string; percent: number }) {
  const cleanPercent = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <div className="student-ai-usage-meter">
      <span>
        <strong>
          <UsageMeterIcon label={label} />
          {label}
        </strong>
        <em>{cleanPercent}% left</em>
      </span>
      <div aria-hidden="true">
        <span style={{ width: `${cleanPercent}%` }} />
      </div>
    </div>
  );
}

function UsageMeterIcon({ label }: { label: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {label === "Today" ? (
        <>
          <path d="M7 3.5v3M17 3.5v3" />
          <path d="M4.5 8.5h15" />
          <path d="M6.5 5.5h11A2.5 2.5 0 0 1 20 8v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18V8a2.5 2.5 0 0 1 2.5-2.5Z" />
        </>
      ) : (
        <>
          <path d="M4 17 9 12l4 4 7-9" />
          <path d="M16 7h4v4" />
        </>
      )}
    </svg>
  );
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
      id: activeClass.id,
      joinCode: activeClass.joinCode,
      name: activeClass.name,
      section: activeClass.section,
      studentChatEnabled: activeClass.studentChatEnabled
    });
  }

  return Array.from(classMap.values()).sort((firstClass, secondClass) =>
    [firstClass.name, firstClass.section].join(" ").localeCompare([secondClass.name, secondClass.section].join(" "))
  );
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

function validateComposerAttachmentFile(file: File) {
  const extension = fileExtension(file.name);

  if (!allowedComposerAttachmentExtensions.includes(extension)) {
    return "Only text-readable PDF homework files are supported.";
  }

  if (file.size > maxComposerPdfBytes) {
    return `PDFs must be ${Math.floor(maxComposerPdfBytes / 1024 / 1024)} MB or smaller.`;
  }

  const expectedContentType = contentTypeFromFileName(file.name);

  if (file.type && file.type !== expectedContentType) {
    return "That file type does not match the selected homework file.";
  }

  return "";
}

function contentTypeFromFileName(fileName: string) {
  const extension = fileExtension(fileName);

  if (extension === ".pdf") {
    return "application/pdf";
  }

  return "";
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

function describeSearchQueryForUi(query: string) {
  const normalizedQuery = query.toLowerCase();

  if (/(problem|page|worksheet|section|chapter|exercise|quiz|exam|number)/.test(normalizedQuery)) {
    return "Checking exact problem and page";
  }

  if (/(method|formula|theorem|definition|rule|example|substitution|derivative|integral|solve)/.test(normalizedQuery)) {
    return "Finding method and example pages";
  }

  return "Searching class PDFs for support";
}

function coerceFiveWordSearchReason(reason: string | undefined, query: string) {
  const words = reason?.match(/[A-Za-z0-9']+/g) ?? [];

  if (words.length === 5) {
    return words.join(" ");
  }

  return describeSearchQueryForUi(query);
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
