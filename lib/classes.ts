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
import { generateClassCode } from "./class-code";
import {
  defaultAnswerPolicySettings,
  defaultAssignmentContext,
  defaultClassModelSettings,
  defaultRefusalStyle,
  defaultSourceUsageSettings,
  type AnswerPolicySettings,
  type ClassModelSettings,
  type SourceUsageSettings,
  type TutorBehavior
} from "./class-settings";
import { db, isFirebaseConfigured } from "./firebase";
import type { TutorKnowledgeKind, TutorKnowledgeSourceMode } from "./tutor-knowledge";
import type { TutorKnowledgePriority } from "./types";

const maxClassCodeAttempts = 10;

export type TeacherClass = {
  id: string;
  name: string;
  section: string;
  teacherId: string;
  teacherName: string;
  joinCode?: string;
  answerPolicy?: AnswerPolicySettings;
  behaviorTitle?: TutorBehavior;
  behaviorInstructions?: string;
  defaultAssignmentContext?: string;
  modelSettings?: ClassModelSettings;
  refusalStyle?: string;
  sourceUsage?: SourceUsageSettings;
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

  return onSnapshot(
    classesQuery,
    (snapshot) => {
      const classes = snapshot.docs
        .map((classDoc) => ({ id: classDoc.id, ...classDoc.data() }) as TeacherClass)
        .sort((firstClass, secondClass) => firstClass.name.localeCompare(secondClass.name));

      callback(classes);
    },
    (error) => onError?.(error)
  );
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

  const classCode = await createUniqueClassCode();
  const classReference = doc(db!, "classes", classCode);

  await setDoc(classReference, {
    name: name.trim(),
    section: section.trim(),
    teacherId,
    teacherName,
    joinCode: classCode,
    behaviorTitle: "Guided problem solving",
    answerPolicy: defaultAnswerPolicySettings,
    behaviorInstructions: [
      "Ask students to explain their thinking before giving hints.",
      "Do not provide final answers unless the student has already shown the main reasoning.",
      "Use course materials before generic explanations when relevant."
    ].join("\n"),
    defaultAssignmentContext,
    modelSettings: defaultClassModelSettings,
    refusalStyle: defaultRefusalStyle,
    sourceUsage: defaultSourceUsageSettings,
    createdAt: serverTimestamp()
  });

  return classReference;
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
  behaviorInstructions,
  behaviorTitle,
  classId,
  defaultAssignmentContext,
  modelSettings,
  name,
  refusalStyle,
  section,
  sourceUsage
}: {
  answerPolicy: AnswerPolicySettings;
  behaviorInstructions: string;
  behaviorTitle: TutorBehavior;
  classId: string;
  defaultAssignmentContext: string;
  modelSettings: ClassModelSettings;
  name: string;
  refusalStyle: string;
  section: string;
  sourceUsage: SourceUsageSettings;
}) {
  assertFirestoreReady();

  await updateDoc(doc(db!, "classes", classId), {
    answerPolicy,
    behaviorInstructions: behaviorInstructions.trim(),
    behaviorTitle: behaviorTitle.trim(),
    defaultAssignmentContext: defaultAssignmentContext.trim(),
    modelSettings,
    name: name.trim(),
    refusalStyle: refusalStyle.trim(),
    section: section.trim(),
    sourceUsage
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
