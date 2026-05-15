const navigationTools = [
  "navigate_teacher_tab",
  "navigate_settings_pane",
  "navigate_sources_section",
  "navigate_ai_tutor_section",
  "open_student_profile",
  "open_student_profile_by_query",
  "open_student_conversations",
  "open_student_conversations_by_query",
  "open_conversation_review",
  "open_conversation_review_by_query",
  "open_student_view"
] as const;

const broadReadTools = [
  "get_teacher_dashboard_summary",
  "get_review_queue",
  "search_students",
  "get_student_context",
  "search_conversations",
  "get_class_materials",
  "search_materials",
  "get_class_settings",
  "get_tutor_settings"
] as const;

export type TeacherAssistantToolPolicy = {
  allowedToolNames: string[];
  maxToolCalls: number;
  reason: string;
};

export function selectTeacherAssistantToolPolicy(
  message: string,
  allowedToolNames: string[]
): TeacherAssistantToolPolicy {
  const allowed = new Set(allowedToolNames);
  const normalized = message.trim().toLowerCase();

  if (isStudentViewNavigationRequest(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 1,
      preferredTools: ["open_student_view", "navigate_teacher_tab"],
      reason: "navigation_only"
    });
  }

  if (mentionsStudent(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 3,
      preferredTools: [
        "search_students",
        "get_student_context",
        "open_student_profile_by_query",
        "open_student_conversations_by_query",
        "open_student_profile",
        "open_student_conversations",
        "navigate_teacher_tab"
      ],
      reason: "student_focused"
    });
  }

  if (mentionsSettings(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 2,
      preferredTools: [
        "get_class_settings",
        "get_tutor_settings",
        "navigate_settings_pane",
        "navigate_ai_tutor_section",
        "update_notification_settings",
        "update_class_general_settings",
        "update_tutor_access_settings",
        "update_tutor_behavior_settings",
        "update_class_instructions",
        "update_source_defaults",
        "update_appearance_settings"
      ],
      reason: "settings_focused"
    });
  }

  if (mentionsConversation(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 3,
      preferredTools: [
        "search_students",
        "search_conversations",
        "get_review_queue",
        "open_conversation_review_by_query",
        "open_student_conversations_by_query",
        "open_conversation_review",
        "open_student_conversations",
        "navigate_teacher_tab"
      ],
      reason: "conversation_focused"
    });
  }

  if (mentionsMaterials(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 2,
      preferredTools: ["search_materials", "get_class_materials", "navigate_sources_section", "navigate_teacher_tab"],
      reason: "materials_focused"
    });
  }

  if (isNavigationOnlyRequest(normalized)) {
    return pickAllowedTools({
      allowed,
      maxToolCalls: 1,
      preferredTools: navigationTools,
      reason: "navigation_only"
    });
  }

  return pickAllowedTools({
    allowed,
    maxToolCalls: 2,
    preferredTools: broadReadTools,
    reason: "default_read"
  });
}

function pickAllowedTools(input: {
  allowed: Set<string>;
  maxToolCalls: number;
  preferredTools: readonly string[];
  reason: string;
}) {
  const allowedToolNames = input.preferredTools.filter((toolName) => input.allowed.has(toolName));

  return {
    allowedToolNames: allowedToolNames.length ? allowedToolNames : [...input.allowed].sort(),
    maxToolCalls: input.maxToolCalls,
    reason: input.reason
  };
}

function isNavigationOnlyRequest(message: string) {
  if (!/\b(open|go to|goto|navigate|show|take me|switch to|view)\b/.test(message)) {
    return false;
  }

  return !/\b(summarize|summary|search|find|who|what|why|how many|list|review queue|settings are|materials are)\b/.test(message);
}

function isStudentViewNavigationRequest(message: string) {
  return /\b(open|go to|goto|navigate|show|take me|switch to|view)\b/.test(message) && /\bstudent view\b/.test(message);
}

function mentionsStudent(message: string) {
  if (/\bstudent view\b/.test(message)) {
    return false;
  }

  return /\b(student|roster|profile|learner|pupil)\b/.test(message) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(message);
}

function mentionsConversation(message: string) {
  if (/^\s*(open|go to|goto|navigate|show|take me|switch to|view)\s+(the\s+)?(conversation|conversations|chat review)(\s+tab)?\s*$/.test(message)) {
    return false;
  }

  return /\b(conversation|conversations|chat|review queue|follow-up|follow up|misunderstanding|retrieval confidence)\b/.test(message);
}

function mentionsMaterials(message: string) {
  if (/^\s*(open|go to|goto|navigate|show|take me|switch to|view)\s+(the\s+)?(material|materials|source|sources)(\s+tab)?\s*$/.test(message)) {
    return false;
  }

  return /\b(material|materials|source|sources|pdf|document|worksheet|homework|textbook|notes|rubric)\b/.test(message);
}

function mentionsSettings(message: string) {
  if (/^\s*(open|go to|goto|navigate|show|take me|switch to|view)\s+(the\s+)?settings(\s+tab)?\s*$/.test(message)) {
    return false;
  }

  return /\b(setting|settings|notification|notifications|privacy|usage|limit|model|tutor|voice|instruction|appearance|theme)\b/.test(message);
}
