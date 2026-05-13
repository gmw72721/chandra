import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

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

function timestampFromMetadata(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
