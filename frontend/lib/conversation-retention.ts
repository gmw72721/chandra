import { adminDb, adminStorage, assertFirebaseAdminAuthReady } from "./firebase-admin";
import {
  listClassConversations,
  listConversationAttachments,
  listConversationMessages,
  softDeleteConversation
} from "./data/conversations";
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

    const expiredConversations = (await listClassConversations(classDoc.id)).filter((conversation) => {
      const lastActivity = conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
      return isConversationExpiredForRetention({ lastActivity, retention });
    });

    for (const conversation of expiredConversations) {
      const deletedConversationData = await deleteConversationRecord(conversation.id);
      result.conversationsDeleted += 1;
      result.attachmentsDeleted += deletedConversationData.attachments;
      result.attachmentFilesDeleted += deletedConversationData.attachmentFiles;
      result.messagesDeleted += deletedConversationData.messages;
    }
  }

  return result;
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
