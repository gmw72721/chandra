import { type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { adminDb, adminStorage } from "@/lib/firebase-admin";
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
  const classRef = adminDb!.collection("classes").doc(classId);
  const identity = await resolveStudentClassIdentity({ classId, encodedStudentId });
  const [classSnapshot, rosterDocs, supportDocs, profileDocs, conversationsSnapshot] = await Promise.all([
    classRef.get(),
    getStudentRosterDocs({ classId, identity }),
    getStudentScopedDocs({ classId, collectionName: "studentSupport", identity }),
    getStudentScopedDocs({ classId, collectionName: "studentLearningProfiles", identity }),
    getStudentConversationDocs({ classId, identity })
  ]);
  const rosterSnapshot = rosterDocs[0] ?? null;
  const roster = rosterSnapshot?.data() ?? {};
  const conversations = await Promise.all(
    conversationsSnapshot.map(async (conversationDoc) => {
      const [messagesSnapshot, attachmentsSnapshot] = await Promise.all([
        conversationDoc.ref.collection("messages").orderBy("createdAt").get().catch(() =>
          conversationDoc.ref.collection("messages").get()
        ),
        conversationDoc.ref.collection("attachments").orderBy("createdAt").get().catch(() =>
          conversationDoc.ref.collection("attachments").get()
        )
      ]);

      return {
        id: conversationDoc.id,
        ...serializeFirestoreData(conversationDoc.data()),
        messages: messagesSnapshot.docs.map((messageDoc) => ({
          id: messageDoc.id,
          ...serializeFirestoreData(messageDoc.data())
        })),
        attachments: attachmentsSnapshot.docs.map((attachmentDoc) => ({
          id: attachmentDoc.id,
          ...serializeFirestoreData(attachmentDoc.data())
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
      id: rosterSnapshot?.id ?? identity.requestedId,
      ...serializeFirestoreData(roster)
    },
    conversations,
    learningProfiles: profileDocs.map((profileDoc) => ({
      id: profileDoc.id,
      ...serializeFirestoreData(profileDoc.data() ?? {})
    })),
    supportNotes: supportDocs.map((supportDoc) => ({
      id: supportDoc.id,
      ...serializeFirestoreData(supportDoc.data() ?? {})
    }))
  };
}

async function deleteStudentClassData({
  classId,
  encodedStudentId
}: {
  classId: string;
  encodedStudentId: string;
}) {
  const identity = await resolveStudentClassIdentity({ classId, encodedStudentId });
  const conversationDocs = await getStudentConversationDocs({ classId, identity });

  collectConversationIdentity(identity, conversationDocs);

  const [rosterDocs, profileDocs, supportDocs, aiUsageReservationDocs, aiUsageEventDocs] = await Promise.all([
    getStudentRosterDocs({ classId, identity }),
    getStudentScopedDocs({ classId, collectionName: "studentLearningProfiles", identity }),
    getStudentScopedDocs({ classId, collectionName: "studentSupport", identity }),
    getAiUsageDocs({ classId, collectionName: "aiUsageReservations", identity, studentField: "studentId" }),
    getAiUsageDocs({ classId, collectionName: "aiUsageEvents", identity, studentField: "userId" })
  ]);
  let messageCount = 0;
  let attachmentCount = 0;
  let attachmentFileCount = 0;

  for (const conversationDoc of conversationDocs) {
    const deletedConversationData = await deleteConversationDocument(conversationDoc);
    messageCount += deletedConversationData.messages;
    attachmentCount += deletedConversationData.attachments;
    attachmentFileCount += deletedConversationData.attachmentFiles;
  }

  await deleteDocumentsInBatches([
    ...profileDocs.map((profileDoc) => profileDoc.ref),
    ...supportDocs.map((supportDoc) => supportDoc.ref),
    ...rosterDocs.map((rosterDoc) => rosterDoc.ref),
    ...aiUsageReservationDocs.map((usageDoc) => usageDoc.ref),
    ...aiUsageEventDocs.map((usageDoc) => usageDoc.ref)
  ]);

  return {
    conversations: conversationDocs.length,
    messages: messageCount,
    attachments: attachmentCount,
    attachmentFiles: attachmentFileCount,
    profiles: profileDocs.length,
    roster: rosterDocs.length,
    supportNotes: supportDocs.length,
    aiUsageEvents: aiUsageEventDocs.length,
    aiUsageReservations: aiUsageReservationDocs.length
  };
}

type StudentClassIdentity = {
  requestedId: string;
  emails: Set<string>;
  uids: Set<string>;
};

async function resolveStudentClassIdentity({
  classId,
  encodedStudentId
}: {
  classId: string;
  encodedStudentId: string;
}): Promise<StudentClassIdentity> {
  const requestedId = decodeURIComponent(encodedStudentId).trim();
  const identity: StudentClassIdentity = {
    requestedId,
    emails: new Set(),
    uids: new Set()
  };
  addStudentIdentifier(identity, requestedId);

  await collectUserIdentity(identity);
  collectRosterIdentity(identity, await getStudentRosterDocs({ classId, identity }));
  await collectUserIdentity(identity);

  return identity;
}

function addStudentIdentifier(identity: StudentClassIdentity, value: unknown) {
  const cleanValue = String(value ?? "").trim();

  if (!cleanValue) {
    return;
  }

  if (cleanValue.includes("@")) {
    identity.emails.add(cleanValue.toLowerCase());
    return;
  }

  identity.uids.add(cleanValue);
}

async function collectUserIdentity(identity: StudentClassIdentity) {
  const uidCandidates = Array.from(identity.uids);
  const emailCandidates = Array.from(identity.emails);

  for (const uid of uidCandidates) {
    const userSnapshot = await adminDb!.collection("users").doc(uid).get();

    if (!userSnapshot.exists) {
      continue;
    }

    const user = userSnapshot.data() ?? {};
    identity.uids.add(userSnapshot.id);
    addStudentIdentifier(identity, user.email);
    addStudentIdentifier(identity, user.uid);
  }

  for (const email of emailCandidates) {
    const usersSnapshot = await adminDb!.collection("users").where("email", "==", email).get();

    usersSnapshot.docs.forEach((userDoc) => {
      const user = userDoc.data() ?? {};
      identity.uids.add(userDoc.id);
      addStudentIdentifier(identity, user.email);
      addStudentIdentifier(identity, user.uid);
    });
  }
}

function collectRosterIdentity(identity: StudentClassIdentity, rosterDocs: QueryDocumentSnapshot[]) {
  rosterDocs.forEach((rosterDoc) => {
    const roster = rosterDoc.data() ?? {};

    addStudentIdentifier(identity, decodeURIComponent(rosterDoc.id));
    addStudentIdentifier(identity, roster.email);
    addStudentIdentifier(identity, roster.uid);
    addStudentIdentifier(identity, roster.studentId);
  });
}

function collectConversationIdentity(identity: StudentClassIdentity, conversationDocs: QueryDocumentSnapshot[]) {
  conversationDocs.forEach((conversationDoc) => {
    const conversation = conversationDoc.data() ?? {};

    addStudentIdentifier(identity, conversation.studentEmail);
    addStudentIdentifier(identity, conversation.studentId);
  });
}

async function getStudentRosterDocs({
  classId,
  identity
}: {
  classId: string;
  identity: StudentClassIdentity;
}) {
  const studentsRef = adminDb!.collection("classes").doc(classId).collection("students");
  const rosterDocs: QueryDocumentSnapshot[] = [];
  const directIds = new Set([
    ...Array.from(identity.emails).map((email) => encodeURIComponent(email)),
    ...Array.from(identity.uids).map((uid) => encodeURIComponent(uid))
  ]);

  for (const directId of directIds) {
    const snapshot = await studentsRef.doc(directId).get();

    if (snapshot.exists) {
      rosterDocs.push(snapshot as QueryDocumentSnapshot);
    }
  }

  for (const email of identity.emails) {
    rosterDocs.push(...(await studentsRef.where("email", "==", email).get()).docs);
  }

  for (const uid of identity.uids) {
    rosterDocs.push(...(await studentsRef.where("uid", "==", uid).get()).docs);
    rosterDocs.push(...(await studentsRef.where("studentId", "==", uid).get()).docs);
  }

  return dedupeDocs(rosterDocs);
}

async function getStudentScopedDocs({
  classId,
  collectionName,
  identity
}: {
  classId: string;
  collectionName: "studentLearningProfiles" | "studentSupport";
  identity: StudentClassIdentity;
}) {
  const collectionRef = adminDb!.collection("classes").doc(classId).collection(collectionName);
  const docs: QueryDocumentSnapshot[] = [];
  const directIds = new Set([
    ...Array.from(identity.emails).map((email) => encodeURIComponent(email)),
    ...Array.from(identity.uids).map((uid) => encodeURIComponent(uid))
  ]);

  for (const directId of directIds) {
    const snapshot = await collectionRef.doc(directId).get();

    if (snapshot.exists) {
      docs.push(snapshot as QueryDocumentSnapshot);
    }
  }

  for (const email of identity.emails) {
    docs.push(...(await collectionRef.where("studentEmail", "==", email).get()).docs);
  }

  for (const uid of identity.uids) {
    docs.push(...(await collectionRef.where("studentId", "==", uid).get()).docs);
  }

  return dedupeDocs(docs);
}

async function getStudentConversationDocs({
  classId,
  identity
}: {
  classId: string;
  identity: StudentClassIdentity;
}) {
  const conversationsRef = adminDb!.collection("classes").doc(classId).collection("conversations");
  const docs: QueryDocumentSnapshot[] = [];

  for (const email of identity.emails) {
    docs.push(...(await conversationsRef.where("studentEmail", "==", email).get()).docs);
  }

  for (const uid of identity.uids) {
    docs.push(...(await conversationsRef.where("studentId", "==", uid).get()).docs);
  }

  return dedupeDocs(docs);
}

async function getAiUsageDocs({
  classId,
  collectionName,
  identity,
  studentField
}: {
  classId: string;
  collectionName: "aiUsageEvents" | "aiUsageReservations";
  identity: StudentClassIdentity;
  studentField: "studentId" | "userId";
}) {
  const docs: QueryDocumentSnapshot[] = [];

  for (const uid of identity.uids) {
    docs.push(
      ...(await adminDb!
        .collection(collectionName)
        .where("classId", "==", classId)
        .where(studentField, "==", uid)
        .get()).docs
    );
  }

  return dedupeDocs(docs);
}

async function deleteConversationDocument(conversationDoc: QueryDocumentSnapshot) {
  const [messagesSnapshot, attachmentsSnapshot] = await Promise.all([
    conversationDoc.ref.collection("messages").get(),
    conversationDoc.ref.collection("attachments").get()
  ]);
  const attachmentFiles = await deleteAttachmentStorageFiles(attachmentsSnapshot.docs);

  await deleteDocumentsInBatches([
    ...messagesSnapshot.docs.map((messageDoc) => messageDoc.ref),
    ...attachmentsSnapshot.docs.map((attachmentDoc) => attachmentDoc.ref),
    conversationDoc.ref
  ]);

  return {
    attachments: attachmentsSnapshot.size,
    attachmentFiles,
    messages: messagesSnapshot.size
  };
}

async function deleteAttachmentStorageFiles(attachmentDocs: QueryDocumentSnapshot[]) {
  if (!adminStorage) {
    return 0;
  }

  const bucket = adminStorage.bucket();
  const storageKeys = Array.from(new Set(attachmentDocs.map((attachmentDoc) =>
    String(attachmentDoc.data()?.storageKey ?? "").trim()
  ).filter(Boolean)));

  await Promise.all(storageKeys.map((storageKey) =>
    bucket.file(storageKey).delete({ ignoreNotFound: true })
  ));

  return storageKeys.length;
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
