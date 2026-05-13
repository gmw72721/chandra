import type { ChatMessage, TutorProblemUnderstandingState, UnderstandingLevel, UnderstandingState } from "./types";

const unsafeUnderstandingReasonPattern =
  /\b(?:correct|incorrect|answer|final\s+solution|solution\s+is|solved|proves?\s+the\s+theorem)\b/i;

export function buildUnderstandingState(messages: ChatMessage[]): UnderstandingState | null {
  const latest = latestProblemUnderstandingState(messages);
  if (!latest) {
    return null;
  }

  const state = latest?.state;
  if (!isRealActiveProblemId(state?.activeProblemId)) {
    return null;
  }
  if (!hasDetectedProblemForUnderstanding(messages, latest.index)) {
    return null;
  }
  if (isSourceLookupOnlyState(latest.message) && !messageHasDetectedProblem(latest.message)) {
    return null;
  }

  const level = normalizeUnderstandingLevel(state.understandingLevel ?? state.level);
  const reasons = safeUnderstandingReasons(state, level);

  return {
    activeProblemId: state.activeProblemId,
    level,
    reasons,
    lastUpdatedAt: dateFromUnknown(state.updatedAt) ?? new Date(0)
  };
}

export function safeUnderstandingReasons(
  state: TutorProblemUnderstandingState,
  level: UnderstandingLevel
): string[] {
  const candidates = [
    understandingLevelUpdate(level),
    attemptUpdate(state.lastStudentAttemptSummary, level),
    ...(Array.isArray(state.conceptsUnderstood) ? state.conceptsUnderstood.map((concept) => conceptUpdate(concept)) : []),
    ...(Array.isArray(state.knownConfusions) ? state.knownConfusions.map((confusion) => confusionUpdate(confusion)) : []),
    ...(Array.isArray(state.reasons) ? state.reasons.map((reason) => reasonUpdate(reason, level)) : []),
    recentSupportUpdate(state.lastHintSummary)
  ];
  const safe = dedupeStrings(candidates.map(sanitizeUnderstandingReason).filter(Boolean));
  return safe.length ? safe.slice(0, 4) : [fallbackUnderstandingReason(level)];
}

export function sanitizeUnderstandingReason(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || unsafeUnderstandingReasonPattern.test(text)) {
    return "";
  }
  return text.slice(0, 160);
}

export function normalizeUnderstandingLevel(value: unknown): UnderstandingLevel {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
    return parsed as UnderstandingLevel;
  }
  return 0;
}

function understandingLevelUpdate(level: UnderstandingLevel) {
  if (level === 0) {
    return "Chandra has the problem, but has not seen your work on it yet.";
  }
  if (level === 1) {
    return "Chandra has the problem and still needs to see your next step or attempt.";
  }
  if (level === 2) {
    return "You have part of the setup; the next update depends on the main idea you use.";
  }
  if (level === 3) {
    return "You are using the main idea; Chandra is watching the execution details.";
  }
  return "You are close; Chandra is mostly checking notation, justification, or cleanup.";
}

function conceptUpdate(value: unknown) {
  const text = conciseProcessText(value);
  if (!text) {
    return "";
  }
  if (looksLikeConceptDefinition(text)) {
    const concept = conceptLabel(text);
    return concept ? `Chandra is checking how you use ${concept} in this problem.` : "";
  }
  return `You identified ${text}.`;
}

function confusionUpdate(value: unknown) {
  const text = conciseProcessText(value);
  return text ? `Next, clarify ${text}.` : "";
}

function attemptUpdate(value: unknown, level: UnderstandingLevel) {
  const text = conciseProcessText(value);
  if (!text) {
    return "";
  }
  if (looksLikeConceptDefinition(text)) {
    return reasonUpdate(text, level);
  }
  return text;
}

function reasonUpdate(value: unknown, level: UnderstandingLevel) {
  const text = conciseProcessText(value);
  if (!text) {
    return "";
  }
  if (normalizeReasonKey(text) === normalizeReasonKey(fallbackUnderstandingReason(level))) {
    return "";
  }
  if (looksLikeConceptDefinition(text)) {
    const concept = conceptLabel(text);
    return concept ? `Chandra is checking how you use ${concept} in this problem.` : understandingLevelUpdate(level);
  }
  return text;
}

function recentSupportUpdate(value: unknown) {
  const text = conciseProcessText(value);
  if (!text) {
    return "";
  }
  if (normalizeReasonKey(text) === normalizeReasonKey(fallbackUnderstandingReason(0))) {
    return "";
  }
  return /^chandra\b/i.test(text) ? text : `Recent support focused on: ${lowercaseFirst(text)}`;
}

function conceptLabel(value: unknown) {
  const text = conciseProcessText(value);
  if (!text) {
    return "";
  }
  const definitionMatch = text.match(/^([A-Za-z][A-Za-z0-9\s-]{1,40})\s+(?:means|is|are|refers to)\b/i);
  const raw = (definitionMatch?.[1] ?? text).replace(/\b(?:the|a|an)\b/gi, " ").replace(/\s+/g, " ").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6 || ["you", "chandra", "student"].includes(words[0].toLowerCase())) {
    return "";
  }
  return words.join(" ").toLowerCase();
}

function conciseProcessText(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.replace(/[.;:]\s*.*$/, "").replace(/[.!?]+$/, "").trim().slice(0, 140);
}

function looksLikeConceptDefinition(value: string) {
  return /^(?!you\b|chandra\b|student\b)[A-Za-z][A-Za-z0-9\s-]{1,40}\s+(?:means|is|are|refers to)\b/i.test(value) || /\bin data science\b/i.test(value);
}

function lowercaseFirst(value: string) {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function normalizeReasonKey(value: string) {
  return value.toLowerCase().replace(/[.!?]+$/, "").trim();
}

function latestProblemUnderstandingState(
  messages: ChatMessage[]
): { index: number; message: ChatMessage; state: TutorProblemUnderstandingState } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const state = message?.langGraphTrace?.problemUnderstandingState;
    if (state?.activeProblemId) {
      return { index, message, state };
    }
  }

  return null;
}

function hasDetectedProblemForUnderstanding(messages: ChatMessage[], throughIndex: number) {
  return messages.slice(0, throughIndex + 1).some(messageHasDetectedProblem);
}

function messageHasDetectedProblem(message: ChatMessage) {
  const structuredProblem = sanitizeProblemText(message.structuredOutput?.sections?.problem);
  if (structuredProblem) {
    return true;
  }

  const contentProblem = sanitizeProblemText(extractProblemSection(message.content));
  return Boolean(contentProblem);
}

function extractProblemSection(content: string) {
  const match = String(content ?? "").match(/(?:^|\n)\s*Problem\s*:\s*([\s\S]+?)(?:\n\s*[A-Z][A-Za-z ]{1,30}\s*:|$)/i);
  return match?.[1] ?? "";
}

function sanitizeProblemText(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /checking|loading|looking|searching|requested/i.test(text)) {
    return "";
  }
  return text.length >= 12 ? text : "";
}

function isSourceLookupOnlyState(message: ChatMessage) {
  const trace = message.langGraphTrace;
  const plan = isRecord(trace?.tutorPlan) ? trace.tutorPlan : {};
  const retrievalReason = String(trace?.retrievalReason || plan.retrievalReason || plan.retrieval_reason || "").trim();
  if (!["student_requested_problem", "student_changed_problem"].includes(retrievalReason)) {
    return false;
  }

  const studentIntent = String(plan.studentIntent || plan.student_intent || "").trim();
  return !["vague_help", "showed_work", "asks_for_next_step", "asks_for_solution", "asks_for_explanation", "verification"].includes(
    studentIntent
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRealActiveProblemId(value: unknown): value is string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized) && !["unknown", "none", "null", "n/a"].includes(normalized);
}

function fallbackUnderstandingReason(level: UnderstandingLevel) {
  if (level === 0) {
    return "Chandra has not seen your work yet.";
  }
  if (level === 1) {
    return "Chandra is starting with a small nudge.";
  }
  if (level === 2) {
    return "You connected the problem to part of the setup.";
  }
  if (level === 3) {
    return "You are working through the execution details.";
  }
  return "You are close and mostly need cleanup.";
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function dateFromUnknown(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}
