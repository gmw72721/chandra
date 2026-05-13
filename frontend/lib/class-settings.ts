import { defaultOpenRouterModelId } from "./model-options";

export const tutorBehaviorOptions = [
  "Guided problem solving",
  "Socratic",
  "Check my work",
  "Exam review",
  "Reading helper"
] as const;

export type TutorBehavior = (typeof tutorBehaviorOptions)[number];

export type AnswerPolicySettings = {
  doNotGiveFinalAnswers: boolean;
  requireStudentAttemptFirst: boolean;
  askGuidingQuestionBeforeExplaining: boolean;
  allowWorkedExamples: boolean;
  refuseAnswerOnlyRequests: boolean;
  helpLimitsByUnderstandingLevel: HelpLimitsByUnderstandingLevel;
};

export const understandingLevelOptions = [0, 1, 2, 3, 4] as const;
export type UnderstandingLevel = (typeof understandingLevelOptions)[number];

export const helpLimitOptionIds = [
  "ask_for_attempt_only",
  "conceptual_orientation",
  "guiding_question",
  "light_hint",
  "targeted_hint_next_action",
  "one_worked_step",
  "check_work_explain_gaps",
  "full_explanation_allowed"
] as const;
export type HelpLimitOptionId = (typeof helpLimitOptionIds)[number];
export type HelpLimitsByUnderstandingLevel = Record<UnderstandingLevel, HelpLimitOptionId>;

export const preferredSourceTypeOptions = [
  "Homework and textbook",
  "Uploaded class materials",
  "Textbook first",
  "Worked examples",
  "Any trusted source"
] as const;

export type PreferredSourceType = (typeof preferredSourceTypeOptions)[number];

export type SourceUsageSettings = {
  useClassMaterialsFirst: boolean;
  citeSourcePages: boolean;
  askClarificationIfSourceUnclear: boolean;
  preferredSourceType: PreferredSourceType;
  quoteSourcePassages: boolean;
};

export const classAccessRoleOptions = ["owner", "co-teacher", "viewer"] as const;
export type ClassAccessRole = (typeof classAccessRoleOptions)[number];

export type ClassCoTeacher = {
  displayName: string;
  email: string;
  role: Exclude<ClassAccessRole, "owner">;
  uid: string;
};

export const conversationRetentionOptions = ["forever", "30-days", "90-days", "1-year"] as const;
export type ConversationRetentionPolicy = (typeof conversationRetentionOptions)[number];

export type ClassPrivacySettings = {
  conversationRetention: ConversationRetentionPolicy;
};

export const materialSourceTypePreferenceOptions = [
  "inherit",
  "student-visible",
  "teacher-review",
  "hidden"
] as const;
export type MaterialSourceTypePreference = (typeof materialSourceTypePreferenceOptions)[number];

export const materialSourceTypeKeys = [
  "Assignment",
  "Textbook",
  "Notes",
  "Worked Example",
  "Rubric",
  "Answer Key"
] as const;
export type MaterialSourceTypeKey = (typeof materialSourceTypeKeys)[number];

export const sourceDefaultPriorityOptions = ["primary", "normal", "low"] as const;
export type SourceDefaultPriority = (typeof sourceDefaultPriorityOptions)[number];

export type SourceDefaultsSettings = {
  activeForStudents: boolean;
  teacherOnly: boolean;
  citationsRequired: boolean;
  priority: SourceDefaultPriority;
  answerKeysTeacherReviewOnly: boolean;
  sourceTypePreferences: Record<MaterialSourceTypeKey, MaterialSourceTypePreference>;
};

export type NotificationSettings = {
  weeklyDigest: boolean;
  followUpReminders: boolean;
  newStudentJoinedClass: boolean;
};

export const reasoningEffortOptions = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEffortOptions)[number];

export const responseLengthOptions = ["short", "medium", "long", "extended"] as const;
export type ResponseLength = (typeof responseLengthOptions)[number];

export type AiTokenLimitSettings = {
  perHour: number;
  perDay: number;
  perWeek: number;
};

export type AiRequestLimitSettings = {
  perStudentDaily: number;
  perClassDaily: number;
  teacherPreviewDaily: number | null;
};

export type ClassModelSettings = {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  creativity: number;
  responseLength: ResponseLength;
  requestLimits: AiRequestLimitSettings;
  tokenLimits: AiTokenLimitSettings;
};

export type TutorAccessSettings = {
  enabled: boolean;
};

export const readingLevelOptions = ["simple", "standard", "advanced"] as const;
export type ReadingLevel = (typeof readingLevelOptions)[number];

export const mathNotationOptions = ["plain", "balanced", "symbolic"] as const;
export type MathNotation = (typeof mathNotationOptions)[number];

export type ResponseFormatSettings = {
  oneStepAtATime: boolean;
  endWithCheckQuestion: boolean;
  readingLevel: ReadingLevel;
  mathNotation: MathNotation;
};

export type ClassTutorDefaultsInput = {
  name?: string;
  section?: string;
};

export const defaultAnswerPolicySettings: AnswerPolicySettings = {
  doNotGiveFinalAnswers: true,
  requireStudentAttemptFirst: true,
  askGuidingQuestionBeforeExplaining: true,
  allowWorkedExamples: false,
  refuseAnswerOnlyRequests: true,
  helpLimitsByUnderstandingLevel: {
    0: "ask_for_attempt_only",
    1: "light_hint",
    2: "targeted_hint_next_action",
    3: "one_worked_step",
    4: "check_work_explain_gaps"
  }
};

export const defaultSourceUsageSettings: SourceUsageSettings = {
  useClassMaterialsFirst: true,
  citeSourcePages: true,
  askClarificationIfSourceUnclear: true,
  preferredSourceType: "Homework and textbook",
  quoteSourcePassages: true
};

export const defaultPrivacySettings: ClassPrivacySettings = {
  conversationRetention: "forever"
};

export const defaultSourceTypePreferences: Record<MaterialSourceTypeKey, MaterialSourceTypePreference> = {
  Assignment: "inherit",
  Textbook: "inherit",
  Notes: "inherit",
  "Worked Example": "inherit",
  Rubric: "inherit",
  "Answer Key": "teacher-review"
};

export const defaultSourceDefaultsSettings: SourceDefaultsSettings = {
  activeForStudents: true,
  teacherOnly: false,
  citationsRequired: true,
  priority: "primary",
  answerKeysTeacherReviewOnly: true,
  sourceTypePreferences: defaultSourceTypePreferences
};

export const defaultNotificationSettings: NotificationSettings = {
  weeklyDigest: true,
  followUpReminders: true,
  newStudentJoinedClass: true
};

export const defaultAiTokenLimitSettings: AiTokenLimitSettings = {
  perHour: 50_000,
  perDay: 400_000,
  perWeek: 1_600_000
};

export const defaultAiRequestLimitSettings: AiRequestLimitSettings = {
  perStudentDaily: 100,
  perClassDaily: 3_000,
  teacherPreviewDaily: 50
};

export const defaultClassModelSettings: ClassModelSettings = {
  modelId: defaultOpenRouterModelId,
  reasoningEffort: "low",
  creativity: 35,
  responseLength: "medium",
  requestLimits: defaultAiRequestLimitSettings,
  tokenLimits: defaultAiTokenLimitSettings
};

export const defaultTutorAccessSettings: TutorAccessSettings = {
  enabled: true
};

export const defaultResponseFormatSettings: ResponseFormatSettings = {
  oneStepAtATime: true,
  endWithCheckQuestion: true,
  readingLevel: "standard",
  mathNotation: "balanced"
};

export const defaultAssignmentContext = "";

export const defaultOpeningMessage =
  "Hi. I can help you work through this class step by step. What are you working on?";

export const defaultStudentFacingInstructions =
  "Show your work. Use exact values unless your teacher asks for decimals.";

export const defaultRefusalStyle =
  "If a student asks for a direct answer or homework-ready wording for the exact task, ask what they have tried, offer to check their work, or walk through a clearly different similar example instead.";

export const defaultBehaviorInstructions = [
  "Ask students to explain their thinking before giving hints.",
  "If a student names a specific task without showing work, ask what they have tried before giving task-specific hints.",
  "Do not provide final answers, proof paragraphs, sentence starters, or homework-ready wording unless the student has already shown the main reasoning.",
  "Use course materials to orient hints and explanations without starting the student's exact task for them."
].join("\n");

export function buildDefaultClassTutorSettings({ name, section }: ClassTutorDefaultsInput) {
  const className = normalizeClassNameForMessage(name);
  const classLabel = className || "this class";
  const lowerName = `${name ?? ""} ${section ?? ""}`.toLowerCase();

  if (/\b(algebra|calculus|geometry|math|precalc|pre-calculus|statistics|trig|trigonometry)\b/.test(lowerName)) {
    return {
      openingMessage: `Hi. I can help with ${classLabel} step by step. What problem are you on, and what have you tried so far?`,
      studentFacingInstructions: "Show your work. Use exact values unless your teacher asks for decimals."
    };
  }

  if (/\b(english|writing|composition|literature|ela|rhetoric|essay)\b/.test(lowerName)) {
    return {
      openingMessage: `Hi. I can help with ${classLabel} reading and writing work. What prompt, passage, or draft are you working on?`,
      studentFacingInstructions: "Use evidence from the assigned text. Share your prompt, passage, or draft before asking for revisions."
    };
  }

  if (/\b(biology|chemistry|physics|science|anatomy|environmental)\b/.test(lowerName)) {
    return {
      openingMessage: `Hi. I can help with ${classLabel} concepts, data, and practice problems. What question are you working on?`,
      studentFacingInstructions: ""
    };
  }

  if (/\b(history|government|civics|social studies|economics)\b/.test(lowerName)) {
    return {
      openingMessage: `Hi. I can help with ${classLabel} sources, concepts, and writing. What question or document are you working with?`,
      studentFacingInstructions: "Use class sources as evidence. Share the question and what you have found so far."
    };
  }

  if (/\b(computer science|programming|coding|software|data structures|web)\b/.test(lowerName)) {
    return {
      openingMessage: `Hi. I can help debug and reason through ${classLabel} step by step. What code, error, or concept are you working on?`,
      studentFacingInstructions: "Share the prompt, your code or approach, and the exact error before asking for a fix."
    };
  }

  return {
    openingMessage: className
      ? `Hi. I can help with ${className} step by step. What are you working on?`
      : defaultOpeningMessage,
    studentFacingInstructions: defaultStudentFacingInstructions
  };
}

export function normalizeTutorBehavior(value: unknown): TutorBehavior {
  return tutorBehaviorOptions.includes(value as TutorBehavior)
    ? (value as TutorBehavior)
    : "Guided problem solving";
}

export function normalizeAnswerPolicySettings(value: unknown): AnswerPolicySettings {
  const source = isRecord(value) ? value : {};

  return {
    doNotGiveFinalAnswers: booleanWithDefault(source.doNotGiveFinalAnswers, true),
    requireStudentAttemptFirst: booleanWithDefault(source.requireStudentAttemptFirst, true),
    askGuidingQuestionBeforeExplaining: booleanWithDefault(source.askGuidingQuestionBeforeExplaining, true),
    allowWorkedExamples: booleanWithDefault(source.allowWorkedExamples, false),
    refuseAnswerOnlyRequests: booleanWithDefault(source.refuseAnswerOnlyRequests, true),
    helpLimitsByUnderstandingLevel: normalizeHelpLimitsByUnderstandingLevel(source.helpLimitsByUnderstandingLevel)
  };
}

export function normalizeHelpLimitsByUnderstandingLevel(value: unknown): HelpLimitsByUnderstandingLevel {
  const source = isRecord(value) ? value : {};

  return Object.fromEntries(
    understandingLevelOptions.map((level) => {
      const configuredLimit = source[level] ?? source[String(level)];
      const limit = helpLimitOptionIds.includes(configuredLimit as HelpLimitOptionId)
        ? (configuredLimit as HelpLimitOptionId)
        : defaultAnswerPolicySettings.helpLimitsByUnderstandingLevel[level];

      return [level, limit];
    })
  ) as HelpLimitsByUnderstandingLevel;
}

export function normalizeSourceUsageSettings(value: unknown): SourceUsageSettings {
  const source = isRecord(value) ? value : {};
  const preferredSourceType = preferredSourceTypeOptions.includes(source.preferredSourceType as PreferredSourceType)
    ? (source.preferredSourceType as PreferredSourceType)
    : defaultSourceUsageSettings.preferredSourceType;

  return {
    useClassMaterialsFirst: booleanWithDefault(source.useClassMaterialsFirst, true),
    citeSourcePages: booleanWithDefault(source.citeSourcePages, true),
    askClarificationIfSourceUnclear: booleanWithDefault(source.askClarificationIfSourceUnclear, true),
    preferredSourceType,
    quoteSourcePassages: booleanWithDefault(source.quoteSourcePassages, true)
  };
}

export function normalizeClassAccessRole(value: unknown): ClassAccessRole {
  return classAccessRoleOptions.includes(value as ClassAccessRole) ? (value as ClassAccessRole) : "viewer";
}

export function normalizeCoTeacher(value: unknown): ClassCoTeacher | null {
  const source = isRecord(value) ? value : {};
  const uid = typeof source.uid === "string" ? source.uid.trim() : "";
  const email = typeof source.email === "string" ? source.email.trim().toLowerCase() : "";
  const role = normalizeClassAccessRole(source.role);

  if (!uid || role === "owner") {
    return null;
  }

  return {
    displayName: typeof source.displayName === "string" ? normalizeWhitespace(source.displayName) : "",
    email,
    role,
    uid
  };
}

export function normalizeClassCoTeachers(value: unknown): Record<string, ClassCoTeacher> {
  const source = isRecord(value) ? value : {};

  return Object.fromEntries(
    Object.entries(source)
      .map(([uid, coTeacher]) => normalizeCoTeacher({ ...(isRecord(coTeacher) ? coTeacher : {}), uid }))
      .filter((coTeacher): coTeacher is ClassCoTeacher => Boolean(coTeacher))
      .map((coTeacher) => [coTeacher.uid, coTeacher])
  );
}

export function normalizePrivacySettings(value: unknown): ClassPrivacySettings {
  const source = isRecord(value) ? value : {};
  const conversationRetention = conversationRetentionOptions.includes(
    source.conversationRetention as ConversationRetentionPolicy
  )
    ? (source.conversationRetention as ConversationRetentionPolicy)
    : defaultPrivacySettings.conversationRetention;

  return { conversationRetention };
}

export function normalizeSourceDefaultsSettings(value: unknown): SourceDefaultsSettings {
  const source = isRecord(value) ? value : {};
  const priority = sourceDefaultPriorityOptions.includes(source.priority as SourceDefaultPriority)
    ? (source.priority as SourceDefaultPriority)
    : defaultSourceDefaultsSettings.priority;
  const sourceTypePreferences = normalizeSourceTypePreferences(source.sourceTypePreferences);

  return {
    activeForStudents: booleanWithDefault(source.activeForStudents, true),
    teacherOnly: booleanWithDefault(source.teacherOnly, false),
    citationsRequired: booleanWithDefault(source.citationsRequired, true),
    priority,
    answerKeysTeacherReviewOnly: booleanWithDefault(source.answerKeysTeacherReviewOnly, true),
    sourceTypePreferences
  };
}

export function sourceDefaultsForMaterialKind(settingsValue: unknown, kindValue: unknown) {
  const settings = normalizeSourceDefaultsSettings(settingsValue);
  const kind = normalizeMaterialSourceTypeKey(kindValue);
  const preference = kind ? settings.sourceTypePreferences[kind] : "inherit";
  const answerKeyTeacherOnly = settings.answerKeysTeacherReviewOnly && kind === "Answer Key";

  if (answerKeyTeacherOnly || preference === "teacher-review") {
    return {
      activeForStudents: false,
      teacherOnly: true,
      citationsRequired: settings.citationsRequired,
      priority: settings.priority
    };
  }

  if (preference === "student-visible") {
    return {
      activeForStudents: true,
      teacherOnly: false,
      citationsRequired: settings.citationsRequired,
      priority: settings.priority
    };
  }

  if (preference === "hidden") {
    return {
      activeForStudents: false,
      teacherOnly: false,
      citationsRequired: settings.citationsRequired,
      priority: settings.priority
    };
  }

  return {
    activeForStudents: settings.activeForStudents,
    teacherOnly: settings.teacherOnly,
    citationsRequired: settings.citationsRequired,
    priority: settings.priority
  };
}

function normalizeMaterialSourceTypeKey(value: unknown): MaterialSourceTypeKey | null {
  if (materialSourceTypeKeys.includes(value as MaterialSourceTypeKey)) {
    return value as MaterialSourceTypeKey;
  }

  if (value === "Reading") {
    return "Textbook";
  }

  if (value === "Example") {
    return "Worked Example";
  }

  if (value === "Practice Solutions") {
    return "Answer Key";
  }

  return null;
}

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const source = isRecord(value) ? value : {};

  return {
    weeklyDigest: booleanWithDefault(source.weeklyDigest, true),
    followUpReminders: booleanWithDefault(source.followUpReminders, true),
    newStudentJoinedClass: booleanWithDefault(source.newStudentJoinedClass, true)
  };
}

export function normalizeClassModelSettings(value: unknown): ClassModelSettings {
  const source = isRecord(value) ? value : {};
  const reasoningEffort = reasoningEffortOptions.includes(source.reasoningEffort as ReasoningEffort)
    ? (source.reasoningEffort as ReasoningEffort)
    : defaultClassModelSettings.reasoningEffort;
  const responseLength = responseLengthOptions.includes(source.responseLength as ResponseLength)
    ? (source.responseLength as ResponseLength)
    : defaultClassModelSettings.responseLength;

  return {
    modelId: typeof source.modelId === "string" && source.modelId.trim()
      ? source.modelId.trim()
      : defaultClassModelSettings.modelId,
    reasoningEffort,
    creativity: clampCreativity(source.creativity),
    responseLength,
    requestLimits: normalizeAiRequestLimitSettings(source.requestLimits),
    tokenLimits: normalizeAiTokenLimitSettings(source.tokenLimits)
  };
}

export function normalizeAiRequestLimitSettings(value: unknown): AiRequestLimitSettings {
  const source = isRecord(value) ? value : {};

  return {
    perStudentDaily: clampRequestLimit(source.perStudentDaily, defaultAiRequestLimitSettings.perStudentDaily, 1, 10_000),
    perClassDaily: clampRequestLimit(source.perClassDaily, defaultAiRequestLimitSettings.perClassDaily, 1, 500_000),
    teacherPreviewDaily: normalizeOptionalRequestLimit(
      source.teacherPreviewDaily,
      defaultAiRequestLimitSettings.teacherPreviewDaily,
      1,
      10_000
    )
  };
}

export function normalizeAiTokenLimitSettings(value: unknown): AiTokenLimitSettings {
  const source = isRecord(value) ? value : {};

  return {
    perHour: clampTokenLimit(source.perHour, defaultAiTokenLimitSettings.perHour, 1_000, 1_000_000),
    perDay: clampTokenLimit(source.perDay, defaultAiTokenLimitSettings.perDay, 1_000, 5_000_000),
    perWeek: clampTokenLimit(source.perWeek, defaultAiTokenLimitSettings.perWeek, 1_000, 20_000_000)
  };
}

export function normalizeTutorAccessSettings(value: unknown): TutorAccessSettings {
  const source = isRecord(value) ? value : {};

  return {
    enabled: booleanWithDefault(source.enabled, true)
  };
}

export function normalizeResponseFormatSettings(value: unknown): ResponseFormatSettings {
  const source = isRecord(value) ? value : {};
  const readingLevel = readingLevelOptions.includes(source.readingLevel as ReadingLevel)
    ? (source.readingLevel as ReadingLevel)
    : defaultResponseFormatSettings.readingLevel;
  const mathNotation = mathNotationOptions.includes(source.mathNotation as MathNotation)
    ? (source.mathNotation as MathNotation)
    : defaultResponseFormatSettings.mathNotation;

  return {
    oneStepAtATime: booleanWithDefault(source.oneStepAtATime, true),
    endWithCheckQuestion: booleanWithDefault(source.endWithCheckQuestion, true),
    readingLevel,
    mathNotation
  };
}

export function normalizeOpeningMessage(value: unknown, classDefaults?: ClassTutorDefaultsInput) {
  const customMessage = typeof value === "string" ? normalizeWhitespace(value) : "";

  if (customMessage) {
    return customMessage;
  }

  return buildDefaultClassTutorSettings(classDefaults ?? {}).openingMessage;
}

export function normalizeStudentFacingInstructions(value: unknown, classDefaults?: ClassTutorDefaultsInput) {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }

  return buildDefaultClassTutorSettings(classDefaults ?? {}).studentFacingInstructions;
}

export function creativityToTemperature(creativity: number) {
  return Number((Math.min(100, Math.max(0, creativity)) / 100).toFixed(2));
}

export function responseLengthToMaxTokens(responseLength: ResponseLength) {
  if (responseLength === "short") {
    return 900;
  }

  if (responseLength === "extended") {
    return 7000;
  }

  if (responseLength === "long") {
    return 4200;
  }

  return 2200;
}

function clampCreativity(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultClassModelSettings.creativity;
  }

  return Math.round(Math.min(100, Math.max(0, numericValue)));
}

function clampTokenLimit(value: unknown, defaultValue: number, min: number, max: number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultValue;
  }

  return Math.round(Math.min(max, Math.max(min, numericValue)));
}

function clampRequestLimit(value: unknown, defaultValue: number, min: number, max: number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultValue;
  }

  return Math.round(Math.min(max, Math.max(min, numericValue)));
}

function normalizeOptionalRequestLimit(value: unknown, defaultValue: number | null, min: number, max: number) {
  if (value === null || value === "" || value === undefined) {
    return defaultValue;
  }

  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Math.round(Math.min(max, Math.max(min, numericValue)));
}

function booleanWithDefault(value: unknown, defaultValue: boolean) {
  return typeof value === "boolean" ? value : defaultValue;
}

function normalizeSourceTypePreferences(value: unknown): Record<MaterialSourceTypeKey, MaterialSourceTypePreference> {
  const source = isRecord(value) ? value : {};

  return Object.fromEntries(
    materialSourceTypeKeys.map((kind) => {
      const preference = materialSourceTypePreferenceOptions.includes(source[kind] as MaterialSourceTypePreference)
        ? (source[kind] as MaterialSourceTypePreference)
        : defaultSourceTypePreferences[kind];

      return [kind, preference];
    })
  ) as Record<MaterialSourceTypeKey, MaterialSourceTypePreference>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeClassNameForMessage(value: unknown) {
  return typeof value === "string" ? normalizeWhitespace(value) : "";
}
