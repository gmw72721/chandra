import { type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb, adminStorage, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  conversationRetentionCutoffDate,
  isConversationExpiredForRetention
} from "./conversation-retention-policy";

export {
  conversationRetentionCutoffDate,
  isConversationExpiredForRetention,
  type ConversationRetentionWindow
} from "./conversation-retention-policy";

export type ConversationRetentionResult = {
  classesChecked: number;
  attachmentsDeleted: number;
  attachmentFilesDeleted: number;
  conversationsDeleted: number;
  messagesDeleted: number;
};

export async function enforceConversationRetention(): Promise<ConversationRetentionResult> {
  assertFirebaseAdminAuthReady();

  const classesSnapshot = await adminDb!.collection("classes").get();
  const result: ConversationRetentionResult = {
    attachmentsDeleted: 0,
    attachmentFilesDeleted: 0,
    classesChecked: 0,
    conversationsDeleted: 0,
    messagesDeleted: 0
  };

  for (const classDoc of classesSnapshot.docs) {
    result.classesChecked += 1;

    const classData = classDoc.data() ?? {};
    const retention = (classData.privacySettings as { conversationRetention?: unknown } | undefined)
      ?.conversationRetention;
    const cutoff = conversationRetentionCutoffDate(retention);

    if (!cutoff) {
      continue;
    }

    const conversationsSnapshot = await classDoc.ref.collection("conversations").get();
    const expiredConversationDocs = conversationsSnapshot.docs.filter((conversationDoc) => {
      const conversation = conversationDoc.data() ?? {};
      const lastActivity = conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
      return isConversationExpiredForRetention({ lastActivity, retention });
    });

    for (const conversationDoc of expiredConversationDocs) {
      const deletedConversationData = await deleteConversationDocument(conversationDoc);
      result.conversationsDeleted += 1;
      result.attachmentsDeleted += deletedConversationData.attachments;
      result.attachmentFilesDeleted += deletedConversationData.attachmentFiles;
      result.messagesDeleted += deletedConversationData.messages;
    }
  }

  return result;
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
