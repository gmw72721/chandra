"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";
import { apiUrl } from "./api-client";
import { generateClassCode } from "./class-code";
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
  type TutorBehavior
} from "./class-settings";
import { auth, db, isFirebaseConfigured } from "./firebase";
import type { TutorKnowledgeKind, TutorKnowledgeSourceMode } from "./tutor-knowledge";
import type { TutorKnowledgePriority } from "./types";

const maxClassCodeAttempts = 10;

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
  createdAt?: unknown;
};

export type ClassStudent = {
  id: string;
  email: string;
  displayName: string;
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
  priority?: TutorKnowledgePriority;
  requireCitations?: boolean;
  sourceMode?: TutorKnowledgeSourceMode;
  status: "uploaded" | "processing" | "ready";
  teacherOnly?: boolean;
  addedAt?: unknown;
};

export type MaterialJobStep =
  | "upload_received"
  | "reading_file"
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
  assertFirestoreReady();

  return onSnapshot(
    collection(db!, "classes", classId, "materials"),
    (snapshot) => {
      const materials = snapshot.docs
        .map((materialDoc) => ({ id: materialDoc.id, ...materialDoc.data() }) as ClassMaterial)
        .sort((firstMaterial, secondMaterial) => firstMaterial.title.localeCompare(secondMaterial.title));

      callback(materials);
    },
    (error) => onError?.(error)
  );
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

  const classReference = doc(db!, "classes", classId);
  const classSnapshot = await getDoc(classReference);

  if (!classSnapshot.exists()) {
    throw new Error("Class not found.");
  }

  const existingJoinCode = classSnapshot.data().joinCode;

  if (typeof existingJoinCode === "string" && existingJoinCode.trim()) {
    return existingJoinCode;
  }

  const joinCode = await createUniqueClassCode();
  await updateDoc(classReference, { joinCode });

  return joinCode;
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
  themeColor: TeacherClassThemeColor;
}) {
  assertFirestoreReady();

  await updateDoc(doc(db!, "classes", classId), {
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
    themeColor: normalizeTeacherClassThemeColor(themeColor)
  });
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

  const normalizedEmail = email.trim().toLowerCase();
  const studentId = encodeURIComponent(normalizedEmail);

  await setDoc(doc(db!, "classes", classId, "students", studentId), {
    email: normalizedEmail,
    displayName: displayName.trim(),
    addedAt: serverTimestamp()
  });
}

function assertFirestoreReady() {
  if (!isFirebaseConfigured || !db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values to .env.local.");
  }
}

async function createUniqueClassCode() {
  for (let attempt = 0; attempt < maxClassCodeAttempts; attempt += 1) {
    const classCode = generateClassCode();

    if (await isClassCodeAvailable(classCode)) {
      return classCode;
    }
  }

  throw new Error("Could not create a unique class code. Please try again.");
}

async function isClassCodeAvailable(classCode: string) {
  const classSnapshot = await getDoc(doc(db!, "classes", classCode));

  if (classSnapshot.exists()) {
    return false;
  }

  const joinCodeSnapshot = await getDocs(
    query(collection(db!, "classes"), where("joinCode", "==", classCode), limit(1))
  );

  return joinCodeSnapshot.empty;
}
