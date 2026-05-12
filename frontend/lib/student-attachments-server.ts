import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { adminStorage, assertFirebaseAdminReady } from "./firebase-admin";
import type { AuthorizedTutorChatScope } from "./tutor-chat-auth";
import type { MessageAttachment } from "./types";
import {
  deleteAttachmentMetadata,
  getConversationAttachment,
  getConversationById,
  listConversationAttachments,
  updateAttachmentMessageId,
  upsertMessageAttachment
} from "./data/conversations";

const maxDocumentIdLength = 200;
const maxPdfFileBytes = 25 * 1024 * 1024;
const maxExtractedAttachmentTextCharacters = 12000;
const maxAttachmentsPerMessage = 3;

const allowedAttachmentTypes = new Map([
  [".pdf", { fileType: "pdf" as const, mimeType: "application/pdf", maxBytes: maxPdfFileBytes }]
]);

type AllowedAttachmentType = (typeof allowedAttachmentTypes extends Map<string, infer Value> ? Value : never);

export class StudentAttachmentError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function maxStudentAttachmentsPerMessage() {
  return maxAttachmentsPerMessage;
}

export function maxStudentAttachmentFileBytes() {
  return maxPdfFileBytes;
}

export async function uploadStudentConversationAttachment({
  conversationId,
  file,
  scope
}: {
  conversationId: string;
  file: File;
  scope: AuthorizedTutorChatScope;
}) {
  assertStudentScope(scope);
  assertSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminReady();
  await verifyStudentConversation({ conversationId, scope });

  const allowedType = validateAttachmentMetadata(file);
  const buffer = Buffer.from(await file.arrayBuffer());
  const validatedFile = await validateAttachmentFile({ allowedType, buffer });
  const extractedText = await extractAttachmentText({
    buffer,
    fileType: validatedFile.fileType
  });
  const attachmentId = randomUUID();
  const now = new Date().toISOString();
  const safeFileName = sanitizeFileName(file.name);
  const storageKey = [
    "student-uploads",
    scope.classId,
    scope.uid,
    conversationId,
    `${attachmentId}-${safeFileName}`
  ].join("/");
  const initialAttachment = {
    classId: scope.classId,
    conversationId,
    createdAt: now,
    extractedText,
    fileName: safeFileName,
    fileSize: file.size,
    fileType: validatedFile.fileType,
    messageId: null,
    mimeType: validatedFile.mimeType,
    pageCount: validatedFile.pageCount,
    storageKey,
    studentId: scope.uid,
    updatedAt: now,
    uploadStatus: "uploading" as const
  };

  await upsertMessageAttachment({
    ...initialAttachment,
    id: attachmentId
  });

  try {
    await adminStorage!.bucket().file(storageKey).save(buffer, {
      contentType: validatedFile.mimeType,
      metadata: {
        metadata: {
          originalFileName: safeFileName
        }
      },
      resumable: false
    });

    const savedAttachment = await upsertMessageAttachment({
      ...initialAttachment,
      id: attachmentId,
      uploadStatus: "ready"
    });
    return attachmentRecordToMessageAttachment(savedAttachment);
  } catch (caughtError) {
    await upsertMessageAttachment({
      ...initialAttachment,
      id: attachmentId,
      uploadStatus: "failed"
    }).catch(() => {});
    console.error("Student attachment upload failed.", caughtError);
    throw new StudentAttachmentError("Homework file upload failed. Try again in a moment.", 502);
  }
}

export async function listStudentConversationAttachments({
  conversationId,
  scope
}: {
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  assertStudentScope(scope);
  assertSafeDocumentId(conversationId, "Conversation id");
  assertFirebaseAdminReady();
  await verifyStudentConversation({ conversationId, scope });
  const postgresAttachments = await listConversationAttachments(conversationId);

  return postgresAttachments
    .map(attachmentRecordToMessageAttachment)
    .filter((attachment) => attachment.studentId === scope.uid && attachment.classId === scope.classId);
}

export async function getStudentConversationAttachment({
  attachmentId,
  conversationId,
  scope
}: {
  attachmentId: string;
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  assertStudentScope(scope);
  assertSafeDocumentId(conversationId, "Conversation id");
  assertSafeDocumentId(attachmentId, "Attachment id");
  assertFirebaseAdminReady();
  await verifyStudentConversation({ conversationId, scope });

  const attachment = await readStudentAttachment({ attachmentId, conversationId, scope });
  return attachment;
}

export async function deleteStudentConversationAttachment({
  attachmentId,
  conversationId,
  scope
}: {
  attachmentId: string;
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  assertStudentScope(scope);
  assertSafeDocumentId(conversationId, "Conversation id");
  assertSafeDocumentId(attachmentId, "Attachment id");
  assertFirebaseAdminReady();
  await verifyStudentConversation({ conversationId, scope });

  const postgresAttachment = await getConversationAttachment(attachmentId);

  if (!postgresAttachment) {
    throw new StudentAttachmentError("Attachment was not found.", 404);
  }

  const attachment = attachmentRecordToMessageAttachment(postgresAttachment);

  if (attachment.classId !== scope.classId || attachment.studentId !== scope.uid || attachment.conversationId !== conversationId) {
    throw new StudentAttachmentError("You can only remove your own class attachments.", 403);
  }

  await Promise.all([
    adminStorage!.bucket().file(attachment.storageKey).delete({ ignoreNotFound: true }),
    deleteAttachmentMetadata(attachmentId)
  ]);
}

export async function associateStudentMessageAttachments({
  attachmentIds,
  conversationId,
  messageId,
  scope
}: {
  attachmentIds: string[];
  conversationId: string;
  messageId: string;
  scope: AuthorizedTutorChatScope;
}) {
  if (!attachmentIds.length) {
    return [];
  }

  assertStudentScope(scope);
  assertSafeDocumentId(conversationId, "Conversation id");
  assertSafeDocumentId(messageId, "Message id");
  assertFirebaseAdminReady();
  assertValidAttachmentIds(attachmentIds);

  const uniqueAttachmentIds = Array.from(new Set(attachmentIds));
  const now = new Date().toISOString();
  const attachments: MessageAttachment[] = [];

  for (const attachmentId of uniqueAttachmentIds) {
    const record = await getConversationAttachment(attachmentId);

    if (!record) {
      throw new StudentAttachmentError("Attachment was not found.", 404);
    }

    const attachment = attachmentRecordToMessageAttachment(record);
    const existingMessageId = String(attachment.messageId ?? "");

    if (
      attachment.classId !== scope.classId ||
      attachment.studentId !== scope.uid ||
      attachment.conversationId !== conversationId
    ) {
      throw new StudentAttachmentError("You can only use your own class attachments.", 403);
    }

    if (attachment.uploadStatus !== "ready") {
      throw new StudentAttachmentError("Wait for homework files to finish uploading before sending.", 400);
    }

    if (existingMessageId && existingMessageId !== messageId) {
      throw new StudentAttachmentError("Attachment has already been sent with another message.", 400);
    }

    await updateAttachmentMessageId({ attachmentId, messageId });
    attachments.push({
      ...attachment,
      messageId,
      updatedAt: now
    });
  }

  return attachments;
}

function assertStudentScope(scope: AuthorizedTutorChatScope) {
  if (scope.role !== "student") {
    throw new StudentAttachmentError("Use a student account to upload homework files.", 403);
  }
}

function assertValidAttachmentIds(attachmentIds: string[]) {
  if (attachmentIds.length > maxAttachmentsPerMessage) {
    throw new StudentAttachmentError(`Attach up to ${maxAttachmentsPerMessage} files per message.`, 400);
  }

  for (const attachmentId of attachmentIds) {
    assertSafeDocumentId(attachmentId, "Attachment id");
  }
}

async function readStudentAttachment({
  attachmentId,
  conversationId,
  scope
}: {
  attachmentId: string;
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  const postgresAttachment = await getConversationAttachment(attachmentId);

  if (!postgresAttachment) {
    throw new StudentAttachmentError("Attachment was not found.", 404);
  }

  const attachment = attachmentRecordToMessageAttachment(postgresAttachment);

  if (attachment.classId !== scope.classId || attachment.studentId !== scope.uid || attachment.conversationId !== conversationId) {
    throw new StudentAttachmentError("You can only open your own class attachments.", 403);
  }

  return attachment;
}

async function verifyStudentConversation({
  conversationId,
  scope
}: {
  conversationId: string;
  scope: AuthorizedTutorChatScope;
}) {
  const postgresConversation = await getConversationById(conversationId);

  if (!postgresConversation) {
    throw new StudentAttachmentError("Conversation was not found.", 404);
  }

  if (postgresConversation.classId !== scope.classId || postgresConversation.studentId !== scope.uid) {
    throw new StudentAttachmentError("You can only use your own class conversations.", 403);
  }
}

function attachmentRecordToMessageAttachment(record: Awaited<ReturnType<typeof getConversationAttachment>> extends infer T ? NonNullable<T> : never): MessageAttachment {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    studentId: record.studentId ?? "",
    classId: record.classId,
    fileName: record.fileName,
    fileType: record.fileType,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    storageKey: record.storageKey,
    uploadStatus: record.uploadStatus,
    extractedText: record.extractedText,
    pageCount: record.pageCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}

function validateAttachmentMetadata(file: File): AllowedAttachmentType {
  const extension = fileExtension(file.name);
  const allowedType = allowedAttachmentTypes.get(extension);

  if (!allowedType) {
    throw new StudentAttachmentError("Only text-readable PDF homework files are supported.", 400);
  }

  if (file.size <= 0) {
    throw new StudentAttachmentError("Upload a non-empty homework file.", 400);
  }

  if (file.size > allowedType.maxBytes) {
    throw new StudentAttachmentError(
      `PDFs must be ${Math.floor(allowedType.maxBytes / 1024 / 1024)} MB or smaller.`,
      413
    );
  }

  const providedMimeType = file.type.trim().toLowerCase();

  if (providedMimeType && providedMimeType !== allowedType.mimeType) {
    throw new StudentAttachmentError("The uploaded file type is not supported.", 400);
  }

  return allowedType;
}

async function validateAttachmentFile({
  allowedType,
  buffer
}: {
  allowedType: AllowedAttachmentType;
  buffer: Buffer;
}) {
  if (!matchesMagicBytes(buffer, allowedType.mimeType)) {
    throw new StudentAttachmentError("The uploaded file does not match its allowed file type.", 400);
  }

  return {
    ...allowedType,
    pageCount: allowedType.fileType === "pdf" ? await readPdfPageCount(buffer) : null
  };
}

async function readPdfPageCount(buffer: Buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    throw new StudentAttachmentError("The uploaded PDF could not be read.", 400);
  }
}

async function extractAttachmentText({
  buffer,
  fileType
}: {
  buffer: Buffer;
  fileType: "image" | "pdf";
}) {
  if (fileType !== "pdf") {
    throw new StudentAttachmentError("Only text-readable PDF homework files are supported.", 400);
  }

  const text = await extractPdfText(buffer);

  if (!text) {
    throw new StudentAttachmentError(
      "That PDF does not contain readable text. Export or upload a text-selectable PDF before sending it to Chandra.",
      400
    );
  }

  return text.slice(0, maxExtractedAttachmentTextCharacters);
}

async function extractPdfText(buffer: Buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return normalizeExtractedText(result.text);
  } catch {
    throw new StudentAttachmentError("The uploaded PDF text could not be extracted.", 400);
  } finally {
    await parser.destroy();
  }
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchesMagicBytes(buffer: Buffer, mimeType: string) {
  if (mimeType === "application/pdf") {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }

  return false;
}

function sanitizeFileName(fileName: string) {
  const extension = fileExtension(fileName);
  const baseName = fileName
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);

  return `${baseName || `homework-${randomUUID().slice(0, 8)}`}${extension}`;
}

function fileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function assertSafeDocumentId(value: string, label: string) {
  if (!value || value.includes("/") || value.length > maxDocumentIdLength) {
    throw new StudentAttachmentError(`${label} is invalid.`, 400);
  }
}
