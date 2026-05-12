"use client";

import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where
} from "firebase/firestore";
import { apiUrl } from "./api-client";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  type TeacherClassAppearance,
  type TeacherClassThemeColor
} from "./class-theme";
import {
  type AnswerPolicySettings,
  type ClassModelSettings,
  type ClassCoTeacher,
  type ClassPrivacySettings,
  type NotificationSettings,
  type ResponseFormatSettings,
  type SourceDefaultsSettings,
  type SourceUsageSettings,
  type TutorAccessSettings,
  type TutorBehavior
} from "./class-settings";
import { auth, db, isFirebaseConfigured } from "./firebase";
import type { TutorKnowledgeKind, TutorKnowledgeSourceMode } from "./tutor-knowledge";
import type { TutorKnowledgePriority } from "./types";

export type TeacherClass = {
  id: string;
  name: string;
  section: string;
  teacherId: string;
  teacherName: string;
  appearance?: TeacherClassAppearance;
  themeColor?: TeacherClassThemeColor;
  joinCode?: string;
  answerPolicy?: AnswerPolicySettings;
  behaviorTitle?: TutorBehavior;
  behaviorInstructions?: string;
  coTeacherIds?: string[];
  coTeachers?: Record<string, ClassCoTeacher>;
  defaultAssignmentContext?: string;
  modelSettings?: ClassModelSettings;
  notificationSettings?: NotificationSettings;
  openingMessage?: string;
  privacySettings?: ClassPrivacySettings;
  refusalStyle?: string;
  responseFormat?: ResponseFormatSettings;
  sourceDefaults?: SourceDefaultsSettings;
  sourceUsage?: SourceUsageSettings;
  studentFacingInstructions?: string;
  studentChatEnabled?: boolean;
  tutorAccess?: TutorAccessSettings;
  createdAt?: unknown;
};

export type ClassStudent = {
  id: string;
  email: string;
  displayName: string;
  chatBlocked?: boolean;
  addedAt?: unknown;
};

export type ClassMaterial = {
  id: string;
  title: string;
  kind: TutorKnowledgeKind;
  activeForStudents?: boolean;
  citationsRequired?: boolean;
  fileName?: string;
  filePath?: string;
  fileUrl?: string;
  contentType?: string;
  fileSize?: number;
  characterCount?: number;
  chunkCount?: number;
  metadata?: Record<string, unknown>;
  ocrPageCount?: number;
  pageCount?: number;
  priority?: TutorKnowledgePriority;
  requireCitations?: boolean;
  sourceMode?: TutorKnowledgeSourceMode;
  status: "uploaded" | "processing" | "ready" | "failed";
  teacherOnly?: boolean;
  visualPageCount?: number;
  addedAt?: unknown;
  processingJob?: MaterialJobProgress;
};

export type MaterialJobStep =
  | "upload_received"
  | "reading_file"
  | "ocr_material"
  | "chunking_material"
  | "embedding_chunks"
  | "saving_to_class"
  | "ready"
  | "failed";

export type MaterialJobProgress = {
  id: string;
  classId: string;
  completedChunks?: number;
  detail: string;
  error?: string;
  materialId?: string;
  percent: number;
  step: MaterialJobStep;
  title?: string;
  totalChunks?: number;
  updatedAt?: unknown;
};

export function subscribeToTeacherClasses(
  teacherId: string,
  callback: (classes: TeacherClass[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  const classesQuery = query(collection(db!, "classes"), where("teacherId", "==", teacherId));
  const coTeacherClassesQuery = query(collection(db!, "classes"), where("coTeacherIds", "array-contains", teacherId));
  const classMap = new Map<string, TeacherClass>();
  const emitClasses = () => {
    callback(Array.from(classMap.values()).sort((firstClass, secondClass) => firstClass.name.localeCompare(secondClass.name)));
  };

  const unsubscribeOwned = onSnapshot(
    classesQuery,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          classMap.delete(change.doc.id);
        } else {
          classMap.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as TeacherClass);
        }
      });
      emitClasses();
    },
    (error) => onError?.(error)
  );
  const unsubscribeCoTeacher = onSnapshot(
    coTeacherClassesQuery,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          classMap.delete(change.doc.id);
        } else {
          classMap.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as TeacherClass);
        }
      });
      emitClasses();
    },
    (error) => onError?.(error)
  );

  return () => {
    unsubscribeOwned();
    unsubscribeCoTeacher();
  };
}

export function subscribeToMaterialJob(
  classId: string,
  jobId: string,
  callback: (progress: MaterialJobProgress | null) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  return onSnapshot(
    doc(db!, "classes", classId, "materialJobs", jobId),
    (snapshot) => {
      callback(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as MaterialJobProgress) : null);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToClass(
  classId: string,
  callback: (teacherClass: TeacherClass | null) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  return onSnapshot(
    doc(db!, "classes", classId),
    (snapshot) => {
      callback(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as TeacherClass) : null);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToClassStudents(
  classId: string,
  callback: (students: ClassStudent[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  return onSnapshot(
    collection(db!, "classes", classId, "students"),
    (snapshot) => {
      const students = snapshot.docs
        .map((studentDoc) => ({ id: studentDoc.id, ...studentDoc.data() }) as ClassStudent)
        .sort((firstStudent, secondStudent) => firstStudent.email.localeCompare(secondStudent.email));

      callback(students);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToClassMaterials(
  classId: string,
  callback: (materials: ClassMaterial[]) => void,
  onError?: (error: Error) => void
) {
  let isSubscribed = true;
  let pollTimer: number | undefined;

  const loadMaterials = async () => {
    try {
      if (!auth?.currentUser) {
        throw new Error("Sign in as the class teacher to load tutor knowledge.");
      }

      const token = await auth.currentUser.getIdToken();
      const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(classId)}/materials`), {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; materials?: ClassMaterial[] };

      if (!response.ok) {
        throw new Error(data.error ?? "Tutor knowledge load failed.");
      }

      if (isSubscribed) {
        callback((data.materials ?? []).sort((firstMaterial, secondMaterial) => firstMaterial.title.localeCompare(secondMaterial.title)));
      }
    } catch (caughtError) {
      if (isSubscribed) {
        onError?.(caughtError instanceof Error ? caughtError : new Error("Tutor knowledge load failed."));
      }
    } finally {
      if (isSubscribed) {
        pollTimer = window.setTimeout(loadMaterials, 3000);
      }
    }
  };

  void loadMaterials();

  return () => {
    isSubscribed = false;

    if (pollTimer) {
      window.clearTimeout(pollTimer);
    }
  };
}

export async function createTeacherClass({
  name,
  section,
  teacherId,
  teacherName
}: {
  name: string;
  section: string;
  teacherId: string;
  teacherName: string;
}) {
  assertFirestoreReady();

  if (!auth?.currentUser || auth.currentUser.uid !== teacherId) {
    throw new Error("Sign in as the class teacher to create a class.");
  }

  const token = await auth.currentUser.getIdToken();
  const response = await fetch(apiUrl("/api/classes"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      section,
      teacherName
    })
  });
  const data = (await response.json()) as { class?: { id?: string }; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Class creation failed.");
  }

  return { id: data.class?.id ?? "" };
}

export async function ensureClassJoinCode(classId: string) {
  assertFirestoreReady();

  const classSnapshot = await getDoc(doc(db!, "classes", classId));
  const existingJoinCode = classSnapshot.exists() ? classSnapshot.data().joinCode : "";

  if (typeof existingJoinCode === "string" && existingJoinCode.trim()) {
    return existingJoinCode;
  }

  if (!auth?.currentUser) {
    throw new Error("Sign in as the class teacher to create an invite code.");
  }

  const token = await auth.currentUser.getIdToken();
  const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(classId)}/invite-code`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; joinCode?: string };

  if (!response.ok || !data.joinCode) {
    throw new Error(data.error ?? "Class invite code reset failed.");
  }

  return data.joinCode;
}

export async function updateTeacherClassSettings({
  answerPolicy,
  appearance,
  behaviorInstructions,
  behaviorTitle,
  classId,
  defaultAssignmentContext,
  modelSettings,
  name,
  notificationSettings,
  openingMessage,
  privacySettings,
  refusalStyle,
  responseFormat,
  section,
  sourceDefaults,
  sourceUsage,
  studentFacingInstructions,
  tutorAccess,
  themeColor
}: {
  answerPolicy: AnswerPolicySettings;
  appearance: TeacherClassAppearance;
  behaviorInstructions: string;
  behaviorTitle: TutorBehavior;
  classId: string;
  defaultAssignmentContext: string;
  modelSettings: ClassModelSettings;
  name: string;
  notificationSettings: NotificationSettings;
  openingMessage: string;
  privacySettings: ClassPrivacySettings;
  refusalStyle: string;
  responseFormat: ResponseFormatSettings;
  section: string;
  sourceDefaults: SourceDefaultsSettings;
  sourceUsage: SourceUsageSettings;
  studentFacingInstructions: string;
  tutorAccess: TutorAccessSettings;
  themeColor: TeacherClassThemeColor;
}) {
  assertFirestoreReady();

  if (!auth?.currentUser) {
    throw new Error("Sign in as the class teacher to update class settings.");
  }

  const token = await auth.currentUser.getIdToken();
  const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(classId)}/settings`), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      answerPolicy,
      appearance: normalizeTeacherClassAppearance(appearance),
      behaviorInstructions: behaviorInstructions.trim(),
      behaviorTitle: behaviorTitle.trim(),
      defaultAssignmentContext: defaultAssignmentContext.trim(),
      modelSettings,
      name: name.trim(),
      notificationSettings,
      openingMessage: openingMessage.trim(),
      privacySettings,
      refusalStyle: refusalStyle.trim(),
      responseFormat,
      section: section.trim(),
      sourceDefaults,
      sourceUsage,
      studentFacingInstructions: studentFacingInstructions.trim(),
      studentChatEnabled: tutorAccess.enabled,
      tutorAccess,
      themeColor: normalizeTeacherClassThemeColor(themeColor)
    })
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Class settings update failed.");
  }
}

export async function addStudentToClass({
  classId,
  displayName,
  email
}: {
  classId: string;
  displayName: string;
  email: string;
}) {
  assertFirestoreReady();
  if (!auth?.currentUser) {
    throw new Error("Sign in as the class teacher to add students.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(apiUrl(`/api/classes/${encodeURIComponent(classId)}/students`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName,
      email: normalizedEmail
    })
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Student add failed.");
  }
}

function assertFirestoreReady() {
  if (!isFirebaseConfigured || !db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values to .env.local.");
  }
}
