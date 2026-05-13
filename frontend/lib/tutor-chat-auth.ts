import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import { normalizeTutorAccessSettings } from "./class-settings";
import { resolveStudentChatClassId, StudentChatScopeError } from "./student-chat-scope";

export type AuthorizedTutorChatScope = {
  classId: string;
  professorId: string;
  professorName?: string;
  role: "student" | "teacher";
  uid: string;
};

type TutorChatAuthorizationOptions = {
  enforceStudentChatAccess?: boolean;
};

export class TutorChatHttpError extends Error {
  classId?: string;
  decision?: "class_chat_disabled" | "student_chat_blocked";
  status: number;
  userId?: string;

  constructor(message: string, status: number, metadata: {
    classId?: string;
    decision?: "class_chat_disabled" | "student_chat_blocked";
    userId?: string;
  } = {}) {
    super(message);
    this.classId = metadata.classId;
    this.decision = metadata.decision;
    this.status = status;
    this.userId = metadata.userId;
  }
}

export async function authorizeTutorChatRequest(
  request: Request,
  requestedCourseId?: string,
  options: TutorChatAuthorizationOptions = {}
): Promise<AuthorizedTutorChatScope> {
  const token = getBearerToken(request);

  if (!token) {
    throw new TutorChatHttpError("Sign in before chatting with the tutor.", 401);
  }

  assertFirebaseAdminAuthReady();

  const decodedToken = await adminAuth!.verifyIdToken(token);
  const userSnapshot = await adminDb!.collection("users").doc(decodedToken.uid).get();

  if (!userSnapshot.exists) {
    throw new TutorChatHttpError("Create a student or teacher profile before chatting.", 403);
  }

  const profile = userSnapshot.data();

  if (!profile) {
    throw new TutorChatHttpError("Create a student or teacher profile before chatting.", 403);
  }

  const role = profile?.role;

  if (role === "student") {
    const classId = resolveStudentClassId({
      requestedCourseId,
      savedClassId: String(profile.classId ?? "")
    });
    const classScope = await getClassProfessorScope(classId);
    if (options.enforceStudentChatAccess !== false) {
      await assertStudentChatAccess({
        classData: classScope.classData,
        classId,
        profile,
        uid: decodedToken.uid
      });
    }
    return { classId, ...classScope, role, uid: decodedToken.uid };
  }

  if (role === "teacher") {
    const classId = requestedCourseId?.trim() ?? "";

    if (!classId) {
      throw new TutorChatHttpError("Choose a class before previewing student chat.", 400);
    }

    const classScope = await getClassProfessorScope(classId);

    if (!classScope.allowedTeacherIds.has(decodedToken.uid)) {
      throw new TutorChatHttpError("Only this class's teachers can preview this chat.", 403);
    }

    return { classId, ...classScope, role, uid: decodedToken.uid };
  }

  throw new TutorChatHttpError("Use a student account to chat with the tutor.", 403);
}

function resolveStudentClassId(input: { requestedCourseId?: string; savedClassId?: string }) {
  try {
    return resolveStudentChatClassId(input);
  } catch (caughtError) {
    if (caughtError instanceof StudentChatScopeError) {
      throw new TutorChatHttpError(caughtError.message, caughtError.status);
    }

    throw caughtError;
  }
}

async function getClassProfessorScope(classId: string) {
  const classSnapshot = await adminDb!.collection("classes").doc(classId).get();

  if (!classSnapshot.exists) {
    throw new TutorChatHttpError("Your saved class was not found. Ask your teacher for the current class code.", 404);
  }

  const classData = classSnapshot.data() ?? {};
  const professorId = String(classData.teacherId ?? classData.professorId ?? "").trim();
  const allowedTeacherIds = new Set<string>();

  if (professorId) {
    allowedTeacherIds.add(professorId);
  }

  for (const [uid, role] of Object.entries(readCoTeacherRoles(classData.coTeachers))) {
    if (role === "owner" || role === "co-teacher") {
      allowedTeacherIds.add(uid);
    }
  }

  if (!professorId) {
    throw new TutorChatHttpError("This class is missing teacher ownership metadata.", 403);
  }

  return {
    allowedTeacherIds,
    classData,
    professorId,
    professorName: String(classData.teacherName ?? classData.professorName ?? "").trim() || undefined
  };
}

async function assertStudentChatAccess({
  classData,
  classId,
  profile,
  uid
}: {
  classData: Record<string, unknown>;
  classId: string;
  profile: Record<string, unknown>;
  uid: string;
}) {
  const tutorAccess = normalizeTutorAccessSettings(classData.tutorAccess ?? {
    enabled: classData.studentChatEnabled
  });

  if (!tutorAccess.enabled) {
    throw new TutorChatHttpError("Your teacher has paused chat for this class.", 403, {
      classId,
      decision: "class_chat_disabled",
      userId: uid
    });
  }

  const studentEmail = String(profile.email ?? "").trim().toLowerCase();
  const supportDocumentId = encodeURIComponent(studentEmail);
  const supportSnapshot = studentEmail
    ? await adminDb!
        .collection("classes")
        .doc(classId)
        .collection("studentSupport")
        .doc(supportDocumentId)
        .get()
    : null;
  const rosterSnapshot = studentEmail
    ? await adminDb!
        .collection("classes")
        .doc(classId)
        .collection("students")
        .doc(supportDocumentId)
        .get()
    : null;
  const chatBlocked =
    supportSnapshot?.data()?.chatBlocked === true ||
    rosterSnapshot?.data()?.chatBlocked === true;

  if (chatBlocked) {
    throw new TutorChatHttpError("Chat is paused for this account.", 403, {
      classId,
      decision: "student_chat_blocked",
      userId: uid
    });
  }
}

function readCoTeacherRoles(coTeachers: unknown): Record<string, string> {
  if (!coTeachers || typeof coTeachers !== "object" || Array.isArray(coTeachers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(coTeachers as Record<string, unknown>).flatMap(([uid, coTeacher]) => {
      if (!coTeacher || typeof coTeacher !== "object" || Array.isArray(coTeacher)) {
        return [];
      }

      const role = (coTeacher as Record<string, unknown>).role;

      return typeof role === "string" ? [[uid, role]] : [];
    })
  );
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
