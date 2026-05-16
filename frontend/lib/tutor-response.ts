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
  "studentResponse",
  "problem",
  "hint",
  "keyIdea",
  "rule",
  "method",
  "example",
  "checkWork",
  "sourceContext"
] as const;

export function normalizeTutorResponse(payload: Partial<TutorApiResponse>): TutorApiResponse {
  const rawMessage = String(payload.message ?? payload.content ?? "");
  const retrievalConfidence = normalizeRetrievalConfidence(payload.retrievalConfidence);
  const rawStructuredMessagePayload = parseStructuredTutorMessagePayload(rawMessage);
  const structuredOutput = normalizeStructuredTutorOutput(payload.structuredOutput ?? rawStructuredMessagePayload, rawMessage);
  const message = rawStructuredMessagePayload && structuredOutput ? visibleTextFromStructuredOutput(structuredOutput) : rawMessage;

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
    const fallbackPayload = parseStructuredTutorMessagePayload(fallbackAnswer);
    return fallbackPayload ? normalizeStructuredTutorOutput(fallbackPayload, fallbackAnswer) : undefined;
  }

  const record = value as Record<string, unknown>;
  const sectionsRecord = isRecord(record.sections) ? record.sections : record;
  const metadataRecord = isRecord(record.metadata) ? record.metadata : record;
  const explicitMainChat = optionalStringValue(
    sectionsRecord.studentResponse ??
      record.studentResponse ??
      sectionsRecord.mainChat ??
      record.mainChat ??
      record.mainText ??
      record.main_text
  );
  const explicitSectionAnswer = optionalStringValue(sectionsRecord.answer);
  const explicitLegacyAnswer = optionalStringValue(record.answer);
  const explicitLegacyExplanation = optionalStringValue(sectionsRecord.explanation);
  const hasExplicitStructuredSection = tutorStructuredSectionKeys.some((key) => Boolean(optionalStringValue(sectionsRecord[key])));
  const baseAnswer =
    explicitMainChat ??
    explicitSectionAnswer ??
    explicitLegacyAnswer ??
    explicitLegacyExplanation ??
    (hasExplicitStructuredSection ? "" : fallbackAnswer);
  const rawLegacyAction = stringValue(sectionsRecord[["next", "Step"].join("")]) || stringValue(record.nextQuestion);
  const sanitizedBaseAnswer = looksLikeWorkflowStatusText(baseAnswer) ? "" : baseAnswer;
  const rawHint = finalSectionValue("hint", sectionsRecord.hint);
  const legacyAction =
    !looksLikeWorkflowStatusText(rawLegacyAction) &&
    !sectionRepeatsEarlierContent(rawLegacyAction, [sanitizedBaseAnswer, rawHint])
      ? rawLegacyAction
      : "";
  const rawProblem = stringValue(sectionsRecord.problem);
  const splitProblem = splitProblemSectionFollowup(rawProblem);
  const problem = finalSectionValue("problem", splitProblem.problem);
  const misplacedProblemStatus = problem ? "" : statusLineFromProblemSection(rawProblem);
  const studentResponseCandidate = normalizeWrappedReferenceNumbers(
    [sanitizedBaseAnswer || misplacedProblemStatus, splitProblem.followup, legacyAction].filter(Boolean).join("\n\n")
  );
  const studentResponse = problem && duplicatesProblemSection(studentResponseCandidate, problem) ? "" : studentResponseCandidate;
  const hint = rawHint && sectionRepeatsEarlierContent(rawHint, [studentResponse]) ? "" : rawHint;
  const keyIdea = finalSectionValue("keyIdea", sectionsRecord.keyIdea);
  const rule = finalSectionValue("rule", sectionsRecord.rule ?? sectionsRecord.formula);
  const method = finalSectionValue("method", sectionsRecord.method);
  const example = finalSectionValue("example", sectionsRecord.example);
  const checkWork = finalSectionValue("checkWork", sectionsRecord.checkWork);
  const sourceContext = finalSectionValue("sourceContext", sectionsRecord.sourceContext ?? sectionsRecord.sourceNote);
  const mode = includesString(tutorModes, metadataRecord.mode) ? metadataRecord.mode : "guided_problem_solving";
  const choiceDisplay =
    metadataRecord.choiceDisplay === "problem_selection" || metadataRecord.choiceDisplay === "support_path_uncertainty"
      ? metadataRecord.choiceDisplay
      : undefined;
  const sections = {
    ...(studentResponse ? { studentResponse } : {}),
    ...(problem ? { problem } : {}),
    ...(hint ? { hint } : {}),
    ...(keyIdea ? { keyIdea } : {}),
    ...(rule ? { rule } : {}),
    ...(method ? { method } : {}),
    ...(example ? { example } : {}),
    ...(checkWork ? { checkWork } : {}),
    ...(sourceContext ? { sourceContext } : {})
  };
  const sectionOrder = normalizeSectionOrder(record.sectionOrder ?? sectionsRecord.sectionOrder).filter(
    (key) => key in sections
  );
  let confusionPrompt = stringValue(record.confusionPrompt ?? record.confusion_prompt).slice(0, 240);
  const confusionChoices = normalizeConfusionChoices(record.confusionChoices ?? record.confusion_choices, {
    maxCount: choiceDisplay === "problem_selection" ? 80 : 6
  });
  if (choiceDisplay === "problem_selection" && confusionChoices && !confusionPrompt) {
    confusionPrompt = "Pick the problem you want help with.";
  }
  return {
    sections,
    ...(sectionOrder.length ? { sectionOrder } : {}),
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

function parseStructuredTutorMessagePayload(value: string): Record<string, unknown> | undefined {
  const parsed = parseJsonObjectFromText(value);
  if (!parsed) {
    return undefined;
  }

  const unwrapped = unwrapNestedTutorJsonPayload(parsed);
  return looksLikeTutorStructuredPayload(unwrapped) ? unwrapped : undefined;
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const candidate = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) {
    return undefined;
  }

  return parseJsonObjectCandidate(candidate) ?? parseJsonObjectCandidate(escapeInvalidJsonBackslashes(candidate));
}

function parseJsonObjectCandidate(candidate: string): Record<string, unknown> | undefined {
  for (const jsonCandidate of jsonRepairCandidates(candidate)) {
    try {
      const parsed = JSON.parse(jsonCandidate) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      // Try the next repair candidate.
    }
  }

  return undefined;
}

function escapeInvalidJsonBackslashes(candidate: string) {
  return candidate.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function jsonRepairCandidates(candidate: string) {
  const repairedBackslashes = escapeInvalidJsonBackslashes(candidate);
  const repairedControlCharacters = escapeJsonStringControlCharacters(candidate);
  const repairedBoth = escapeInvalidJsonBackslashes(repairedControlCharacters);

  return Array.from(new Set([candidate, repairedBackslashes, repairedControlCharacters, repairedBoth]));
}

function escapeJsonStringControlCharacters(candidate: string) {
  let output = "";
  let inString = false;
  let escaping = false;

  for (const character of candidate) {
    if (escaping) {
      output += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      output += character;
      if (inString) {
        escaping = true;
      }
      continue;
    }

    if (character === "\"") {
      output += character;
      inString = !inString;
      continue;
    }

    if (inString && character < " ") {
      output += JSON.stringify(character).slice(1, -1);
      continue;
    }

    output += character;
  }

  return output;
}

function unwrapNestedTutorJsonPayload(value: Record<string, unknown>): Record<string, unknown> {
  const nested =
    typeof value.content === "string"
      ? parseStructuredTutorMessagePayload(value.content)
      : typeof value.message === "string"
        ? parseStructuredTutorMessagePayload(value.message)
        : undefined;
  if (!nested) {
    return value;
  }

  const { content: _content, message: _message, metadata: _metadata, sectionOrder: _sectionOrder, sections: _sections, ...outer } = value;
  return { ...nested, ...outer };
}

function looksLikeTutorStructuredPayload(value: Record<string, unknown>) {
  return (
    isRecord(value.sections) ||
    isRecord(value.metadata) ||
    tutorStructuredSectionKeys.some((key) => typeof value[key] === "string") ||
    typeof value.mainChat === "string" ||
    typeof value.mainText === "string" ||
    typeof value.main_text === "string"
  );
}

function visibleTextFromStructuredOutput(value: TutorStructuredOutput) {
  const sections = value.sections;
  return (
    sections.studentResponse?.trim() ||
    sections.answer?.trim() ||
    sections.hint?.trim() ||
    sections.problem?.trim() ||
    value.confusionPrompt?.trim() ||
    ""
  );
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
    const description = stringValue(item.description).slice(0, 180);
    const message = stringValue(item.message ?? item.value ?? item.content).slice(0, 240);
    if (!label || !message) {
      continue;
    }

    const id = stringValue(item.id).slice(0, 80) || `choice-${choices.length + 1}`;
    choices.push({ ...(description ? { description } : {}), id, label, message });
  }

  const maxCount = options.maxCount ?? 6;
  return choices.length >= 2 && choices.length <= maxCount ? choices : undefined;
}

function normalizeSectionOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => sectionOrderAlias(item))
    .filter((item): item is (typeof tutorStructuredSectionKeys)[number] => includesString(tutorStructuredSectionKeys, item));
}

function sectionOrderAlias(value: unknown) {
  if (value === "answer" || value === "mainChat" || value === "mainText" || value === "main_text") {
    return "studentResponse";
  }
  if (value === "formula" || value === "formulas") {
    return "rule";
  }
  if (value === "sourceNote" || value === "source_note") {
    return "sourceContext";
  }
  return value;
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

function finalSectionValue(section: string, value: unknown) {
  const text = stringValue(value);
  if (!text || looksLikeWorkflowStatusText(text)) {
    return "";
  }

  if (section === "problem" && looksLikeProblemSectionStatusText(text)) {
    return "";
  }

  return text;
}

function duplicatesProblemSection(value: string, problem: string) {
  const normalizedValue = normalizeComparableProblemText(value);
  const normalizedProblem = normalizeComparableProblemText(problem);
  return Boolean(
    normalizedValue &&
      normalizedProblem &&
      (normalizedValue === normalizedProblem ||
        (normalizedProblem.length >= 24 &&
          (normalizedValue.endsWith(normalizedProblem) || normalizedValue.includes(normalizedProblem))))
  );
}

function sectionRepeatsEarlierContent(sectionContent: string, previousSections: Array<string | undefined>) {
  const normalizedSection = normalizeComparableSectionText(sectionContent);
  if (!normalizedSection) {
    return false;
  }

  return previousSections.some((previousContent) => {
    const normalizedPrevious = normalizeComparableSectionText(previousContent ?? "");
    if (!normalizedPrevious) {
      return false;
    }

    return (
      normalizedPrevious === normalizedSection ||
      (normalizedSection.length >= 24 &&
        (normalizedPrevious.endsWith(normalizedSection) || normalizedPrevious.includes(normalizedSection))) ||
      hasHighMeaningfulTokenOverlap(normalizedPrevious, normalizedSection)
    );
  });
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

function normalizeComparableSectionText(value: string) {
  return value
    .replace(/^(?:\*\*)?(?:answer|hint|key idea|rule|method|source context|source note|explanation|your next step|next step|main chat)(?:\*\*)?\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

function normalizeComparableProblemText(value: string) {
  return normalizeSectionStringValue(value)
    .replace(/^\s*(?:problem|exercise|question)(?:\s+\d+(?:\.\d+)*)?\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeWorkflowStatusText(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  return (
    (/\b(checking|looking up|searching|locating|finding)\b/.test(normalized) &&
      /\b(class materials?|problem|exercise|question|page|source|textbook|worksheet|homework)\b/.test(normalized)) ||
    /\bplease wait\b/.test(normalized) ||
    /\bsend (?:me )?(?:the|a|your)?\s*(page|textbook|worksheet|homework|screenshot|photo|image)\b/.test(normalized)
  );
}

function looksLikeProblemSectionStatusText(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  return /\b(you said|which problem|what problem|page or textbook|textbook name)\b/.test(normalized);
}

function statusLineFromProblemSection(text: string) {
  if (!looksLikeProblemSectionStatusText(text)) {
    return "";
  }

  return text
    .split(/\n{2,}/)[0]
    .split(/\n/)[0]
    .trim();
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
    followup: match[1].trim().replace(/[.!?]+$/g, "")
  };
}

function normalizeSectionStringValue(value: string) {
  const trimmed = value.trim();
  const textMatch = trimmed.match(/^\{\s*['"]text['"]\s*:\s*(['"])([\s\S]*)\1\s*\}$/);

  return textMatch ? textMatch[2].trim() : trimmed;
}

function normalizeWrappedReferenceNumbers(text: string) {
  return text.replace(
    /\b(Example|Exercise|Section|Definition|Theorem|Lemma|Corollary)\s+(\d+(?:\.\d+)*)\.?\s*\n\s*(\d+\b)(?!\s*[\).])/gi,
    (_match, label: string, prefix: string, suffix: string) => `${label} ${prefix}.${suffix}`
  );
}
