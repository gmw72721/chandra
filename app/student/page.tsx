"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { useAuth } from "@/components/AuthProvider";
import { AuthNav } from "@/components/AuthNav";
import { RequireAuth } from "@/components/RequireAuth";
import { apiUrl } from "@/lib/api-client";
import { updateStudentClass } from "@/lib/auth";
import { CLASS_CODE_LENGTH, formatClassCodeInput } from "@/lib/class-code";
import { subscribeToClass, type TeacherClass } from "@/lib/classes";
import type { ChatMessage, StudentConversationSummary, TutorApiResponse } from "@/lib/types";

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
  | { message: string; stage: string; type: "error" }
  | { payload: TutorApiResponse; type: "final" };

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Hi. I can help you work through the assignment step by step. What problem are you on?",
    createdAt: new Date().toISOString()
  }
];

export default function StudentPage() {
  return (
    <main className="shell chat-shell">
      <nav className="topbar">
        <Link className="brand" href="/">
          Chandra
        </Link>
        <AuthNav />
      </nav>

      <Suspense
        fallback={
          <section className="auth-state-panel">
            <p className="eyebrow">Loading</p>
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
  const searchParams = useSearchParams();
  const { firebaseReady, profile, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
  const [isSavingClassCode, setIsSavingClassCode] = useState(false);
  const [classCodeError, setClassCodeError] = useState("");
  const [classCodeMessage, setClassCodeMessage] = useState("");
  const [classLoadError, setClassLoadError] = useState<{ classId: string; message: string } | null>(null);
  const [loadedClassId, setLoadedClassId] = useState("");
  const [savedClass, setSavedClass] = useState<TeacherClass | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState("");
  const [conversationMessagesError, setConversationMessagesError] = useState("");
  const [conversationSummaries, setConversationSummaries] = useState<StudentConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
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
    if (!firebaseReady || !activeCourseId) {
      return () => {};
    }

    return subscribeToClass(
      activeCourseId,
      (nextClass) => {
        setSavedClass(nextClass);
        setLoadedClassId(activeCourseId);
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
  }, [activeCourseId, firebaseReady]);

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

  const activeClass = savedClass?.id === activeCourseId ? savedClass : null;
  const className = activeClass?.name ?? (activeCourseId ? "Saved class" : "Class needed");
  const classSection = activeClass?.section ?? (activeCourseId ? "Student chat" : "Enter your class code");
  const visibleConversationSummaries = conversationSummaries.filter(
    (conversation) => conversation.classId === activeCourseId && conversation.studentId === user?.uid
  );
  const activeSelectedConversationId = selectedConversationClassId === activeCourseId ? selectedConversationId : "";

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !activeSelectedConversationId || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) =>
        fetchStudentConversationMessages({
          classId: activeCourseId,
          conversationId: activeSelectedConversationId,
          token
        })
      )
      .then((savedMessages) => {
        if (!isCancelled) {
          setMessages(savedMessages.length ? savedMessages : initialMessages);
          setConversationMessagesError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setConversationMessagesError(describeStudentConversationMessageError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, activeSelectedConversationId, firebaseReady, user]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();

    if (!content || isSending) {
      return;
    }

    if (!user) {
      return;
    }

    const studentMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "student",
      content,
      createdAt: new Date().toISOString()
    };

    const nextMessages = [...messages, studentMessage];
    setMessages(nextMessages);
    setDraft("");
    setIsSending(true);
    setChatProgress({
      message: "Getting ready.",
      searches: []
    });

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversationId: activeSelectedConversationId || undefined,
          courseId: activeCourseId,
          messages: nextMessages,
          stream: true
        })
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
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

      try {
        setConversationSummaries(await fetchStudentConversationSummaries({ classId: activeCourseId, token }));
        setConversationLoadError("");
      } catch (caughtError) {
        setConversationLoadError(describeStudentConversationLoadError(caughtError));
      }

      setMessages((current) => [
        ...current,
        {
          id: data.assistantMessageId ?? crypto.randomUUID(),
          role: "assistant",
          content: data.message ?? data.content ?? "I could not generate a response.",
          createdAt: new Date().toISOString(),
          langGraphTrace: data.langGraphTrace,
          sources: data.sources ?? []
        }
      ]);
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
      setIsSending(false);
      setChatProgress(null);
    }
  }

  async function submitClassCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    setClassCodeError("");
    setClassCodeMessage("");
    setIsSavingClassCode(true);

    try {
      await updateStudentClass({
        classId: String(formData.get("classCode") ?? ""),
        uid: user.uid
      });
      setClassCodeMessage("Class saved.");
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Class save failed.";
      setClassCodeError(
        message.toLowerCase().includes("permission")
          ? "Class code was not found, or you do not have permission to join it."
          : message
      );
    } finally {
      setIsSavingClassCode(false);
    }
  }

  function startNewConversation() {
    setSelectedConversationId("");
    setSelectedConversationClassId(activeCourseId);
    setMessages(initialMessages);
    setConversationMessagesError("");
  }

  return (
    <RequireAuth role={isTeacherPreview ? ["student", "teacher"] : "student"}>
      <section className="chat-layout">
        <aside className="student-sidebar">
          <p className="eyebrow">{isTeacherPreview ? "Student view" : className}</p>
          <h1>{classSection}</h1>
          {isLoadingClass ? <p className="sidebar-note">Loading class.</p> : null}
          {classLoadMessage ? <p className="form-error">{classLoadMessage}</p> : null}
          {isTeacherPreview ? (
            <Link className="secondary-button preview-exit" href="/teacher">
              Back to dashboard
            </Link>
          ) : null}

          {profile?.role === "student" && !isTeacherPreview ? (
            <form className="student-class-form" key={profile.classId ?? "no-class"} onSubmit={submitClassCode}>
              <label className="field-label" htmlFor="student-class-code">
                Class code
              </label>
              <div>
                <input
                  id="student-class-code"
                  name="classCode"
                  defaultValue=""
                  maxLength={CLASS_CODE_LENGTH}
                  onChange={(event) => {
                    event.currentTarget.value = formatClassCodeInput(event.currentTarget.value);
                  }}
                  placeholder="ABCDEF"
                />
                <button className="secondary-button compact" disabled={isSavingClassCode} type="submit">
                  {isSavingClassCode ? "Saving" : "Save"}
                </button>
              </div>
              {classCodeError ? <p className="form-error">{classCodeError}</p> : null}
              {classCodeMessage ? <p className="form-success">{classCodeMessage}</p> : null}
            </form>
          ) : null}

          {profile?.role === "student" && !isTeacherPreview && activeCourseId ? (
            <section className="student-conversation-history" aria-label="Saved conversations">
              <div className="sidebar-section-heading">
                <strong>Conversations</strong>
                <button className="secondary-button compact" type="button" onClick={startNewConversation}>
                  New
                </button>
              </div>
              {conversationLoadError ? <p className="form-error">{conversationLoadError}</p> : null}
              <div className="student-conversation-list">
                {visibleConversationSummaries.map((conversation) => (
                  <button
                    aria-pressed={conversation.id === activeSelectedConversationId}
                    className="student-conversation-row"
                    key={conversation.id}
                    type="button"
                    onClick={() => {
                      setSelectedConversationId(conversation.id);
                      setSelectedConversationClassId(activeCourseId);
                    }}
                  >
                    <strong>{conversation.title}</strong>
                    <span>{formatConversationMeta(conversation)}</span>
                  </button>
                ))}
                {!visibleConversationSummaries.length && !conversationLoadError ? (
                  <p className="sidebar-note">No saved conversations.</p>
                ) : null}
              </div>
            </section>
          ) : null}
        </aside>

        <section className="chat-panel" aria-label="Student tutor chat">
          {conversationMessagesError ? <p className="form-error chat-error">{conversationMessagesError}</p> : null}
          <div className="message-list">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-meta">{message.role === "student" ? "You" : "Chandra"}</div>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {normalizeMarkdownMath(message.content)}
                </ReactMarkdown>
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
            ))}
            {isSending && chatProgress ? <ChatProgressMessage progress={chatProgress} /> : null}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <textarea
              aria-label="Message Chandra"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={activeCourseId ? "Ask about a problem, step, or equation..." : "Save your class code to start chatting."}
              rows={3}
            />
            <button type="submit" disabled={isSending || !draft.trim() || !activeCourseId}>
              {isSending ? "Sending" : "Send"}
            </button>
          </form>
        </section>
      </section>
    </RequireAuth>
  );
}

function ChatProgressMessage({ progress }: { progress: ChatProgress }) {
  return (
    <article className="message assistant progress-message" aria-live="polite">
      <div className="message-meta">Chandra</div>
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
    </article>
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
  token
}: {
  classId: string;
  conversationId: string;
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
      }
    }
  );
  const data = (await response.json()) as { messages?: ChatMessage[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Conversation messages failed to load.");
  }

  return data.messages ?? [];
}

function describeStudentConversationLoadError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Saved conversations failed to load.";
}

function describeStudentConversationMessageError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Conversation messages failed to load.";
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

function formatSourceLabel(source: NonNullable<ChatMessage["sources"]>[number]) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ].filter(Boolean).join(" · ");
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

function normalizeMarkdownMath(content: string) {
  return content
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/^\[\s*(\\(?:int|frac|sqrt|sum|lim|prod)[\s\S]*?)\s*\]$/gm, "$$$$\n$1\n$$$$");
}
