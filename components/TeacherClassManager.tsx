"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api-client";
import { signOutCurrentUser } from "@/lib/auth";
import {
  defaultRefusalStyle,
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeSourceUsageSettings,
  normalizeTutorBehavior,
  preferredSourceTypeOptions,
  reasoningEffortOptions,
  responseLengthOptions,
  tutorBehaviorOptions,
  type AnswerPolicySettings,
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
  maxTutorKnowledgeUploadBytes,
  supportedTutorKnowledgeExtensions,
  tutorKnowledgeKinds,
  type TutorKnowledgeKind
} from "@/lib/tutor-knowledge";
import type { ChatMessage, StudentConversationSummary, StudentRosterActivitySummary } from "@/lib/types";
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
type RosterConversationPreview = {
  meta: string;
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

const teacherTabs: Array<{ id: TeacherTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roster", label: "Roster" },
  { id: "settings", label: "AI Settings" },
  { id: "knowledge", label: "Knowledge" },
  { id: "insights", label: "Insights" },
  { id: "conversations", label: "Conversations" }
];

const rosterFilters: Array<{ id: RosterFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active recently" },
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

const answerPolicySettings = [
  {
    id: "doNotGiveFinalAnswers",
    title: "Do not give final answers",
    description: "Avoid providing final answers unless explicitly allowed."
  },
  {
    id: "requireStudentAttemptFirst",
    title: "Require student attempt first",
    description: "Encourage students to try before getting help."
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
  }
] as const;

const selectableModelOptions = defaultModelOptions.filter((modelOption) => modelOption.provider === "openrouter");

export function TeacherClassManager() {
  const router = useRouter();
  const { profile, user } = useAuth();
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [materials, setMaterials] = useState<ClassMaterial[]>([]);
  const [rosterActivity, setRosterActivity] = useState<StudentRosterActivitySummary[]>([]);
  const [studentConversations, setStudentConversations] = useState<StudentConversationSummary[]>([]);
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
  const [activeTab, setActiveTab] = useState<TeacherTab>("roster");
  const [rosterSearchQuery, setRosterSearchQuery] = useState("");
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>("all");
  const [checkedStudentIds, setCheckedStudentIds] = useState<string[]>([]);
  const [isRosterDetailOpen, setIsRosterDetailOpen] = useState(true);
  const [isProfessorReviewOpen, setIsProfessorReviewOpen] = useState(false);
  const [teacherNotesByStudentId, setTeacherNotesByStudentId] = useState<Record<string, string>>({});
  const [savingNotesStudentId, setSavingNotesStudentId] = useState("");
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
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [isStudentDialogOpen, setIsStudentDialogOpen] = useState(false);
  const [isKnowledgeDialogOpen, setIsKnowledgeDialogOpen] = useState(false);
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
  const visibleStudentConversations = studentConversations.filter(
    (conversation) =>
      conversation.classId === activeClassId &&
      conversation.studentEmail === selectedStudent?.email.trim().toLowerCase()
  );
  const activeSelectedConversationId =
    selectedConversationClassId === activeClassId &&
    visibleStudentConversations.some((conversation) => conversation.id === selectedConversationId)
      ? selectedConversationId
      : visibleStudentConversations[0]?.id ?? "";
  const selectedConversation = visibleStudentConversations.find(
    (conversation) => conversation.id === activeSelectedConversationId
  );
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
  const selectedClassCode = selectedClass?.joinCode ?? "";
  const selectedAnswerPolicy = normalizeAnswerPolicySettings(selectedClass?.answerPolicy);
  const selectedSourceUsage = normalizeSourceUsageSettings(selectedClass?.sourceUsage);
  const selectedModelSettings = normalizeClassModelSettings(selectedClass?.modelSettings);
  const selectedTutorBehavior = normalizeTutorBehavior(selectedClass?.behaviorTitle);
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
        }).preferredSourceType
      };

      await updateTeacherClassSettings({
        answerPolicy,
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
        refusalStyle: selectedClass?.refusalStyle ?? defaultRefusalStyle,
        section: String(formData.get("section") ?? ""),
        sourceUsage
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

  return (
    <>
      <section className="teacher-dashboard" aria-label="Teacher dashboard">
        <aside className="teacher-sidebar" aria-label="Teacher navigation">
          <div className="teacher-sidebar-scroll">
            <div className="teacher-brand">
              <Link className="teacher-wordmark" href="/">
                Chandra
              </Link>
            </div>

            <section className="teacher-sidebar-card class-list-card" aria-labelledby="classes-heading">
              <div className="teacher-card-heading">
                <p className="eyebrow" id="classes-heading">
                  Classes
                </p>
                <button
                  className="sidebar-create-button"
                  type="button"
                  onClick={() => setIsClassDialogOpen(true)}
                >
                  Create class
                </button>
              </div>
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
                      setConversationMessages([]);
                      setConversationError("");
                      setSelectedMaterialId("");
                      setKnowledgeFilter("All");
                      setCheckedStudentIds([]);
                      setIsRosterDetailOpen(true);
                      setIsProfessorReviewOpen(false);
                      setRosterSearchQuery("");
                      setRosterFilter("all");
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
            <header className="teacher-main-header">
              <div>
                <h1>{selectedClass ? selectedClass.name : "Create a class"}</h1>
                <p>{selectedClass ? formatSectionLabel(selectedClass.section) : "Add your first class from the sidebar."}</p>
              </div>

              {selectedClass ? (
	                <div className="class-heading-actions">
	                  <span className="class-code">
	                    Class code: {selectedClassCode || "Creating code..."}
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
              <>
                <div className="tab-list" role="tablist" aria-label="Class editor sections">
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

                {isLoadingClassDetails ? (
                  <div className="empty-state detail-loading">
                    <strong>Loading class details</strong>
                    <span>Fetching roster and tutor knowledge.</span>
                  </div>
                ) : null}

                {activeTab === "settings" ? (
                  <form className="class-settings-form settings-workspace" key={selectedClass.id} onSubmit={submitSettings}>
                    <div className="teacher-section-heading settings-page-heading">
                      <div>
                        <p className="eyebrow">AI Behavior</p>
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
                            <p className="eyebrow">Student</p>
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
                              <p className="eyebrow">Professor view</p>
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
                            <p className="eyebrow">Roster</p>
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
                          <RosterStatCard label="Active today" tone="positive" value={String(rosterStats.activeToday)} />
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
                                <span>Status</span>
                                <span>Last active</span>
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
                                    <span className="roster-cell" role="cell">
                                      <span className={`roster-status-pill ${row.statusTone}`}>{row.status}</span>
                                    </span>
                                    <span className="roster-cell" role="cell">{row.lastActive}</span>
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
                        <p className="eyebrow">Knowledge sources</p>
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
                                  onClick={() => setSelectedMaterialId(material.id)}
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
                                    onClick={() => {
                                      setSelectedMaterialId(material.id);
                                      window.alert("Source preview is intentionally omitted for now.");
                                    }}
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
                <p className="eyebrow">Create class</p>
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
                <p className="eyebrow">Roster</p>
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
                <p className="eyebrow">Tutor Knowledge</p>
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
              <p className="field-hint">PDF, TXT, MD, or CSV only. Max size: {formatBytes(maxTutorKnowledgeUploadBytes)}.</p>

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

function capitalizeLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
  const normalizedSection = section.trim().replace(/^(section|period)\s*:?\s*/i, "");

  return normalizedSection ? `Section: ${normalizedSection}` : "Section";
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

function buildStudentActivityByEmail(activity: StudentRosterActivitySummary[]) {
  return new Map(
    activity
      .filter((studentActivity) => studentActivity.studentEmail.trim())
      .map((studentActivity) => [studentActivity.studentEmail.trim().toLowerCase(), studentActivity])
  );
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
        meta: formatConversationDate(conversation.lastMessageAt),
        title: conversation.title
      })) ?? [];

    return {
      activeToday: (activity?.questionsToday ?? 0) > 0,
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

  return [{ title: "No recent conversations", meta: "" }];
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
  if (file.size > maxTutorKnowledgeUploadBytes) {
    throw new Error("Files must be 12 MB or smaller.");
  }

  const normalizedName = file.name.toLowerCase();
  const supportedExtension = supportedTutorKnowledgeExtensions.some((extension) =>
    normalizedName.endsWith(extension)
  );

  if (!supportedExtension) {
    throw new Error("Only PDF, TXT, MD, and CSV files are supported.");
  }
}
