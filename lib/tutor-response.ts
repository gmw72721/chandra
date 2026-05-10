import type { RetrievalConfidence, TutorApiResponse, TutorStructuredOutput } from "./types";

export const tutorHintLevels = ["none", "small_hint", "guided_step", "worked_example", "refusal"] as const;
export const tutorStudentActions = [
  "none",
  "show_attempt",
  "try_next_step",
  "answer_question",
  "review_source",
  "paste_problem",
  "ask_teacher"
] as const;
export const tutorModes = [
  "guided_problem_solving",
  "socratic",
  "check_work",
  "reading_helper",
  "exam_review",
  "source_lookup",
  "direct_answer_refusal",
  "clarification",
  "off_topic_redirect"
] as const;
const tutorStructuredSectionKeys = [
  "answer",
  "problem",
  "hint",
  "explanation",
  "formula",
  "example",
  "checkWork",
  "sourceNote",
  "nextStep"
] as const;

export function normalizeTutorResponse(payload: Partial<TutorApiResponse>): TutorApiResponse {
  const message = String(payload.message ?? payload.content ?? "");
  const retrievalConfidence = normalizeRetrievalConfidence(payload.retrievalConfidence);
  const structuredOutput = normalizeStructuredTutorOutput(payload.structuredOutput, message);

  return {
    assistantMessageId: payload.assistantMessageId,
    content: message,
    conversationId: payload.conversationId,
    langGraphTrace: payload.langGraphTrace,
    message,
    retrievalConfidence,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    ...(structuredOutput ? { structuredOutput } : {})
  };
}

export function normalizeStructuredTutorOutput(
  value: unknown,
  fallbackAnswer = ""
): TutorStructuredOutput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sectionsRecord = isRecord(record.sections) ? record.sections : record;
  const metadataRecord = isRecord(record.metadata) ? record.metadata : record;
  const explicitSectionAnswer = optionalStringValue(sectionsRecord.answer);
  const explicitLegacyAnswer = optionalStringValue(record.answer);
  const rawAnswer = normalizeWrappedReferenceNumbers(explicitSectionAnswer ?? explicitLegacyAnswer ?? fallbackAnswer);
  const problem = stringValue(sectionsRecord.problem);
  const rawHint = stringValue(sectionsRecord.hint);
  const explanation = stringValue(sectionsRecord.explanation);
  const formula = stringValue(sectionsRecord.formula);
  const example = stringValue(sectionsRecord.example);
  const checkWork = stringValue(sectionsRecord.checkWork);
  const sourceNote = stringValue(sectionsRecord.sourceNote);
  const rawNextStep = normalizeWrappedReferenceNumbers(
    stringValue(sectionsRecord.nextStep) || stringValue(record.nextQuestion)
  );
  const repaired = repairSplitReferenceNextStep(rawAnswer, rawNextStep);
  const { hint, nextStep } = repairHintLabeledNextStep(rawHint, repaired.nextStep);
  const sectionOrder = normalizeSectionOrder(record.sectionOrder ?? sectionsRecord.sectionOrder);

  return {
    sections: {
      answer: repaired.answer,
      ...(problem ? { problem } : {}),
      ...(hint ? { hint } : {}),
      ...(explanation ? { explanation } : {}),
      ...(formula ? { formula } : {}),
      ...(example ? { example } : {}),
      ...(checkWork ? { checkWork } : {}),
      ...(sourceNote ? { sourceNote } : {}),
      ...(nextStep ? { nextStep } : {})
    },
    ...(sectionOrder.length ? { sectionOrder } : {}),
    metadata: {
      hintLevel: includesString(tutorHintLevels, metadataRecord.hintLevel) ? metadataRecord.hintLevel : "guided_step",
      sourceConfidence: normalizeRetrievalConfidence(metadataRecord.sourceConfidence),
      studentActionNeeded: includesString(tutorStudentActions, metadataRecord.studentActionNeeded)
        ? metadataRecord.studentActionNeeded
        : "try_next_step",
      mode: includesString(tutorModes, metadataRecord.mode) ? metadataRecord.mode : "guided_problem_solving"
    }
  };
}

function normalizeSectionOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is (typeof tutorStructuredSectionKeys)[number] =>
    includesString(tutorStructuredSectionKeys, item)
  );
}

function normalizeRetrievalConfidence(value: unknown): RetrievalConfidence {
  return value === "high" || value === "medium" ? value : "low";
}

function includesString<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}

function repairSplitReferenceNextStep(answer: string, nextStep: string) {
  if (!nextStep || !/^\d+\b/.test(nextStep)) {
    return { answer, nextStep };
  }

  if (!/\b(Example|Exercise|Section|Definition|Theorem|Lemma|Corollary)\s+\d+(?:\.\d+)*\.?$/i.test(answer)) {
    return { answer, nextStep };
  }

  const separator = answer.endsWith(".") ? "" : ".";
  return {
    answer: `${answer}${separator}${nextStep}`,
    nextStep: ""
  };
}

function repairHintLabeledNextStep(hint: string, nextStep: string) {
  const hintMatch = nextStep.match(/^(?:\*\*)?hint(?:\*\*)?\s*:\s*(.+)$/is);

  if (!hintMatch) {
    return { hint, nextStep };
  }

  const nextStepHint = hintMatch[1].trim();

  return {
    hint: [hint, nextStepHint].filter(Boolean).join("\n\n"),
    nextStep: ""
  };
}

function normalizeWrappedReferenceNumbers(text: string) {
  return text.replace(
    /\b(Example|Exercise|Section|Definition|Theorem|Lemma|Corollary)\s+(\d+(?:\.\d+)*)\.?\s*\n\s*(\d+\b)(?!\s*[\).])/gi,
    (_match, label: string, prefix: string, suffix: string) => `${label} ${prefix}.${suffix}`
  );
}
