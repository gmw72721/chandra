import { listClassConversations, listClassConversationMessages } from "./data/conversations";
import { assertFirebaseAdminAuthReady } from "./firebase-admin";
import { buildTeacherProblemRows } from "./teacher-problem-aggregation";
import type { TeacherProblemSummaryRow } from "./types";

export async function getTeacherClassProblems({
  classId
}: {
  classId: string;
}): Promise<TeacherProblemSummaryRow[]> {
  assertFirebaseAdminAuthReady();

  const [conversations, messages] = await Promise.all([
    listClassConversations(classId),
    listClassConversationMessages(classId)
  ]);

  return buildTeacherProblemRows({ conversations, messages });
}
