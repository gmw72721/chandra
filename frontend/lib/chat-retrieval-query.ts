import type { ChatMessage, TutorSource } from "./types";

type RetrievalQueryMessage = Pick<ChatMessage, "content" | "role"> & {
  sources?: TutorSource[];
};

const retrievalConversationMessageLimit = 6;
const retrievalMessageCharacterLimit = 900;

export function getLatestStudentQuestion(messages: RetrievalQueryMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "student") {
      return message.content.trim();
    }
  }

  return "";
}

export function buildChatRetrievalQuery(messages: RetrievalQueryMessage[]) {
  const recentSourceHints = getRecentSourceHints(messages);
  const recentMessages: string[] = [];
  let selectedMessageCount = 0;

  for (
    let index = messages.length - 1;
    index >= 0 && selectedMessageCount < retrievalConversationMessageLimit;
    index -= 1
  ) {
    const message = messages[index];

    if (message?.role !== "student" && message?.role !== "assistant") {
      continue;
    }

    selectedMessageCount += 1;

    const content = truncateForRetrieval(message.content.trim());

    if (content) {
      recentMessages.push(content);
    }
  }

  const conversationQuery = recentMessages.reverse().join("\n\n");

  return [
    recentSourceHints.length
      ? `Previously used source context: ${recentSourceHints.map(formatSourceHint).join("; ")}`
      : "",
    conversationQuery
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function getRecentSourceHints(messages: RetrievalQueryMessage[]) {
  const sourceHints: TutorSource[] = [];

  for (let index = messages.length - 1; index >= 0 && sourceHints.length < 4; index -= 1) {
    const message = messages[index];

    if (message?.role !== "assistant" || !message.sources?.length) {
      continue;
    }

    for (const source of message.sources) {
      sourceHints.push(source);

      if (sourceHints.length >= 4) {
        break;
      }
    }
  }

  return sourceHints;
}

function formatSourceHint(source: TutorSource) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `page ${source.pageNumber}` : ""
  ]
    .filter(Boolean)
    .join(", ");
}

function truncateForRetrieval(content: string) {
  if (content.length <= retrievalMessageCharacterLimit) {
    return content;
  }

  return content.slice(0, retrievalMessageCharacterLimit).trim();
}
