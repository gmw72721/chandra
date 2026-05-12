import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { checkRateLimitPostgres } from "./data/operational";
import { isPostgresConfigured, shouldFallbackToFirestoreWhenPostgresFails, withPostgresTransaction } from "./data/postgres";

export type FirestoreRateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterMs: number;
};

export async function checkFirestoreRateLimit({
  key,
  limit,
  namespace,
  windowMs
}: {
  key: string;
  limit: number;
  namespace: string;
  windowMs: number;
}): Promise<FirestoreRateLimitResult> {
  if (!adminDb) {
    return {
      allowed: true,
      count: 0,
      limit,
      retryAfterMs: 0
    };
  }

  const now = Date.now();
  const documentId = createHash("sha256").update(`${namespace}:${key}`).digest("hex");
  const windowKey = String(Math.floor(now / windowMs));

  if (isPostgresConfigured()) {
    try {
      return await withPostgresTransaction((client) =>
        checkRateLimitPostgres({
          id: documentId,
          keyHash: documentId,
          limit,
          namespace,
          now: new Date(now),
          windowKey,
          windowMs
        }, client)
      );
    } catch (caughtError) {
      if (!shouldFallbackToFirestoreWhenPostgresFails()) {
        throw caughtError;
      }

      console.warn("Rate limit Postgres path failed; using Firestore fallback.", caughtError);
    }
  }

  const reference = adminDb.collection("rateLimits").doc(documentId);

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const resetAtMillis = Number(data.resetAtMillis ?? 0);
    const currentCount = resetAtMillis > now ? Number(data.count ?? 0) : 0;
    const nextCount = currentCount + 1;
    const nextResetAtMillis = resetAtMillis > now ? resetAtMillis : now + windowMs;
    const allowed = nextCount <= limit;

    transaction.set(
      reference,
      {
        count: nextCount,
        firstSeenAt: snapshot.exists && resetAtMillis > now ? data.firstSeenAt : FieldValue.serverTimestamp(),
        keyHash: documentId,
        lastSeenAt: FieldValue.serverTimestamp(),
        namespace,
        resetAtMillis: nextResetAtMillis
      },
      { merge: true }
    );

    return {
      allowed,
      count: nextCount,
      limit,
      retryAfterMs: Math.max(0, nextResetAtMillis - now)
    };
  });
}
