import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { enrollStudentPostgresFirst } from "@/lib/data/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    await authorizeClassAccess(request, classId, "manageRoster");
    const classReference = adminDb!.collection("classes").doc(classId);

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
      await enrollStudentPostgresFirst({
        classId,
        displayName,
        studentEmail: email,
        studentId: profileDoc.id
      });
      syncedCount += 1;
    }

    if (syncedCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({ syncedCount });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Roster sync failed." }, { status: 500 });
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
