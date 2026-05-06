"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { useAuth } from "@/components/AuthProvider";
import { RequireAuth } from "@/components/RequireAuth";
import { apiUrl } from "@/lib/api-client";
import { signOutCurrentUser } from "@/lib/auth";
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
  | { errorCode?: string; errorId?: string; message: string; stage: string; type: "error" }
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
    <main className="student-workspace-page">
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { firebaseReady, profile, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
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
  const classSectionLabel = formatClassSectionLabel(classSection, Boolean(activeCourseId));
  const visibleClassCode = activeClass?.joinCode || activeClass?.id || activeCourseId;
  const pinnedTeacherInstructions = activeClass ? formatPinnedTeacherInstructions(activeClass.defaultAssignmentContext) : "";
  const visibleConversationSummaries = conversationSummaries.filter(
    (conversation) => conversation.classId === activeCourseId && conversation.studentId === user?.uid
  );
  const activeSelectedConversationId = selectedConversationClassId === activeCourseId ? selectedConversationId : "";
  const selectedConversation =
    visibleConversationSummaries.find((conversation) => conversation.id === activeSelectedConversationId) ?? null;
  const conversationTitle = selectedConversation?.title ?? "";
  const conversationMessageCount = selectedConversation?.messageCount ?? 0;
  const accountName = profile?.displayName ?? user?.displayName ?? "Student";
  const accountEmail = profile?.email ?? user?.email ?? "";

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

  function startNewConversation() {
    setSelectedConversationId("");
    setSelectedConversationClassId(activeCourseId);
    setMessages(initialMessages);
    setConversationMessagesError("");
  }

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth");
  }

  return (
    <RequireAuth role={isTeacherPreview ? ["student", "teacher"] : "student"}>
      <section className="student-workspace-shell">
        <aside className="student-workspace-sidebar" aria-label="Student workspace navigation">
          <div className="student-sidebar-scroll">
            <Link className="student-brand" href="/">
              <span className="student-wordmark">Chandra</span>
            </Link>

            <section className="student-sidebar-card student-current-class-card" aria-label="Current class">
              <p className="eyebrow">Current class</p>
              <h2>
                <span>{className}</span>
                {classSectionLabel ? <span>{classSectionLabel}</span> : null}
              </h2>
              {isLoadingClass ? <p className="sidebar-note">Loading class.</p> : null}
              {classLoadMessage ? <p className="form-error">{classLoadMessage}</p> : null}
              {isTeacherPreview ? (
                <Link className="student-sidebar-action" href="/teacher">
                  Back to dashboard
                </Link>
              ) : null}

              {profile?.role === "student" && !isTeacherPreview ? (
                <div className="student-class-code-display" aria-label="Class code">
                  <span>Class code</span>
                  <strong>{visibleClassCode || "No class joined"}</strong>
                </div>
              ) : null}
            </section>

            {profile?.role === "student" && !isTeacherPreview ? (
              <section className="student-sidebar-card student-conversation-history" aria-label="Saved conversations">
                <div className="sidebar-section-heading">
                  <p className="eyebrow">Conversations</p>
                  <button className="student-new-mini-button" type="button" onClick={startNewConversation}>
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
                      <span className="student-conversation-icon" aria-hidden="true" />
                      <span className="student-conversation-copy">
                        <strong>{conversation.title}</strong>
                        <span>{formatConversationMeta(conversation)}</span>
                      </span>
                      <span className="student-row-chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
                  {!visibleConversationSummaries.length && !conversationLoadError ? (
                    <p className="sidebar-note">No saved conversations.</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>

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
        </aside>

        <section className="student-workspace-main" aria-label="Student tutor chat">
          <header className="student-main-header">
            <div>
              <h1>
                <span>{className}</span>
                {classSectionLabel ? <span>{classSectionLabel}</span> : null}
              </h1>
            </div>
            <div className="student-status-actions" aria-label="Workspace status">
              <span className="student-status-pill">
                <span className="student-user-icon" aria-hidden="true" />
                Student
              </span>
              <span className="student-status-pill">
                <span className="student-connected-dot" aria-hidden="true" />
                Connected
              </span>
            </div>
          </header>

          {pinnedTeacherInstructions ? (
            <section className="student-teacher-instructions" aria-label="Teacher instructions">
              <div>
                <p className="eyebrow">Teacher instructions</p>
                <p>{pinnedTeacherInstructions}</p>
              </div>
            </section>
          ) : null}

          {selectedConversation ? (
            <section className="student-conversation-header" aria-label="Current conversation">
              <div>
                <h2>{conversationTitle}</h2>
                <p>{formatMessageCount(conversationMessageCount)}</p>
              </div>
            </section>
          ) : null}

          {conversationMessagesError ? <p className="form-error chat-error">{conversationMessagesError}</p> : null}
          <div className="message-list student-message-list">
            {messages.map((message) => (
              <article className={`student-workspace-message ${message.role === "student" ? "student" : "assistant"}`} key={message.id}>
                {message.role === "student" ? (
                  <div className="student-message-stack">
                    <div className="message-meta">You</div>
                    <div className="student-message-bubble">
                      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {normalizeMarkdownMath(message.content)}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="chandra-message-avatar" aria-hidden="true">
                      C
                    </span>
                    <div className="assistant-message-stack">
                      <div className="message-meta">Chandra</div>
                      <div className="assistant-message-bubble">
                        <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                          {normalizeMarkdownMath(message.content)}
                        </ReactMarkdown>
                      </div>
                      {message.sources?.length ? (
                        <div className="message-sources" aria-label="Sources used">
                          <strong>Sources:</strong>
                          {message.sources.map((source, index) => (
                            <span key={`${source.title}-${source.pageNumber ?? ""}-${source.problemNumber ?? ""}-${index}`}>
                              {formatSourceLabel(source)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </article>
            ))}
            {isSending && chatProgress ? <ChatProgressMessage progress={chatProgress} /> : null}
          </div>

          <form className="composer student-composer" onSubmit={sendMessage}>
            <textarea
              aria-label="Message Chandra"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={activeCourseId ? "Ask about a problem, step, or equation..." : "Join a class to start chatting."}
              rows={1}
            />
            <button className="student-send-button" type="submit" disabled={isSending || !draft.trim() || !activeCourseId}>
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

function formatMessageCount(count: number) {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

function formatClassSectionLabel(classSection: string, hasClass: boolean) {
  if (!hasClass || !classSection || classSection === "Enter your class code" || classSection === "Student chat") {
    return "";
  }

  return `Section ${classSection}`;
}

function formatPinnedTeacherInstructions(defaultAssignmentContext?: string) {
  const customInstructions = defaultAssignmentContext?.replace(/\s+/g, " ").trim();

  return customInstructions || "Show your work. Do not use decimals unless asked.";
}

function getInitials(name: string, email: string) {
  const source = name.trim() || email.trim();
  const parts = source
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);

  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2)).toUpperCase();
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
