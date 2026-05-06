export class StudentChatScopeError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function resolveStudentChatClassId({
  requestedCourseId,
  savedClassId
}: {
  requestedCourseId?: string;
  savedClassId?: string;
}) {
  const cleanSavedClassId = savedClassId?.trim() ?? "";

  if (!cleanSavedClassId) {
    throw new StudentChatScopeError("Your student profile needs a class before using the tutor.", 403);
  }

  return cleanSavedClassId;
}
