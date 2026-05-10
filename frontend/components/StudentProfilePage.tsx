"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api-client";
import { subscribeToClass, subscribeToClassStudents, type ClassStudent, type TeacherClass } from "@/lib/classes";
import { formatConversationDate } from "@/lib/display-format";
import type {
  StudentConversationSummary,
  StudentLearningProfileDocument,
  StudentRosterActivitySummary
} from "@/lib/types";
import { useAuth } from "./AuthProvider";
import { formatLearningProfileUpdateResult, StudentLearningProfileCard } from "./StudentLearningProfileCard";

type StudentProfileStats = {
  chatBlocked: boolean;
  conversationsLabel: string;
  lastActive: string;
  lastChatTopic: string;
  questionsPerDay: number;
  questionsToday: number;
  status: "Active" | "Inactive" | "No activity";
  statusTone: "active" | "inactive" | "none";
  teacherNotes: string;
  totalQuestions: number;
};

const emptyStats: StudentProfileStats = {
  chatBlocked: false,
  conversationsLabel: "0 conversations",
  lastActive: "Never",
  lastChatTopic: "No saved topic",
  questionsPerDay: 0,
  questionsToday: 0,
  status: "No activity",
  statusTone: "none",
  teacherNotes: "",
  totalQuestions: 0
};

export function StudentProfilePage({
  classId,
  embedded = false,
  studentId
}: {
  classId: string;
  embedded?: boolean;
  studentId: string;
}) {
  const decodedStudentId = decodeURIComponent(studentId).trim().toLowerCase();
  const { user } = useAuth();
  const [teacherClass, setTeacherClass] = useState<TeacherClass | null>(null);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [rosterActivity, setRosterActivity] = useState<StudentRosterActivitySummary[]>([]);
  const [conversations, setConversations] = useState<StudentConversationSummary[]>([]);
  const [learningProfile, setLearningProfile] = useState<StudentLearningProfileDocument | null>(null);
  const [teacherNotes, setTeacherNotes] = useState("");
  const [error, setError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingLearningProfileAction, setSavingLearningProfileAction] = useState("");
  const [learningProfileStatusMessage, setLearningProfileStatusMessage] = useState("");
  const [canForceLearningProfileUpdate, setCanForceLearningProfileUpdate] = useState(false);

  const student = useMemo(
    () =>
      students.find((rosterStudent) => rosterStudent.email.trim().toLowerCase() === decodedStudentId) ??
      students.find((rosterStudent) => rosterStudent.id === studentId || rosterStudent.id === encodeURIComponent(decodedStudentId)) ??
      null,
    [decodedStudentId, studentId, students]
  );
  const activity = useMemo(
    () => rosterActivity.find((row) => row.studentEmail.trim().toLowerCase() === decodedStudentId) ?? null,
    [decodedStudentId, rosterActivity]
  );
  const stats = useMemo(() => buildStudentProfileStats(activity), [activity]);
  const displayName = student?.displayName || activity?.displayName || decodedStudentId || "Student";
  const email = student?.email || activity?.studentEmail || decodedStudentId;
  const rosterHref = { pathname: "/teacher", query: { classId, student: email, tab: "roster" } };
  const conversationsHref = { pathname: "/teacher", query: { classId, student: email, tab: "conversations" } };

  useEffect(() => {
    if (!classId) {
      return () => {};
    }

    const unsubscribeClass = subscribeToClass(
      classId,
      setTeacherClass,
      (caughtError) => setError(formatProfileError(caughtError, "Class load failed."))
    );
    const unsubscribeStudents = subscribeToClassStudents(
      classId,
      setStudents,
      (caughtError) => setError(formatProfileError(caughtError, "Roster load failed."))
    );

    return () => {
      unsubscribeClass();
      unsubscribeStudents();
    };
  }, [classId]);

  useEffect(() => {
    if (!user || !classId) {
      return;
    }

    let isCancelled = false;

    async function loadStudentProfileData() {
      try {
        const token = await user!.getIdToken();
        const encodedClassId = encodeURIComponent(classId);
        const encodedStudentEmail = encodeURIComponent(decodedStudentId);
        const [activityResponse, conversationsResponse, profileResponse] = await Promise.all([
          fetch(apiUrl(`/api/classes/${encodedClassId}/roster/activity`), {
            headers: { Authorization: `Bearer ${token}` }
          }),
          fetch(apiUrl(`/api/classes/${encodedClassId}/students/${encodedStudentEmail}/conversations`), {
            headers: { Authorization: `Bearer ${token}` }
          }),
          fetch(apiUrl(`/api/classes/${encodedClassId}/students/${encodedStudentEmail}/learning-profile`), {
            headers: { Authorization: `Bearer ${token}` }
          })
        ]);
        const activityData = (await activityResponse.json()) as {
          activity?: StudentRosterActivitySummary[];
          error?: string;
        };
        const conversationsData = (await conversationsResponse.json()) as {
          conversations?: StudentConversationSummary[];
          error?: string;
        };
        const profileData = (await profileResponse.json()) as {
          profile?: StudentLearningProfileDocument | null;
          error?: string;
        };

        if (!activityResponse.ok) {
          throw new Error(activityData.error ?? "Roster activity load failed.");
        }

        if (!conversationsResponse.ok) {
          throw new Error(conversationsData.error ?? "Conversation load failed.");
        }

        if (!profileResponse.ok) {
          throw new Error(profileData.error ?? "Learning profile load failed.");
        }

        if (!isCancelled) {
          setRosterActivity(activityData.activity ?? []);
          setConversations(conversationsData.conversations ?? []);
          setLearningProfile(profileData.profile ?? null);
          setLearningProfileStatusMessage("");
          setCanForceLearningProfileUpdate(false);
          setError("");
          setConversationError("");
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setConversationError(formatProfileError(caughtError, "Student profile load failed."));
        }
      }
    }

    void loadStudentProfileData();
  }, [classId, decodedStudentId, user]);

  useEffect(() => {
    const syncNotesTimer = window.setTimeout(() => {
      setTeacherNotes(activity?.teacherNotes ?? "");
    }, 0);

    return () => window.clearTimeout(syncNotesTimer);
  }, [activity?.teacherNotes, decodedStudentId]);

  async function saveTeacherNotes(options: { chatBlocked?: boolean } = {}) {
    if (!user || savingNotes) {
      return;
    }

    setSavingNotes(true);
    setError("");

    try {
      const token = await user.getIdToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(classId)}/students/${encodeURIComponent(decodedStudentId)}/support`
        ),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ chatBlocked: options.chatBlocked ?? stats.chatBlocked, teacherNotes })
        }
      );
      const data = (await response.json()) as { chatBlocked?: boolean; teacherNotes?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Student notes save failed.");
      }

      const savedNotes = data.teacherNotes ?? teacherNotes;
      setTeacherNotes(savedNotes);
      setRosterActivity((currentActivity) =>
        currentActivity.map((row) =>
          row.studentEmail.trim().toLowerCase() === decodedStudentId
            ? { ...row, chatBlocked: data.chatBlocked ?? options.chatBlocked ?? stats.chatBlocked, teacherNotes: savedNotes }
            : row
        )
      );
    } catch (caughtError) {
      setError(formatProfileError(caughtError, "Student notes save failed."));
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveLearningProfileAction(action: "approve" | "disable" | "clearDraft" | "clear") {
    if (!user || savingLearningProfileAction) {
      return;
    }

    setSavingLearningProfileAction(action);
    setError("");

    try {
      const token = await user.getIdToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(classId)}/students/${encodeURIComponent(decodedStudentId)}/learning-profile`
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

      setLearningProfile(data.profile ?? null);
    } catch (caughtError) {
      setError(formatProfileError(caughtError, "Learning profile save failed."));
    } finally {
      setSavingLearningProfileAction("");
    }
  }

  async function updateLearningProfileNow(forceLastSevenDays = false) {
    if (!user || savingLearningProfileAction) {
      return;
    }

    setSavingLearningProfileAction("update");
    setError("");
    setLearningProfileStatusMessage("");
    setCanForceLearningProfileUpdate(false);

    try {
      const token = await user.getIdToken();
      const response = await fetch(
        apiUrl(
          `/api/classes/${encodeURIComponent(classId)}/students/${encodeURIComponent(decodedStudentId)}/learning-profile`
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

      setLearningProfile(data.profile ?? null);
      setLearningProfileStatusMessage(formatLearningProfileUpdateResult(data.result, forceLastSevenDays));
      setCanForceLearningProfileUpdate(!forceLastSevenDays && data.result?.reason === "below_threshold");
    } catch (caughtError) {
      setError(formatProfileError(caughtError, "Learning profile update failed."));
    } finally {
      setSavingLearningProfileAction("");
    }
  }

  return (
    <section className={`student-profile-shell${embedded ? " embedded" : ""}`} aria-label="Student profile">
      <header className="student-profile-header">
        <div>
          <p className="conversation-breadcrumb">Roster / Student Profile</p>
          <h1>{displayName}</h1>
          <p>{email}</p>
          {teacherClass ? (
            <span className="student-profile-class-context">
              {teacherClass.name}
              {teacherClass.section ? ` / ${teacherClass.section}` : ""}
            </span>
          ) : null}
        </div>
        <div className="student-profile-header-actions">
          <Link className="secondary-button" href={rosterHref}>
            Back to roster
          </Link>
          <Link className="primary-button teacher-primary-button compact" href={conversationsHref}>
            View conversations
          </Link>
        </div>
      </header>

      {error ? <p className="form-error teacher-alert">{error}</p> : null}
      {conversationError ? <p className="form-error teacher-alert">{conversationError}</p> : null}

      <div className="student-profile-grid">
        <section className="student-detail-card student-profile-summary-card">
          <div className="student-detail-card-heading">
            <h4>Activity stats</h4>
            <span className={`roster-status-pill ${stats.statusTone}`}>{stats.status}</span>
          </div>
          <dl>
            <div>
              <dt>Last active</dt>
              <dd>{stats.lastActive}</dd>
            </div>
            <div>
              <dt>Questions/day</dt>
              <dd>{formatStatNumber(stats.questionsPerDay)}</dd>
            </div>
            <div>
              <dt>Today&apos;s activity</dt>
              <dd>{formatQuestionCount(stats.questionsToday)}</dd>
            </div>
            <div>
              <dt>Total questions</dt>
              <dd>{formatQuestionCount(stats.totalQuestions)}</dd>
            </div>
            <div>
              <dt>Conversations</dt>
              <dd>{stats.conversationsLabel}</dd>
            </div>
            <div>
              <dt>Last chat topic</dt>
              <dd>{stats.lastChatTopic}</dd>
            </div>
          </dl>
        </section>

        <section className="student-detail-card student-profile-conversations-card">
          <div className="student-detail-card-heading">
            <h4>Recent conversations</h4>
            <Link href={conversationsHref}>View all</Link>
          </div>
          <div className="student-recent-list">
            {(conversations.length ? conversations : placeholderConversations()).slice(0, 6).map((conversation) => (
              <article className="student-recent-row student-profile-conversation-row" key={conversation.id}>
                <span>{conversation.title}</span>
                <time>{formatConversationMeta(conversation)}</time>
              </article>
            ))}
          </div>
        </section>

        <div className="student-profile-learning-column">
          <StudentLearningProfileCard
            canForceUpdate={canForceLearningProfileUpdate}
            isSavingAction={savingLearningProfileAction}
            statusMessage={learningProfileStatusMessage}
            profile={learningProfile}
            onApprove={() => void saveLearningProfileAction("approve")}
            onClearDraft={() => void saveLearningProfileAction("clearDraft")}
            onDisable={() => void saveLearningProfileAction("disable")}
            onUpdateNow={() => void updateLearningProfileNow()}
            onForceSevenDays={() => void updateLearningProfileNow(true)}
          />
        </div>

        <section className="student-detail-card student-profile-notes-card">
          <div className="student-detail-card-heading">
            <h4>Private teacher notes</h4>
            <span>Private to you</span>
          </div>
          <label className="settings-choice-pill">
            <input
              checked={stats.chatBlocked}
              type="checkbox"
              onChange={(event) => {
                const chatBlocked = event.target.checked;
                setRosterActivity((currentActivity) =>
                  currentActivity.map((row) =>
                    row.studentEmail.trim().toLowerCase() === decodedStudentId
                      ? { ...row, chatBlocked }
                      : row
                  )
                );
                void saveTeacherNotes({ chatBlocked });
              }}
            />
            <span>{stats.chatBlocked ? "Student chat paused" : "Student chat allowed"}</span>
          </label>
          <textarea
            aria-label={`Private teacher notes for ${displayName}`}
            maxLength={1000}
            rows={8}
            value={teacherNotes}
            onBlur={() => void saveTeacherNotes()}
            onChange={(event) => setTeacherNotes(event.target.value)}
          />
          <span className="student-note-count">
            {teacherNotes.length} / 1000{savingNotes ? " / saving" : ""}
          </span>
        </section>

        <section className="student-detail-card student-profile-actions-card">
          <h4>Quick access</h4>
          <div className="student-quick-actions">
            <Link href={conversationsHref}>Open conversation review</Link>
            <Link href={rosterHref}>Return to roster row</Link>
          </div>
        </section>
      </div>
    </section>
  );
}

function buildStudentProfileStats(activity: StudentRosterActivitySummary | null): StudentProfileStats {
  if (!activity) {
    return emptyStats;
  }

  const status = activityStatusLabel(activity.status);

  return {
    chatBlocked: activity.chatBlocked,
    conversationsLabel: formatConversationCount(activity.conversationCount),
    lastActive: formatConversationDate(activity.lastActiveAt) || "Never",
    lastChatTopic: activity.lastChatTopic || "No saved topic",
    questionsPerDay: activity.questionsPerDay,
    questionsToday: activity.questionsToday,
    status,
    statusTone: status === "Active" ? "active" : status === "Inactive" ? "inactive" : "none",
    teacherNotes: activity.teacherNotes,
    totalQuestions: activity.totalQuestions
  };
}

function placeholderConversations(): StudentConversationSummary[] {
  return [
    {
      classId: "",
      createdAt: "",
      id: "empty",
      lastMessageAt: "",
      messageCount: 0,
      modelId: "",
      studentEmail: "",
      studentId: "",
      studentName: "",
      teacherId: "",
      title: "No recent conversations",
      updatedAt: ""
    }
  ];
}

function activityStatusLabel(status: StudentRosterActivitySummary["status"]): StudentProfileStats["status"] {
  if (status === "active") {
    return "Active";
  }

  if (status === "inactive") {
    return "Inactive";
  }

  return "No activity";
}

function formatConversationMeta(conversation: StudentConversationSummary) {
  return [`${conversation.messageCount} messages`, formatConversationDate(conversation.lastMessageAt)]
    .filter(Boolean)
    .join(" / ");
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

function formatProfileError(caughtError: unknown, fallback: string) {
  return caughtError instanceof Error ? caughtError.message : fallback;
}
