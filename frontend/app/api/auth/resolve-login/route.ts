import { NextResponse } from "next/server";
import { writeSecurityLog } from "@/lib/audit-log";
import {
  checkAbuseLockout,
  clientFingerprint,
  hashForLog,
  recordAbuseFailure,
  resetAbuseFailures
} from "@/lib/abuse-lockout";
import { resolveLoginEmailPostgresFirst } from "@/lib/data/server";
import { adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";
import { checkFirestoreRateLimit } from "@/lib/firestore-rate-limit";

export const runtime = "nodejs";

type ResolveLoginBody = {
  identifier?: unknown;
};

const resolveLoginWindowMs = 10 * 60 * 1000;
const resolveLoginLimit = 20;
const repeatedFailedLookupThreshold = 5;
const resolveLoginLockoutPolicy = {
  resetWindowMs: 60 * 60 * 1000,
  lockoutSteps: [
    { failures: 5, cooldownMs: 5 * 60 * 1000 },
    { failures: 10, cooldownMs: 30 * 60 * 1000 },
    { failures: 20, cooldownMs: 24 * 60 * 60 * 1000 }
  ]
};

export async function POST(request: Request) {
  try {
    assertFirebaseAdminAuthReady();

    const body = (await request.json().catch(() => ({}))) as ResolveLoginBody;
    const identifier = normalizeLoginIdentifier(body.identifier);
    const rateLimit = await checkFirestoreRateLimit({
      key: `${clientIpForRateLimit(request)}:${identifier || "missing"}`,
      limit: resolveLoginLimit,
      namespace: "auth.resolve-login",
      windowMs: resolveLoginWindowMs
    });

    if (!identifier) {
      return genericResolveLoginResponse();
    }

    const abuseScope = {
      identifier,
      namespace: "auth.resolve_login",
      request,
      route: "/api/auth/resolve-login"
    };
    const lockout = await checkAbuseLockout(abuseScope, resolveLoginLockoutPolicy);

    if (lockout.locked) {
      return genericResolveLoginResponse();
    }

    if (!rateLimit.allowed) {
      await writeSecurityLog({
        eventType: "auth.resolve_login.rate_limited",
        metadata: {
          clientFingerprint: clientFingerprint(request),
          count: rateLimit.count,
          identifierHash: hashForLog(identifier),
          retryAfterMs: rateLimit.retryAfterMs
        },
        route: "/api/auth/resolve-login"
      });

      return genericResolveLoginResponse();
    }

    const postgresEmail = await resolveLoginEmailPostgresFirst(identifier);

    if (postgresEmail) {
      await resetAbuseFailures(abuseScope);
      return NextResponse.json({ email: postgresEmail });
    }

    const usernameSnapshot = await adminDb!
      .collection("users")
      .where("username", "==", identifier)
      .limit(1)
      .get();
    const usernameProfile = usernameSnapshot.docs[0]?.data();
    const usernameEmail = normalizeEmail(usernameProfile?.email);

    if (usernameEmail) {
      await resetAbuseFailures(abuseScope);
      return NextResponse.json({ email: usernameEmail });
    }

    const emailSnapshot = await adminDb!
      .collection("users")
      .where("email", "==", identifier)
      .limit(1)
      .get();
    const emailProfile = emailSnapshot.docs[0]?.data();
    const fallbackEmail = normalizeEmail(emailProfile?.email);

    if (fallbackEmail) {
      await resetAbuseFailures(abuseScope);
      return NextResponse.json({ email: fallbackEmail });
    }

    await recordAbuseFailure(abuseScope, resolveLoginLockoutPolicy);

    if (rateLimit.count >= repeatedFailedLookupThreshold) {
      await writeSecurityLog({
        eventType: "auth.resolve_login.failed_lookup_repeated",
        metadata: {
          clientFingerprint: clientFingerprint(request),
          count: rateLimit.count,
          identifierHash: hashForLog(identifier)
        },
        route: "/api/auth/resolve-login"
      });
    }

    return genericResolveLoginResponse();
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return genericResolveLoginResponse();
  }
}

function normalizeLoginIdentifier(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function genericResolveLoginResponse() {
  return NextResponse.json({ email: "" });
}

function clientIpForRateLimit(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const firstForwardedIp = forwardedFor.split(",")[0]?.trim();
  return firstForwardedIp || request.headers.get("x-real-ip") || "unknown";
}
