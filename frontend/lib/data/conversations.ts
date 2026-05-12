import type { Role } from "../types.ts";
import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type ConversationRecord = {
  id: string;
  classId: string;
  studentId: string | null;
  studentEmail: string;
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  title: string;
  assignment: string;
  modelId: string;
  messageCount: number;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  deletedAt: Date | null;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  classId: string;
  role: Role;
  content: string;
  modelId: string | null;
  sources: unknown[];
  metadata: Record<string, unknown>;
  attachments?: unknown[];
  debugInfo?: unknown;
  langGraphTrace?: unknown;
  learningStrategyTelemetry?: unknown;
  retrievalConfidence?: unknown;
  structuredOutput?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageAttachmentRecord = {
  id: string;
  conversationId: string;
  messageId: string | null;
  classId: string;
  studentId: string | null;
  fileName: string;
  fileType: "image" | "pdf";
  mimeType: string;
  fileSize: number;
  storageKey: string;
  uploadStatus: "uploading" | "ready" | "failed";
  extractedText: string | null;
  pageCount: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type ConversationRow = {
  id: string;
  class_id: string;
  student_id: string | null;
  student_email: string;
  student_name: string;
  teacher_id: string | null;
  teacher_name: string;
  title: string;
  assignment: string;
  model_id: string;
  message_count: number;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
  deleted_at: Date | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  class_id: string;
  role: Role;
  content: string;
  model_id: string | null;
  attachments?: unknown[];
  debug_info: unknown;
  langgraph_trace: unknown;
  learning_strategy_telemetry: unknown;
  retrieval_confidence: unknown;
  sources: unknown[];
  structured_output: unknown;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type MessageAttachmentRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  class_id: string;
  student_id: string | null;
  file_name: string;
  file_type: "image" | "pdf";
  mime_type: string;
  file_size: string | number;
  storage_key: string;
  upload_status: "uploading" | "ready" | "failed";
  extracted_text: string | null;
  page_count: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type InsertedMessageResultRow = {
  inserted: MessageRow | null;
};

export type UpsertConversationInput = {
  id: string;
  classId: string;
  assignment?: string;
  metadata?: Record<string, unknown>;
  modelId?: string;
  studentEmail?: string;
  studentId?: string | null;
  studentName?: string;
  tags?: string[];
  teacherId?: string | null;
  teacherName?: string;
  title?: string;
};

export async function upsertConversation(input: UpsertConversationInput, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `INSERT INTO conversations (
      id, class_id, student_id, student_email, student_name, teacher_id, teacher_name,
      title, assignment, model_id, tags, metadata, last_message_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12::jsonb, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      student_id = EXCLUDED.student_id,
      student_email = EXCLUDED.student_email,
      student_name = EXCLUDED.student_name,
      teacher_id = EXCLUDED.teacher_id,
      teacher_name = EXCLUDED.teacher_name,
      title = EXCLUDED.title,
      assignment = EXCLUDED.assignment,
      model_id = EXCLUDED.model_id,
      tags = EXCLUDED.tags,
      metadata = conversations.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.id,
      input.classId,
      input.studentId ?? null,
      input.studentEmail?.trim().toLowerCase() ?? "",
      input.studentName?.trim() ?? "",
      input.teacherId ?? null,
      input.teacherName?.trim() ?? "",
      input.title?.trim() ?? "",
      input.assignment?.trim() ?? "",
      input.modelId ?? "",
      input.tags ?? [],
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return rowToConversation(result.rows[0]);
}

export async function getConversationById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(client, "SELECT * FROM conversations WHERE id = $1", [id]);
  return result.rows[0] ? rowToConversation(result.rows[0]) : null;
}

export async function listStudentConversations({
  classId,
  studentId
}: {
  classId: string;
  studentId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `SELECT *
    FROM conversations
    WHERE class_id = $1 AND student_id = $2 AND deleted_at IS NULL
    ORDER BY coalesce(last_message_at, created_at) DESC`,
    [classId, studentId]
  );

  return result.rows.map(rowToConversation);
}

export async function listTeacherStudentConversations({
  classId,
  studentEmail
}: {
  classId: string;
  studentEmail: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `SELECT *
    FROM conversations
    WHERE class_id = $1 AND student_email = lower($2) AND deleted_at IS NULL
    ORDER BY coalesce(last_message_at, created_at) DESC`,
    [classId, studentEmail.trim().toLowerCase()]
  );

  return result.rows.map(rowToConversation);
}

export async function listClassConversations(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `SELECT *
    FROM conversations
    WHERE class_id = $1 AND deleted_at IS NULL
    ORDER BY coalesce(last_message_at, created_at) DESC`,
    [classId]
  );

  return result.rows.map(rowToConversation);
}

export async function addMessage(input: {
  attachments?: unknown[];
  classId: string;
  content: string;
  conversationId: string;
  debugInfo?: unknown;
  id: string;
  langGraphTrace?: unknown;
  learningStrategyTelemetry?: unknown;
  metadata?: Record<string, unknown>;
  modelId?: string | null;
  retrievalConfidence?: unknown;
  role: Role;
  sources?: unknown[];
  structuredOutput?: unknown;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<InsertedMessageResultRow>(
    client,
    `WITH inserted_message AS (
      INSERT INTO messages (
        conversation_id, id, class_id, role, content, model_id, attachments,
        retrieval_confidence, sources, structured_output, debug_info, langgraph_trace,
        learning_strategy_telemetry, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb,
        $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
        $13::jsonb, $14::jsonb
      )
      ON CONFLICT (conversation_id, id) DO UPDATE SET
        role = EXCLUDED.role,
        content = EXCLUDED.content,
        model_id = EXCLUDED.model_id,
        attachments = EXCLUDED.attachments,
        retrieval_confidence = EXCLUDED.retrieval_confidence,
        sources = EXCLUDED.sources,
        structured_output = EXCLUDED.structured_output,
        debug_info = EXCLUDED.debug_info,
        langgraph_trace = EXCLUDED.langgraph_trace,
        learning_strategy_telemetry = EXCLUDED.learning_strategy_telemetry,
        metadata = messages.metadata || EXCLUDED.metadata
      RETURNING *
    )
    UPDATE conversations
    SET message_count = (
        SELECT count(*)::int
        FROM messages
        WHERE conversation_id = $1
      ),
      last_message_at = now()
    WHERE id = $1
    RETURNING (
      SELECT row_to_json(inserted_message.*)
      FROM inserted_message
    ) AS inserted`,
    [
      input.conversationId,
      input.id,
      input.classId,
      input.role,
      input.content,
      input.modelId ?? null,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.retrievalConfidence ?? null),
      JSON.stringify(input.sources ?? []),
      JSON.stringify(input.structuredOutput ?? null),
      JSON.stringify(input.debugInfo ?? null),
      JSON.stringify(input.langGraphTrace ?? null),
      JSON.stringify(input.learningStrategyTelemetry ?? null),
      JSON.stringify(input.metadata ?? {})
    ]
  );

  const inserted = result.rows[0]?.inserted as MessageRow | undefined;
  return inserted ? rowToMessage(inserted) : null;
}

export async function updateConversationMetadata({
  contextUpdatedAt,
  currentContext,
  id
}: {
  contextUpdatedAt?: string;
  currentContext?: unknown;
  id: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `UPDATE conversations
    SET metadata = metadata || $2::jsonb,
      updated_at = now()
    WHERE id = $1
    RETURNING *`,
    [
      id,
      JSON.stringify({
        ...(currentContext === undefined ? {} : { currentContext }),
        ...(contextUpdatedAt ? { contextUpdatedAt } : {})
      })
    ]
  );

  return result.rows[0] ? rowToConversation(result.rows[0]) : null;
}

export async function updateConversationTitle({
  id,
  title
}: {
  id: string;
  title: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `UPDATE conversations
    SET title = $2,
      updated_at = now()
    WHERE id = $1
    RETURNING *`,
    [id, title.trim()]
  );

  return result.rows[0] ? rowToConversation(result.rows[0]) : null;
}

export async function anonymizeStudentConversations({
  anonymizedId,
  anonymizedLabel,
  deletedStudentDisplayName,
  email,
  originalEmailHash,
  studentId
}: {
  anonymizedId: string;
  anonymizedLabel: string;
  deletedStudentDisplayName: string;
  email?: string;
  originalEmailHash?: string;
  studentId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `UPDATE conversations
    SET student_id = $2,
      student_email = '',
      student_name = $3,
      metadata = metadata || $4::jsonb,
      updated_at = now()
    WHERE student_id = $1 OR ($5 <> '' AND student_email = lower($5))
    RETURNING *`,
    [
      studentId,
      anonymizedId,
      anonymizedLabel,
      JSON.stringify({
        deletedStudentDisplayName,
        originalStudentEmailHash: originalEmailHash ?? "",
        studentDeleted: true
      }),
      email?.trim().toLowerCase() ?? ""
    ]
  );

  return result.rows.map(rowToConversation);
}

export async function listConversationMessages(conversationId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageRow>(
    client,
    `SELECT *
    FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC`,
    [conversationId]
  );

  return result.rows.map(rowToMessage);
}

export async function updateMessageLearningStrategyTelemetry({
  conversationId,
  learningStrategyTelemetry,
  messageId
}: {
  conversationId: string;
  learningStrategyTelemetry: unknown;
  messageId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageRow>(
    client,
    `UPDATE messages
    SET learning_strategy_telemetry = $3::jsonb,
      updated_at = now()
    WHERE conversation_id = $1 AND id = $2
    RETURNING *`,
    [conversationId, messageId, JSON.stringify(learningStrategyTelemetry ?? null)]
  );

  return result.rows[0] ? rowToMessage(result.rows[0]) : null;
}

export async function upsertMessageAttachment(input: {
  classId: string;
  conversationId: string;
  extractedText?: string | null;
  fileName: string;
  fileSize: number;
  fileType: "image" | "pdf";
  id: string;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
  mimeType: string;
  pageCount?: number | null;
  storageKey: string;
  studentId: string;
  uploadStatus: "uploading" | "ready" | "failed";
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageAttachmentRow>(
    client,
    `INSERT INTO message_attachments (
      id, conversation_id, message_id, class_id, student_id, file_name, file_type,
      mime_type, file_size, storage_key, upload_status, extracted_text, page_count,
      metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      conversation_id = EXCLUDED.conversation_id,
      message_id = EXCLUDED.message_id,
      class_id = EXCLUDED.class_id,
      student_id = EXCLUDED.student_id,
      file_name = EXCLUDED.file_name,
      file_type = EXCLUDED.file_type,
      mime_type = EXCLUDED.mime_type,
      file_size = EXCLUDED.file_size,
      storage_key = EXCLUDED.storage_key,
      upload_status = EXCLUDED.upload_status,
      extracted_text = EXCLUDED.extracted_text,
      page_count = EXCLUDED.page_count,
      metadata = message_attachments.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.id,
      input.conversationId,
      input.messageId ?? null,
      input.classId,
      input.studentId,
      input.fileName,
      input.fileType,
      input.mimeType,
      input.fileSize,
      input.storageKey,
      input.uploadStatus,
      input.extractedText ?? null,
      input.pageCount ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return rowToAttachment(result.rows[0]);
}

export async function listConversationAttachments(conversationId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageAttachmentRow>(
    client,
    `SELECT *
    FROM message_attachments
    WHERE conversation_id = $1
    ORDER BY created_at ASC`,
    [conversationId]
  );

  return result.rows.map(rowToAttachment);
}

export async function getConversationAttachment(attachmentId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageAttachmentRow>(
    client,
    "SELECT * FROM message_attachments WHERE id = $1",
    [attachmentId]
  );

  return result.rows[0] ? rowToAttachment(result.rows[0]) : null;
}

export async function updateAttachmentMessageId({
  attachmentId,
  messageId
}: {
  attachmentId: string;
  messageId: string | null;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MessageAttachmentRow>(
    client,
    `UPDATE message_attachments
    SET message_id = $2
    WHERE id = $1
    RETURNING *`,
    [attachmentId, messageId]
  );

  return result.rows[0] ? rowToAttachment(result.rows[0]) : null;
}

export async function deleteAttachmentMetadata(attachmentId: string, client?: PostgresQueryClient) {
  await runPostgresQuery(client, "DELETE FROM message_attachments WHERE id = $1", [attachmentId]);
}

export async function softDeleteConversation(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationRow>(
    client,
    `UPDATE conversations
    SET deleted_at = now()
    WHERE id = $1
    RETURNING *`,
    [id]
  );

  return result.rows[0] ? rowToConversation(result.rows[0]) : null;
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    classId: row.class_id,
    studentId: row.student_id,
    studentEmail: row.student_email,
    studentName: row.student_name,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    title: row.title,
    assignment: row.assignment,
    modelId: row.model_id,
    messageCount: row.message_count,
    tags: row.tags,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    deletedAt: row.deleted_at
  };
}

function rowToMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    classId: row.class_id,
    role: row.role,
    content: row.content,
    modelId: row.model_id,
    attachments: row.attachments,
    debugInfo: row.debug_info,
    langGraphTrace: row.langgraph_trace,
    learningStrategyTelemetry: row.learning_strategy_telemetry,
    retrievalConfidence: row.retrieval_confidence,
    sources: row.sources,
    structuredOutput: row.structured_output,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToAttachment(row: MessageAttachmentRow): MessageAttachmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    classId: row.class_id,
    studentId: row.student_id,
    fileName: row.file_name,
    fileType: row.file_type,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    storageKey: row.storage_key,
    uploadStatus: row.upload_status,
    extractedText: row.extracted_text,
    pageCount: row.page_count,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
