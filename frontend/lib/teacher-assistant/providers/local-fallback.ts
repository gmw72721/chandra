import type { AssistantEvent, AssistantTurnInput, TeacherAssistantProvider } from "../types.ts";

export function createLocalFallbackProvider(): TeacherAssistantProvider {
  return {
    async *send(input: AssistantTurnInput): AsyncIterable<AssistantEvent> {
      const message = input.message.trim();
      const contextualMessage = resolveContextualMessage(input, message);
      const lowerMessage = contextualMessage.toLowerCase();

      if (!input.runTool) {
        yield {
          content: "Teacher assistant tools are not available in this runtime.",
          type: "message"
        };
        return;
      }

      if (!message) {
        yield {
          content: "Ask me to open a dashboard tab, summarize the class, or check the review queue.",
          type: "message"
        };
        return;
      }

      const studentSearch = studentSearchFromMessage(contextualMessage);
      if (studentSearch) {
        return yield* runLocalTool(input, "search_students", { classId: input.classId, query: studentSearch });
      }

      const materialSearch = materialSearchFromMessage(contextualMessage);
      if (materialSearch) {
        return yield* runLocalTool(input, "search_materials", { classId: input.classId, query: materialSearch });
      }

      const toolRequest = inferLocalTeacherAssistantToolRequest(lowerMessage, input.classId);

      if (toolRequest) {
        return yield* runLocalTool(input, toolRequest.toolName, toolRequest.args);
      }

      yield {
        content:
          "I can open teacher tabs, summarize this class, show the review queue, and prepare notification setting changes for confirmation.",
        type: "message"
      };
    }
  };
}

function resolveContextualMessage(input: AssistantTurnInput, message: string) {
  const lowerMessage = message.toLowerCase();
  const needsPriorRequest =
    lowerMessage.includes("what i told") ||
    lowerMessage.includes("what i asked") ||
    lowerMessage.includes("do that") ||
    lowerMessage.includes("try again");

  if (!needsPriorRequest) {
    return message;
  }

  const previousUserMessage = [...(input.chatHistory ?? [])]
    .reverse()
    .find((historyMessage) => historyMessage.role === "user" && historyMessage.content.trim() !== message)?.content;

  return previousUserMessage?.trim() || message;
}

async function* runLocalTool(input: AssistantTurnInput, toolName: string, args: Record<string, unknown>) {
  const result = await input.runTool!(toolName, args);
  if (result.action) {
    yield { action: result.action, type: "action" } as const;
  }
  yield {
    content: result.content ?? result.summary,
    type: "message"
  } as const;
}

export function inferLocalTeacherAssistantToolRequest(message: string, classId: string) {
  if (message.includes("review queue") || message.includes("needs review")) {
    return {
      args: { classId },
      toolName: "get_review_queue"
    };
  }

  if (message.includes("class settings")) {
    return {
      args: { classId },
      toolName: "get_class_settings"
    };
  }

  if (message.includes("tutor settings")) {
    return {
      args: { classId },
      toolName: "get_tutor_settings"
    };
  }

  if (message.includes("class material") || message.includes("materials list") || message.includes("all materials")) {
    return {
      args: { classId },
      toolName: "get_class_materials"
    };
  }

  if (message.includes("summary") || message.includes("summarize") || message.includes("overview")) {
    if (message.includes("open") || message.includes("go to") || message.includes("navigate")) {
      return {
        args: { classId, tab: "overview" },
        toolName: "navigate_teacher_tab"
      };
    }

    return {
      args: { classId },
      toolName: "get_teacher_dashboard_summary"
    };
  }

  const tab = tabFromMessage(message);
  if (tab) {
    return {
      args: { classId, tab },
      toolName: "navigate_teacher_tab"
    };
  }

  const settingsPane = settingsPaneFromMessage(message);
  if (settingsPane) {
    return {
      args: { classId, pane: settingsPane },
      toolName: "navigate_settings_pane"
    };
  }

  const sourceSection = sourceSectionFromMessage(message);
  if (sourceSection) {
    return {
      args: { classId, section: sourceSection },
      toolName: "navigate_sources_section"
    };
  }

  const aiTutorSection = aiTutorSectionFromMessage(message);
  if (aiTutorSection) {
    return {
      args: { classId, section: aiTutorSection },
      toolName: "navigate_ai_tutor_section"
    };
  }

  const notificationPatch = notificationPatchFromMessage(message);
  if (notificationPatch) {
    return {
      args: { classId, patch: notificationPatch },
      toolName: "update_notification_settings"
    };
  }

  const tutorAccessPatch = tutorAccessPatchFromMessage(message);
  if (tutorAccessPatch) {
    return {
      args: { classId, patch: tutorAccessPatch },
      toolName: "update_tutor_access_settings"
    };
  }

  return null;
}

function tabFromMessage(message: string) {
  if (message.includes("roster") || message.includes("student list") || message.includes("students tab")) {
    return "roster";
  }
  if (message.includes("problem")) {
    return "problems";
  }
  if (message.includes("conversation") || message.includes("chat review")) {
    return "conversations";
  }
  if (message.includes("source") || message.includes("material")) {
    return "sources";
  }
  if (message.includes("ai tutor") || message.includes("tutor settings")) {
    return "knowledge";
  }
  if (message.includes("settings")) {
    return "settings";
  }
  return "";
}

function settingsPaneFromMessage(message: string) {
  if (!message.includes("settings") && !message.includes("pane")) {
    return "";
  }
  if (message.includes("people") || message.includes("access") || message.includes("staff")) {
    return "classAccess";
  }
  if (message.includes("privacy") || message.includes("data retention")) {
    return "privacy";
  }
  if (message.includes("notification")) {
    return "notifications";
  }
  if (message.includes("usage") || message.includes("limit")) {
    return "usage";
  }
  if (message.includes("account")) {
    return "account";
  }
  if (message.includes("appearance") || message.includes("theme")) {
    return "appearance";
  }
  if (message.includes("class detail") || message.includes("general")) {
    return "general";
  }
  return "";
}

function sourceSectionFromMessage(message: string) {
  if (!message.includes("source")) {
    return "";
  }
  if (message.includes("setting") || message.includes("default")) {
    return "sourceSettings";
  }
  return "sources";
}

function aiTutorSectionFromMessage(message: string) {
  if (!message.includes("tutor") && !message.includes("chandra")) {
    return "";
  }
  if (message.includes("access")) {
    return "access";
  }
  if (message.includes("mode")) {
    return "tutorMode";
  }
  if (message.includes("voice") || message.includes("detail")) {
    return "voiceDetail";
  }
  if (message.includes("rule") || message.includes("answer")) {
    return "helpRules";
  }
  if (message.includes("instruction")) {
    return "classInstructions";
  }
  if (message.includes("model") || message.includes("advanced")) {
    return "model";
  }
  return "";
}

function notificationPatchFromMessage(message: string) {
  if (!message.includes("notification") && !message.includes("digest") && !message.includes("reminder")) {
    return null;
  }

  const enabled = message.includes("enable") || message.includes("turn on") || message.includes("start");
  const disabled = message.includes("disable") || message.includes("turn off") || message.includes("stop");

  if (!enabled && !disabled) {
    return null;
  }

  const value = enabled;
  const patch: Record<string, boolean> = {};

  if (message.includes("weekly") || message.includes("digest")) {
    patch.weeklyDigest = value;
  }
  if (message.includes("follow-up") || message.includes("follow up") || message.includes("reminder")) {
    patch.followUpReminders = value;
  }
  if (message.includes("new student") || message.includes("joined")) {
    patch.newStudentJoinedClass = value;
  }

  return Object.keys(patch).length ? patch : null;
}

function tutorAccessPatchFromMessage(message: string) {
  if (!message.includes("tutor") && !message.includes("chat")) {
    return null;
  }

  if (message.includes("pause") || message.includes("disable") || message.includes("turn off")) {
    return { enabled: false };
  }

  if (message.includes("enable") || message.includes("turn on") || message.includes("allow")) {
    return { enabled: true };
  }

  return null;
}

function studentSearchFromMessage(message: string) {
  const match = message.match(/\b(?:find|search|look up)\s+(?:student|roster)?\s*([^?.!]+)/i);
  return match?.[1]?.trim() ?? "";
}

function materialSearchFromMessage(message: string) {
  const match = message.match(/\b(?:find|search|look up)\s+(?:material|source|pdf|document)?\s*([^?.!]+)/i);
  const candidate = match?.[1]?.trim() ?? "";
  return /\b(material|source|pdf|document|worksheet|homework|textbook|notes)\b/i.test(message) ? candidate : "";
}
