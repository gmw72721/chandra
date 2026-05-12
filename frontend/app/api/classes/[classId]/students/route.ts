import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { enrollStudentPostgresFirst } from "@/lib/data/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as {
      displayName?: unknown;
      email?: unknown;
      uid?: unknown;
    };
    const email = String(body.email ?? "").trim().toLowerCase();
    const displayName = String(body.displayName ?? "").trim() || email || "Chandra student";
    const uid = String(body.uid ?? "").trim();

    if (!email) {
      return NextResponse.json({ error: "Enter a student email." }, { status: 400 });
    }

    const studentId = encodeURIComponent(email);
    await enrollStudentPostgresFirst({
      classId,
      displayName,
      studentEmail: email,
      studentId: uid || null
    });
    await adminDb!.collection("classes").doc(classId).collection("students").doc(studentId).set(
      {
        addedAt: FieldValue.serverTimestamp(),
        displayName,
        email,
        ...(uid ? { uid } : {})
      },
      { merge: true }
    );

    return NextResponse.json({ student: { id: studentId, displayName, email, uid } });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    return NextResponse.json({ error: "Student add failed." }, { status: 500 });
  }
}
