import { type DocumentReference } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

type StudentDataRouteParams = {
  classId: string;
  studentId: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<StudentDataRouteParams> }
) {
  try {
    const { classId, studentId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const exportData = await buildStudentClassDataExport({ classId, encodedStudentId: studentId });
    const studentEmail = "email" in exportData.student ? String(exportData.student.email ?? "") : "";
    const fileName = `${classId}-${studentEmail || studentId}-export.json`.replace(/[^a-zA-Z0-9._-]/g, "-");

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "student_data.exported",
      route: "/api/classes/[classId]/students/[studentId]/data",
      target: {
        classId,
        studentId
      }
    });

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  } catch (caughtError) {
    return studentDataErrorResponse(caughtError, "Student data export failed.");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<StudentDataRouteParams> }
) {
  try {
    const { classId, studentId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };

    if (body.confirm !== "DELETE_STUDENT_CLASS_DATA") {
      return NextResponse.json({ error: "Confirm deletion before removing student class data." }, { status: 400 });
    }

    const deleted = await deleteStudentClassData({ classId, encodedStudentId: studentId });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "student_data.deleted",
      metadata: deleted,
      route: "/api/classes/[classId]/students/[studentId]/data",
      target: {
        classId,
        studentId
      }
    });

    return NextResponse.json({ deleted });
  } catch (caughtError) {
    return studentDataErrorResponse(caughtError, "Student data deletion failed.");
  }
}

async function buildStudentClassDataExport({
  classId,
  encodedStudentId
}: {
  classId: string;
  encodedStudentId: string;
}) {
  const studentEmail = decodeURIComponent(encodedStudentId).trim().toLowerCase();
  const classRef = adminDb!.collection("classes").doc(classId);
  const rosterRef = classRef.collection("students").doc(encodeURIComponent(studentEmail));
  const [classSnapshot, rosterSnapshot, supportSnapshot, profileSnapshot, conversationsSnapshot] = await Promise.all([
    classRef.get(),
    rosterRef.get(),
    classRef.collection("studentSupport").doc(encodeURIComponent(studentEmail)).get(),
    classRef.collection("studentLearningProfiles").doc(encodeURIComponent(studentEmail)).get(),
    classRef.collection("conversations").where("studentEmail", "==", studentEmail).get()
  ]);
  const roster = rosterSnapshot.data() ?? {};
  const studentUid = String(roster.uid ?? roster.studentId ?? "");
  const studentIdConversationSnapshot = studentUid
    ? await classRef.collection("conversations").where("studentId", "==", studentUid).get()
    : null;
  const conversationDocs = dedupeDocs([
    ...conversationsSnapshot.docs,
    ...(studentIdConversationSnapshot?.docs ?? [])
  ]);
  const conversations = await Promise.all(
    conversationDocs.map(async (conversationDoc) => {
      const messagesSnapshot = await conversationDoc.ref.collection("messages").orderBy("createdAt").get().catch(() =>
        conversationDoc.ref.collection("messages").get()
      );

      return {
        id: conversationDoc.id,
        ...serializeFirestoreData(conversationDoc.data()),
        messages: messagesSnapshot.docs.map((messageDoc) => ({
          id: messageDoc.id,
          ...serializeFirestoreData(messageDoc.data())
        }))
      };
    })
  );

  return {
    exportedAt: new Date().toISOString(),
    class: {
      id: classSnapshot.id,
      name: String(classSnapshot.data()?.name ?? ""),
      section: String(classSnapshot.data()?.section ?? "")
    },
    student: {
      id: rosterSnapshot.id,
      ...serializeFirestoreData(roster)
    },
    conversations,
    learningProfile: profileSnapshot.exists
      ? { id: profileSnapshot.id, ...serializeFirestoreData(profileSnapshot.data() ?? {}) }
      : null,
    supportNotes: supportSnapshot.exists
      ? { id: supportSnapshot.id, ...serializeFirestoreData(supportSnapshot.data() ?? {}) }
      : null
  };
}

async function deleteStudentClassData({
  classId,
  encodedStudentId
}: {
  classId: string;
  encodedStudentId: string;
}) {
  const studentEmail = decodeURIComponent(encodedStudentId).trim().toLowerCase();
  const classRef = adminDb!.collection("classes").doc(classId);
  const rosterRef = classRef.collection("students").doc(encodeURIComponent(studentEmail));
  const rosterSnapshot = await rosterRef.get();
  const roster = rosterSnapshot.data() ?? {};
  const studentUid = String(roster.uid ?? roster.studentId ?? "");
  const emailConversationsSnapshot = await classRef.collection("conversations").where("studentEmail", "==", studentEmail).get();
  const uidConversationsSnapshot = studentUid
    ? await classRef.collection("conversations").where("studentId", "==", studentUid).get()
    : null;
  const conversationDocs = dedupeDocs([
    ...emailConversationsSnapshot.docs,
    ...(uidConversationsSnapshot?.docs ?? [])
  ]);
  let messageCount = 0;

  for (const conversationDoc of conversationDocs) {
    const messageSnapshot = await conversationDoc.ref.collection("messages").get();
    messageCount += messageSnapshot.size;
    await deleteDocumentsInBatches(messageSnapshot.docs.map((messageDoc) => messageDoc.ref));
  }

  await deleteDocumentsInBatches([
    ...conversationDocs.map((conversationDoc) => conversationDoc.ref),
    classRef.collection("studentLearningProfiles").doc(encodeURIComponent(studentEmail)),
    classRef.collection("studentSupport").doc(encodeURIComponent(studentEmail)),
    rosterRef
  ]);

  return {
    conversations: conversationDocs.length,
    messages: messageCount,
    profile: 1,
    roster: rosterSnapshot.exists ? 1 : 0,
    supportNotes: 1
  };
}

async function deleteDocumentsInBatches(references: DocumentReference[]) {
  for (let index = 0; index < references.length; index += 450) {
    const batch = adminDb!.batch();
    references.slice(index, index + 450).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

function dedupeDocs<T extends { id: string }>(docs: T[]) {
  return Array.from(new Map(docs.map((doc) => [doc.id, doc])).values());
}

function serializeFirestoreData(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, serializeFirestoreValue(value)])
  );
}

function serializeFirestoreValue(value: unknown): unknown {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item));
  }

  if (value && typeof value === "object") {
    return serializeFirestoreData(value as Record<string, unknown>);
  }

  return value;
}

function studentDataErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
