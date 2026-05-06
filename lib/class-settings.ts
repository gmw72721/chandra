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
};

export const reasoningEffortOptions = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEffortOptions)[number];

export const responseLengthOptions = ["short", "medium", "long"] as const;
export type ResponseLength = (typeof responseLengthOptions)[number];

export type ClassModelSettings = {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  creativity: number;
  responseLength: ResponseLength;
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
  preferredSourceType: "Homework and textbook"
};

export const defaultClassModelSettings: ClassModelSettings = {
  modelId: defaultOpenRouterModelId,
  reasoningEffort: "medium",
  creativity: 35,
  responseLength: "medium"
};

export const defaultAssignmentContext = "";

export const defaultRefusalStyle =
  "If a student asks for a direct answer, redirect them toward the next useful step and ask a checking question.";

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
    preferredSourceType
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

export function creativityToTemperature(creativity: number) {
  return Number((Math.min(100, Math.max(0, creativity)) / 100).toFixed(2));
}

export function responseLengthToMaxTokens(responseLength: ResponseLength) {
  if (responseLength === "short") {
    return 450;
  }

  if (responseLength === "long") {
    return 1400;
  }

  return 850;
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
