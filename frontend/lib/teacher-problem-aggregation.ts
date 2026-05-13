import type { ConversationRecord, MessageRecord } from "./data/conversations.ts";
import type {
  TeacherProblemLevelDistribution,
  TeacherProblemStudentRow,
  TeacherProblemSummaryRow,
  TutorProblemUnderstandingState,
  UnderstandingLevel
} from "./types.ts";

type ProblemStateSnapshot = {
  confusions: string[];
  level: UnderstandingLevel;
  problemId: string;
};

type ProblemStudentAccumulator = {
  conversationIds: Set<string>;
  latestStateAt: number;
  latestUnderstandingLevel: UnderstandingLevel;
  lastActiveAt: number;
  openConversationId?: string;
  studentEmail: string;
  studentId: string;
  studentMessageCount: number;
  studentName: string;
};

type ProblemAccumulator = {
  commonConfusions: Map<string, { count: number; label: string }>;
  conversationIds: Set<string>;
  id: string;
  label: string;
  lastActiveAt: number;
  openConversationId?: string;
  students: Map<string, ProblemStudentAccumulator>;
  totalStudentMessages: number;
};

export function buildTeacherProblemRows({
  conversations,
  messages
}: {
  conversations: ConversationRecord[];
  messages: MessageRecord[];
}): TeacherProblemSummaryRow[] {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const messagesByConversationId = new Map<string, MessageRecord[]>();

  for (const message of messages) {
    if (!conversationsById.has(message.conversationId)) {
      continue;
    }

    const conversationMessages = messagesByConversationId.get(message.conversationId) ?? [];
    conversationMessages.push(message);
    messagesByConversationId.set(message.conversationId, conversationMessages);
  }

  const problemAccumulators = new Map<string, ProblemAccumulator>();

  for (const [conversationId, conversationMessages] of messagesByConversationId) {
    const conversation = conversationsById.get(conversationId);
    if (!conversation) {
      continue;
    }

    const sortedMessages = [...conversationMessages].sort(
      (first, second) => first.createdAt.getTime() - second.createdAt.getTime()
    );
    const nextProblemIds = buildNextProblemIds(sortedMessages);
    let activeProblemId = "";

    sortedMessages.forEach((message, index) => {
      const state = extractProblemState(message.langGraphTrace);
      const messageTime = message.createdAt.getTime();

      if (state) {
        activeProblemId = state.problemId;
        const problem = getProblemAccumulator(problemAccumulators, state.problemId);
        const student = getProblemStudentAccumulator(problem, conversation);

        problem.conversationIds.add(conversation.id);
        problem.lastActiveAt = Math.max(problem.lastActiveAt, messageTime);
        problem.openConversationId = conversation.id;
        student.conversationIds.add(conversation.id);
        if (messageTime >= student.latestStateAt) {
          student.latestUnderstandingLevel = state.level;
          student.latestStateAt = messageTime;
          student.openConversationId = conversation.id;
        }
        student.lastActiveAt = Math.max(student.lastActiveAt, messageTime);

        for (const confusion of state.confusions) {
          const key = confusion.toLowerCase();
          const current = problem.commonConfusions.get(key);
          problem.commonConfusions.set(key, {
            count: (current?.count ?? 0) + 1,
            label: current?.label ?? confusion
          });
        }
      }

      if (message.role === "student") {
        const problemId = activeProblemId || nextProblemIds[index] || "";
        if (!problemId) {
          return;
        }

        const problem = getProblemAccumulator(problemAccumulators, problemId);
        const student = getProblemStudentAccumulator(problem, conversation);

        problem.conversationIds.add(conversation.id);
        problem.totalStudentMessages += 1;
        problem.lastActiveAt = Math.max(problem.lastActiveAt, messageTime);
        problem.openConversationId = conversation.id;
        student.conversationIds.add(conversation.id);
        student.studentMessageCount += 1;
        student.lastActiveAt = Math.max(student.lastActiveAt, messageTime);
        student.openConversationId = conversation.id;
      }
    });
  }

  return [...problemAccumulators.values()]
    .filter((problem) => problem.students.size > 0)
    .map(finalizeProblemRow)
    .sort(
      (first, second) =>
        first.averageUnderstandingLevel - second.averageUnderstandingLevel ||
        second.studentCount - first.studentCount ||
        timestampMillis(second.lastActive) - timestampMillis(first.lastActive) ||
        first.label.localeCompare(second.label)
    );
}

function buildNextProblemIds(messages: MessageRecord[]) {
  const nextProblemIds: string[] = new Array(messages.length).fill("");
  let nextProblemId = "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    nextProblemIds[index] = nextProblemId;
    const state = extractProblemState(messages[index].langGraphTrace);
    if (state) {
      nextProblemId = state.problemId;
    }
  }

  return nextProblemIds;
}

function extractProblemState(langGraphTrace: unknown): ProblemStateSnapshot | null {
  if (!isRecord(langGraphTrace) || !isRecord(langGraphTrace.problemUnderstandingState)) {
    return null;
  }

  const state = langGraphTrace.problemUnderstandingState as TutorProblemUnderstandingState;
  const problemId = normalizeActiveProblemId(state.activeProblemId);
  if (!problemId) {
    return null;
  }

  return {
    confusions: normalizeConfusions(state.knownConfusions),
    level: normalizeUnderstandingLevel(state.understandingLevel ?? state.level),
    problemId
  };
}

function getProblemAccumulator(accumulators: Map<string, ProblemAccumulator>, problemId: string) {
  const existing = accumulators.get(problemId);
  if (existing) {
    return existing;
  }

  const next: ProblemAccumulator = {
    commonConfusions: new Map(),
    conversationIds: new Set(),
    id: problemId,
    label: formatProblemLabel(problemId),
    lastActiveAt: 0,
    students: new Map(),
    totalStudentMessages: 0
  };
  accumulators.set(problemId, next);
  return next;
}

function getProblemStudentAccumulator(problem: ProblemAccumulator, conversation: ConversationRecord) {
  const studentKey = conversation.studentId || conversation.studentEmail || conversation.studentName || conversation.id;
  const existing = problem.students.get(studentKey);
  if (existing) {
    return existing;
  }

  const next: ProblemStudentAccumulator = {
    conversationIds: new Set(),
    latestStateAt: 0,
    latestUnderstandingLevel: 0,
    lastActiveAt: 0,
    studentEmail: conversation.studentEmail,
    studentId: conversation.studentId ?? "",
    studentMessageCount: 0,
    studentName: conversation.studentName || conversation.studentEmail || "Student"
  };
  problem.students.set(studentKey, next);
  return next;
}

function finalizeProblemRow(problem: ProblemAccumulator): TeacherProblemSummaryRow {
  const students = [...problem.students.values()].map(finalizeStudentRow).sort(
    (first, second) =>
      first.latestUnderstandingLevel - second.latestUnderstandingLevel ||
      timestampMillis(second.lastActive) - timestampMillis(first.lastActive) ||
      first.studentName.localeCompare(second.studentName)
  );
  const levelDistribution: TeacherProblemLevelDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let levelTotal = 0;

  for (const student of students) {
    levelDistribution[student.latestUnderstandingLevel] += 1;
    levelTotal += student.latestUnderstandingLevel;
  }

  return {
    averageConversationsPerStudent: students.length ? roundToTenth(problem.conversationIds.size / students.length) : 0,
    averageUnderstandingLevel: students.length ? roundToTenth(levelTotal / students.length) : 0,
    commonConfusions: [...problem.commonConfusions.values()]
      .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label))
      .map((confusion) => confusion.label)
      .slice(0, 5),
    conversationCount: problem.conversationIds.size,
    conversationIds: [...problem.conversationIds],
    id: problem.id,
    label: problem.label,
    lastActive: problem.lastActiveAt ? new Date(problem.lastActiveAt).toISOString() : "",
    levelDistribution,
    openConversationId: problem.openConversationId,
    studentCount: students.length,
    students,
    totalStudentMessages: problem.totalStudentMessages
  };
}

function finalizeStudentRow(student: ProblemStudentAccumulator): TeacherProblemStudentRow {
  return {
    conversationCount: student.conversationIds.size,
    conversationIds: [...student.conversationIds],
    latestUnderstandingLevel: student.latestUnderstandingLevel,
    lastActive: student.lastActiveAt ? new Date(student.lastActiveAt).toISOString() : "",
    openConversationId: student.openConversationId,
    studentEmail: student.studentEmail,
    studentId: student.studentId,
    studentMessageCount: student.studentMessageCount,
    studentName: student.studentName
  };
}

export function normalizeActiveProblemId(value: unknown) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const lower = normalized.toLowerCase();

  if (!normalized || ["unknown", "none", "null", "undefined", "n/a", "na", "no active problem"].includes(lower)) {
    return "";
  }

  return normalized;
}

function formatProblemLabel(problemId: string) {
  return problemId.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeUnderstandingLevel(value: unknown): UnderstandingLevel {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
    return parsed as UnderstandingLevel;
  }
  return 0;
}

function normalizeConfusions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const confusions: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    confusions.push(text.slice(0, 120));
  }

  return confusions;
}

function roundToTenth(value: number) {
  return Math.round(value * 10) / 10;
}

function timestampMillis(value: unknown) {
  const millis = new Date(String(value ?? "")).getTime();
  return Number.isNaN(millis) ? 0 : millis;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
