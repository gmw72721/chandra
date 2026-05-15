"use client";

import { Fragment, type FormEvent, type ReactNode, useMemo, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/api-client";
import type {
  TeacherAssistantAction,
  TeacherAssistantChatHistoryMessage,
  TeacherAssistantResponse
} from "@/lib/teacher-assistant/types";
import { useAuth } from "./AuthProvider";
import { TeacherAssistantActionCard } from "./TeacherAssistantActionCard";

type LocalMessage = {
  actions?: TeacherAssistantAction[];
  content: string;
  id: string;
  role: "assistant" | "user";
};

export function TeacherAssistantWidget({
  classId,
  className
}: {
  classId: string;
  className?: string;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<LocalMessage[]>([
    {
      content: "Ask me to open a tab, summarize the dashboard, or review class follow-ups.",
      id: "welcome",
      role: "assistant"
    }
  ]);
  const title = useMemo(() => (className ? `Chandra assistant for ${className}` : "Chandra assistant"), [className]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();

    if (!message || isSending) {
      return;
    }

    setInput("");
    setError("");
    const nextMessages: LocalMessage[] = [
      ...messages,
      {
        content: message,
        id: `user-${Date.now()}`,
        role: "user"
      }
    ];
    setMessages(nextMessages);
    await sendAssistantRequest({ chatHistory: toAssistantChatHistory(messages), message });
  }

  async function sendAssistantRequest(inputBody: {
    chatHistory?: TeacherAssistantChatHistoryMessage[];
    confirmation?: {
      decision: "approved" | "rejected";
      pendingActionId: string;
    };
    message?: string;
  }) {
    if (!user) {
      setError("Sign in as a teacher to use the assistant.");
      return;
    }

    setIsSending(true);

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/teacher-assistant"), {
        body: JSON.stringify({
          classId,
          chatHistory: inputBody.chatHistory ?? toAssistantChatHistory(messages),
          confirmation: inputBody.confirmation,
          message: inputBody.message ?? "",
          sessionId
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      const data = (await response.json().catch(() => ({}))) as TeacherAssistantResponse & { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Teacher assistant request failed.");
      }

      setSessionId(data.sessionId);
      setMessages((currentMessages) => [
        ...currentMessages,
        ...data.messages.map((message, index) => ({
          actions: index === data.messages.length - 1 ? data.actions : undefined,
          content: message.content,
          id: `assistant-${Date.now()}-${index}`,
          role: "assistant" as const
        }))
      ]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Teacher assistant request failed.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <aside className="teacher-assistant-shell" aria-label={title}>
      {isOpen ? (
        <div className="teacher-assistant-panel">
          <header>
            <div>
              <strong>Chandra</strong>
              <span>Teacher assistant</span>
            </div>
            <button aria-label="Close teacher assistant" type="button" onClick={() => setIsOpen(false)}>
              ×
            </button>
          </header>

          <div className="teacher-assistant-messages" aria-live="polite">
            {messages.map((message) => (
              <article className={`teacher-assistant-message ${message.role}`} key={message.id}>
                {renderAssistantMessageContent(message.content)}
                {message.actions?.length ? (
                  <div className="teacher-assistant-action-list">
                    {message.actions.map((action) => (
                      <TeacherAssistantActionCard
                        action={action}
                        disabled={isSending}
                        key={teacherAssistantActionKey(action)}
                        onConfirm={(pendingActionId, decision) =>
                          void sendAssistantRequest({
                            confirmation: {
                              decision,
                              pendingActionId
                            }
                          })
                        }
                        onNavigate={(href) => {
                          router.push(href as Route);
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {error ? <p className="teacher-assistant-error">{error}</p> : null}
            {isSending ? <p className="teacher-assistant-status">Working...</p> : null}
          </div>

          <form className="teacher-assistant-form" onSubmit={submitMessage}>
            <input
              aria-label="Message Chandra teacher assistant"
              disabled={isSending}
              placeholder="Ask Chandra..."
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <button disabled={isSending || !input.trim()} type="submit">
              Send
            </button>
          </form>
        </div>
      ) : null}

      <button
        aria-expanded={isOpen}
        aria-label="Open teacher assistant"
        className="teacher-assistant-launcher"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        C
      </button>
    </aside>
  );
}

function toAssistantChatHistory(messages: LocalMessage[]): TeacherAssistantChatHistoryMessage[] {
  return messages
    .filter((message) => message.id !== "welcome")
    .slice(-10)
    .map((message) => ({
      content: message.content,
      role: message.role
    }));
}

function renderAssistantMessageContent(content: string) {
  const blocks = content.split(/\n{2,}/).filter((block) => block.trim());

  if (blocks.length === 0) {
    return null;
  }

  return blocks.map((block, index) => <p key={`${index}-${block.slice(0, 12)}`}>{renderInlineMarkdown(block)}</p>);
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(\*\*[^*]+?\*\*)/g;
  const tokens = text.split(tokenPattern);

  tokens.forEach((token, tokenIndex) => {
    if (!token) {
      return;
    }

    const content = token.startsWith("**") && token.endsWith("**") ? token.slice(2, -2) : token;
    const pieces = content.split(/\n/);

    pieces.forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) {
        nodes.push(<br key={`br-${tokenIndex}-${pieceIndex}`} />);
      }

      if (!piece) {
        return;
      }

      if (token.startsWith("**") && token.endsWith("**")) {
        nodes.push(<strong key={`strong-${tokenIndex}-${pieceIndex}`}>{piece}</strong>);
        return;
      }

      nodes.push(<Fragment key={`text-${tokenIndex}-${pieceIndex}`}>{piece}</Fragment>);
    });
  });

  return nodes;
}

function teacherAssistantActionKey(action: TeacherAssistantAction) {
  if (action.kind === "confirmation") {
    return action.pendingActionId;
  }

  if (action.kind === "navigate") {
    return `${action.kind}-${action.href}`;
  }

  return `${action.kind}-${action.toolName}-${action.summary}`;
}
