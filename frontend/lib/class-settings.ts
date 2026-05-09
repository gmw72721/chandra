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
};

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

export const reasoningEffortOptions = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEffortOptions)[number];

export const responseLengthOptions = ["short", "medium", "long", "extended"] as const;
export type ResponseLength = (typeof responseLengthOptions)[number];

export type ClassModelSettings = {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  creativity: number;
  responseLength: ResponseLength;
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
  refuseAnswerOnlyRequests: true
};

export const defaultSourceUsageSettings: SourceUsageSettings = {
  useClassMaterialsFirst: true,
  citeSourcePages: true,
  askClarificationIfSourceUnclear: true,
  preferredSourceType: "Homework and textbook",
  quoteSourcePassages: true
};

export const defaultClassModelSettings: ClassModelSettings = {
  modelId: defaultOpenRouterModelId,
  reasoningEffort: "medium",
  creativity: 35,
  responseLength: "medium"
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
    refuseAnswerOnlyRequests: booleanWithDefault(source.refuseAnswerOnlyRequests, true)
  };
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
    responseLength
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

function booleanWithDefault(value: unknown, defaultValue: boolean) {
  return typeof value === "boolean" ? value : defaultValue;
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
