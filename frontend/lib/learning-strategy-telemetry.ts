import type {
  LearningStrategyExpectedStudentAction,
  LearningStrategyObservedOutcome,
  LearningStrategyTelemetry,
  LearningStrategyTutorMove,
  TutorApiResponse
} from "./types";

export type LearningStrategyProfileContext = {
  digest: string;
  strategies: LearningStrategyProfileStrategy[];
};

export type LearningStrategyProfileStrategy = {
  id?: string;
  label: string;
  source: "strategiesToTryNext" | "triedStrategies";
};

const tutorMoves = new Set<LearningStrategyTutorMove>([
  "ask_guiding_question",
  "small_hint",
  "worked_example",
  "check_work",
  "source_grounded_explanation",
  "refusal_redirect",
  "clarification"
]);
const expectedStudentActions = new Set<LearningStrategyExpectedStudentAction>([
  "answer_question",
  "try_next_step",
  "show_work",
  "revise_step",
  "review_source",
  "paste_problem"
]);
const observedOutcomes = new Set<LearningStrategyObservedOutcome>([
  "unknown",
  "student_progressed",
  "student_still_stuck",
  "student_disengaged"
]);
const insignificantStrategyWords = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "student",
  "students",
  "problem",
  "step",
  "work",
  "try",
  "next",
  "help",
  "ask",
  "use",
  "give"
]);

export function buildLearningStrategyTelemetry({
  profileContext,
  response
}: {
  profileContext: LearningStrategyProfileContext;
  response: TutorApiResponse;
}): LearningStrategyTelemetry {
  const existingTelemetry = normalizeLearningStrategyTelemetry(response.learningStrategyTelemetry);
  const tutorMove = existingTelemetry?.tutorMove ?? inferTutorMove(response);
  const expectedStudentAction = existingTelemetry?.expectedStudentAction ?? inferExpectedStudentAction(response, tutorMove);
  const profileUsed = Boolean(profileContext.digest.trim());
  const matchedStrategy = profileUsed
    ? existingTelemetry?.selectedStrategy
      ? undefined
      : findMatchingStrategy(response.message, profileContext.strategies)
    : undefined;

  return {
    profileUsed,
    ...(profileUsed && existingTelemetry?.selectedStrategy ? { selectedStrategy: existingTelemetry.selectedStrategy } : {}),
    ...(profileUsed && existingTelemetry?.selectedStrategyId
      ? { selectedStrategyId: existingTelemetry.selectedStrategyId }
      : {}),
    ...(profileUsed && existingTelemetry?.reasonSelected ? { reasonSelected: existingTelemetry.reasonSelected } : {}),
    ...(matchedStrategy
      ? {
          selectedStrategy: matchedStrategy.label,
          ...(matchedStrategy.id ? { selectedStrategyId: matchedStrategy.id } : {}),
          reasonSelected: "Assistant response overlaps with a reviewed profile strategy."
        }
      : {}),
    tutorMove,
    expectedStudentAction,
    observedOutcome: existingTelemetry?.observedOutcome ?? "unknown"
  };
}

export function normalizeLearningStrategyTelemetry(value: unknown): LearningStrategyTelemetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const tutorMove = tutorMoves.has(source.tutorMove as LearningStrategyTutorMove)
    ? (source.tutorMove as LearningStrategyTutorMove)
    : undefined;
  const expectedStudentAction = expectedStudentActions.has(
    source.expectedStudentAction as LearningStrategyExpectedStudentAction
  )
    ? (source.expectedStudentAction as LearningStrategyExpectedStudentAction)
    : undefined;

  if (!tutorMove || !expectedStudentAction) {
    return undefined;
  }

  const observedOutcome = observedOutcomes.has(source.observedOutcome as LearningStrategyObservedOutcome)
    ? (source.observedOutcome as LearningStrategyObservedOutcome)
    : undefined;

  return {
    profileUsed: Boolean(source.profileUsed),
    ...(shortOptionalText(source.selectedStrategy, 160)
      ? { selectedStrategy: shortOptionalText(source.selectedStrategy, 160) }
      : {}),
    ...(shortOptionalText(source.selectedStrategyId, 100)
      ? { selectedStrategyId: shortOptionalText(source.selectedStrategyId, 100) }
      : {}),
    ...(shortOptionalText(source.reasonSelected, 180)
      ? { reasonSelected: shortOptionalText(source.reasonSelected, 180) }
      : {}),
    tutorMove,
    expectedStudentAction,
    ...(observedOutcome ? { observedOutcome } : {})
  };
}

export function inferLearningStrategyObservedOutcome(studentMessage: string): LearningStrategyObservedOutcome {
  const normalized = studentMessage.replace(/\s+/g, " ").trim().toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (
    /\b(just|only)\s+(give|tell|show)\s+me\s+(the\s+)?answer\b/.test(normalized) ||
    /\b(give|tell|show)\s+me\s+(the\s+)?(final\s+)?answer\b/.test(normalized) ||
    /\b(still|again)\s+(stuck|confused|lost|don't understand|dont understand)\b/.test(normalized) ||
    /\b(i\s+)?(still\s+)?(don't|dont|do not)\s+(get|understand|know)\b/.test(normalized)
  ) {
    return "student_still_stuck";
  }

  if (/\b(nevermind|never mind|bye|nothing|forget it)\b/.test(normalized)) {
    return "student_disengaged";
  }

  if (
    /\b(i\s+(tried|got|think|used|did|found|answered)|so\s+i|then\s+i|my\s+next\s+step)\b/.test(normalized) ||
    /\b(because|therefore|then|so)\b/.test(normalized) ||
    /(?:=|->|→|\\frac|\\sqrt|\^|∫|√)/.test(studentMessage) ||
    /\b(x|y|n|a|b|c)\s*=\s*[-+*/^(). 0-9a-z]+/i.test(studentMessage)
  ) {
    return "student_progressed";
  }

  return "unknown";
}

export function stripTeacherOnlyTutorResponseFields(response: TutorApiResponse): TutorApiResponse {
  const studentSafeResponse = { ...response };

  delete studentSafeResponse.debugInfo;
  delete studentSafeResponse.hintLevel;
  delete studentSafeResponse.learningStrategyTelemetry;
  delete studentSafeResponse.mode;
  delete studentSafeResponse.studentActionNeeded;

  return studentSafeResponse;
}

function inferTutorMove(response: TutorApiResponse): LearningStrategyTutorMove {
  const hintLevel = response.structuredOutput?.metadata.hintLevel ?? response.hintLevel;
  const mode = response.structuredOutput?.metadata.mode ?? response.mode;

  if (hintLevel === "small_hint") {
    return "small_hint";
  }

  if (hintLevel === "worked_example") {
    return "worked_example";
  }

  if (hintLevel === "refusal") {
    return "refusal_redirect";
  }

  if (mode === "check_work") {
    return "check_work";
  }

  if (mode === "direct_answer_refusal") {
    return "refusal_redirect";
  }

  if (mode === "worked_example") {
    return "worked_example";
  }

  if (mode === "clarification") {
    return "clarification";
  }

  const normalized = response.message.toLowerCase();

  if (/\b(can't|cannot|won't|will not)\s+(give|provide|tell|show).{0,40}\b(answer|final answer)\b/.test(normalized)) {
    return "refusal_redirect";
  }

  if (/\b(check|checking|mistake|error|revise|valid step)\b/.test(normalized)) {
    return "check_work";
  }

  if (/\b(example|similar problem|walk through)\b/.test(normalized)) {
    return "worked_example";
  }

  if (response.sources.length || response.retrievalConfidence === "high" || response.retrievalConfidence === "medium") {
    return "source_grounded_explanation";
  }

  if (/\?/.test(response.message)) {
    return "ask_guiding_question";
  }

  return "small_hint";
}

function inferExpectedStudentAction(
  response: TutorApiResponse,
  tutorMove: LearningStrategyTutorMove
): LearningStrategyExpectedStudentAction {
  const studentActionNeeded = response.structuredOutput?.metadata.studentActionNeeded ?? response.studentActionNeeded;

  if (studentActionNeeded === "show_attempt") {
    return "show_work";
  }

  if (studentActionNeeded === "try_next_step") {
    return "try_next_step";
  }

  if (studentActionNeeded === "answer_question") {
    return "answer_question";
  }

  if (studentActionNeeded === "review_source") {
    return "review_source";
  }

  if (studentActionNeeded === "paste_problem") {
    return "paste_problem";
  }

  const normalized = response.message.toLowerCase();

  if (/\b(paste|send|share).{0,30}\b(problem|question|text|prompt|page)\b/.test(normalized)) {
    return "paste_problem";
  }

  if (/\b(show|share|send|write).{0,30}\b(work|attempt|step|what you tried)\b/.test(normalized)) {
    return "show_work";
  }

  if (/\b(revise|fix|correct|try that step again)\b/.test(normalized) || tutorMove === "check_work") {
    return "revise_step";
  }

  if (/\b(review|look at|read).{0,40}\b(source|page|example|textbook|reading)\b/.test(normalized)) {
    return "review_source";
  }

  if (/\?/.test(response.message) || tutorMove === "ask_guiding_question") {
    return "answer_question";
  }

  return "try_next_step";
}

function findMatchingStrategy(responseText: string, strategies: LearningStrategyProfileStrategy[]) {
  const normalizedResponseWords = new Set(strategyWords(responseText));

  for (const strategy of strategies) {
    const words = strategyWords(strategy.label).filter((word) => !insignificantStrategyWords.has(word));
    const overlap = words.filter((word) => normalizedResponseWords.has(word));

    if (overlap.length >= Math.min(3, words.length) && words.length >= 2) {
      return strategy;
    }
  }

  return undefined;
}

function strategyWords(value: string) {
  return Array.from(new Set(value.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []));
}

function shortOptionalText(value: unknown, maxLength: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : undefined;
}
