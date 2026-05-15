export const teacherAssistantTabs = [
  "overview",
  "roster",
  "problems",
  "sources",
  "knowledge",
  "conversations",
  "settings"
] as const;

export type TeacherAssistantTab = (typeof teacherAssistantTabs)[number];

export const teacherAssistantSettingsPanes = [
  "general",
  "classAccess",
  "privacy",
  "notifications",
  "usage",
  "account",
  "appearance"
] as const;

export type TeacherAssistantSettingsPane = (typeof teacherAssistantSettingsPanes)[number];

export const teacherAssistantSourceSections = ["sources", "sourceSettings"] as const;
export type TeacherAssistantSourceSection = (typeof teacherAssistantSourceSections)[number];

export const teacherAssistantAiTutorSections = [
  "access",
  "tutorMode",
  "voiceDetail",
  "helpRules",
  "classInstructions",
  "model"
] as const;

export type TeacherAssistantAiTutorSection = (typeof teacherAssistantAiTutorSections)[number];

export function isTeacherAssistantTab(value: unknown): value is TeacherAssistantTab {
  return typeof value === "string" && teacherAssistantTabs.includes(value as TeacherAssistantTab);
}

export function isTeacherAssistantSettingsPane(value: unknown): value is TeacherAssistantSettingsPane {
  return typeof value === "string" && teacherAssistantSettingsPanes.includes(value as TeacherAssistantSettingsPane);
}

export function isTeacherAssistantSourceSection(value: unknown): value is TeacherAssistantSourceSection {
  return typeof value === "string" && teacherAssistantSourceSections.includes(value as TeacherAssistantSourceSection);
}

export function isTeacherAssistantAiTutorSection(value: unknown): value is TeacherAssistantAiTutorSection {
  return typeof value === "string" && teacherAssistantAiTutorSections.includes(value as TeacherAssistantAiTutorSection);
}

export function buildTeacherAssistantTabHref(
  tab: TeacherAssistantTab,
  query: Record<string, string | boolean | undefined | null> = {}
) {
  const params = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    params.set(key, String(value));
  });

  const queryString = params.toString();
  return `/teacher/${tab}${queryString ? `?${queryString}` : ""}`;
}

export function resolveTeacherAssistantNavigation(input: {
  aiTutorSection?: unknown;
  classId?: unknown;
  conversationId?: unknown;
  newTab?: unknown;
  settingsPane?: unknown;
  sourceSection?: unknown;
  studentEmail?: unknown;
  tab?: unknown;
}) {
  const classId = normalizeRouteToken(input.classId);
  const tab = normalizeTeacherAssistantTab(input.tab);
  const query: Record<string, string | boolean> = {};

  if (classId) {
    query.classId = classId;
  }

  if (input.settingsPane !== undefined && input.settingsPane !== null && input.settingsPane !== "") {
    const settingsPane = normalizeTeacherAssistantSettingsPane(input.settingsPane);
    query.settingsPane = settingsPane;
  }

  if (input.sourceSection !== undefined && input.sourceSection !== null && input.sourceSection !== "") {
    const sourceSection = normalizeTeacherAssistantSourceSection(input.sourceSection);
    query.sourceSection = sourceSection;
  }

  if (input.aiTutorSection !== undefined && input.aiTutorSection !== null && input.aiTutorSection !== "") {
    const aiTutorSection = normalizeTeacherAssistantAiTutorSection(input.aiTutorSection);
    query.aiTutorSection = aiTutorSection;
  }

  const studentEmail = normalizeEmail(input.studentEmail);
  if (studentEmail) {
    query.student = studentEmail;
  }

  const conversationId = normalizeRouteToken(input.conversationId);
  if (conversationId) {
    query.conversationId = conversationId;
  }

  return {
    href: buildTeacherAssistantTabHref(tab, query),
    newTab: input.newTab === true,
    tab
  };
}

export function normalizeTeacherAssistantTab(value: unknown): TeacherAssistantTab {
  if (!isTeacherAssistantTab(value)) {
    throw new Error("Unsupported teacher dashboard tab.");
  }

  return value;
}

export function normalizeTeacherAssistantSettingsPane(value: unknown): TeacherAssistantSettingsPane {
  if (!isTeacherAssistantSettingsPane(value)) {
    throw new Error("Unsupported settings pane.");
  }

  return value;
}

export function normalizeTeacherAssistantSourceSection(value: unknown): TeacherAssistantSourceSection {
  if (!isTeacherAssistantSourceSection(value)) {
    throw new Error("Unsupported source section.");
  }

  return value;
}

export function normalizeTeacherAssistantAiTutorSection(value: unknown): TeacherAssistantAiTutorSection {
  if (!isTeacherAssistantAiTutorSection(value)) {
    throw new Error("Unsupported AI tutor section.");
  }

  return value;
}

export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 320) : "";
}

export function normalizeRouteToken(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}
