import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor
} from "@/lib/class-theme";

export const runtime = "nodejs";

type StudentClassSummary = {
  appearance: string;
  id: string;
  joinCode?: string;
  name: string;
  openingMessage?: string;
  section: string;
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
    const profileSnapshot = await adminDb!.collection("users").doc(decodedToken.uid).get();
    const profile = profileSnapshot.data();

    if (!profileSnapshot.exists || profile?.role !== "student") {
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
      const rosterClassIds = await getRosterClassIdsByEmail(email);

      for (const classId of rosterClassIds) {
        classIds.add(classId);
      }
    }

    const uidRosterClassIds = await getRosterClassIdsByUid(decodedToken.uid);

    for (const classId of uidRosterClassIds) {
      classIds.add(classId);
    }

    const classResults = await Promise.all(Array.from(classIds).map((classId) => getStudentClassSummary(classId)));
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

async function getStudentClassSummary(classId: string): Promise<StudentClassSummary | null> {
  const classSnapshot = await adminDb!.collection("classes").doc(classId).get();

  if (!classSnapshot.exists) {
    return null;
  }

  const classData = classSnapshot.data() ?? {};

  return {
    appearance: normalizeTeacherClassAppearance(classData.appearance),
    id: classSnapshot.id,
    ...(String(classData.joinCode ?? "").trim() ? { joinCode: String(classData.joinCode ?? "").trim() } : {}),
    name: String(classData.name ?? "Saved class").trim() || "Saved class",
    ...(String(classData.openingMessage ?? "").trim()
      ? { openingMessage: String(classData.openingMessage ?? "").trim() }
      : {}),
    section: String(classData.section ?? "").trim(),
    studentChatEnabled: classData.tutorAccess?.enabled !== false && classData.studentChatEnabled !== false,
    themeColor: normalizeTeacherClassThemeColor(classData.themeColor)
  };
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
