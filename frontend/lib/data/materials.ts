import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type MaterialStatus = "uploaded" | "processing" | "ready" | "failed" | "deleted";
export type MaterialPriority = "primary" | "normal" | "low";

export type MaterialRecord = {
  id: string;
  classId: string;
  teacherId: string;
  title: string;
  kind: string;
  materialType: string;
  sourceMode: string;
  status: MaterialStatus;
  activeForStudents: boolean;
  citationsRequired: boolean;
  teacherOnly: boolean;
  priority: MaterialPriority;
  fileName: string | null;
  contentType: string | null;
  fileSize: number;
  characterCount: number;
  chunkCount: number;
  storageBucket: string | null;
  storagePath: string | null;
  storageUri: string | null;
  fileUrl: string | null;
  searchMetadataSource: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type MaterialJobStatus = "queued" | "processing" | "ready" | "failed";

export type MaterialJobRecord = {
  id: string;
  classId: string;
  materialId: string | null;
  step: string;
  status: MaterialJobStatus;
  percent: number;
  detail: string;
  error: string | null;
  completedChunks: number | null;
  totalChunks: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type MaterialRow = {
  id: string;
  class_id: string;
  teacher_id: string;
  title: string;
  kind: string;
  material_type: string;
  source_mode: string;
  status: MaterialStatus;
  active_for_students: boolean;
  citations_required: boolean;
  teacher_only: boolean;
  priority: MaterialPriority;
  file_name: string | null;
  content_type: string | null;
  file_size: string | number;
  character_count: number;
  chunk_count: number;
  storage_bucket: string | null;
  storage_path: string | null;
  storage_uri: string | null;
  file_url: string | null;
  search_metadata_source: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

type MaterialJobRow = {
  id: string;
  class_id: string;
  material_id: string | null;
  step: string;
  status: MaterialJobStatus;
  percent: number;
  detail: string;
  error: string | null;
  completed_chunks: number | null;
  total_chunks: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type UpsertMaterialInput = {
  id: string;
  classId: string;
  teacherId: string;
  title: string;
  kind: string;
  activeForStudents?: boolean;
  citationsRequired?: boolean;
  contentType?: string | null;
  fileName?: string | null;
  fileSize?: number;
  fileUrl?: string | null;
  materialType?: string;
  metadata?: Record<string, unknown>;
  priority?: MaterialPriority;
  searchMetadataSource?: string;
  sourceMode?: string;
  status?: MaterialStatus;
  storageBucket?: string | null;
  storagePath?: string | null;
  storageUri?: string | null;
  teacherOnly?: boolean;
};

export async function upsertMaterial(input: UpsertMaterialInput, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialRow>(
    client,
    `INSERT INTO materials (
      id, class_id, teacher_id, title, kind, material_type, source_mode, status,
      active_for_students, citations_required, teacher_only, priority,
      file_name, content_type, file_size, storage_bucket, storage_path, storage_uri,
      file_url, search_metadata_source, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18,
      $19, $20, $21::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      teacher_id = EXCLUDED.teacher_id,
      title = EXCLUDED.title,
      kind = EXCLUDED.kind,
      material_type = EXCLUDED.material_type,
      source_mode = EXCLUDED.source_mode,
      status = EXCLUDED.status,
      active_for_students = EXCLUDED.active_for_students,
      citations_required = EXCLUDED.citations_required,
      teacher_only = EXCLUDED.teacher_only,
      priority = EXCLUDED.priority,
      file_name = EXCLUDED.file_name,
      content_type = EXCLUDED.content_type,
      file_size = EXCLUDED.file_size,
      storage_bucket = EXCLUDED.storage_bucket,
      storage_path = EXCLUDED.storage_path,
      storage_uri = EXCLUDED.storage_uri,
      file_url = EXCLUDED.file_url,
      search_metadata_source = EXCLUDED.search_metadata_source,
      metadata = materials.metadata || EXCLUDED.metadata,
      deleted_at = CASE WHEN EXCLUDED.status = 'deleted' THEN materials.deleted_at ELSE NULL END
    RETURNING *`,
    [
      input.id,
      input.classId,
      input.teacherId,
      input.title.trim(),
      input.kind,
      input.materialType ?? "",
      input.sourceMode ?? "pasted",
      input.status ?? "uploaded",
      input.activeForStudents ?? false,
      input.citationsRequired ?? false,
      input.teacherOnly ?? false,
      input.priority ?? "normal",
      input.fileName ?? null,
      input.contentType ?? null,
      input.fileSize ?? 0,
      input.storageBucket ?? null,
      input.storagePath ?? null,
      input.storageUri ?? null,
      input.fileUrl ?? null,
      input.searchMetadataSource ?? "firestore",
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return rowToMaterial(result.rows[0]);
}

export async function getMaterialById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialRow>(client, "SELECT * FROM materials WHERE id = $1", [id]);
  return result.rows[0] ? rowToMaterial(result.rows[0]) : null;
}

export async function listClassMaterials(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialRow>(
    client,
    `SELECT *
    FROM materials
    WHERE class_id = $1 AND deleted_at IS NULL
    ORDER BY title ASC`,
    [classId]
  );

  return result.rows.map(rowToMaterial);
}

export async function listActiveMaterialJobsByClass(classId: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialJobRow>(
    client,
    `SELECT DISTINCT ON (material_id) *
    FROM material_jobs
    WHERE class_id = $1
      AND material_id IS NOT NULL
      AND status = 'processing'
    ORDER BY material_id, updated_at DESC`,
    [classId]
  );

  return result.rows.map(rowToMaterialJob);
}

export async function updateMaterialStatus({
  characterCount,
  chunkCount,
  id,
  searchMetadataSource,
  status
}: {
  characterCount?: number;
  chunkCount?: number;
  id: string;
  searchMetadataSource?: string;
  status: MaterialStatus;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialRow>(
    client,
    `UPDATE materials
    SET status = $2,
      character_count = coalesce($3, character_count),
      chunk_count = coalesce($4, chunk_count),
      search_metadata_source = coalesce($5, search_metadata_source),
      deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE deleted_at END
    WHERE id = $1
    RETURNING *`,
    [id, status, characterCount ?? null, chunkCount ?? null, searchMetadataSource ?? null]
  );

  return result.rows[0] ? rowToMaterial(result.rows[0]) : null;
}

export async function updateMaterialVisibility({
  activeForStudents,
  citationsRequired,
  id,
  priority,
  teacherOnly
}: {
  activeForStudents: boolean;
  citationsRequired: boolean;
  id: string;
  priority: MaterialPriority;
  teacherOnly: boolean;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialRow>(
    client,
    `UPDATE materials
    SET active_for_students = $2,
      citations_required = $3,
      priority = $4,
      teacher_only = $5
    WHERE id = $1
    RETURNING *`,
    [id, activeForStudents, citationsRequired, priority, teacherOnly]
  );

  return result.rows[0] ? rowToMaterial(result.rows[0]) : null;
}

export async function deleteMaterial(id: string, client?: PostgresQueryClient) {
  return updateMaterialStatus({ id, status: "deleted" }, client);
}

export async function upsertMaterialJob(input: {
  classId: string;
  completedChunks?: number | null;
  detail: string;
  error?: string | null;
  id: string;
  materialId?: string | null;
  metadata?: Record<string, unknown>;
  percent: number;
  step: string;
  title?: string;
  totalChunks?: number | null;
}, client?: PostgresQueryClient) {
  const status: MaterialJobStatus = input.step === "failed"
    ? "failed"
    : input.step === "ready"
      ? "ready"
      : "processing";
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.title ? { title: input.title } : {})
  };
  const result = await runPostgresQuery<MaterialJobRow>(
    client,
    `INSERT INTO material_jobs (
      id, class_id, material_id, step, status, percent, detail, error,
      completed_chunks, total_chunks, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      material_id = EXCLUDED.material_id,
      step = EXCLUDED.step,
      status = EXCLUDED.status,
      percent = EXCLUDED.percent,
      detail = EXCLUDED.detail,
      error = EXCLUDED.error,
      completed_chunks = EXCLUDED.completed_chunks,
      total_chunks = EXCLUDED.total_chunks,
      metadata = material_jobs.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.id,
      input.classId,
      input.materialId ?? null,
      input.step,
      status,
      Math.max(0, Math.min(100, input.percent)),
      input.detail,
      input.error ?? null,
      input.completedChunks ?? null,
      input.totalChunks ?? null,
      JSON.stringify(metadata)
    ]
  );

  return rowToMaterialJob(result.rows[0]);
}

export async function getMaterialJobById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<MaterialJobRow>(
    client,
    "SELECT * FROM material_jobs WHERE id = $1",
    [id]
  );

  return result.rows[0] ? rowToMaterialJob(result.rows[0]) : null;
}

export async function createMaterialUploadSession(input: {
  classId: string;
  contentType?: string;
  expiresAt: Date;
  fileName?: string;
  fileSize?: number;
  materialId: string;
  storageBucket?: string;
  storagePath?: string;
  teacherId: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO material_upload_sessions (
      id, class_id, material_id, teacher_id, file_name, content_type,
      file_size, storage_bucket, storage_path, status, expires_at
    ) VALUES (
      $1, $2, NULL, $3, $4, $5,
      $6, $7, $8, 'pending', $9
    )
    ON CONFLICT (id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      teacher_id = EXCLUDED.teacher_id,
      file_name = EXCLUDED.file_name,
      content_type = EXCLUDED.content_type,
      file_size = EXCLUDED.file_size,
      storage_bucket = EXCLUDED.storage_bucket,
      storage_path = EXCLUDED.storage_path,
      status = 'pending',
      expires_at = EXCLUDED.expires_at`,
    [
      input.materialId,
      input.classId,
      input.teacherId,
      input.fileName ?? "",
      input.contentType ?? "",
      input.fileSize ?? 0,
      input.storageBucket ?? "",
      input.storagePath ?? "",
      input.expiresAt
    ]
  );
}

function rowToMaterial(row: MaterialRow): MaterialRecord {
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    title: row.title,
    kind: row.kind,
    materialType: row.material_type,
    sourceMode: row.source_mode,
    status: row.status,
    activeForStudents: row.active_for_students,
    citationsRequired: row.citations_required,
    teacherOnly: row.teacher_only,
    priority: row.priority,
    fileName: row.file_name,
    contentType: row.content_type,
    fileSize: Number(row.file_size),
    characterCount: row.character_count,
    chunkCount: row.chunk_count,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    storageUri: row.storage_uri,
    fileUrl: row.file_url,
    searchMetadataSource: row.search_metadata_source,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function rowToMaterialJob(row: MaterialJobRow): MaterialJobRecord {
  return {
    id: row.id,
    classId: row.class_id,
    materialId: row.material_id,
    step: row.step,
    status: row.status,
    percent: row.percent,
    detail: row.detail,
    error: row.error,
    completedChunks: row.completed_chunks,
    totalChunks: row.total_chunks,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
