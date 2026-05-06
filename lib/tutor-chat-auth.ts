import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import { resolveStudentChatClassId, StudentChatScopeError } from "./student-chat-scope";

export type AuthorizedTutorChatScope = {
  classId: string;
  professorId: string;
  professorName?: string;
  role: "student" | "teacher";
  uid: string;
};

export class TutorChatHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function authorizeTutorChatRequest(
  request: Request,
  requestedCourseId?: string
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
    return { classId, ...classScope, role, uid: decodedToken.uid };
  }

  if (role === "teacher") {
    const classId = requestedCourseId?.trim() ?? "";

    if (!classId) {
      throw new TutorChatHttpError("Choose a class before previewing student chat.", 400);
    }

    const classScope = await getClassProfessorScope(classId);

    if (classScope.professorId !== decodedToken.uid) {
      throw new TutorChatHttpError("Only the class teacher can preview this chat.", 403);
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

  if (!professorId) {
    throw new TutorChatHttpError("This class is missing teacher ownership metadata.", 403);
  }

  return {
    professorId,
    professorName: String(classData.teacherName ?? classData.professorName ?? "").trim() || undefined
  };
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
