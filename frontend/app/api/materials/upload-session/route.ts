import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TutorKnowledgeHttpError, authorizeClassTeacher } from "@/lib/tutor-knowledge-server";
import { adminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { classId?: unknown; materialId?: unknown };
    const classId = String(body.classId ?? "").trim();
    const materialId = String(body.materialId ?? "").trim();

    if (!classId || !materialId) {
      return NextResponse.json({ error: "Choose a class and material before uploading." }, { status: 400 });
    }

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(materialId)) {
      return NextResponse.json({ error: "Invalid tutor knowledge material id." }, { status: 400 });
    }

    const { uid } = await authorizeClassTeacher(request, classId);
    const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);

    await adminDb!
      .collection("classes")
      .doc(classId)
      .collection("materialUploadSessions")
      .doc(materialId)
      .set(
        {
          classId,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt,
          materialId,
          teacherId: uid
        },
        { merge: true }
      );

    return NextResponse.json({ expiresAt: expiresAt.toDate().toISOString(), materialId });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    console.error("Tutor knowledge upload session failed.", caughtError);
    return NextResponse.json({ error: "Tutor knowledge upload session failed." }, { status: 500 });
  }
}
