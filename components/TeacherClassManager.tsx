"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api-client";
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
import {
  formatBytes,
  maxTutorKnowledgeUploadBytes,
  supportedTutorKnowledgeExtensions,
  tutorKnowledgeKinds,
  type TutorKnowledgeKind
} from "@/lib/tutor-knowledge";
import type { ChatMessage, StudentConversationSummary } from "@/lib/types";
import { useAuth } from "./AuthProvider";

type MaterialUploadProgress = {
  detail: string;
  percent: number;
  step: "prepare" | "upload" | "read" | "chunk" | "embed" | "save" | "complete";
  uploadPercent: number;
};

export function TeacherClassManager() {
  const { profile, user } = useAuth();
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [materials, setMaterials] = useState<ClassMaterial[]>([]);
  const [studentConversations, setStudentConversations] = useState<StudentConversationSummary[]>([]);
  const [conversationMessages, setConversationMessages] = useState<ChatMessage[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [selectedStudentClassId, setSelectedStudentClassId] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
  const [className, setClassName] = useState("");
  const [classSection, setClassSection] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [studentName, setStudentName] = useState("");
  const [activeTab, setActiveTab] = useState<"roster" | "settings" | "knowledge">("roster");
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
  const selectedStudent = useMemo(() => {
    return students.find((student) => student.id === activeSelectedStudentId) ?? null;
  }, [activeSelectedStudentId, students]);
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
  const selectedClassCode = selectedClass?.joinCode ?? "";
  const inviteLinkCopyStatus =
    inviteLinkCopyResult?.classCode === selectedClassCode ? inviteLinkCopyResult.status : "";
  const isLoadingClassDetails = Boolean(activeClassId && loadedDetailsClassId !== activeClassId);
  const hasTutorKnowledgeSource = Boolean(materialFile || materialText.trim());

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
      await updateTeacherClassSettings({
        behaviorInstructions: String(formData.get("behaviorInstructions") ?? ""),
        behaviorTitle: String(formData.get("behaviorTitle") ?? ""),
        classId: activeClassId,
        name: String(formData.get("name") ?? ""),
        refusalStyle: String(formData.get("refusalStyle") ?? ""),
        section: String(formData.get("section") ?? "")
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

  return (
    <section className="class-workflow" aria-label="Class workflow">
      <article className="panel class-list-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Classes</p>
            <h2>Your classes</h2>
          </div>
          <span className="status ok">{isLoadingClasses ? "Loading" : `${classes.length} total`}</span>
        </div>

        <form className="class-form" onSubmit={submitClass}>
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

          <button className="primary-button" disabled={isSavingClass} type="submit">
            {isSavingClass ? "Creating" : "Create class"}
          </button>
        </form>

        <div className="class-list">
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
                setStudentConversations([]);
                setConversationMessages([]);
                setConversationError("");
              }}
            >
              <strong>{teacherClass.name}</strong>
              <span>{teacherClass.section}</span>
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
      </article>

      <article className="panel class-detail-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Class workspace</p>
            <h2>{selectedClass ? selectedClass.name : "Create a class"}</h2>
          </div>
          {selectedClass ? (
            <div className="class-heading-actions">
              <span className="class-code">
                Class code: {selectedClassCode || "Creating code..."}
              </span>
              <button
                className="secondary-button compact"
                disabled={!selectedClassCode}
                type="button"
                onClick={copyStudentInviteLink}
              >
                {inviteLinkCopyStatus === "copied"
                  ? "Copied"
                  : inviteLinkCopyStatus === "failed"
                    ? "Copy failed"
                    : "Copy student invite link"}
              </button>
              <Link className="secondary-button compact" href={`/student?classId=${selectedClass.id}&preview=teacher`}>
                Student view
              </Link>
            </div>
          ) : null}
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        {selectedClass ? (
          <>
            {isLoadingClassDetails ? (
              <div className="empty-state detail-loading">
                <strong>Loading class details</strong>
                <span>Fetching roster and tutor knowledge.</span>
              </div>
            ) : null}

            <div className="tab-list" role="tablist" aria-label="Class editor sections">
              <button
                aria-selected={activeTab === "roster"}
                role="tab"
                type="button"
                onClick={() => setActiveTab("roster")}
              >
                Roster
              </button>
              <button
                aria-selected={activeTab === "settings"}
                role="tab"
                type="button"
                onClick={() => setActiveTab("settings")}
              >
                AI settings
              </button>
              <button
                aria-selected={activeTab === "knowledge"}
                role="tab"
                type="button"
                onClick={() => setActiveTab("knowledge")}
              >
                Tutor Knowledge
              </button>
            </div>

            {activeTab === "settings" ? (
              <form className="class-settings-form" key={selectedClass.id} onSubmit={submitSettings}>
              <div className="panel-heading compact-heading">
                <div>
                  <p className="eyebrow">AI behavior</p>
                  <h3>Guidance settings</h3>
                </div>
                <button className="secondary-button compact" disabled={isSavingSettings} type="submit">
                  {isSavingSettings ? "Saving" : "Save"}
                </button>
              </div>

              <label className="field-label" htmlFor="settings-name">
                Class name
              </label>
              <input
                id="settings-name"
                name="name"
                required
                defaultValue={selectedClass.name}
              />

              <label className="field-label" htmlFor="settings-section">
                Section
              </label>
              <input
                id="settings-section"
                name="section"
                required
                defaultValue={selectedClass.section}
              />

              <label className="field-label" htmlFor="behavior-title">
                Behavior preset
              </label>
              <input
                id="behavior-title"
                name="behaviorTitle"
                required
                defaultValue={selectedClass.behaviorTitle ?? "Guided problem solving"}
              />

              <label className="field-label" htmlFor="behavior-instructions">
                Hidden tutor instructions
              </label>
              <textarea
                id="behavior-instructions"
                name="behaviorInstructions"
                required
                rows={5}
                defaultValue={selectedClass.behaviorInstructions ?? ""}
              />

              <label className="field-label" htmlFor="refusal-style">
                Redirection style
              </label>
              <textarea
                id="refusal-style"
                name="refusalStyle"
                required
                rows={3}
                defaultValue={selectedClass.refusalStyle ?? ""}
              />
            </form>
            ) : null}

            {activeTab === "roster" ? (
              <div className="roster-editor">
                {selectedStudent ? (
                  <section className="professor-chat-review" aria-label="Professor conversation review">
                    <aside className="professor-chat-sidebar">
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => {
                          setSelectedStudentId("");
                          setSelectedStudentClassId(activeClassId);
                          setSelectedConversationId("");
                          setSelectedConversationClassId(activeClassId);
                          setStudentConversations([]);
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
                        {selectedConversation ? <span className="status muted">{formatConversationMeta(selectedConversation)}</span> : null}
                      </div>
                      <div className="message-list professor-message-list">
                        {activeSelectedConversationId && conversationMessages.length ? (
                          conversationMessages.map((message) => (
                            <article className={`message ${message.role}`} key={message.id}>
                              <div className="message-meta">{message.role === "student" ? selectedStudent.displayName : "Chandra"}</div>
                              <p>{message.content}</p>
                              {message.role === "assistant" && message.sources?.length ? (
                                <div className="message-sources" aria-label="Sources used">
                                  {message.sources.map((source, index) => (
                                    <span key={`${source.title}-${source.pageNumber ?? ""}-${source.problemNumber ?? ""}-${index}`}>
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
                  <>
                    <div className="panel-heading compact-heading">
                      <div>
                        <p className="eyebrow">Roster</p>
                        <h3>{students.length} students</h3>
                      </div>
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => setIsStudentDialogOpen(true)}
                      >
                        Add student
                      </button>
                    </div>

                    <div className="student-list">
                      {students.map((student) => (
                        <div className="student-row" key={student.id}>
                          <div>
                            <strong>{student.displayName}</strong>
                            <span>{student.email}</span>
                          </div>
                          <button
                            className="secondary-button compact"
                            type="button"
                            onClick={() => {
                              setSelectedStudentId(student.id);
                              setSelectedStudentClassId(activeClassId);
                              setSelectedConversationId("");
                              setSelectedConversationClassId(activeClassId);
                              setConversationMessages([]);
                            }}
                          >
                            View chats
                          </button>
                        </div>
                      ))}

                      {!students.length ? (
                        <div className="empty-state">
                          <strong>No students yet</strong>
                          <span>Add students by name and email.</span>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
            </div>
            ) : null}

            {activeTab === "knowledge" ? (
              <div className="materials-editor">
              <div className="panel-heading compact-heading">
                <div>
                  <p className="eyebrow">Tutor Knowledge</p>
                  <h3>{materials.length} sources</h3>
                </div>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => setIsKnowledgeDialogOpen(true)}
                >
                  Add knowledge
                </button>
              </div>

              {materialSuccess ? <p className="form-success">{materialSuccess}</p> : null}

              <div className="material-list">
                {materials.map((material) => (
                  <div className="material-row" key={material.id}>
                    <div>
                      <strong>{material.title}</strong>
                      <span>
                        {material.kind}
                        {material.fileName ? ` / ${material.fileName}` : ""}
                        {material.characterCount ? ` / ${material.characterCount.toLocaleString()} chars` : ""}
                        {material.chunkCount ? ` / ${material.chunkCount} knowledge chunks` : ""}
                      </span>
                    </div>
                    <div className="material-row-actions">
                      <span className="status muted">{material.status}</span>
                      <button
                        className="icon-text-button"
                        disabled={deletingMaterialId === material.id}
                        type="button"
                        onClick={() => deleteMaterial(material)}
                      >
                        {deletingMaterialId === material.id ? "Deleting" : "Delete"}
                      </button>
                    </div>
                  </div>
                ))}

                {!materials.length ? (
                  <div className="empty-state">
                    <strong>No tutor knowledge yet</strong>
                    <span>Add assignments, notes, readings, examples, or rubrics to ground the tutor.</span>
                  </div>
                ) : null}
              </div>
            </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <strong>Start with a class</strong>
            <span>Your editable roster, behavior settings, and tutor knowledge will appear here.</span>
          </div>
        )}
      </article>

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
    </section>
  );
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
