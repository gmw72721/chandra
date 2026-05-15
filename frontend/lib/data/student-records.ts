import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type StudentFeedbackRecord = {
  id: string;
  classId: string;
  conversationId: string | null;
  messageId: string | null;
  studentId: string | null;
  studentEmail: string;
  studentName: string;
  kind: string;
  promptReason: string | null;
  rating: string | null;
  comment: string;
  status: string;
  teacherNote: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationReviewRecord = {
  classId: string;
  conversationId: string;
  status: string;
  teacherNote: string;
  reviewedBy: string | null;
  metadata: Record<string, unknown>;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudentSupportRecord = {
  id: string;
  classId: string;
  studentId: string | null;
  studentEmail: string;
  displayName: string;
  chatBlocked: boolean;
  supportNotes: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type StudentLearningProfileRecord = {
  id: string;
  classId: string;
  studentId: string | null;
  studentEmail: string;
  studentName: string;
  activeProfile: Record<string, unknown> | null;
  draftProfile: Record<string, unknown> | null;
  confidence: "low" | "medium" | "high";
  disabled: boolean;
  metadata: Record<string, unknown>;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type StudentFeedbackRow = {
  id: string;
  class_id: string;
  conversation_id: string | null;
  message_id: string | null;
  student_id: string | null;
  student_email: string;
  student_name: string;
  kind: string;
  prompt_reason: string | null;
  rating: string | null;
  comment: string;
  status: string;
  teacher_note: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type ConversationReviewRow = {
  class_id: string;
  conversation_id: string;
  status: string;
  teacher_note: string;
  reviewed_by: string | null;
  metadata: Record<string, unknown>;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type StudentSupportRow = {
  id: string;
  class_id: string;
  student_id: string | null;
  student_email: string;
  display_name: string;
  chat_blocked: boolean;
  support_notes: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type StudentLearningProfileRow = {
  id: string;
  class_id: string;
  student_id: string | null;
  student_email: string;
  student_name: string;
  active_profile: Record<string, unknown> | null;
  draft_profile: Record<string, unknown> | null;
  confidence: "low" | "medium" | "high";
  disabled: boolean;
  metadata: Record<string, unknown>;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function upsertStudentFeedback(input: {
  classId: string;
  comment: string;
  conversationId?: string | null;
  id: string;
  kind: string;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
  promptReason?: string | null;
  rating?: string | null;
  status?: string;
  studentVisibleResponse?: string;
  studentVisibleResponseSentAt?: string;
  studentEmail: string;
  studentId: string;
  studentName: string;
  teacherNote?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentFeedbackRow>(
    client,
    `INSERT INTO student_feedback (
      id, class_id, conversation_id, message_id, student_id, student_email, student_name,
      kind, prompt_reason, rating, comment, status, teacher_note, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      teacher_note = EXCLUDED.teacher_note,
      metadata = student_feedback.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.id,
      input.classId,
      input.conversationId ?? null,
      input.messageId ?? null,
      input.studentId,
      input.studentEmail.trim().toLowerCase(),
      input.studentName,
      input.kind,
      input.promptReason ?? null,
      input.rating ?? null,
      input.comment,
      input.status ?? "new",
      input.teacherNote ?? "",
      JSON.stringify({
        ...(input.metadata ?? {}),
        studentVisibleResponse: input.studentVisibleResponse ?? input.metadata?.studentVisibleResponse ?? "",
        studentVisibleResponseSentAt: input.studentVisibleResponseSentAt ?? input.metadata?.studentVisibleResponseSentAt ?? ""
      })
    ]
  );

  return rowToFeedback(result.rows[0]);
}

export async function listFeedback(input: {
  classId: string;
  conversationId?: string;
  status?: string;
  studentId?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentFeedbackRow>(
    client,
    `SELECT *
    FROM student_feedback
    WHERE class_id = $1
      AND ($2::text IS NULL OR student_id = $2)
      AND ($3::text IS NULL OR conversation_id = $3)
      AND ($4::text IS NULL OR status = $4)
    ORDER BY created_at DESC`,
    [
      input.classId,
      input.studentId ?? null,
      input.conversationId ?? null,
      input.status ?? null
    ]
  );

  return result.rows.map(rowToFeedback);
}

export async function upsertConversationReview(input: {
  classId: string;
  conversationId: string;
  flags?: string[];
  followUpDueAt?: string | null;
  privateNote?: string;
  reviewedBy?: string;
  studentVisibleNote?: string;
  studentVisibleNoteSentAt?: string | null;
  status: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationReviewRow>(
    client,
    `INSERT INTO conversation_reviews (
      class_id, conversation_id, status, teacher_note, reviewed_by, reviewed_at, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, CASE WHEN $3 = 'new' THEN NULL ELSE now() END, $6::jsonb
    )
    ON CONFLICT (class_id, conversation_id) DO UPDATE SET
      status = EXCLUDED.status,
      teacher_note = EXCLUDED.teacher_note,
      reviewed_by = EXCLUDED.reviewed_by,
      reviewed_at = EXCLUDED.reviewed_at,
      metadata = conversation_reviews.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.classId,
      input.conversationId,
      input.status,
      input.privateNote ?? "",
      input.reviewedBy ?? null,
      JSON.stringify({
        flags: input.flags ?? [],
        followUpDueAt: input.followUpDueAt ?? null,
        ...(input.studentVisibleNote === undefined ? {} : { studentVisibleNote: input.studentVisibleNote }),
        ...(input.studentVisibleNoteSentAt === undefined
          ? {}
          : { studentVisibleNoteSentAt: input.studentVisibleNoteSentAt ?? null }),
        teacherId: input.reviewedBy ?? ""
      })
    ]
  );

  return rowToReview(result.rows[0]);
}

export async function listConversationReviews(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ConversationReviewRow>(
    client,
    "SELECT * FROM conversation_reviews WHERE class_id = $1",
    [classId]
  );

  return result.rows.map(rowToReview);
}

export async function upsertStudentSupport(input: {
  chatBlocked?: boolean;
  classId: string;
  displayName?: string;
  id: string;
  metadata?: Record<string, unknown>;
  studentEmail: string;
  studentId?: string | null;
  supportNotes?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentSupportRow>(
    client,
    `INSERT INTO student_support (
      id, class_id, student_id, student_email, display_name, chat_blocked, support_notes, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      student_id = coalesce(EXCLUDED.student_id, student_support.student_id),
      student_email = EXCLUDED.student_email,
      display_name = coalesce(nullif(EXCLUDED.display_name, ''), student_support.display_name),
      chat_blocked = EXCLUDED.chat_blocked,
      support_notes = EXCLUDED.support_notes,
      metadata = student_support.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.id,
      input.classId,
      input.studentId ?? null,
      input.studentEmail.trim().toLowerCase(),
      input.displayName ?? "",
      input.chatBlocked ?? false,
      input.supportNotes ?? "",
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return rowToSupport(result.rows[0]);
}

export async function listStudentSupport(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentSupportRow>(
    client,
    "SELECT * FROM student_support WHERE class_id = $1",
    [classId]
  );

  return result.rows.map(rowToSupport);
}

export async function upsertStudentLearningProfile(input: {
  activeProfile?: Record<string, unknown> | null;
  approvedAt?: Date | null;
  classId: string;
  confidence?: "low" | "medium" | "high";
  disabled?: boolean;
  draftProfile?: Record<string, unknown> | null;
  id: string;
  metadata?: Record<string, unknown>;
  studentEmail?: string;
  studentId?: string;
  studentName?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentLearningProfileRow>(
    client,
    `INSERT INTO student_learning_profiles (
      id, class_id, student_id, student_email, student_name,
      active_profile, draft_profile, confidence, disabled, metadata, approved_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11
    )
	    ON CONFLICT (id) DO UPDATE SET
	      student_id = coalesce(EXCLUDED.student_id, student_learning_profiles.student_id),
	      student_email = coalesce(nullif(EXCLUDED.student_email, ''), student_learning_profiles.student_email),
	      student_name = coalesce(nullif(EXCLUDED.student_name, ''), student_learning_profiles.student_name),
	      active_profile = CASE WHEN $12::boolean THEN EXCLUDED.active_profile ELSE student_learning_profiles.active_profile END,
	      draft_profile = CASE WHEN $13::boolean THEN EXCLUDED.draft_profile ELSE student_learning_profiles.draft_profile END,
	      confidence = CASE WHEN $14::boolean THEN EXCLUDED.confidence ELSE student_learning_profiles.confidence END,
	      disabled = CASE WHEN $15::boolean THEN EXCLUDED.disabled ELSE student_learning_profiles.disabled END,
	      metadata = student_learning_profiles.metadata || EXCLUDED.metadata,
	      approved_at = coalesce(EXCLUDED.approved_at, student_learning_profiles.approved_at)
	    RETURNING *`,
    [
      input.id,
      input.classId,
      input.studentId ?? null,
      input.studentEmail ?? "",
      input.studentName ?? "Student",
      JSON.stringify(input.activeProfile ?? null),
      JSON.stringify(input.draftProfile ?? null),
      input.confidence ?? "low",
      input.disabled ?? false,
      JSON.stringify(input.metadata ?? {}),
	      input.approvedAt ?? null,
	      Object.prototype.hasOwnProperty.call(input, "activeProfile") && input.activeProfile !== undefined,
	      Object.prototype.hasOwnProperty.call(input, "draftProfile") && input.draftProfile !== undefined,
	      Object.prototype.hasOwnProperty.call(input, "confidence") && input.confidence !== undefined,
	      Object.prototype.hasOwnProperty.call(input, "disabled") && input.disabled !== undefined
	    ]
	  );

  return rowToProfile(result.rows[0]);
}

export async function getStudentLearningProfileById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<StudentLearningProfileRow>(
    client,
    "SELECT * FROM student_learning_profiles WHERE id = $1",
    [id]
  );

  return result.rows[0] ? rowToProfile(result.rows[0]) : null;
}

export async function addLearningProfileRevision(input: {
  classId: string;
  confidence?: string;
  nextProfile?: Record<string, unknown> | null;
  previousProfile?: Record<string, unknown> | null;
  profileId: string;
  revisionType: string;
  studentId?: string | null;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO learning_profile_revisions (
      profile_id, class_id, student_id, revision_type, previous_profile,
      next_profile, confidence, metadata
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb,
      $6::jsonb, $7, '{}'::jsonb
    )`,
    [
      input.profileId,
      input.classId,
      input.studentId ?? null,
      input.revisionType,
      JSON.stringify(input.previousProfile ?? null),
      JSON.stringify(input.nextProfile ?? null),
      input.confidence ?? null
    ]
  );
}

function rowToFeedback(row: StudentFeedbackRow): StudentFeedbackRecord {
  return {
    id: row.id,
    classId: row.class_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    studentId: row.student_id,
    studentEmail: row.student_email,
    studentName: row.student_name,
    kind: row.kind,
    promptReason: row.prompt_reason,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    teacherNote: row.teacher_note,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToReview(row: ConversationReviewRow): ConversationReviewRecord {
  return {
    classId: row.class_id,
    conversationId: row.conversation_id,
    status: row.status,
    teacherNote: row.teacher_note,
    reviewedBy: row.reviewed_by,
    metadata: row.metadata,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSupport(row: StudentSupportRow): StudentSupportRecord {
  return {
    id: row.id,
    classId: row.class_id,
    studentId: row.student_id,
    studentEmail: row.student_email,
    displayName: row.display_name,
    chatBlocked: row.chat_blocked,
    supportNotes: row.support_notes,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToProfile(row: StudentLearningProfileRow): StudentLearningProfileRecord {
  return {
    id: row.id,
    classId: row.class_id,
    studentId: row.student_id,
    studentEmail: row.student_email,
    studentName: row.student_name,
    activeProfile: row.active_profile,
    draftProfile: row.draft_profile,
    confidence: row.confidence,
    disabled: row.disabled,
    metadata: row.metadata,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
