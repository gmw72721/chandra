import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import {
  defaultAiTokenLimitSettings,
  normalizeAiRequestLimitSettings,
  normalizeAiTokenLimitSettings,
  type AiRequestLimitSettings,
  type AiTokenLimitSettings
} from "./class-settings.ts";
import { adminDb, assertFirebaseAdminAuthReady } from "./firebase-admin";
import { isPostgresConfigured, shouldFallbackToFirestoreWhenPostgresFails } from "./data/postgres.ts";
import {
  adjustAiUsageReservationPostgres,
  ensureAiUsageAnchorPostgres,
  finalizeAiUsagePostgres,
  getAiUsageAnchorPostgres,
  getAiUsageReservationPostgres,
  getAiUsageAllowancePercentPostgres,
  listAiUsageTokenBucketsPostgres,
  PostgresAiUsageLimitDataError,
  reserveAiUsagePostgres,
  updateAiUsageAnchorPostgres,
  upsertAiUsageAllowancePostgres,
  type AiUsageRequestBucketInput,
  type AiUsageTokenBucketInput
} from "./data/usage.ts";

export const AI_TOKEN_LIMITS = {
  ...defaultAiTokenLimitSettings
} as const;

const nearLimitThresholdPercent = 10;
const estimatedCharactersPerToken = 4;
const openRouterToolSchemaReserveTokens = 600;
const ragModelPassReserveTokens = 1_000;
const pdfPageAssetReserveTokens = 4_000;
const attachmentReserveTokens = 1_500;
const dayBucketDurationMs = 24 * 60 * 60 * 1000;
const weekBucketDurationMs = 7 * dayBucketDurationMs;

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type StudentAiUsageStatus = {
  blocked: boolean;
  dailyLimit?: number;
  dailyUsed?: number;
  nearLimit: boolean;
  resetHint: string;
  dailyResetAt?: string;
  todayPercentRemaining: number;
  weekPercentRemaining: number;
  weeklyResetAt?: string;
  weeklyLimit?: number;
  weeklyUsed?: number;
};

export type AiUsageReservation = {
  estimatedTokens: number;
  id: string;
  requestQuota?: AiRequestQuotaReservation;
  studentStatus: StudentAiUsageStatus | null;
};

type AiRequestQuotaReservation = {
  bucketIds: string[];
  dayBucket: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  modelId: string;
  provider: string;
  role: "student" | "teacher";
};

type TokenBucketScope = "student" | "ip";
type TokenBucketPeriod = "fiveMinute" | "hour" | "day" | "week";

type TokenBucketSpec = {
  bucketKey: string;
  classId?: string;
  id: string;
  limit: number;
  period: TokenBucketPeriod;
  reference: DocumentReference;
  scope: TokenBucketScope;
  scopeHash: string;
};

type RequestQuotaScope = "student" | "teacherPreview" | "class";

type RequestQuotaSpec = {
  classId: string;
  dayBucket: string;
  id: string;
  limit: number;
  modelId: string;
  period: "day" | "week";
  provider: string;
  reference: DocumentReference;
  role: "student" | "teacher";
  scope: RequestQuotaScope;
  scopeHash: string;
  userId: string;
};

type RequestQuotaSnapshot = RequestQuotaSpec & {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  requestCount: number;
};

type TokenBucketSnapshot = TokenBucketSpec & {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;
  reservedTokens: number;
};

type StudentAiUsageAnchor = {
  anchorAt: Date;
  classId: string;
  dayAnchorAt: Date;
  studentId: string;
  weekAnchorAt: Date;
};

export class AiUsageLimitError extends Error {
  status = 429;
  quotaScope?: RequestQuotaScope | TokenBucketScope;
  studentStatus: StudentAiUsageStatus;

  constructor(studentStatus: StudentAiUsageStatus, quotaScope?: RequestQuotaScope | TokenBucketScope) {
    super("AI usage limit reached.");
    this.quotaScope = quotaScope;
    this.studentStatus = studentStatus;
  }
}

export function estimateAiRequestTokens({
  attachmentCount = 0,
  maxTokens,
  messages,
  useClassMaterialsFirst = true
}: {
  attachmentCount?: number;
  maxTokens?: number | null;
  messages: Array<{ content?: unknown }>;
  useClassMaterialsFirst?: boolean;
}) {
  const promptTokens = estimateMessagesTokens(messages);
  const responseReserve = Math.max(1, Number(maxTokens ?? 0));
  const ragReserve = useClassMaterialsFirst ? ragModelPassReserveTokens + pdfPageAssetReserveTokens : 0;
  const attachmentReserve = Math.max(0, attachmentCount) * attachmentReserveTokens;

  return Math.max(
    1,
    promptTokens + openRouterToolSchemaReserveTokens + responseReserve + ragReserve + attachmentReserve
  );
}

export async function reserveAiTokenUsage({
  classId,
  estimatedInputTokens,
  estimatedOutputTokens,
  estimatedTokens,
  ipAddress,
  modelId,
  provider = "langgraph",
  requestLimits,
  role = "student",
  studentId,
  userId,
  tokenLimits
}: {
  classId: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedTokens: number;
  ipAddress: string;
  modelId?: string;
  provider?: string;
  requestLimits?: Partial<AiRequestLimitSettings> | null;
  role?: "student" | "teacher";
  studentId?: string;
  userId?: string;
  tokenLimits?: Partial<AiTokenLimitSettings> | null;
}): Promise<AiUsageReservation> {
  assertFirebaseAdminAuthReady();

  const now = new Date();
  const reservationId = randomUUID();
  const quotaUserId = (userId || studentId || "").trim();
  const cleanEstimate = Math.max(1, Math.ceil(estimatedTokens));
  const cleanEstimatedInputTokens = Math.max(0, Math.ceil(estimatedInputTokens ?? cleanEstimate));
  const cleanEstimatedOutputTokens = Math.max(0, Math.ceil(estimatedOutputTokens ?? 0));
  const usageAnchor = role === "student" && quotaUserId
    ? await ensureStudentAiUsageAnchor({ classId, now, studentId: quotaUserId })
    : null;
  const usageWindows = usageAnchor ? aiUsageWindows(now, usageAnchor) : null;
  const limits = await tokenLimitsWithActiveAllowance({
    classId,
    dayBucket: usageWindows?.day.bucketKey,
    now,
    studentId: quotaUserId,
    tokenLimits
  });
  const specs = role === "student" && quotaUserId
    ? tokenBucketSpecs({ anchor: usageAnchor, classId, ipAddress, now, studentId: quotaUserId, tokenLimits: limits })
    : [];
  const requestQuotaSpecs = requestQuotaBucketSpecs({
    classId,
    modelId: modelId ?? "",
    now,
    provider,
    requestLimits: normalizeAiRequestLimitSettings(requestLimits),
    role,
    usageWindows,
    userId: quotaUserId
  });
  const reservationReference = adminDb!.collection("aiUsageReservations").doc(reservationId);
  const usageEventReference = adminDb!.collection("aiUsageEvents").doc(reservationId);

  if (isPostgresConfigured()) {
    try {
      const { tokenBuckets: buckets } = await reserveAiUsagePostgres({
        classId,
        estimatedInputTokens: cleanEstimatedInputTokens,
        estimatedOutputTokens: cleanEstimatedOutputTokens,
        estimatedTotalTokens: cleanEstimate,
        modelId: modelId ?? "",
        provider,
        requestBuckets: requestQuotaSpecs.map(requestQuotaSpecToPostgres),
        reservationId,
        role,
        studentId: role === "student" ? quotaUserId : undefined,
        tokenBuckets: specs.map(tokenBucketSpecToPostgres),
        userId: quotaUserId
      });

      return {
        estimatedTokens: cleanEstimate,
        id: reservationId,
        requestQuota: {
          bucketIds: requestQuotaSpecs.map((spec) => spec.id),
          dayBucket: dayBucketKey(now),
          estimatedInputTokens: cleanEstimatedInputTokens,
          estimatedOutputTokens: cleanEstimatedOutputTokens,
          estimatedTotalTokens: cleanEstimate,
          modelId: modelId ?? "",
          provider,
          role
        },
        studentStatus: buckets.length ? studentStatusFromBuckets(buckets) : null
      };
    } catch (caughtError) {
      if (caughtError instanceof PostgresAiUsageLimitDataError) {
        const fallbackBuckets = await listAiUsageTokenBucketsPostgres(specs.map(tokenBucketSpecToPostgres)).catch(() => []);
        throw new AiUsageLimitError(
          fallbackBuckets.length ? blockedRealUsageStatus(fallbackBuckets) : blockedUsageStatus(),
          caughtError.quotaScope
        );
      }

      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage reservation Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  return adminDb!.runTransaction(async (transaction) => {
    const [buckets, requestQuotaBuckets] = await Promise.all([
      readTokenBuckets(transaction, specs),
      readRequestQuotaBuckets(transaction, requestQuotaSpecs)
    ]);
    const blockedQuota = blockedRequestQuotaBucket(requestQuotaBuckets);

    if (blockedQuota) {
      throw new AiUsageLimitError(blockedRealUsageStatus(buckets), blockedQuota.scope);
    }

    const blockedStatus = blockedStudentStatusAfterReservation(buckets, cleanEstimate);

    if (blockedStatus) {
      throw new AiUsageLimitError(blockedStatus, "student");
    }

    for (const bucket of requestQuotaBuckets) {
      transaction.set(
        bucket.reference,
        compactFirestoreData({
          bucketKey: bucket.dayBucket,
          classId,
          createdAt: FieldValue.serverTimestamp(),
          dayBucket: bucket.dayBucket,
          estimatedInputTokens: FieldValue.increment(cleanEstimatedInputTokens),
          estimatedOutputTokens: FieldValue.increment(cleanEstimatedOutputTokens),
          estimatedTotalTokens: FieldValue.increment(cleanEstimate),
          limitRequests: bucket.limit,
          modelId: bucket.modelId,
          period: bucket.period,
          provider: bucket.provider,
          requestCount: FieldValue.increment(1),
          role: bucket.role,
          scope: bucket.scope,
          scopeHash: bucket.scopeHash,
          updatedAt: FieldValue.serverTimestamp(),
          userId: bucket.scope === "class" ? undefined : bucket.userId
        }),
        { merge: true }
      );
    }

    for (const bucket of buckets) {
      transaction.set(
        bucket.reference,
        compactFirestoreData({
          actualInputTokens: bucket.actualInputTokens,
          actualOutputTokens: bucket.actualOutputTokens,
          actualTotalTokens: bucket.actualTotalTokens,
          bucketKey: bucket.bucketKey,
          classId: bucket.scope === "student" ? classId : undefined,
          createdAt: FieldValue.serverTimestamp(),
          limitTokens: bucket.limit,
          period: bucket.period,
          reservedTokens: FieldValue.increment(cleanEstimate),
          scope: bucket.scope,
          scopeHash: bucket.scopeHash,
          updatedAt: FieldValue.serverTimestamp()
        }),
        { merge: true }
      );
    }

    transaction.set(reservationReference, compactFirestoreData({
      bucketIds: specs.map((spec) => spec.reference.id),
      classId,
      createdAt: FieldValue.serverTimestamp(),
      dayBucket: dayBucketKey(now),
      estimatedInputTokens: cleanEstimatedInputTokens,
      estimatedOutputTokens: cleanEstimatedOutputTokens,
      estimatedTokens: cleanEstimate,
      limitTokens: limits,
      modelId: modelId ?? "",
      provider,
      requestQuotaBucketIds: requestQuotaSpecs.map((spec) => spec.reference.id),
      role,
      status: "pending",
      studentId: role === "student" ? quotaUserId : undefined,
      updatedAt: FieldValue.serverTimestamp()
    }));

    transaction.set(usageEventReference, compactFirestoreData({
      classId,
      createdAt: FieldValue.serverTimestamp(),
      dayBucket: dayBucketKey(now),
      estimatedInputTokens: cleanEstimatedInputTokens,
      estimatedOutputTokens: cleanEstimatedOutputTokens,
      estimatedTotalTokens: cleanEstimate,
      modelId: modelId ?? "",
      provider,
      requestCount: 1,
      reservationId,
      role,
      status: "reserved",
      timestamp: FieldValue.serverTimestamp(),
      userId: quotaUserId
    }));

    return {
      estimatedTokens: cleanEstimate,
      id: reservationId,
      requestQuota: {
        bucketIds: requestQuotaSpecs.map((spec) => spec.reference.id),
        dayBucket: dayBucketKey(now),
        estimatedInputTokens: cleanEstimatedInputTokens,
        estimatedOutputTokens: cleanEstimatedOutputTokens,
        estimatedTotalTokens: cleanEstimate,
        modelId: modelId ?? "",
        provider,
        role
      },
      studentStatus: buckets.length ? studentStatusFromBuckets(buckets) : null
    };
  });
}

export async function finalizeAiTokenUsage({
  actualUsage,
  reservation
}: {
  actualUsage: AiTokenUsage;
  reservation: AiUsageReservation | null;
}): Promise<StudentAiUsageStatus | null> {
  if (!reservation) {
    return null;
  }

  assertFirebaseAdminAuthReady();

  const reservationReference = adminDb!.collection("aiUsageReservations").doc(reservation.id);
  const actual = normalizeAiTokenUsage(actualUsage);

  if (isPostgresConfigured()) {
    try {
      const buckets = await finalizeAiUsagePostgres({
        actualInputTokens: actual.inputTokens,
        actualOutputTokens: actual.outputTokens,
        actualTotalTokens: actual.totalTokens,
        reservationId: reservation.id
      });

      if (buckets) {
        const studentBuckets = buckets.filter((bucket) => bucket.scope === "student");
        return studentBuckets.length ? studentStatusFromBuckets(studentBuckets) : null;
      }
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage finalization Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  return adminDb!.runTransaction(async (transaction) => {
    const reservationSnapshot = await transaction.get(reservationReference);

    if (!reservationSnapshot.exists || reservationSnapshot.data()?.status !== "pending") {
      return null;
    }

    const rawBucketIds = reservationSnapshot.data()?.bucketIds;
    const bucketIds = Array.isArray(rawBucketIds)
      ? rawBucketIds.map((bucketId: unknown) => String(bucketId))
      : [];
    const bucketReferences = bucketIds.map((bucketId) => adminDb!.collection("aiUsageBuckets").doc(bucketId));
    const bucketSnapshots = await Promise.all(
      bucketReferences.map((reference: DocumentReference) => transaction.get(reference))
    );
    const buckets = bucketSnapshots.map((snapshot, index) => tokenBucketFromSnapshot(bucketReferences[index]!, snapshot.data() ?? {}));
    const updatedStudentBuckets: TokenBucketSnapshot[] = [];

    for (const bucket of buckets) {
      const nextReservedTokens = Math.max(0, bucket.reservedTokens - reservation.estimatedTokens);
      const nextActualInputTokens = bucket.actualInputTokens + actual.inputTokens;
      const nextActualOutputTokens = bucket.actualOutputTokens + actual.outputTokens;
      const nextActualTotalTokens = bucket.actualTotalTokens + actual.totalTokens;

      transaction.set(
        bucket.reference,
        {
          actualInputTokens: nextActualInputTokens,
          actualOutputTokens: nextActualOutputTokens,
          actualTotalTokens: nextActualTotalTokens,
          reservedTokens: nextReservedTokens,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      if (bucket.scope === "student") {
        updatedStudentBuckets.push({
          ...bucket,
          actualInputTokens: nextActualInputTokens,
          actualOutputTokens: nextActualOutputTokens,
          actualTotalTokens: nextActualTotalTokens,
          reservedTokens: nextReservedTokens
        });
      }
    }

    const nextStudentStatus = updatedStudentBuckets.length
      ? studentStatusFromBuckets(updatedStudentBuckets)
      : null;

    transaction.update(reservationReference, {
      actualInputTokens: actual.inputTokens,
      actualOutputTokens: actual.outputTokens,
      actualTotalTokens: actual.totalTokens,
      status: "finalized",
      updatedAt: FieldValue.serverTimestamp()
    });

    transaction.set(
      adminDb!.collection("aiUsageEvents").doc(reservation.id),
      {
        actualInputTokens: actual.inputTokens,
        actualOutputTokens: actual.outputTokens,
        actualTotalTokens: actual.totalTokens,
        status: "finalized",
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return nextStudentStatus;
  });
}

export async function adjustAiTokenReservation({
  estimatedTokens,
  reservationId,
  studentId
}: {
  estimatedTokens: number;
  reservationId: string;
  studentId?: string;
}): Promise<StudentAiUsageStatus | null> {
  assertFirebaseAdminAuthReady();

  const reservationReference = adminDb!.collection("aiUsageReservations").doc(reservationId);
  const nextEstimate = Math.max(1, Math.ceil(estimatedTokens));

  if (isPostgresConfigured()) {
    try {
      const postgresReservation = await getAiUsageReservationPostgres(reservationId);

      if (!postgresReservation || postgresReservation.status !== "reserved") {
        return null;
      }

      if (studentId && postgresReservation.studentId !== studentId) {
        throw new AiUsageLimitError(blockedUsageStatus());
      }

      const currentEstimate = nonnegativeInteger(postgresReservation.estimatedTotalTokens);

      if (nextEstimate <= currentEstimate) {
        return null;
      }

      const deltaTokens = nextEstimate - currentEstimate;
      const buckets = await adjustAiUsageReservationPostgres({
        deltaTokens,
        nextEstimatedTokens: nextEstimate,
        reservationId
      });

      return buckets?.length ? studentStatusFromBuckets(buckets) : null;
    } catch (caughtError) {
      if (caughtError instanceof AiUsageLimitError) {
        throw caughtError;
      }

      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage reservation adjustment Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  return adminDb!.runTransaction(async (transaction) => {
    const reservationSnapshot = await transaction.get(reservationReference);

    if (!reservationSnapshot.exists || reservationSnapshot.data()?.status !== "pending") {
      return null;
    }

    const reservationData = reservationSnapshot.data() ?? {};

    if (studentId && String(reservationData.studentId ?? "") !== studentId) {
      throw new AiUsageLimitError(blockedUsageStatus());
    }

    const currentEstimate = nonnegativeInteger(reservationData.estimatedTokens);

    if (nextEstimate <= currentEstimate) {
      return null;
    }

    const deltaTokens = nextEstimate - currentEstimate;
    const rawBucketIds = reservationData.bucketIds;
    const bucketIds = Array.isArray(rawBucketIds)
      ? rawBucketIds.map((bucketId: unknown) => String(bucketId))
      : [];
    const bucketReferences = bucketIds.map((bucketId) => adminDb!.collection("aiUsageBuckets").doc(bucketId));
    const bucketSnapshots = await Promise.all(
      bucketReferences.map((reference: DocumentReference) => transaction.get(reference))
    );
    const buckets = bucketSnapshots.map((snapshot, index) => tokenBucketFromSnapshot(bucketReferences[index]!, snapshot.data() ?? {}));
    const blockedStatus = blockedStudentStatusAfterReservation(buckets, deltaTokens);

    if (blockedStatus) {
      throw new AiUsageLimitError(blockedStatus);
    }

    for (const bucket of buckets) {
      transaction.set(
        bucket.reference,
        {
          reservedTokens: FieldValue.increment(deltaTokens),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    transaction.update(reservationReference, {
      estimatedTokens: nextEstimate,
      updatedAt: FieldValue.serverTimestamp()
    });

    return studentStatusFromBuckets(buckets);
  });
}

export async function releaseAiTokenReservation(reservation: AiUsageReservation | null) {
  return finalizeAiTokenUsage({
    actualUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reservation
  });
}

function blockedUsageStatus(): StudentAiUsageStatus {
  return {
    blocked: true,
    dailyLimit: 100,
    dailyUsed: 100,
    nearLimit: false,
    resetHint: "today",
    todayPercentRemaining: 0,
    weekPercentRemaining: 0,
    weeklyLimit: 400,
    weeklyUsed: 400
  };
}

function blockedRealUsageStatus(
  buckets: Pick<TokenBucketSnapshot, "actualTotalTokens" | "bucketKey" | "limit" | "period" | "reservedTokens" | "scope">[]
): StudentAiUsageStatus {
  return buckets.length ? studentStatusFromBuckets(buckets, true) : blockedUsageStatus();
}

export async function getStudentAiUsageStatus(
  studentId: string,
  classId?: string,
  tokenLimits?: Partial<AiTokenLimitSettings> | null
): Promise<StudentAiUsageStatus> {
  assertFirebaseAdminAuthReady();

  const now = new Date();
  const usageAnchor = await getStudentAiUsageAnchor({ classId, studentId });

  if (!usageAnchor) {
    return studentStatusFromBuckets([]);
  }

  const usageWindows = aiUsageWindows(now, usageAnchor);
  const limits = await tokenLimitsWithActiveAllowance({
    classId,
    dayBucket: usageWindows.day.bucketKey,
    now,
    studentId,
    tokenLimits
  });
  const specs = tokenBucketSpecs({
    anchor: usageAnchor,
    classId,
    ipAddress: "",
    now,
    studentId,
    tokenLimits: limits
  }).filter(
    (spec) => spec.scope === "student" && (spec.period === "day" || spec.period === "week")
  );

  if (isPostgresConfigured()) {
    try {
      const postgresBuckets = await listAiUsageTokenBucketsPostgres(specs.map(tokenBucketSpecToPostgres));
      return studentStatusFromBuckets(postgresBuckets);
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage status Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  const snapshots = await Promise.all(specs.map((spec) => spec.reference.get()));
  const buckets = snapshots.map((snapshot, index) => ({
    ...specs[index]!,
    ...tokenBucketValues(snapshot.data() ?? {})
  }));

  return studentStatusFromBuckets(buckets);
}

export async function grantStudentAiUsageAllowance({
  classId,
  feedbackId,
  percent,
  studentId,
  teacherId
}: {
  classId: string;
  feedbackId?: string;
  percent: number;
  studentId: string;
  teacherId: string;
}) {
  assertFirebaseAdminAuthReady();

  const now = new Date();
  const cleanPercent = normalizeAllowancePercent(percent);
  const usageAnchor = await getStudentAiUsageAnchor({ classId, studentId });
  const dayBucket = usageAnchor ? aiUsageWindows(now, usageAnchor).day.bucketKey : dayBucketKey(now);
  const allowanceReference = aiUsageAllowanceReference(classId, studentId, dayBucket);

  if (isPostgresConfigured()) {
    try {
      await upsertAiUsageAllowancePostgres({
        classId,
        dayBucket,
        feedbackId,
        percent: cleanPercent,
        studentId,
        teacherId
      });

      return {
        dayBucket,
        percent: cleanPercent
      };
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage allowance Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  await allowanceReference.set(
    compactFirestoreData({
      classId,
      createdAt: FieldValue.serverTimestamp(),
      dayBucket,
      feedbackId: feedbackId || undefined,
      percent: cleanPercent,
      studentId,
      teacherId,
      updatedAt: FieldValue.serverTimestamp()
    }),
    { merge: true }
  );

  return {
    dayBucket,
    percent: cleanPercent
  };
}

export function normalizeAiTokenUsage(value: unknown): AiTokenUsage {
  if (!value || typeof value !== "object") {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  }

  const record = value as Record<string, unknown>;
  const inputTokens = nonnegativeInteger(record.inputTokens ?? record.input_tokens ?? record.prompt_tokens);
  const outputTokens = nonnegativeInteger(record.outputTokens ?? record.output_tokens ?? record.completion_tokens);
  const reasoningTokens = nonnegativeInteger(record.reasoningTokens ?? record.reasoning_tokens);
  const explicitTotal = nonnegativeInteger(record.totalTokens ?? record.total_tokens);
  const totalTokens = explicitTotal || inputTokens + outputTokens + reasoningTokens;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens
  };
}

export function getClientIpAddress(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || "";
}

function estimateMessagesTokens(messages: Array<{ content?: unknown }>) {
  const totalCharacters = messages.reduce((total, message) => total + estimateContentCharacters(message.content), 0);
  return Math.ceil(totalCharacters / estimatedCharactersPerToken);
}

function estimateContentCharacters(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + estimateContentCharacters(part), 0);
  }

  if (content && typeof content === "object") {
    return Object.values(content).reduce((total, value) => total + estimateContentCharacters(value), 0);
  }

  return 0;
}

async function readTokenBuckets(transaction: Transaction, specs: TokenBucketSpec[]) {
  const snapshots = await Promise.all(specs.map((spec) => transaction.get(spec.reference)));
  return snapshots.map((snapshot, index) => ({
    ...specs[index]!,
    ...tokenBucketValues(snapshot.data() ?? {})
  }));
}

async function readRequestQuotaBuckets(transaction: Transaction, specs: RequestQuotaSpec[]) {
  const snapshots = await Promise.all(specs.map((spec) => transaction.get(spec.reference)));
  return snapshots.map((snapshot, index) => requestQuotaBucketFromSnapshot(specs[index]!, snapshot.data() ?? {}));
}

function blockedRequestQuotaBucket(buckets: RequestQuotaSnapshot[]) {
  return buckets.find((bucket) => bucket.requestCount + 1 > bucket.limit) ?? null;
}

function blockedStudentStatusAfterReservation(buckets: TokenBucketSnapshot[], estimatedTokens: number) {
  const blocked = buckets.some((bucket) => bucket.actualTotalTokens + estimatedTokens > bucket.limit);

  return blocked ? blockedRealUsageStatus(buckets) : null;
}

function studentStatusFromBuckets(
  buckets: Pick<TokenBucketSnapshot, "actualTotalTokens" | "bucketKey" | "limit" | "period" | "reservedTokens" | "scope">[],
  forceBlocked = false
): StudentAiUsageStatus {
  let dayRemaining = 100;
  let dailyLimit = 100;
  let dailyUsed = 0;
  let dailyResetAt: string | undefined;
  let weekRemaining = 100;
  let weeklyLimit = 400;
  let weeklyUsed = 0;
  let weeklyResetAt: string | undefined;

  for (const bucket of buckets) {
    if (bucket.scope !== "student" || (bucket.period !== "day" && bucket.period !== "week")) {
      continue;
    }

    const usedTokens = bucket.actualTotalTokens;
    const remainingPercent = percentRemaining(bucket.limit, usedTokens);

    if (bucket.period === "day") {
      dayRemaining = remainingPercent;
      dailyLimit = bucket.limit;
      dailyUsed = usedTokens;
      dailyResetAt = anchoredBucketResetAt(bucket.bucketKey, "day");
    }

    if (bucket.period === "week") {
      weekRemaining = remainingPercent;
      weeklyLimit = bucket.limit;
      weeklyUsed = usedTokens;
      weeklyResetAt = anchoredBucketResetAt(bucket.bucketKey, "week");
    }
  }

  const lowestRemaining = Math.min(dayRemaining, weekRemaining);

  return {
    blocked: forceBlocked || lowestRemaining <= 0,
    dailyLimit,
    dailyUsed,
    nearLimit: lowestRemaining > 0 && lowestRemaining <= nearLimitThresholdPercent,
    resetHint: dayRemaining <= weekRemaining ? "today" : "this week",
    dailyResetAt,
    todayPercentRemaining: dayRemaining,
    weekPercentRemaining: weekRemaining,
    weeklyResetAt,
    weeklyLimit,
    weeklyUsed
  };
}

function percentRemaining(limit: number, usedTokens: number) {
  if (limit <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((limit - usedTokens) / limit) * 100)));
}

async function tokenLimitsWithActiveAllowance({
  classId,
  dayBucket,
  now,
  studentId,
  tokenLimits
}: {
  classId?: string;
  dayBucket?: string;
  now: Date;
  studentId: string;
  tokenLimits?: Partial<AiTokenLimitSettings> | null;
}): Promise<AiTokenLimitSettings> {
  const limits = normalizeAiTokenLimitSettings(tokenLimits);

  if (!classId || !studentId) {
    return limits;
  }

  const allowancePercent = await activeAiUsageAllowancePercent(classId, studentId, dayBucket ?? dayBucketKey(now));

  if (allowancePercent <= 0) {
    return limits;
  }

  return {
    perHour: applyAllowancePercent(limits.perHour, allowancePercent),
    perDay: applyAllowancePercent(limits.perDay, allowancePercent),
    perWeek: applyAllowancePercent(limits.perWeek, allowancePercent)
  };
}

async function activeAiUsageAllowancePercent(classId: string, studentId: string, dayBucket: string) {
  if (isPostgresConfigured()) {
    try {
      return await getAiUsageAllowancePercentPostgres({
        classId,
        dayBucket,
        studentId
      });
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage allowance Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  const snapshot = await aiUsageAllowanceReference(classId, studentId, dayBucket).get();

  return normalizeAllowancePercent(snapshot.data()?.percent ?? 0);
}

function applyAllowancePercent(limit: number, percent: number) {
  return Math.max(1, Math.floor(limit * (1 + percent / 100)));
}

function tokenBucketSpecs({
  anchor,
  classId,
  ipAddress,
  now,
  studentId,
  tokenLimits
}: {
  anchor?: StudentAiUsageAnchor | null;
  classId?: string;
  ipAddress: string;
  now: Date;
  studentId: string;
  tokenLimits?: AiTokenLimitSettings;
}): TokenBucketSpec[] {
  const limits = normalizeAiTokenLimitSettings(tokenLimits);
  const studentHash = stableHash(classId ? `${classId}:${studentId}` : studentId);
  const usageWindows = anchor ? aiUsageWindows(now, anchor) : null;
  return [
    bucketSpec({ bucketKey: usageWindows?.day.bucketKey ?? dayBucketKey(now), classId, limit: limits.perDay, period: "day", scope: "student", scopeHash: studentHash }),
    bucketSpec({ bucketKey: usageWindows?.week.bucketKey ?? weekBucketKey(now), classId, limit: limits.perWeek, period: "week", scope: "student", scopeHash: studentHash })
  ];
}

function requestQuotaBucketSpecs({
  classId,
  modelId,
  now,
  provider,
  requestLimits,
  role,
  usageWindows,
  userId
}: {
  classId: string;
  modelId: string;
  now: Date;
  provider: string;
  requestLimits: AiRequestLimitSettings;
  role: "student" | "teacher";
  usageWindows?: ReturnType<typeof aiUsageWindows> | null;
  userId: string;
}): RequestQuotaSpec[] {
  const dayBucket = dayBucketKey(now);
  const weekBucket = weekBucketKey(now);
  const studentDayBucket = usageWindows?.day.bucketKey ?? dayBucket;
  const studentWeekBucket = usageWindows?.week.bucketKey ?? weekBucket;
  const classHash = stableHash(classId);
  const specs: RequestQuotaSpec[] = [
    requestQuotaBucketSpec({
      classId,
      dayBucket,
      limit: requestLimits.perClassDaily,
      modelId,
      period: "day",
      provider,
      role,
      scope: "class",
      scopeHash: classHash,
      userId
    })
  ];

  if (role === "student") {
    specs.push(
      requestQuotaBucketSpec({
        classId,
        dayBucket: studentDayBucket,
        limit: requestLimits.perStudentDaily,
        modelId,
        period: "day",
        provider,
        role,
        scope: "student",
        scopeHash: stableHash(`${classId}:${userId}`),
        userId
      }),
      requestQuotaBucketSpec({
        classId,
        dayBucket: studentWeekBucket,
        limit: requestLimits.perStudentWeekly,
        modelId,
        period: "week",
        provider,
        role,
        scope: "student",
        scopeHash: stableHash(`${classId}:${userId}`),
        userId
      })
    );
  } else if (requestLimits.teacherPreviewDaily !== null) {
    specs.push(
      requestQuotaBucketSpec({
        classId,
        dayBucket,
        limit: requestLimits.teacherPreviewDaily,
        modelId,
        period: "day",
        provider,
        role,
        scope: "teacherPreview",
        scopeHash: stableHash(`${classId}:${userId}`),
        userId
      })
    );
  }

  return specs;
}

function requestQuotaBucketSpec({
  classId,
  dayBucket,
  limit,
  modelId,
  period,
  provider,
  role,
  scope,
  scopeHash,
  userId
}: Omit<RequestQuotaSpec, "id" | "reference">): RequestQuotaSpec {
  const documentId = `${scope}_${scopeHash}_${period}_${dayBucket}`;

  return {
    classId,
    dayBucket,
    id: documentId,
    limit,
    modelId,
    period,
    provider,
    reference: adminDb!.collection("aiUsageRequestBuckets").doc(documentId),
    role,
    scope,
    scopeHash,
    userId
  };
}

function bucketSpec({
  bucketKey,
  classId,
  limit,
  period,
  scope,
  scopeHash
}: Omit<TokenBucketSpec, "id" | "reference">): TokenBucketSpec {
  const documentId = `${scope}_${scopeHash}_${period}_${bucketKey}`;

  return {
    bucketKey,
    classId,
    id: documentId,
    limit,
    period,
    reference: adminDb!.collection("aiUsageBuckets").doc(documentId),
    scope,
    scopeHash
  };
}

function aiUsageAllowanceReference(classId: string, studentId: string, dayBucket: string) {
  return adminDb!.collection("aiUsageAllowances").doc(stableHash(`${classId}:${studentId}:${dayBucket}`));
}

function requestQuotaBucketFromSnapshot(spec: RequestQuotaSpec, data: Record<string, unknown>): RequestQuotaSnapshot {
  return {
    ...spec,
    estimatedInputTokens: nonnegativeInteger(data.estimatedInputTokens),
    estimatedOutputTokens: nonnegativeInteger(data.estimatedOutputTokens),
    estimatedTotalTokens: nonnegativeInteger(data.estimatedTotalTokens),
    requestCount: nonnegativeInteger(data.requestCount)
  };
}

function tokenBucketFromSnapshot(reference: DocumentReference, data: Record<string, unknown>): TokenBucketSnapshot {
  return {
    actualInputTokens: nonnegativeInteger(data.actualInputTokens),
    actualOutputTokens: nonnegativeInteger(data.actualOutputTokens),
    actualTotalTokens: nonnegativeInteger(data.actualTotalTokens),
    bucketKey: String(data.bucketKey ?? ""),
    limit: nonnegativeInteger(data.limitTokens),
    period: String(data.period ?? "day") as TokenBucketPeriod,
    id: reference.id,
    reference,
    reservedTokens: nonnegativeInteger(data.reservedTokens),
    scope: String(data.scope ?? "student") as TokenBucketScope,
    scopeHash: String(data.scopeHash ?? "")
  };
}

function tokenBucketSpecToPostgres(spec: TokenBucketSpec): AiUsageTokenBucketInput {
  return {
    bucketKey: spec.bucketKey,
    classId: spec.classId,
    id: spec.id,
    limit: spec.limit,
    period: spec.period,
    scope: spec.scope,
    scopeHash: spec.scopeHash
  };
}

function requestQuotaSpecToPostgres(spec: RequestQuotaSpec): AiUsageRequestBucketInput {
  return {
    classId: spec.classId,
    dayBucket: spec.dayBucket,
    id: spec.id,
    limit: spec.limit,
    modelId: spec.modelId,
    period: spec.period,
    provider: spec.provider,
    role: spec.role,
    scope: spec.scope,
    scopeHash: spec.scopeHash,
    userId: spec.userId
  };
}

function tokenBucketValues(data: Record<string, unknown>) {
  return {
    actualInputTokens: nonnegativeInteger(data.actualInputTokens),
    actualOutputTokens: nonnegativeInteger(data.actualOutputTokens),
    actualTotalTokens: nonnegativeInteger(data.actualTotalTokens),
    reservedTokens: nonnegativeInteger(data.reservedTokens)
  };
}

async function ensureStudentAiUsageAnchor({
  classId,
  now,
  studentId
}: {
  classId: string;
  now: Date;
  studentId: string;
}): Promise<StudentAiUsageAnchor> {
  if (isPostgresConfigured()) {
    try {
      const existingAnchor = normalizeStudentAiUsageAnchor(await ensureAiUsageAnchorPostgres({
        anchorAt: now.toISOString(),
        classId,
        dayAnchorAt: now.toISOString(),
        studentId
      }));
      const activeAnchor = activeStudentAiUsageAnchor(existingAnchor, now);

      if (
        activeAnchor.dayAnchorAt.getTime() !== existingAnchor.dayAnchorAt.getTime() ||
        activeAnchor.weekAnchorAt.getTime() !== existingAnchor.weekAnchorAt.getTime()
      ) {
        return normalizeStudentAiUsageAnchor(await updateAiUsageAnchorPostgres({
          classId,
          dayAnchorAt: activeAnchor.dayAnchorAt.toISOString(),
          studentId,
          weekAnchorAt: activeAnchor.weekAnchorAt.toISOString()
        }));
      }

      return existingAnchor;
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage anchor Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  return ensureStudentAiUsageAnchorFirestore({ classId, now, studentId });
}

async function getStudentAiUsageAnchor({
  classId,
  studentId
}: {
  classId?: string;
  studentId: string;
}): Promise<StudentAiUsageAnchor | null> {
  if (!classId || !studentId) {
    return null;
  }

  if (isPostgresConfigured()) {
    try {
      const anchor = await getAiUsageAnchorPostgres({ classId, studentId });
      return anchor ? normalizeStudentAiUsageAnchor(anchor) : null;
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("AI usage anchor Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  const snapshot = await aiUsageAnchorReference(classId, studentId).get();
  return snapshot.exists ? anchorFromFirestoreData(classId, studentId, snapshot.data() ?? {}) : null;
}

function ensureStudentAiUsageAnchorFirestore({
  classId,
  now,
  studentId
}: {
  classId: string;
  now: Date;
  studentId: string;
}) {
  const reference = aiUsageAnchorReference(classId, studentId);
  const anchorAt = now.toISOString();

  return adminDb!.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);

    if (snapshot.exists) {
      const existingAnchor = anchorFromFirestoreData(classId, studentId, snapshot.data() ?? {});
      const activeAnchor = activeStudentAiUsageAnchor(existingAnchor, now);

      if (
        activeAnchor.dayAnchorAt.getTime() !== existingAnchor.dayAnchorAt.getTime() ||
        activeAnchor.weekAnchorAt.getTime() !== existingAnchor.weekAnchorAt.getTime()
      ) {
        transaction.set(reference, {
          dayAnchorAt: activeAnchor.dayAnchorAt.toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
          weekAnchorAt: activeAnchor.weekAnchorAt.toISOString()
        }, { merge: true });
      }

      return activeAnchor;
    }

    transaction.set(reference, {
      anchorAt,
      classId,
      createdAt: FieldValue.serverTimestamp(),
      dayAnchorAt: anchorAt,
      studentId,
      updatedAt: FieldValue.serverTimestamp(),
      weekAnchorAt: anchorAt
    });

    return {
      anchorAt: now,
      classId,
      dayAnchorAt: now,
      studentId,
      weekAnchorAt: now
    };
  });
}

function aiUsageAnchorReference(classId: string, studentId: string) {
  return adminDb!.collection("aiUsageAnchors").doc(stableHash(`${classId}:${studentId}`));
}

function normalizeStudentAiUsageAnchor(anchor: {
  anchorAt: Date | string;
  classId: string;
  dayAnchorAt?: Date | string;
  studentId: string;
  weekAnchorAt?: Date | string;
}): StudentAiUsageAnchor {
  const anchorAt = dateFromUnknown(anchor.anchorAt);

  return {
    anchorAt,
    classId: anchor.classId,
    dayAnchorAt: dateFromUnknown(anchor.dayAnchorAt ?? anchorAt),
    studentId: anchor.studentId,
    weekAnchorAt: dateFromUnknown(anchor.weekAnchorAt ?? anchorAt)
  };
}

function anchorFromFirestoreData(classId: string, studentId: string, data: Record<string, unknown>): StudentAiUsageAnchor {
  const anchorAt = dateFromUnknown(data.anchorAt);

  return {
    anchorAt,
    classId,
    dayAnchorAt: dateFromUnknown(data.dayAnchorAt ?? anchorAt),
    studentId,
    weekAnchorAt: dateFromUnknown(data.weekAnchorAt ?? anchorAt)
  };
}

function dateFromUnknown(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (typeof value === "object" && value && "toDate" in value) {
    const maybeTimestamp = value as { toDate?: () => unknown };
    const firestoreDate = typeof maybeTimestamp.toDate === "function" ? maybeTimestamp.toDate() : null;

    if (firestoreDate instanceof Date && Number.isFinite(firestoreDate.getTime())) {
      return firestoreDate;
    }
  }

  const parsedDate = new Date(String(value ?? ""));
  return Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date(0);
}

export function buildAnchoredAiUsageBucketKey(now: Date, anchorAt: Date, period: "day" | "week") {
  return anchoredBucketWindow(now, anchorAt, period).bucketKey;
}

export function buildAnchoredAiUsageResetAt(now: Date, anchorAt: Date, period: "day" | "week") {
  return anchoredBucketWindow(now, anchorAt, period).resetAt;
}

function aiUsageWindows(now: Date, anchor: StudentAiUsageAnchor) {
  return {
    day: anchoredBucketWindow(now, anchor.dayAnchorAt, "day"),
    week: anchoredBucketWindow(now, anchor.weekAnchorAt, "week")
  };
}

function activeStudentAiUsageAnchor(anchor: StudentAiUsageAnchor, now: Date): StudentAiUsageAnchor {
  return {
    ...anchor,
    dayAnchorAt: anchoredBucketWindowExpired(now, anchor.dayAnchorAt, "day") ? now : anchor.dayAnchorAt,
    weekAnchorAt: anchoredBucketWindowExpired(now, anchor.weekAnchorAt, "week") ? now : anchor.weekAnchorAt
  };
}

function anchoredBucketWindowExpired(now: Date, anchorAt: Date, period: "day" | "week") {
  const periodMs = period === "day" ? dayBucketDurationMs : weekBucketDurationMs;
  return now.getTime() >= anchorAt.getTime() + periodMs;
}

function anchoredBucketWindow(now: Date, anchorAt: Date, period: "day" | "week") {
  const periodMs = period === "day" ? dayBucketDurationMs : weekBucketDurationMs;
  const anchorMillis = anchorAt.getTime();
  const elapsedPeriods = Math.max(0, Math.floor((now.getTime() - anchorMillis) / periodMs));
  const resetAt = new Date(anchorMillis + (elapsedPeriods + 1) * periodMs).toISOString();

  return {
    bucketKey: `anchored_${anchorMillis}_${elapsedPeriods}`,
    resetAt
  };
}

function anchoredBucketResetAt(bucketKey: string, period: "day" | "week") {
  const match = /^anchored_(\d+)_(\d+)$/.exec(bucketKey);

  if (!match) {
    return undefined;
  }

  const anchorMillis = Number(match[1]);
  const elapsedPeriods = Number(match[2]);

  if (!Number.isFinite(anchorMillis) || !Number.isFinite(elapsedPeriods)) {
    return undefined;
  }

  const periodMs = period === "day" ? dayBucketDurationMs : weekBucketDurationMs;
  return new Date(anchorMillis + (elapsedPeriods + 1) * periodMs).toISOString();
}

function fiveMinuteBucketKey(date: Date) {
  const millis = date.getTime();
  const bucketStart = Math.floor(millis / (5 * 60 * 1000)) * 5 * 60 * 1000;
  return new Date(bucketStart).toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

function hourBucketKey(date: Date) {
  return date.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function dayBucketKey(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function buildAiUsageDayBucketKey(date: Date) {
  return dayBucketKey(date);
}

function weekBucketKey(date: Date) {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utcDate.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function nonnegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function normalizeAllowancePercent(value: unknown) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(500, Math.round(numeric)));
}

function compactFirestoreData<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
