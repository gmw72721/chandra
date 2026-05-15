import { runPostgresQuery, withPostgresTransaction, type PostgresQueryClient } from "./postgres.ts";

export type AiUsageTokenBucketInput = {
  bucketKey: string;
  classId?: string;
  id: string;
  limit: number;
  period: "fiveMinute" | "hour" | "day" | "week";
  scope: "student" | "ip";
  scopeHash: string;
};

export type AiUsageRequestBucketInput = {
  classId: string;
  dayBucket: string;
  id: string;
  limit: number;
  modelId: string;
  provider: string;
  role: "student" | "teacher";
  scope: "student" | "teacherPreview" | "class";
  scopeHash: string;
  userId: string;
};

export type AiUsageTokenBucketSnapshot = AiUsageTokenBucketInput & {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;
  reservedTokens: number;
};

export type AiUsageRequestBucketSnapshot = AiUsageRequestBucketInput & {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  requestCount: number;
};

export type AiUsageReservationRecord = {
  id: string;
  bucketIds: string[];
  classId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  modelId: string;
  provider: string;
  requestBucketIds: string[];
  role: "student" | "teacher";
  status: string;
  studentId: string;
  userId: string;
};

export type AiUsageAnchorRecord = {
  anchorAt: string;
  classId: string;
  dayAnchorAt: string;
  studentId: string;
  weekAnchorAt: string;
};

type TokenBucketRow = {
  id: string;
  class_id: string | null;
  scope: "student" | "ip";
  scope_hash: string;
  bucket_key: string;
  period: "fiveMinute" | "hour" | "day" | "week";
  limit_tokens: number;
  reserved_tokens: number;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_total_tokens: number;
};

type RequestBucketRow = {
  id: string;
  class_id: string | null;
  user_id: string | null;
  role: "student" | "teacher";
  scope: "student" | "teacherPreview" | "class";
  scope_hash: string;
  provider: string;
  model_id: string;
  day_bucket: string;
  limit_requests: number;
  request_count: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
};

type ReservationRow = {
  id: string;
  class_id: string | null;
  user_id: string | null;
  student_id: string | null;
  role: "student" | "teacher";
  provider: string;
  model_id: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
  bucket_ids: string[];
  request_bucket_ids: string[];
  status: string;
};

type AllowanceRow = {
  extra_tokens: number;
};

type AnchorRow = {
  anchor_at: Date | string;
  class_id: string;
  day_anchor_at: Date | string | null;
  student_id: string;
  week_anchor_at: Date | string | null;
};

export class PostgresAiUsageLimitDataError extends Error {
  constructor(readonly quotaScope: "student" | "teacherPreview" | "class" | "ip") {
    super("AI usage limit reached.");
    this.name = "PostgresAiUsageLimitDataError";
  }
}

export async function reserveAiUsagePostgres(input: {
  classId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  modelId: string;
  provider: string;
  requestBuckets: AiUsageRequestBucketInput[];
  reservationId: string;
  role: "student" | "teacher";
  studentId?: string;
  tokenBuckets: AiUsageTokenBucketInput[];
  userId: string;
}) {
  return withPostgresTransaction(async (client) => {
    await ensureRequestBuckets(client, input.requestBuckets);
    await ensureTokenBuckets(client, input.tokenBuckets);
    const [requestBuckets, tokenBuckets] = await Promise.all([
      readRequestBuckets(client, input.requestBuckets),
      readTokenBuckets(client, input.tokenBuckets)
    ]);
    const blockedRequestBucket = requestBuckets.find((bucket) => bucket.requestCount + 1 > bucket.limit);

    if (blockedRequestBucket) {
      throw new PostgresAiUsageLimitDataError(blockedRequestBucket.scope);
    }

    const blockedTokenBucket = tokenBuckets.find((bucket) => bucket.actualTotalTokens + input.estimatedTotalTokens > bucket.limit);

    if (blockedTokenBucket) {
      throw new PostgresAiUsageLimitDataError(blockedTokenBucket.scope);
    }

    await incrementRequestBuckets(client, input.requestBuckets, {
      estimatedInputTokens: input.estimatedInputTokens,
      estimatedOutputTokens: input.estimatedOutputTokens,
      estimatedTotalTokens: input.estimatedTotalTokens
    });
    await reserveTokenBuckets(client, input.tokenBuckets, input.estimatedTotalTokens);
    await runPostgresQuery(
      client,
      `INSERT INTO ai_usage_reservations (
        id, class_id, user_id, student_id, role, provider, model_id,
        estimated_input_tokens, estimated_output_tokens, estimated_total_tokens,
        bucket_ids, request_bucket_ids, status, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, 'reserved', '{}'::jsonb
      )`,
      [
        input.reservationId,
        input.classId || null,
        input.userId || null,
        input.role === "student" ? input.userId || input.studentId || null : null,
        input.role,
        input.provider,
        input.modelId,
        input.estimatedInputTokens,
        input.estimatedOutputTokens,
        input.estimatedTotalTokens,
        input.tokenBuckets.map((bucket) => bucket.id),
        input.requestBuckets.map((bucket) => bucket.id)
      ]
    );
    await runPostgresQuery(
      client,
      `INSERT INTO ai_usage_events (
        id, reservation_id, class_id, user_id, role, provider, model_id,
        input_tokens, output_tokens, total_tokens, status, metadata
      ) VALUES (
        $1, $1, $2, $3, $4, $5, $6,
        0, 0, 0, 'recorded', $7::jsonb
      )`,
      [
        input.reservationId,
        input.classId || null,
        input.userId || null,
        input.role,
        input.provider,
        input.modelId,
        JSON.stringify({
          estimatedInputTokens: input.estimatedInputTokens,
          estimatedOutputTokens: input.estimatedOutputTokens,
          estimatedTotalTokens: input.estimatedTotalTokens,
          reservationStatus: "reserved"
        })
      ]
    );

    return { requestBuckets, tokenBuckets };
  });
}

export async function ensureAiUsageAnchorPostgres(input: {
  anchorAt: string;
  classId: string;
  dayAnchorAt?: string;
  studentId: string;
  weekAnchorAt?: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `INSERT INTO ai_usage_anchors (
      class_id, student_id, anchor_at, day_anchor_at, week_anchor_at
    ) VALUES (
      $1, $2, $3, $4, $5
    )
    ON CONFLICT (class_id, student_id) DO NOTHING`,
    [
      input.classId,
      input.studentId,
      input.anchorAt,
      input.dayAnchorAt ?? input.anchorAt,
      input.weekAnchorAt ?? input.anchorAt
    ]
  );

  const anchor = await getAiUsageAnchorPostgres({
    classId: input.classId,
    studentId: input.studentId
  }, client);

  if (!anchor) {
    return {
      anchorAt: input.anchorAt,
      classId: input.classId,
      dayAnchorAt: input.dayAnchorAt ?? input.anchorAt,
      studentId: input.studentId,
      weekAnchorAt: input.weekAnchorAt ?? input.anchorAt
    };
  }

  return anchor;
}

export async function updateAiUsageAnchorPostgres(input: {
  classId: string;
  dayAnchorAt: string;
  studentId: string;
  weekAnchorAt: string;
}, client?: PostgresQueryClient) {
  await runPostgresQuery(
    client,
    `UPDATE ai_usage_anchors
    SET day_anchor_at = $3,
      week_anchor_at = $4
    WHERE class_id = $1 AND student_id = $2`,
    [input.classId, input.studentId, input.dayAnchorAt, input.weekAnchorAt]
  );

  const anchor = await getAiUsageAnchorPostgres({
    classId: input.classId,
    studentId: input.studentId
  }, client);

  if (!anchor) {
    return {
      anchorAt: input.dayAnchorAt,
      classId: input.classId,
      dayAnchorAt: input.dayAnchorAt,
      studentId: input.studentId,
      weekAnchorAt: input.weekAnchorAt
    };
  }

  return anchor;
}

export async function getAiUsageAnchorPostgres(input: {
  classId: string;
  studentId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AnchorRow>(
    client,
    `SELECT class_id, student_id, anchor_at, day_anchor_at, week_anchor_at
    FROM ai_usage_anchors
    WHERE class_id = $1 AND student_id = $2`,
    [input.classId, input.studentId]
  );

  return result.rows[0] ? rowToAnchor(result.rows[0]) : null;
}

export async function getAiUsageReservationPostgres(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<ReservationRow>(
    client,
    "SELECT * FROM ai_usage_reservations WHERE id = $1",
    [id]
  );
  return result.rows[0] ? rowToReservation(result.rows[0]) : null;
}

export async function finalizeAiUsagePostgres(input: {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;
  reservationId: string;
}) {
  return withPostgresTransaction(async (client) => {
    const reservationResult = await runPostgresQuery<ReservationRow>(
      client,
      "SELECT * FROM ai_usage_reservations WHERE id = $1 FOR UPDATE",
      [input.reservationId]
    );
    const reservation = reservationResult.rows[0] ? rowToReservation(reservationResult.rows[0]) : null;

    if (!reservation || reservation.status !== "reserved") {
      return null;
    }

    const tokenBuckets = await readTokenBucketsByIds(client, reservation.bucketIds);

    for (const bucket of tokenBuckets) {
      await runPostgresQuery(
        client,
        `UPDATE ai_usage_buckets
        SET reserved_tokens = greatest(0, reserved_tokens - $2),
          actual_input_tokens = actual_input_tokens + $3,
          actual_output_tokens = actual_output_tokens + $4,
          actual_total_tokens = actual_total_tokens + $5
        WHERE id = $1`,
        [
          bucket.id,
          reservation.estimatedTotalTokens,
          input.actualInputTokens,
          input.actualOutputTokens,
          input.actualTotalTokens
        ]
      );
    }

    await runPostgresQuery(
      client,
      `UPDATE ai_usage_reservations
      SET actual_input_tokens = $2,
        actual_output_tokens = $3,
        actual_total_tokens = $4,
        status = 'committed',
        committed_at = now()
      WHERE id = $1`,
      [input.reservationId, input.actualInputTokens, input.actualOutputTokens, input.actualTotalTokens]
    );
    await runPostgresQuery(
      client,
      `UPDATE ai_usage_events
      SET input_tokens = $2,
        output_tokens = $3,
        total_tokens = $4,
        status = 'recorded',
        metadata = metadata || $5::jsonb
      WHERE id = $1`,
      [
        input.reservationId,
        input.actualInputTokens,
        input.actualOutputTokens,
        input.actualTotalTokens,
        JSON.stringify({ reservationStatus: "committed" })
      ]
    );

    return readTokenBucketsByIds(client, reservation.bucketIds);
  });
}

export async function adjustAiUsageReservationPostgres(input: {
  deltaTokens: number;
  reservationId: string;
  nextEstimatedTokens: number;
}) {
  return withPostgresTransaction(async (client) => {
    const reservation = await getAiUsageReservationPostgres(input.reservationId, client);

    if (!reservation || reservation.status !== "reserved") {
      return null;
    }

    await reserveTokenBucketsByIds(client, reservation.bucketIds, input.deltaTokens);
    await runPostgresQuery(
      client,
      "UPDATE ai_usage_reservations SET estimated_total_tokens = $2 WHERE id = $1",
      [input.reservationId, input.nextEstimatedTokens]
    );

    return readTokenBucketsByIds(client, reservation.bucketIds);
  });
}

export async function listAiUsageTokenBucketsPostgres(specs: AiUsageTokenBucketInput[], client?: PostgresQueryClient) {
  await ensureTokenBuckets(client, specs);
  return readTokenBuckets(client, specs);
}

export async function getAiUsageAllowancePercentPostgres(input: {
  classId: string;
  dayBucket: string;
  studentId: string;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AllowanceRow>(
    client,
    `SELECT extra_tokens
    FROM ai_usage_allowances
    WHERE class_id = $1 AND student_id = $2 AND day_bucket = $3
      AND (expires_at IS NULL OR expires_at > now())`,
    [input.classId, input.studentId, input.dayBucket]
  );
  return Math.max(0, Number(result.rows[0]?.extra_tokens ?? 0));
}

export async function upsertAiUsageAllowancePostgres(input: {
  classId: string;
  dayBucket: string;
  feedbackId?: string;
  percent: number;
  studentId: string;
  teacherId: string;
}, client?: PostgresQueryClient) {
  const id = `${input.classId}:${input.studentId}:${input.dayBucket}`;

  await runPostgresQuery(
    client,
    `INSERT INTO ai_usage_allowances (
      id, class_id, student_id, day_bucket, extra_tokens, reason, granted_by, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, 'teacher_feedback', $6, $7::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      extra_tokens = EXCLUDED.extra_tokens,
      reason = EXCLUDED.reason,
      granted_by = EXCLUDED.granted_by,
      metadata = ai_usage_allowances.metadata || EXCLUDED.metadata`,
    [
      id,
      input.classId,
      input.studentId,
      input.dayBucket,
      input.percent,
      input.teacherId,
      JSON.stringify({ feedbackId: input.feedbackId ?? "" })
    ]
  );
}

async function ensureTokenBuckets(client: PostgresQueryClient | undefined, specs: AiUsageTokenBucketInput[]) {
  for (const spec of specs) {
    await runPostgresQuery(
      client,
      `INSERT INTO ai_usage_buckets (
        id, class_id, scope, scope_hash, bucket_key, period, limit_tokens
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7
      )
      ON CONFLICT (id) DO UPDATE SET
        limit_tokens = EXCLUDED.limit_tokens`,
      [spec.id, spec.classId || null, spec.scope, spec.scopeHash, spec.bucketKey, spec.period, spec.limit]
    );
  }
}

async function ensureRequestBuckets(client: PostgresQueryClient | undefined, specs: AiUsageRequestBucketInput[]) {
  for (const spec of specs) {
    await runPostgresQuery(
      client,
      `INSERT INTO ai_usage_request_buckets (
        id, class_id, user_id, role, scope, scope_hash, provider, model_id, day_bucket, limit_requests
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
      ON CONFLICT (id) DO UPDATE SET
        limit_requests = EXCLUDED.limit_requests`,
      [
        spec.id,
        spec.classId || null,
        spec.scope === "class" ? null : spec.userId || null,
        spec.role,
        spec.scope,
        spec.scopeHash,
        spec.provider,
        spec.modelId,
        spec.dayBucket,
        spec.limit
      ]
    );
  }
}

async function readTokenBuckets(client: PostgresQueryClient | undefined, specs: AiUsageTokenBucketInput[]) {
  if (!specs.length) {
    return [];
  }

  const result = await runPostgresQuery<TokenBucketRow>(
    client,
    "SELECT * FROM ai_usage_buckets WHERE id = ANY($1::text[]) FOR UPDATE",
    [specs.map((spec) => spec.id)]
  );
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  return specs.map((spec) => rowToTokenBucket(spec, rowsById.get(spec.id)));
}

async function readTokenBucketsByIds(client: PostgresQueryClient | undefined, bucketIds: string[]) {
  if (!bucketIds.length) {
    return [];
  }

  const result = await runPostgresQuery<TokenBucketRow>(
    client,
    "SELECT * FROM ai_usage_buckets WHERE id = ANY($1::text[]) FOR UPDATE",
    [bucketIds]
  );
  return result.rows.map((row) => rowToTokenBucket({
    bucketKey: row.bucket_key,
    classId: row.class_id ?? undefined,
    id: row.id,
    limit: row.limit_tokens,
    period: row.period,
    scope: row.scope,
    scopeHash: row.scope_hash
  }, row));
}

async function readRequestBuckets(client: PostgresQueryClient | undefined, specs: AiUsageRequestBucketInput[]) {
  if (!specs.length) {
    return [];
  }

  const result = await runPostgresQuery<RequestBucketRow>(
    client,
    "SELECT * FROM ai_usage_request_buckets WHERE id = ANY($1::text[]) FOR UPDATE",
    [specs.map((spec) => spec.id)]
  );
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  return specs.map((spec) => rowToRequestBucket(spec, rowsById.get(spec.id)));
}

async function incrementRequestBuckets(
  client: PostgresQueryClient,
  specs: AiUsageRequestBucketInput[],
  tokens: { estimatedInputTokens: number; estimatedOutputTokens: number; estimatedTotalTokens: number }
) {
  for (const spec of specs) {
    await runPostgresQuery(
      client,
      `UPDATE ai_usage_request_buckets
      SET request_count = request_count + 1,
        estimated_input_tokens = estimated_input_tokens + $2,
        estimated_output_tokens = estimated_output_tokens + $3,
        estimated_total_tokens = estimated_total_tokens + $4
      WHERE id = $1`,
      [spec.id, tokens.estimatedInputTokens, tokens.estimatedOutputTokens, tokens.estimatedTotalTokens]
    );
  }
}

async function reserveTokenBuckets(client: PostgresQueryClient, specs: AiUsageTokenBucketInput[], estimatedTokens: number) {
  for (const spec of specs) {
    await runPostgresQuery(
      client,
      "UPDATE ai_usage_buckets SET reserved_tokens = reserved_tokens + $2 WHERE id = $1",
      [spec.id, estimatedTokens]
    );
  }
}

async function reserveTokenBucketsByIds(client: PostgresQueryClient, bucketIds: string[], deltaTokens: number) {
  for (const bucketId of bucketIds) {
    await runPostgresQuery(
      client,
      "UPDATE ai_usage_buckets SET reserved_tokens = reserved_tokens + $2 WHERE id = $1",
      [bucketId, deltaTokens]
    );
  }
}

function rowToTokenBucket(spec: AiUsageTokenBucketInput, row?: TokenBucketRow): AiUsageTokenBucketSnapshot {
  return {
    ...spec,
    actualInputTokens: Number(row?.actual_input_tokens ?? 0),
    actualOutputTokens: Number(row?.actual_output_tokens ?? 0),
    actualTotalTokens: Number(row?.actual_total_tokens ?? 0),
    reservedTokens: Number(row?.reserved_tokens ?? 0)
  };
}

function rowToRequestBucket(spec: AiUsageRequestBucketInput, row?: RequestBucketRow): AiUsageRequestBucketSnapshot {
  return {
    ...spec,
    estimatedInputTokens: Number(row?.estimated_input_tokens ?? 0),
    estimatedOutputTokens: Number(row?.estimated_output_tokens ?? 0),
    estimatedTotalTokens: Number(row?.estimated_total_tokens ?? 0),
    requestCount: Number(row?.request_count ?? 0)
  };
}

function rowToReservation(row: ReservationRow): AiUsageReservationRecord {
  return {
    id: row.id,
    bucketIds: row.bucket_ids ?? [],
    classId: row.class_id ?? "",
    estimatedInputTokens: row.estimated_input_tokens,
    estimatedOutputTokens: row.estimated_output_tokens,
    estimatedTotalTokens: row.estimated_total_tokens,
    modelId: row.model_id,
    provider: row.provider,
    requestBucketIds: row.request_bucket_ids ?? [],
    role: row.role,
    status: row.status,
    studentId: row.student_id ?? "",
    userId: row.user_id ?? ""
  };
}

function rowToAnchor(row: AnchorRow): AiUsageAnchorRecord {
  const anchorAt = row.anchor_at instanceof Date ? row.anchor_at.toISOString() : String(row.anchor_at);
  const dayAnchorAt = row.day_anchor_at instanceof Date
    ? row.day_anchor_at.toISOString()
    : String(row.day_anchor_at ?? anchorAt);
  const weekAnchorAt = row.week_anchor_at instanceof Date
    ? row.week_anchor_at.toISOString()
    : String(row.week_anchor_at ?? anchorAt);

  return {
    anchorAt,
    classId: row.class_id,
    dayAnchorAt,
    studentId: row.student_id,
    weekAnchorAt
  };
}
