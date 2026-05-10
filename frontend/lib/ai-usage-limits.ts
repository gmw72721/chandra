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

export const AI_TOKEN_LIMITS = {
  ...defaultAiTokenLimitSettings,
  ipPerFiveMinutes: 30_000,
  ipPerHour: 250_000
} as const;

const nearLimitThresholdPercent = 10;
const estimatedCharactersPerToken = 4;
const openRouterToolSchemaReserveTokens = 600;
const ragModelPassReserveTokens = 1_000;
const pdfPageAssetReserveTokens = 4_000;
const attachmentReserveTokens = 1_500;

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type StudentAiUsageStatus = {
  blocked: boolean;
  nearLimit: boolean;
  resetHint: string;
  todayPercentRemaining: number;
  weekPercentRemaining: number;
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
  limit: number;
  modelId: string;
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
  const limits = normalizeAiTokenLimitSettings(tokenLimits);
  const specs = role === "student" && quotaUserId
    ? tokenBucketSpecs({ classId, ipAddress, now, studentId: quotaUserId, tokenLimits: limits })
    : [];
  const requestQuotaSpecs = requestQuotaBucketSpecs({
    classId,
    modelId: modelId ?? "",
    now,
    provider,
    requestLimits: normalizeAiRequestLimitSettings(requestLimits),
    role,
    userId: quotaUserId
  });
  const reservationReference = adminDb!.collection("aiUsageReservations").doc(reservationId);
  const usageEventReference = adminDb!.collection("aiUsageEvents").doc(reservationId);

  return adminDb!.runTransaction(async (transaction) => {
    const [buckets, requestQuotaBuckets] = await Promise.all([
      readTokenBuckets(transaction, specs),
      readRequestQuotaBuckets(transaction, requestQuotaSpecs)
    ]);
    const blockedQuota = blockedRequestQuotaBucket(requestQuotaBuckets);

    if (blockedQuota) {
      throw new AiUsageLimitError(blockedUsageStatus(), blockedQuota.scope);
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
      studentStatus: buckets.length ? studentStatusFromBuckets(buckets, cleanEstimate) : null
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

    return nextStudentStatus ?? reservation.studentStatus;
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

    return studentStatusFromBuckets(buckets, deltaTokens);
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
    nearLimit: false,
    resetHint: "today",
    todayPercentRemaining: 0,
    weekPercentRemaining: 0
  };
}

export async function getStudentAiUsageStatus(
  studentId: string,
  classId?: string,
  tokenLimits?: Partial<AiTokenLimitSettings> | null
): Promise<StudentAiUsageStatus> {
  assertFirebaseAdminAuthReady();

  const limits = normalizeAiTokenLimitSettings(tokenLimits);
  const specs = tokenBucketSpecs({
    classId,
    ipAddress: "",
    now: new Date(),
    studentId,
    tokenLimits: limits
  }).filter((spec) => spec.scope === "student" && (spec.period === "day" || spec.period === "week"));
  const snapshots = await Promise.all(specs.map((spec) => spec.reference.get()));
  const buckets = snapshots.map((snapshot, index) => ({
    ...specs[index]!,
    ...tokenBucketValues(snapshot.data() ?? {})
  }));

  return studentStatusFromBuckets(buckets, 0);
}

export function normalizeAiTokenUsage(value: unknown): AiTokenUsage {
  if (!value || typeof value !== "object") {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const record = value as Record<string, unknown>;
  const inputTokens = nonnegativeInteger(record.inputTokens ?? record.input_tokens ?? record.prompt_tokens);
  const outputTokens = nonnegativeInteger(record.outputTokens ?? record.output_tokens ?? record.completion_tokens);
  const explicitTotal = nonnegativeInteger(record.totalTokens ?? record.total_tokens);
  const totalTokens = explicitTotal || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
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
  const blocked = buckets.some((bucket) => bucket.actualTotalTokens + bucket.reservedTokens + estimatedTokens > bucket.limit);

  return blocked ? studentStatusFromBuckets(buckets, 0, true) : null;
}

function studentStatusFromBuckets(
  buckets: Pick<TokenBucketSnapshot, "actualTotalTokens" | "limit" | "period" | "reservedTokens" | "scope">[],
  reservationTokens = 0,
  forceBlocked = false
): StudentAiUsageStatus {
  let dayRemaining = 100;
  let weekRemaining = 100;

  for (const bucket of buckets) {
    if (bucket.scope !== "student") {
      continue;
    }

    const usedTokens = bucket.actualTotalTokens + bucket.reservedTokens + reservationTokens;
    const remainingPercent = percentRemaining(bucket.limit, usedTokens);

    if (bucket.period === "day") {
      dayRemaining = remainingPercent;
    }

    if (bucket.period === "week") {
      weekRemaining = remainingPercent;
    }
  }

  const lowestRemaining = Math.min(dayRemaining, weekRemaining);

  return {
    blocked: forceBlocked || lowestRemaining <= 0,
    nearLimit: lowestRemaining > 0 && lowestRemaining <= nearLimitThresholdPercent,
    resetHint: dayRemaining <= weekRemaining ? "today" : "this week",
    todayPercentRemaining: dayRemaining,
    weekPercentRemaining: weekRemaining
  };
}

function percentRemaining(limit: number, usedTokens: number) {
  if (limit <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((limit - usedTokens) / limit) * 100)));
}

function tokenBucketSpecs({
  classId,
  ipAddress,
  now,
  studentId,
  tokenLimits
}: {
  classId?: string;
  ipAddress: string;
  now: Date;
  studentId: string;
  tokenLimits?: AiTokenLimitSettings;
}): TokenBucketSpec[] {
  const limits = normalizeAiTokenLimitSettings(tokenLimits);
  const studentHash = stableHash(classId ? `${classId}:${studentId}` : studentId);
  const specs: TokenBucketSpec[] = [
    bucketSpec({ bucketKey: hourBucketKey(now), limit: limits.perHour, period: "hour", scope: "student", scopeHash: studentHash }),
    bucketSpec({ bucketKey: dayBucketKey(now), limit: limits.perDay, period: "day", scope: "student", scopeHash: studentHash }),
    bucketSpec({ bucketKey: weekBucketKey(now), limit: limits.perWeek, period: "week", scope: "student", scopeHash: studentHash })
  ];

  if (ipAddress) {
    const ipHash = stableHash(ipAddress);
    specs.push(
      bucketSpec({ bucketKey: fiveMinuteBucketKey(now), limit: AI_TOKEN_LIMITS.ipPerFiveMinutes, period: "fiveMinute", scope: "ip", scopeHash: ipHash }),
      bucketSpec({ bucketKey: hourBucketKey(now), limit: AI_TOKEN_LIMITS.ipPerHour, period: "hour", scope: "ip", scopeHash: ipHash })
    );
  }

  return specs;
}

function requestQuotaBucketSpecs({
  classId,
  modelId,
  now,
  provider,
  requestLimits,
  role,
  userId
}: {
  classId: string;
  modelId: string;
  now: Date;
  provider: string;
  requestLimits: AiRequestLimitSettings;
  role: "student" | "teacher";
  userId: string;
}): RequestQuotaSpec[] {
  const dayBucket = dayBucketKey(now);
  const classHash = stableHash(classId);
  const specs: RequestQuotaSpec[] = [
    requestQuotaBucketSpec({
      classId,
      dayBucket,
      limit: requestLimits.perClassDaily,
      modelId,
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
        dayBucket,
        limit: requestLimits.perStudentDaily,
        modelId,
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
  provider,
  role,
  scope,
  scopeHash,
  userId
}: Omit<RequestQuotaSpec, "reference">): RequestQuotaSpec {
  const documentId = `${scope}_${scopeHash}_day_${dayBucket}`;

  return {
    classId,
    dayBucket,
    limit,
    modelId,
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
  limit,
  period,
  scope,
  scopeHash
}: Omit<TokenBucketSpec, "reference">): TokenBucketSpec {
  const documentId = `${scope}_${scopeHash}_${period}_${bucketKey}`;

  return {
    bucketKey,
    limit,
    period,
    reference: adminDb!.collection("aiUsageBuckets").doc(documentId),
    scope,
    scopeHash
  };
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
    reference,
    reservedTokens: nonnegativeInteger(data.reservedTokens),
    scope: String(data.scope ?? "student") as TokenBucketScope,
    scopeHash: String(data.scopeHash ?? "")
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

function compactFirestoreData<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
