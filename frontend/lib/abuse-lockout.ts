import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { writeSecurityLog } from "./audit-log";
import { adminDb } from "./firebase-admin";

export type AbuseLockoutPolicy = {
  lockoutSteps?: { failures: number; cooldownMs: number }[];
  resetWindowMs?: number;
};

export type AbuseLockoutScope = {
  actorUid?: string;
  identifier: string;
  namespace: string;
  request: Request;
  route: string;
};

export type AbuseLockoutState = {
  failureCount: number;
  keyHash: string;
  locked: boolean;
  retryAfterMs: number;
};

const defaultResetWindowMs = 60 * 60 * 1000;
const defaultLockoutSteps = [
  { failures: 5, cooldownMs: 5 * 60 * 1000 },
  { failures: 10, cooldownMs: 30 * 60 * 1000 },
  { failures: 20, cooldownMs: 24 * 60 * 60 * 1000 }
];

export async function checkAbuseLockout(
  scope: AbuseLockoutScope,
  policy: AbuseLockoutPolicy = {}
): Promise<AbuseLockoutState> {
  const keyHash = abuseKeyHash(scope);

  if (!adminDb) {
    return { failureCount: 0, keyHash, locked: false, retryAfterMs: 0 };
  }

  const snapshot = await adminDb.collection("abuseLockouts").doc(keyHash).get();
  const data = snapshot.data() ?? {};
  const now = Date.now();
  const lockedUntilMillis = Number(data.lockedUntilMillis ?? 0);
  const resetAtMillis = Number(data.resetAtMillis ?? 0);
  const locked = lockedUntilMillis > now;
  const failureCount = resetAtMillis > now ? Number(data.failureCount ?? 0) : 0;

  if (locked) {
    await writeSecurityLog({
      eventType: `${scope.namespace}.lockout_denied`,
      metadata: {
        actorUid: scope.actorUid ?? "",
        failureCount,
        identifierHash: hashForLog(scope.identifier),
        keyHash,
        retryAfterMs: lockedUntilMillis - now
      },
      route: scope.route
    });
  }

  return {
    failureCount,
    keyHash,
    locked,
    retryAfterMs: locked ? lockedUntilMillis - now : 0
  };
}

export async function recordAbuseFailure(
  scope: AbuseLockoutScope,
  policy: AbuseLockoutPolicy = {}
): Promise<AbuseLockoutState> {
  const keyHash = abuseKeyHash(scope);

  if (!adminDb) {
    return { failureCount: 0, keyHash, locked: false, retryAfterMs: 0 };
  }

  const resetWindowMs = policy.resetWindowMs ?? defaultResetWindowMs;
  const lockoutSteps = policy.lockoutSteps ?? defaultLockoutSteps;
  const now = Date.now();
  const reference = adminDb.collection("abuseLockouts").doc(keyHash);

  const state = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const previousResetAtMillis = Number(data.resetAtMillis ?? 0);
    const currentFailureCount = previousResetAtMillis > now ? Number(data.failureCount ?? 0) : 0;
    const failureCount = currentFailureCount + 1;
    const resetAtMillis = previousResetAtMillis > now ? previousResetAtMillis : now + resetWindowMs;
    const cooldownMs = lockoutCooldownMs(failureCount, lockoutSteps);
    const lockedUntilMillis = cooldownMs ? now + cooldownMs : Number(data.lockedUntilMillis ?? 0);

    transaction.set(
      reference,
      {
        actorUid: scope.actorUid ?? "",
        failureCount,
        firstFailureAt: snapshot.exists && previousResetAtMillis > now ? data.firstFailureAt : FieldValue.serverTimestamp(),
        identifierHash: hashForLog(scope.identifier),
        keyHash,
        lastFailureAt: FieldValue.serverTimestamp(),
        lockedUntilMillis,
        namespace: scope.namespace,
        resetAtMillis
      },
      { merge: true }
    );

    return {
      failureCount,
      keyHash,
      locked: Boolean(cooldownMs),
      retryAfterMs: cooldownMs
    };
  });

  if (state.locked) {
    await writeSecurityLog({
      eventType: `${scope.namespace}.lockout`,
      metadata: {
        actorUid: scope.actorUid ?? "",
        failureCount: state.failureCount,
        identifierHash: hashForLog(scope.identifier),
        keyHash,
        retryAfterMs: state.retryAfterMs
      },
      route: scope.route
    });
  }

  return state;
}

export async function resetAbuseFailures(scope: AbuseLockoutScope) {
  const keyHash = abuseKeyHash(scope);

  if (!adminDb) {
    return;
  }

  await adminDb.collection("abuseLockouts").doc(keyHash).set(
    {
      failureCount: 0,
      lastResetAt: FieldValue.serverTimestamp(),
      lockedUntilMillis: 0,
      resetAtMillis: 0
    },
    { merge: true }
  );
}

export function clientFingerprint(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const firstForwardedIp = forwardedFor.split(",")[0]?.trim();
  const ip = firstForwardedIp || request.headers.get("x-real-ip") || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";
  return `${ip}:${hashForLog(userAgent).slice(0, 16)}`;
}

export function hashForLog(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function abuseKeyHash(scope: AbuseLockoutScope) {
  return hashForLog([
    scope.namespace,
    scope.identifier.trim().toLowerCase(),
    clientFingerprint(scope.request),
    scope.actorUid ?? ""
  ].join(":"));
}

function lockoutCooldownMs(failureCount: number, steps: { failures: number; cooldownMs: number }[]) {
  return [...steps]
    .sort((first, second) => second.failures - first.failures)
    .find((step) => failureCount >= step.failures)?.cooldownMs ?? 0;
}
