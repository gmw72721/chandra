import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type ClassRecord = {
  id: string;
  teacherId: string;
  teacherName: string;
  name: string;
  section: string;
  joinCode: string | null;
  studentChatEnabled: boolean;
  appearance: string;
  themeColor: string;
  settings: {
    answerPolicy: Record<string, unknown>;
    modelSettings: Record<string, unknown>;
    notificationSettings: Record<string, unknown>;
    privacySettings: Record<string, unknown>;
    responseFormat: Record<string, unknown>;
    sourceDefaults: Record<string, unknown>;
    sourceUsage: Record<string, unknown>;
    tutorAccess: Record<string, unknown>;
  };
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  coTeacherIds?: string[];
  coTeachers?: Record<string, CoTeacherRecord>;
};

export type ClassEnrollmentRecord = {
  id: number;
  classId: string;
  studentId: string | null;
  studentEmail: string;
  displayName: string;
  chatBlocked: boolean;
  status: string;
};

export type CoTeacherRecord = {
  displayName: string;
  email: string;
  role: "co-teacher" | "viewer";
  uid: string;
};

type ClassRow = {
  id: string;
  teacher_id: string;
  teacher_name: string;
  name: string;
  section: string;
  join_code: string | null;
  student_chat_enabled: boolean;
  appearance: string;
  theme_color: string;
  answer_policy: Record<string, unknown>;
  model_settings: Record<string, unknown>;
  notification_settings: Record<string, unknown>;
  privacy_settings: Record<string, unknown>;
  response_format: Record<string, unknown>;
  source_defaults: Record<string, unknown>;
  source_usage: Record<string, unknown>;
  tutor_access: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

type ClassEnrollmentRow = {
  id: number;
  class_id: string;
  student_id: string | null;
  student_email: string;
  display_name: string;
  chat_blocked: boolean;
  status: string;
};

type CoTeacherRow = {
  class_id: string;
  teacher_id: string;
  email: string;
  display_name: string;
  permissions: Record<string, unknown>;
  status: string;
};

export type UpsertClassInput = {
  id: string;
  name: string;
  teacherId: string;
  teacherName?: string;
  section?: string;
  joinCode?: string | null;
  studentChatEnabled?: boolean;
  appearance?: string;
  themeColor?: string;
  settings?: Partial<ClassRecord["settings"]>;
};

export async function upsertClass(input: UpsertClassInput, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    `INSERT INTO classes (
      id, teacher_id, teacher_name, name, section, join_code, student_chat_enabled,
      appearance, theme_color, answer_policy, model_settings, notification_settings, privacy_settings,
      response_format, source_defaults, source_usage, tutor_access
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
      $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      teacher_id = EXCLUDED.teacher_id,
      teacher_name = EXCLUDED.teacher_name,
      name = EXCLUDED.name,
      section = EXCLUDED.section,
      join_code = EXCLUDED.join_code,
      student_chat_enabled = EXCLUDED.student_chat_enabled,
      appearance = EXCLUDED.appearance,
      theme_color = EXCLUDED.theme_color,
      answer_policy = classes.answer_policy || EXCLUDED.answer_policy,
      model_settings = classes.model_settings || EXCLUDED.model_settings,
      notification_settings = classes.notification_settings || EXCLUDED.notification_settings,
      privacy_settings = classes.privacy_settings || EXCLUDED.privacy_settings,
      response_format = classes.response_format || EXCLUDED.response_format,
      source_defaults = classes.source_defaults || EXCLUDED.source_defaults,
      source_usage = classes.source_usage || EXCLUDED.source_usage,
      tutor_access = classes.tutor_access || EXCLUDED.tutor_access
    RETURNING *`,
    [
      input.id,
      input.teacherId,
      input.teacherName?.trim() ?? "",
      input.name.trim(),
      input.section?.trim() ?? "",
      input.joinCode?.trim() || null,
      input.studentChatEnabled ?? true,
      input.appearance ?? "",
      input.themeColor ?? "",
      JSON.stringify(input.settings?.answerPolicy ?? {}),
      JSON.stringify(input.settings?.modelSettings ?? {}),
      JSON.stringify(input.settings?.notificationSettings ?? {}),
      JSON.stringify(input.settings?.privacySettings ?? {}),
      JSON.stringify(input.settings?.responseFormat ?? {}),
      JSON.stringify(input.settings?.sourceDefaults ?? {}),
      JSON.stringify(input.settings?.sourceUsage ?? {}),
      JSON.stringify(input.settings?.tutorAccess ?? {})
    ]
  );

  return rowToClass(result.rows[0]);
}

export async function getClassById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(client, "SELECT * FROM classes WHERE id = $1", [id]);
  return result.rows[0] ? rowToClass(result.rows[0]) : null;
}

export async function getClassByJoinCode(joinCode: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    "SELECT * FROM classes WHERE join_code = $1 LIMIT 1",
    [joinCode.trim()]
  );
  return result.rows[0] ? rowToClass(result.rows[0]) : null;
}

export async function resolveClassIdByCode(classCode: string, client?: PostgresQueryClient) {
  const classById = await getClassById(classCode, client);

  if (classById) {
    return classById.id;
  }

  const classByJoinCode = await getClassByJoinCode(classCode, client);
  return classByJoinCode?.id ?? "";
}

export async function listTeacherClasses(teacherId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    `SELECT DISTINCT c.*
    FROM classes c
    LEFT JOIN co_teachers ct
      ON ct.class_id = c.id
      AND ct.teacher_id = $1
      AND ct.status = 'active'
    WHERE c.teacher_id = $1 OR ct.teacher_id IS NOT NULL
    ORDER BY c.name ASC, c.section ASC`,
    [teacherId]
  );

  return result.rows.map(rowToClass);
}

export async function listClassEnrollments(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassEnrollmentRow>(
    client,
    `SELECT *
    FROM class_enrollments
    WHERE class_id = $1 AND status = 'active'
    ORDER BY student_email ASC`,
    [classId]
  );

  return result.rows.map(rowToEnrollment);
}

export async function listStudentEnrollmentClassIds({
  email,
  studentId
}: {
  email?: string;
  studentId?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<{ class_id: string }>(
    client,
    `SELECT DISTINCT class_id
    FROM class_enrollments
    WHERE status = 'active'
      AND (
        ($1::text IS NOT NULL AND student_id = $1)
        OR ($2::text IS NOT NULL AND student_email_normalized = lower($2))
      )`,
    [studentId?.trim() || null, email?.trim().toLowerCase() || null]
  );

  return new Set(result.rows.map((row) => row.class_id));
}

export async function enrollStudentInClass({
  classId,
  displayName,
  studentEmail,
  studentId
}: {
  classId: string;
  displayName: string;
  studentEmail: string;
  studentId?: string | null;
}, client?: PostgresQueryClient) {
  if (!studentId) {
    const result = await runPostgresQuery(
      client,
      `INSERT INTO class_enrollments (
        class_id, student_id, student_email, display_name
      ) VALUES (
        $1, NULL, $2, $3
      )
      ON CONFLICT (class_id, student_email_normalized) WHERE (student_email <> '') DO UPDATE SET
        display_name = EXCLUDED.display_name,
        status = 'active',
        removed_at = NULL
      RETURNING *`,
      [classId, studentEmail.trim().toLowerCase(), displayName.trim()]
    );

    return result.rows[0] ?? null;
  }

  const result = await runPostgresQuery(
    client,
    `INSERT INTO class_enrollments (
      class_id, student_id, student_email, display_name
    ) VALUES (
      $1, $2, $3, $4
    )
    ON CONFLICT (class_id, student_id) WHERE (student_id IS NOT NULL) DO UPDATE SET
      student_email = EXCLUDED.student_email,
      display_name = EXCLUDED.display_name,
      status = 'active',
      removed_at = NULL
    RETURNING *`,
    [classId, studentId, studentEmail.trim().toLowerCase(), displayName.trim()]
  );

  return result.rows[0] ?? null;
}

export async function updateStudentEnrollmentIdentity({
  displayName,
  newEmail,
  oldEmail,
  studentId
}: {
  displayName: string;
  newEmail: string;
  oldEmail?: string;
  studentId: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `UPDATE class_enrollments
    SET
      student_email = $3,
      display_name = coalesce(nullif($4, ''), display_name)
    WHERE ($1::text IS NOT NULL AND student_id = $1)
      OR ($2::text IS NOT NULL AND student_email_normalized = lower($2))`,
    [studentId.trim() || null, oldEmail?.trim().toLowerCase() || null, newEmail.trim().toLowerCase(), displayName.trim()]
  );
}

export async function archiveClass(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    `UPDATE classes
    SET archived_at = now()
    WHERE id = $1
    RETURNING *`,
    [id]
  );

  return result.rows[0] ? rowToClass(result.rows[0]) : null;
}

export async function updateClassJoinCode({
  classId,
  joinCode
}: {
  classId: string;
  joinCode: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    `UPDATE classes
    SET join_code = $2
    WHERE id = $1
    RETURNING *`,
    [classId, joinCode.trim()]
  );

  return result.rows[0] ? rowToClass(result.rows[0]) : null;
}

export async function updateClassSettings(input: {
  answerPolicy?: Record<string, unknown>;
  appearance?: string;
  behaviorInstructions?: string;
  behaviorTitle?: string;
  classId: string;
  defaultAssignmentContext?: string;
  modelSettings?: Record<string, unknown>;
  name?: string;
  notificationSettings?: Record<string, unknown>;
  openingMessage?: string;
  privacySettings?: Record<string, unknown>;
  refusalStyle?: string;
  responseFormat?: Record<string, unknown>;
  section?: string;
  sourceDefaults?: Record<string, unknown>;
  sourceUsage?: Record<string, unknown>;
  studentFacingInstructions?: string;
  studentChatEnabled?: boolean;
  teacherName?: string;
  tutorAccess?: Record<string, unknown>;
  themeColor?: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ClassRow>(
    client,
    `UPDATE classes
    SET
      answer_policy = coalesce($2::jsonb, answer_policy),
      appearance = coalesce($3, appearance),
      theme_color = coalesce($4, theme_color),
      behavior_instructions = coalesce($5, behavior_instructions),
      behavior_title = coalesce($6, behavior_title),
      default_assignment_context = coalesce($7, default_assignment_context),
      model_settings = coalesce($8::jsonb, model_settings),
      name = coalesce($9, name),
      notification_settings = coalesce($10::jsonb, notification_settings),
      opening_message = coalesce($11, opening_message),
      privacy_settings = coalesce($12::jsonb, privacy_settings),
      refusal_style = coalesce($13, refusal_style),
      response_format = coalesce($14::jsonb, response_format),
      section = coalesce($15, section),
      source_defaults = coalesce($16::jsonb, source_defaults),
      source_usage = coalesce($17::jsonb, source_usage),
      student_facing_instructions = coalesce($18, student_facing_instructions),
      student_chat_enabled = coalesce($19, student_chat_enabled),
      teacher_name = coalesce($20, teacher_name),
      tutor_access = coalesce($21::jsonb, tutor_access)
    WHERE id = $1
    RETURNING *`,
    [
      input.classId,
      input.answerPolicy ? JSON.stringify(input.answerPolicy) : null,
      input.appearance ?? null,
      input.themeColor ?? null,
      input.behaviorInstructions ?? null,
      input.behaviorTitle ?? null,
      input.defaultAssignmentContext ?? null,
      input.modelSettings ? JSON.stringify(input.modelSettings) : null,
      input.name ?? null,
      input.notificationSettings ? JSON.stringify(input.notificationSettings) : null,
      input.openingMessage ?? null,
      input.privacySettings ? JSON.stringify(input.privacySettings) : null,
      input.refusalStyle ?? null,
      input.responseFormat ? JSON.stringify(input.responseFormat) : null,
      input.section ?? null,
      input.sourceDefaults ? JSON.stringify(input.sourceDefaults) : null,
      input.sourceUsage ? JSON.stringify(input.sourceUsage) : null,
      input.studentFacingInstructions ?? null,
      input.studentChatEnabled ?? null,
      input.teacherName ?? null,
      input.tutorAccess ? JSON.stringify(input.tutorAccess) : null
    ]
  );

  return result.rows[0] ? rowToClass(result.rows[0]) : null;
}

export async function upsertCoTeacher({
  classId,
  displayName,
  email,
  invitedBy,
  role,
  teacherId
}: {
  classId: string;
  displayName: string;
  email: string;
  invitedBy?: string;
  role: "co-teacher" | "viewer";
  teacherId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<CoTeacherRow>(
    client,
    `INSERT INTO co_teachers (
      class_id, teacher_id, email, display_name, status, invited_by, permissions
    ) VALUES (
      $1, $2, $3, $4, 'active', $5, $6::jsonb
    )
    ON CONFLICT (class_id, teacher_id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name,
      status = 'active',
      permissions = EXCLUDED.permissions,
      removed_at = NULL
    RETURNING *`,
    [classId, teacherId, email.trim().toLowerCase(), displayName.trim(), invitedBy ?? null, JSON.stringify({ role })]
  );

  return rowToCoTeacher(result.rows[0]);
}

export async function updateCoTeacherProfile({
  displayName,
  email,
  teacherId
}: {
  displayName: string;
  email: string;
  teacherId: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `UPDATE co_teachers
    SET email = $2,
      display_name = coalesce(nullif($3, ''), display_name)
    WHERE teacher_id = $1 AND status = 'active'`,
    [teacherId, email.trim().toLowerCase(), displayName.trim()]
  );
}

export async function updateCoTeacherRole({
  classId,
  role,
  teacherId
}: {
  classId: string;
  role: "co-teacher" | "viewer";
  teacherId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<CoTeacherRow>(
    client,
    `UPDATE co_teachers
    SET permissions = permissions || $3::jsonb
    WHERE class_id = $1 AND teacher_id = $2 AND status = 'active'
    RETURNING *`,
    [classId, teacherId, JSON.stringify({ role })]
  );

  return result.rows[0] ? rowToCoTeacher(result.rows[0]) : null;
}

export async function removeCoTeacher({
  classId,
  teacherId
}: {
  classId: string;
  teacherId: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `UPDATE co_teachers
    SET status = 'removed', removed_at = now()
    WHERE class_id = $1 AND teacher_id = $2`,
    [classId, teacherId]
  );
}

export async function listCoTeachers(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<CoTeacherRow>(
    client,
    "SELECT * FROM co_teachers WHERE class_id = $1 AND status = 'active' ORDER BY email ASC",
    [classId]
  );

  return result.rows.map(rowToCoTeacher);
}

function rowToClass(row: ClassRow): ClassRecord {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    name: row.name,
    section: row.section,
    joinCode: row.join_code,
    studentChatEnabled: row.student_chat_enabled,
    appearance: row.appearance,
    themeColor: row.theme_color,
    settings: {
      answerPolicy: row.answer_policy,
      modelSettings: row.model_settings,
      notificationSettings: row.notification_settings,
      privacySettings: row.privacy_settings,
      responseFormat: row.response_format,
      sourceDefaults: row.source_defaults,
      sourceUsage: row.source_usage,
      tutorAccess: row.tutor_access
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function rowToEnrollment(row: ClassEnrollmentRow): ClassEnrollmentRecord {
  return {
    id: row.id,
    classId: row.class_id,
    studentId: row.student_id,
    studentEmail: row.student_email,
    displayName: row.display_name,
    chatBlocked: row.chat_blocked,
    status: row.status
  };
}

function rowToCoTeacher(row: CoTeacherRow): CoTeacherRecord {
  const role = row.permissions.role === "viewer" ? "viewer" : "co-teacher";

  return {
    displayName: row.display_name,
    email: row.email,
    role,
    uid: row.teacher_id
  };
}
