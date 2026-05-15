import type { AssistantEvent, AssistantTurnInput, TeacherAssistantProvider } from "../types.ts";

export function createLocalFallbackProvider(): TeacherAssistantProvider {
  return {
    async *send(input: AssistantTurnInput): AsyncIterable<AssistantEvent> {
      const message = input.message.trim();
      const lowerMessage = message.toLowerCase();

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

      const toolRequest = inferLocalToolRequest(lowerMessage, input.classId);

      if (toolRequest) {
        const result = await input.runTool(toolRequest.toolName, toolRequest.args);
        if (result.action) {
          yield { action: result.action, type: "action" };
        }
        yield {
          content: result.content ?? result.summary,
          type: "message"
        };
        return;
      }

      yield {
        content:
          "I can open teacher tabs, summarize this class, show the review queue, and prepare notification setting changes for confirmation.",
        type: "message"
      };
    }
  };
}

function inferLocalToolRequest(message: string, classId: string) {
  if (message.includes("review queue") || message.includes("needs review")) {
    return {
      args: { classId },
      toolName: "get_review_queue"
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
