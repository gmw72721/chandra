import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in as the class teacher to sync the roster." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);
    const classReference = adminDb!.collection("classes").doc(classId);
    const classSnapshot = await classReference.get();

    if (!classSnapshot.exists) {
      return NextResponse.json({ error: "Class not found." }, { status: 404 });
    }

    if (classSnapshot.data()?.teacherId !== decodedToken.uid) {
      return NextResponse.json({ error: "Only the class teacher can sync this roster." }, { status: 403 });
    }

    const [profileSnapshot, rosterSnapshot] = await Promise.all([
      adminDb!.collection("users").where("classId", "==", classId).get(),
      classReference.collection("students").get()
    ]);
    const existingRosterIds = new Set(rosterSnapshot.docs.map((studentDoc) => studentDoc.id));
    const batch = adminDb!.batch();
    let syncedCount = 0;

    for (const profileDoc of profileSnapshot.docs) {
      const profile = profileDoc.data();

      if (profile.role !== "student") {
        continue;
      }

      const email = normalizeEmail(String(profile.email ?? ""));
      const displayName = String(profile.displayName ?? "").trim() || email || "Chandra student";

      if (!email) {
        continue;
      }

      const rosterStudentId = encodeURIComponent(email);
      const rosterData: { addedAt?: FieldValue; displayName: string; email: string } = {
        displayName,
        email
      };

      if (!existingRosterIds.has(rosterStudentId)) {
        rosterData.addedAt = FieldValue.serverTimestamp();
      }

      batch.set(classReference.collection("students").doc(rosterStudentId), rosterData, { merge: true });
      syncedCount += 1;
    }

    if (syncedCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({ syncedCount });
  } catch {
    return NextResponse.json({ error: "Roster sync failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
