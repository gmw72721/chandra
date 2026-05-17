import { NextResponse } from "next/server";
import { getAccountProfile, getClassSnapshotPostgresFirst, listStudentClassIdsPostgresFirst } from "@/lib/data/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor
} from "@/lib/class-theme";

export const runtime = "nodejs";

type StudentClassSummary = {
  appearance: string;
  chatBlocked: boolean;
  chatBlockedReason?: string;
  chatBlockedUntil?: string | null;
  id: string;
  joinCode?: string;
  name: string;
  openingMessage?: string;
  section: string;
  studentPromptPlaceholder?: string;
  studentChatEnabled: boolean;
  themeColor: string;
};

export async function GET(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before loading your classes." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const profile = await getAccountProfile(decodedToken.uid);

    if (profile?.role !== "student") {
      return NextResponse.json({ error: "Use a student account to load classes." }, { status: 403 });
    }

    const activeClassId = String(profile.classId ?? "").trim();
    const enrolledClassIds = Array.isArray(profile.classIds) ? profile.classIds : [];
    const email = String(profile.email ?? decodedToken.email ?? "").trim().toLowerCase();
    const classIds = new Set<string>();

    if (activeClassId) {
      classIds.add(activeClassId);
    }

    for (const classId of enrolledClassIds) {
      if (typeof classId === "string" && classId.trim()) {
        classIds.add(classId.trim());
      }
    }

    if (email) {
      const postgresClassIds = await listStudentClassIdsPostgresFirst({ email, studentId: decodedToken.uid });

      for (const classId of postgresClassIds) {
        classIds.add(classId);
      }

      const rosterClassIds = await getRosterClassIdsByEmail(email);

      for (const classId of rosterClassIds) {
        classIds.add(classId);
      }
    }

    const uidRosterClassIds = await getRosterClassIdsByUid(decodedToken.uid);

    for (const classId of uidRosterClassIds) {
      classIds.add(classId);
    }

    const studentIdentity = {
      email,
      uid: decodedToken.uid
    };
    const classResults = await Promise.all(
      Array.from(classIds).map((classId) => getStudentClassSummary(classId, studentIdentity))
    );
    const classes = classResults
      .filter((teacherClass): teacherClass is StudentClassSummary => teacherClass !== null)
      .sort((firstClass, secondClass) =>
        [firstClass.name, firstClass.section].join(" ").localeCompare([secondClass.name, secondClass.section].join(" "))
      );

    return NextResponse.json({ activeClassId, classes });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    console.error("Student classes failed to load.", caughtError);

    return NextResponse.json({ error: "Student classes failed to load." }, { status: 500 });
  }
}

async function getRosterClassIdsByEmail(email: string) {
  try {
    const rosterSnapshot = await adminDb!
      .collectionGroup("students")
      .where("email", "==", email)
      .get();
    const classIds = new Set<string>();

    for (const rosterDoc of rosterSnapshot.docs) {
      const classReference = rosterDoc.ref.parent.parent;

      if (classReference) {
        classIds.add(classReference.id);
      }
    }

    return classIds;
  } catch (caughtError) {
    console.warn("Student roster class lookup failed; falling back to profile class ids.", caughtError);
    return new Set<string>();
  }
}

async function getRosterClassIdsByUid(uid: string) {
  try {
    const rosterSnapshot = await adminDb!
      .collectionGroup("students")
      .where("uid", "==", uid)
      .get();
    const classIds = new Set<string>();

    for (const rosterDoc of rosterSnapshot.docs) {
      const classReference = rosterDoc.ref.parent.parent;

      if (classReference) {
        classIds.add(classReference.id);
      }
    }

    return classIds;
  } catch (caughtError) {
    console.warn("Student roster uid lookup failed; falling back to profile class ids.", caughtError);
    return new Set<string>();
  }
}

async function getStudentClassSummary(
  classId: string,
  studentIdentity: { email: string; uid: string }
): Promise<StudentClassSummary | null> {
  const classSnapshot = await getClassSnapshotPostgresFirst(classId);

  if (!classSnapshot.exists) {
    return null;
  }

  const classData = classSnapshot.data;
  const chatBlock = await getStudentChatBlock(classId, studentIdentity);

  return {
    appearance: normalizeTeacherClassAppearance(classData.appearance),
    chatBlocked: chatBlock.chatBlocked,
    chatBlockedReason: chatBlock.chatBlockedReason,
    chatBlockedUntil: chatBlock.chatBlockedUntil,
    id: classSnapshot.id,
    ...(String(classData.joinCode ?? "").trim() ? { joinCode: String(classData.joinCode ?? "").trim() } : {}),
    name: String(classData.name ?? "Saved class").trim() || "Saved class",
    ...(String(classData.openingMessage ?? "").trim()
      ? { openingMessage: String(classData.openingMessage ?? "").trim() }
      : {}),
    section: String(classData.section ?? "").trim(),
    ...(String(classData.studentPromptPlaceholder ?? "").trim()
      ? { studentPromptPlaceholder: String(classData.studentPromptPlaceholder ?? "").trim() }
      : {}),
    studentChatEnabled: readTutorAccessEnabled(classData.tutorAccess) !== false && classData.studentChatEnabled !== false,
    themeColor: normalizeTeacherClassThemeColor(classData.themeColor)
  };
}

async function getStudentChatBlock(classId: string, { email, uid }: { email: string; uid: string }) {
  const supportDocumentId = email ? encodeURIComponent(email) : "";
  const [supportSnapshot, rosterSnapshot, uidRosterSnapshot] = await Promise.all([
    supportDocumentId
      ? adminDb!
          .collection("classes")
          .doc(classId)
          .collection("studentSupport")
          .doc(supportDocumentId)
          .get()
      : null,
    supportDocumentId
      ? adminDb!
          .collection("classes")
          .doc(classId)
          .collection("students")
          .doc(supportDocumentId)
          .get()
      : null,
    adminDb!
      .collection("classes")
      .doc(classId)
      .collection("students")
      .where("uid", "==", uid)
      .limit(1)
      .get()
  ]);
  const uidRosterDoc = uidRosterSnapshot.docs[0] ?? null;
  const block = activeStudentChatBlock([supportSnapshot?.data(), rosterSnapshot?.data(), uidRosterDoc?.data()]);

  return block;
}

function activeStudentChatBlock(records: Array<Record<string, unknown> | undefined>) {
  const now = Date.now();

  for (const record of records) {
    if (!record || record.chatBlocked !== true) {
      continue;
    }

    const pausedUntil = parseTimestampMillis(record.chatBlockedUntil);

    if (pausedUntil && pausedUntil > now) {
      return {
        chatBlocked: true,
        chatBlockedReason: String(record.chatBlockedReason ?? ""),
        chatBlockedUntil: new Date(pausedUntil).toISOString()
      };
    }

    if (!pausedUntil) {
      return {
        chatBlocked: true,
        chatBlockedReason: String(record.chatBlockedReason ?? ""),
        chatBlockedUntil: null
      };
    }
  }

  return { chatBlocked: false, chatBlockedReason: "", chatBlockedUntil: null };
}

function parseTimestampMillis(value: unknown) {
  const serialized =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
        ? (value.toDate() as Date).toISOString()
        : "";
  const timestamp = serialized ? new Date(serialized).getTime() : 0;

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function readTutorAccessEnabled(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { enabled?: unknown }).enabled
    : undefined;
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
