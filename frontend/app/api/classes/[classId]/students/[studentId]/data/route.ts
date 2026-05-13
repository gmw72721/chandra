import { type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import {
  listConversationAttachments,
  listConversationMessages,
  listStudentConversations,
  listTeacherStudentConversations,
  softDeleteConversation
} from "@/lib/data/conversations";
import { adminDb, adminStorage } from "@/lib/firebase-admin";
import { authorizeClassAccess, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

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
    const { email: actorEmail, uid } = await authorizeClassAccess(request, classId, "exportStudentData");
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
    const { email: actorEmail, uid } = await authorizeClassAccess(request, classId, "deleteStudentData");
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
      const [messages, attachments] = await Promise.all([
        listConversationMessages(conversationDoc.id),
        listConversationAttachments(conversationDoc.id)
      ]);

      return {
        id: conversationDoc.id,
        ...serializeFirestoreData(conversationDoc.data()),
        messages: messages.map((message) => ({
          id: message.id,
          ...serializeFirestoreData(message as unknown as Record<string, unknown>)
        })),
        attachments: attachments.map((attachment) => ({
          id: attachment.id,
          ...serializeFirestoreData(attachment as unknown as Record<string, unknown>)
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
    const deletedConversationData = await deleteConversationRecord(conversationDoc.id);
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

function collectConversationIdentity(
  identity: StudentClassIdentity,
  conversationDocs: Array<{ data: () => Record<string, unknown> }>
) {
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
  const conversations = [];

  for (const email of identity.emails) {
    conversations.push(...(await listTeacherStudentConversations({ classId, studentEmail: email })));
  }

  for (const uid of identity.uids) {
    conversations.push(...(await listStudentConversations({ classId, studentId: uid })));
  }

  return dedupeDocs(conversations).map((conversation) => ({
    id: conversation.id,
    data: () => conversation as unknown as Record<string, unknown>
  }));
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

async function deleteConversationRecord(conversationId: string) {
  const [messages, attachments] = await Promise.all([
    listConversationMessages(conversationId),
    listConversationAttachments(conversationId)
  ]);
  const attachmentFiles = await deleteAttachmentStorageFiles(attachments.map((attachment) => attachment.storageKey));

  await softDeleteConversation(conversationId);

  return {
    attachments: attachments.length,
    attachmentFiles,
    messages: messages.length
  };
}

async function deleteAttachmentStorageFiles(storageKeys: string[]) {
  if (!adminStorage) {
    return 0;
  }

  const bucket = adminStorage.bucket();
  const uniqueStorageKeys = Array.from(new Set(storageKeys.map((storageKey) => storageKey.trim()).filter(Boolean)));

  await Promise.all(uniqueStorageKeys.map((storageKey) =>
    bucket.file(storageKey).delete({ ignoreNotFound: true })
  ));

  return uniqueStorageKeys.length;
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
  if (value instanceof Date) {
    return value.toISOString();
  }

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
