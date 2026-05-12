import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type TeacherInviteRecord = {
  id: string;
  tokenHash: string;
  email: string;
  createdBy: string;
  usedBy: string;
  status: "active" | "used" | "revoked" | "expired";
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  revokedAt: Date | null;
};

type TeacherInviteRow = {
  id: string;
  token_hash: string;
  email: string | null;
  created_by: string | null;
  used_by: string | null;
  status: "active" | "used" | "revoked" | "expired";
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  used_at: Date | null;
  revoked_at: Date | null;
};

type RateLimitRow = {
  count: number;
  expires_at: Date;
};

type AbuseLockoutRow = {
  attempt_count: number;
  locked_until: Date;
  metadata: Record<string, unknown>;
};

export async function writeAuditLogPostgres(input: {
  actorId?: string;
  actorRole?: string;
  eventType: string;
  ipHash?: string;
  metadata?: Record<string, unknown>;
  resourceId?: string;
  resourceType?: string;
  route?: string;
  userAgent?: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO audit_logs (
      actor_id, actor_role, event_type, resource_type, resource_id, route, ip_hash, user_agent, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb
    )`,
    [
      input.actorId || null,
      input.actorRole || null,
      input.eventType,
      input.resourceType || null,
      input.resourceId || null,
      input.route || null,
      input.ipHash || null,
      input.userAgent || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function writeSecurityEventPostgres(input: {
  actorId?: string;
  eventType: string;
  ipHash?: string;
  metadata?: Record<string, unknown>;
  route?: string;
  severity?: "info" | "warning" | "error" | "critical";
  userAgent?: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO security_events (
      actor_id, event_type, severity, route, ip_hash, user_agent, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb
    )`,
    [
      input.actorId || null,
      input.eventType,
      input.severity ?? "info",
      input.route || null,
      input.ipHash || null,
      input.userAgent || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function writeChatErrorReferencePostgres(input: {
  classId?: string;
  conversationId?: string;
  errorCode: string;
  errorMessage?: string;
  id: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  modelId?: string;
  provider?: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO chat_error_references (
      id, class_id, conversation_id, message_id, error_code, error_message, provider, model_id, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      class_id = EXCLUDED.class_id,
      conversation_id = EXCLUDED.conversation_id,
      message_id = EXCLUDED.message_id,
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      provider = EXCLUDED.provider,
      model_id = EXCLUDED.model_id,
      metadata = chat_error_references.metadata || EXCLUDED.metadata`,
    [
      input.id,
      input.classId || null,
      input.conversationId || null,
      input.messageId || null,
      input.errorCode,
      input.errorMessage || null,
      input.provider || null,
      input.modelId || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function checkRateLimitPostgres(input: {
  id: string;
  keyHash: string;
  limit: number;
  namespace: string;
  now: Date;
  windowKey: string;
  windowMs: number;
}, client?: PostgresQueryClient) {
  const expiresAt = new Date(input.now.getTime() + input.windowMs);
  const existing = await runPostgresQuery<RateLimitRow>(
    client,
    "SELECT count, expires_at FROM rate_limits WHERE id = $1 FOR UPDATE",
    [input.id]
  );
  const row = existing.rows[0];
  const currentCount = row && row.expires_at.getTime() > input.now.getTime() ? Number(row.count ?? 0) : 0;
  const nextCount = currentCount + 1;
  const nextExpiresAt = row && row.expires_at.getTime() > input.now.getTime() ? row.expires_at : expiresAt;

  await runPostgresQuery(
    client,
    `INSERT INTO rate_limits (
      id, namespace, key_hash, window_key, limit_count, count, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7
    )
    ON CONFLICT (id) DO UPDATE SET
      limit_count = EXCLUDED.limit_count,
      count = EXCLUDED.count,
      expires_at = EXCLUDED.expires_at`,
    [input.id, input.namespace, input.keyHash, input.windowKey, input.limit, nextCount, nextExpiresAt]
  );

  return {
    allowed: nextCount <= input.limit,
    count: nextCount,
    limit: input.limit,
    retryAfterMs: Math.max(0, nextExpiresAt.getTime() - input.now.getTime())
  };
}

export async function getAbuseLockoutPostgres(keyHash: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AbuseLockoutRow>(
    client,
    "SELECT attempt_count, locked_until, metadata FROM abuse_lockouts WHERE key_hash = $1",
    [keyHash]
  );
  return result.rows[0] ?? null;
}

export async function recordAbuseFailurePostgres(input: {
  actorUid?: string;
  identifierHash: string;
  keyHash: string;
  lockedUntil: Date;
  namespace: string;
  now: Date;
  resetAt: Date;
}, client?: PostgresQueryClient) {
  const existing = await runPostgresQuery<AbuseLockoutRow>(
    client,
    "SELECT attempt_count, locked_until, metadata FROM abuse_lockouts WHERE key_hash = $1 FOR UPDATE",
    [input.keyHash]
  );
  const previous = existing.rows[0];
  const previousResetAt = timestampFromMetadata(previous?.metadata.resetAtMillis);
  const currentCount = previous && previousResetAt > input.now.getTime() ? Number(previous.attempt_count ?? 0) : 0;
  const attemptCount = currentCount + 1;

  await runPostgresQuery(
    client,
    `INSERT INTO abuse_lockouts (
      id, key_hash, reason, locked_until, attempt_count, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      locked_until = EXCLUDED.locked_until,
      attempt_count = EXCLUDED.attempt_count,
      metadata = abuse_lockouts.metadata || EXCLUDED.metadata`,
    [
      input.keyHash,
      input.keyHash,
      input.namespace,
      input.lockedUntil,
      attemptCount,
      JSON.stringify({
        actorUid: input.actorUid ?? "",
        identifierHash: input.identifierHash,
        namespace: input.namespace,
        resetAtMillis: input.resetAt.getTime()
      })
    ]
  );

  return attemptCount;
}

export async function resetAbuseLockoutPostgres(keyHash: string, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO abuse_lockouts (
      id, key_hash, locked_until, attempt_count, metadata
    ) VALUES (
      $1, $1, to_timestamp(0), 0, '{"resetAtMillis":0}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      locked_until = to_timestamp(0),
      attempt_count = 0,
      metadata = abuse_lockouts.metadata || '{"resetAtMillis":0}'::jsonb`,
    [keyHash]
  );
}

export async function createTeacherInvitePostgres(input: {
  createdBy: string;
  createdByEmail: string;
  expiresAt: Date;
  tokenHash: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<TeacherInviteRow>(
    client,
    `INSERT INTO teacher_invites (
      id, token_hash, created_by, status, expires_at, metadata
    ) VALUES (
      $1, $1, $2, 'active', $3, $4::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      token_hash = EXCLUDED.token_hash,
      created_by = EXCLUDED.created_by,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      metadata = teacher_invites.metadata || EXCLUDED.metadata
    RETURNING *`,
    [
      input.tokenHash,
      input.createdBy,
      input.expiresAt,
      JSON.stringify({ createdByEmail: input.createdByEmail })
    ]
  );

  return rowToTeacherInvite(result.rows[0]);
}

export async function listTeacherInvitesPostgres(createdBy: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<TeacherInviteRow>(
    client,
    `SELECT *
    FROM teacher_invites
    WHERE created_by = $1
    ORDER BY created_at DESC`,
    [createdBy]
  );
  return result.rows.map(rowToTeacherInvite);
}

export async function getTeacherInvitePostgres(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<TeacherInviteRow>(
    client,
    "SELECT * FROM teacher_invites WHERE id = $1",
    [id]
  );
  return result.rows[0] ? rowToTeacherInvite(result.rows[0]) : null;
}

export async function revokeTeacherInvitePostgres(input: {
  id: string;
  revokedBy: string;
  revokedByEmail: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<TeacherInviteRow>(
    client,
    `UPDATE teacher_invites
    SET status = 'revoked',
      revoked_at = coalesce(revoked_at, now()),
      metadata = metadata || $2::jsonb
    WHERE id = $1 AND used_at IS NULL
    RETURNING *`,
    [
      input.id,
      JSON.stringify({ revokedBy: input.revokedBy, revokedByEmail: input.revokedByEmail })
    ]
  );
  return result.rows[0] ? rowToTeacherInvite(result.rows[0]) : null;
}

export async function markTeacherInviteUsedPostgres(input: {
  id: string;
  usedBy: string;
  usedByEmail: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<TeacherInviteRow>(
    client,
    `UPDATE teacher_invites
    SET status = 'used',
      used_at = coalesce(used_at, now()),
      used_by = $2,
      metadata = metadata || $3::jsonb
    WHERE id = $1
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING *`,
    [
      input.id,
      input.usedBy,
      JSON.stringify({ usedByEmail: input.usedByEmail })
    ]
  );
  return result.rows[0] ? rowToTeacherInvite(result.rows[0]) : null;
}

function rowToTeacherInvite(row: TeacherInviteRow): TeacherInviteRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    email: row.email ?? "",
    createdBy: row.created_by ?? "",
    usedBy: row.used_by ?? "",
    status: row.status,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at
  };
}

function timestampFromMetadata(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
