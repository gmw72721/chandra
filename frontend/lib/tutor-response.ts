import type { RetrievalConfidence, TutorApiResponse, TutorConfusionChoice, TutorStructuredOutput } from "./types";

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
  const rawMessage = String(payload.message ?? payload.content ?? "");
  const retrievalConfidence = normalizeRetrievalConfidence(payload.retrievalConfidence);
  const structuredOutput = normalizeStructuredTutorOutput(payload.structuredOutput, rawMessage);
  const message = suppressDuplicateProblemMessage(rawMessage, structuredOutput);

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

function suppressDuplicateProblemMessage(message: string, structuredOutput: TutorStructuredOutput | undefined) {
  const problem = structuredOutput?.sections.problem;
  if (!problem) {
    return message;
  }

  if (answerDuplicatesProblemSection(message, problem)) {
    return "";
  }

  return message;
}

function answerDuplicatesProblemSection(answer: string, problem: string) {
  const normalizedAnswer = normalizeProblemDuplicateText(answer);
  const normalizedProblem = normalizeProblemDuplicateText(problem);
  return Boolean(
    normalizedAnswer &&
      normalizedProblem &&
      (normalizedAnswer === normalizedProblem ||
        (normalizedProblem.length >= 24 &&
          (normalizedAnswer.endsWith(normalizedProblem) || normalizedAnswer.includes(normalizedProblem))))
  );
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
  let rawAnswer = normalizeWrappedReferenceNumbers(explicitSectionAnswer ?? explicitLegacyAnswer ?? fallbackAnswer);
  const splitProblem = splitProblemSectionFollowup(stringValue(sectionsRecord.problem));
  const problem = looksLikeAcademicProblemSection(splitProblem.problem) ? splitProblem.problem : "";
  const misplacedProblemAnswer = splitProblem.problem && !problem ? splitProblem.problem : "";
  if (problem && answerDuplicatesProblemSection(rawAnswer, problem)) {
    rawAnswer = "";
  }
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
  const answer = repaired.answer || splitProblem.followup || misplacedProblemAnswer;
  const { hint, nextStep } = repairHintLabeledNextStep(rawHint, repaired.nextStep);
  const mode = includesString(tutorModes, metadataRecord.mode) ? metadataRecord.mode : "guided_problem_solving";
  const choiceDisplay = metadataRecord.choiceDisplay === "problem_selection" ? "problem_selection" : undefined;
  const dedupedSections = suppressDuplicatedTutorSections(
    {
      answer,
      ...(problem ? { problem } : {}),
      ...(hint ? { hint } : {}),
      ...(explanation ? { explanation } : {}),
      ...(formula ? { formula } : {}),
      ...(example ? { example } : {}),
      ...(checkWork ? { checkWork } : {}),
      ...(sourceNote ? { sourceNote } : {}),
      ...(nextStep ? { nextStep } : {})
    },
    mode
  );
  const sectionOrder = normalizeSectionOrder(record.sectionOrder ?? sectionsRecord.sectionOrder).filter(
    (key) => key in dedupedSections
  );
  let confusionPrompt = stringValue(record.confusionPrompt ?? record.confusion_prompt).slice(0, 240);
  const confusionChoices = normalizeConfusionChoices(record.confusionChoices ?? record.confusion_choices, {
    maxCount: choiceDisplay === "problem_selection" ? 80 : 6
  });
  if (choiceDisplay === "problem_selection" && confusionChoices && !confusionPrompt) {
    confusionPrompt = "Pick the problem you want help with.";
  }
  const finalSections =
    confusionPrompt && confusionChoices
      ? { answer: preferredConfusionChoicePrompt(dedupedSections.answer, confusionPrompt) }
      : dedupedSections;
  const finalSectionOrder = confusionChoices ? [] : sectionOrder;

  return {
    sections: finalSections,
    ...(finalSectionOrder.length ? { sectionOrder: finalSectionOrder } : {}),
    ...(confusionPrompt ? { confusionPrompt } : {}),
    ...(confusionChoices ? { confusionChoices } : {}),
    metadata: {
      hintLevel: includesString(tutorHintLevels, metadataRecord.hintLevel) ? metadataRecord.hintLevel : "guided_step",
      ...(choiceDisplay ? { choiceDisplay } : {}),
      ...optionalProblemMetadata(metadataRecord),
      sourceConfidence: normalizeRetrievalConfidence(metadataRecord.sourceConfidence),
      studentActionNeeded: includesString(tutorStudentActions, metadataRecord.studentActionNeeded)
        ? metadataRecord.studentActionNeeded
        : "try_next_step",
      mode
    }
  };
}

function preferredConfusionChoicePrompt(answer: string | undefined, confusionPrompt: string): string {
  if (answer && /\b(?:not sure|unclear|unsure|pick one|choose one)\b/i.test(answer)) {
    return answer;
  }
  return confusionPrompt;
}

function normalizeConfusionChoices(
  value: unknown,
  options: { maxCount?: number } = {}
): TutorConfusionChoice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const choices: TutorConfusionChoice[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const label = stringValue(item.label).slice(0, 80);
    const message = stringValue(item.message ?? item.value ?? item.content).slice(0, 240);
    if (!label || !message) {
      continue;
    }

    const id = stringValue(item.id).slice(0, 80) || `choice-${choices.length + 1}`;
    choices.push({ id, label, message });
  }

  const maxCount = options.maxCount ?? 6;
  return choices.length >= 2 && choices.length <= maxCount ? choices : undefined;
}

function splitProblemSectionFollowup(problem: string) {
  const followupPattern = [
    String.raw`(?:That(?:'|\u2019)s|This is|It(?:'|\u2019)s)\s+(?:the\s+)?(?:exact\s+)?(?:problem|exercise|question)\b.+\b(?:page|printed\s+page|source|textbook|worksheet)\b.+`,
    String.raw`(?:You can find|I found)\s+.+\b(?:page|printed\s+page|source|textbook|worksheet)\b.+`,
    String.raw`If you (?:want|can),?\s+.+`,
    String.raw`I can help you\s+.+`,
    String.raw`Want to\s+.+`,
    String.raw`Send me\s+.+`,
    String.raw`Show me\s+.+`,
    String.raw`What have you\s+.+`,
    String.raw`Where do you\s+.+`
  ].join("|");
  const match = problem.match(new RegExp(String.raw`\s+(${followupPattern})$`, "i"));

  if (!match) {
    return { problem, followup: "" };
  }

  return {
    problem: problem.slice(0, match.index).trim(),
    followup: match[1].trim()
  };
}

function looksLikeAcademicProblemSection(text: string) {
  const normalized = normalizeComparableSectionText(text);
  if (!normalized) {
    return false;
  }

  if (
    looksLikeRetrievalStatusText(text) ||
    asksForPastedProblemOrSource(text) ||
    /\b(you said|which problem|what problem|page or textbook|textbook name|class materials?|checking|looking|locating|searching)\b/i.test(
      normalized
    )
  ) {
    return false;
  }

  const taskPattern =
    "assume|calculate|compute|consider|define|describe|determine|evaluate|explain|find|for|given|if|let|prove|recall|show|solve|suppose|use|verify|what|when|where|which|why|write";
  const taskRegex = new RegExp(`\\b(?:${taskPattern})\\b`, "i");
  const startsWithTaskRegex = new RegExp(`^\\s*(?:${taskPattern})\\b`, "i");
  const hasTaskVerb = taskRegex.test(text);
  const startsWithTask = startsWithTaskRegex.test(text);
  const hasProblemMarker =
    /\b(?:problem|exercise|question|ex\.?)\s*\d/i.test(text) ||
    /(?<![\d.])\d{1,3}\s*\.\s*\d{1,3}[a-z]?(?!\s*\.\s*\d)/i.test(text);
  const hasMathSignal = /(\\|=|<|>|\^|_|∫|√|\$|\bmatrix\b|\boperator\b|\bfunction\b)/i.test(text);
  const wordCount = text.match(/[A-Za-z0-9]+/g)?.length ?? 0;

  return wordCount >= 4 && hasTaskVerb && (hasProblemMarker || hasMathSignal || startsWithTask);
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

function optionalProblemMetadata(metadataRecord: Record<string, unknown>) {
  const problemNumber = stringValue(metadataRecord.problemNumber).slice(0, 40);
  const problemSummary = stringValue(metadataRecord.problemSummary).slice(0, 180);

  return {
    ...(problemNumber ? { problemNumber } : {}),
    ...(problemSummary ? { problemSummary } : {})
  };
}

function includesString<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return normalizeSectionStringValue(value);
  }

  if (isRecord(value)) {
    return stringValue(value.text ?? value.content ?? value.value ?? value.message);
  }

  return "";
}

function optionalStringValue(value: unknown) {
  if (typeof value === "string") {
    return normalizeSectionStringValue(value);
  }

  if (isRecord(value)) {
    const nested = stringValue(value.text ?? value.content ?? value.value ?? value.message);
    return nested || undefined;
  }

  return undefined;
}

function normalizeSectionStringValue(value: string) {
  const trimmed = value.trim();
  const textMatch = trimmed.match(/^\{\s*['"]text['"]\s*:\s*(['"])([\s\S]*)\1\s*\}$/);

  return textMatch ? textMatch[2].trim() : trimmed;
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

function isRepeatedSectionContent(previousContent: string, sectionContent: string) {
  const normalizedPrevious = normalizeComparableSectionText(previousContent);
  const normalizedSection = normalizeComparableSectionText(sectionContent);

  return Boolean(
    normalizedSection &&
      (normalizedPrevious === normalizedSection ||
        (normalizedSection.length >= 24 &&
          (normalizedPrevious.endsWith(normalizedSection) || normalizedPrevious.includes(normalizedSection))) ||
        hasHighMeaningfulTokenOverlap(normalizedPrevious, normalizedSection))
  );
}

function suppressDuplicatedTutorSections<T extends Record<string, string>>(
  sections: T,
  mode: (typeof tutorModes)[number]
): T {
  const nextSections = { ...sections };

  if (nextSections.hint && sectionRepeatsEarlierContent(nextSections.hint, [
    nextSections.answer,
    nextSections.explanation
  ])) {
    delete nextSections.hint;
  }

  if (
    nextSections.nextStep &&
    (mode === "source_lookup" ||
      nextSections.problem ||
      looksLikeRetrievalStatusText(nextSections.nextStep) ||
      (looksLikeRetrievalStatusText(nextSections.answer) && asksForPastedProblemOrSource(nextSections.nextStep)) ||
      sectionRepeatsEarlierContent(nextSections.nextStep, [
        nextSections.answer,
        nextSections.hint,
        nextSections.explanation,
        nextSections.checkWork
      ]))
  ) {
    delete nextSections.nextStep;
  }

  return nextSections;
}

function sectionRepeatsEarlierContent(sectionContent: string, previousSections: Array<string | undefined>) {
  return previousSections.some((previousContent) =>
    previousContent ? isRepeatedSectionContent(previousContent, sectionContent) : false
  );
}

function hasHighMeaningfulTokenOverlap(previousContent: string, sectionContent: string) {
  if (sectionContent.length < 28) {
    return false;
  }

  const previousTokens = new Set(meaningfulTokens(previousContent));
  const sectionTokens = meaningfulTokens(sectionContent);
  if (sectionTokens.length < 3 || !previousTokens.size) {
    return false;
  }

  const sharedCount = sectionTokens.filter((token) => previousTokens.has(token)).length;
  return sharedCount / sectionTokens.length >= 0.75;
}

const sectionTokenStopWords = new Set([
  "about",
  "again",
  "because",
  "before",
  "could",
  "first",
  "from",
  "have",
  "into",
  "just",
  "next",
  "that",
  "their",
  "then",
  "there",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your"
]);

function meaningfulTokens(value: string) {
  const matches = value.match(/[a-z0-9]+/g) ?? [];
  return matches.filter((token) => token.length > 2 && !sectionTokenStopWords.has(token));
}

function looksLikeRetrievalStatusText(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return Boolean(
    /\b(checking|locating|looking|searching|finding)\b/.test(normalized) &&
      /\b(problem|exercise|question|page|source|textbook|homework|worksheet|class material|materials)\b/.test(normalized)
  );
}

function asksForPastedProblemOrSource(text: string) {
  const normalized = text.toLowerCase();
  return Boolean(
    /\bpaste\s+(the\s+)?(exact\s+)?(problem|question|source|text|worksheet)\b/.test(normalized) ||
      /\btype\s+(the\s+)?(full\s+|exact\s+)?(problem|question|source|text|worksheet)(\s+text)?\b/.test(
        normalized
      ) ||
      /\bsend\s+(the\s+)?(full\s+|exact\s+)?(problem|question|source|text|worksheet|page|photo|image|screenshot)(\s+(text|photo|image|screenshot))?\b/.test(
        normalized
      ) ||
      /\b(?:send|upload)\s+(?:me\s+)?(?:the\s+)?(?:textbook|homework|worksheet|page|source).{0,40}\b(?:title|photo|page|name|image|screenshot|text)\b/.test(
        normalized
      ) ||
      /\bshare\s+(the\s+)?(full\s+|exact\s+)?(problem|question|source|text|worksheet|page|photo|image|screenshot)(\s+(text|photo|image|screenshot))?\b/.test(
        normalized
      )
  );
}

function normalizeComparableSectionText(value: string) {
  return value
    .replace(/^(?:\*\*)?(?:answer|hint|source note|your next step|next step)(?:\*\*)?\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

function normalizeProblemDuplicateText(value: string) {
  return normalizeComparableSectionText(
    value.replace(/^(?:\*\*)?(?:problem|exercise|question)(?:\s+\d+(?:\.\d+)*)?(?:\*\*)?\s*:\s*/i, "")
  );
}

function normalizeWrappedReferenceNumbers(text: string) {
  return text.replace(
    /\b(Example|Exercise|Section|Definition|Theorem|Lemma|Corollary)\s+(\d+(?:\.\d+)*)\.?\s*\n\s*(\d+\b)(?!\s*[\).])/gi,
    (_match, label: string, prefix: string, suffix: string) => `${label} ${prefix}.${suffix}`
  );
}
