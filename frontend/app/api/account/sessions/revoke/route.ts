import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { adminAuth, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before revoking sessions." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);

    await adminAuth!.revokeRefreshTokens(decodedToken.uid);
    await writeAuditLog({
      actor: {
        email: decodedToken.email,
        uid: decodedToken.uid
      },
      eventType: "account.sessions.revoked",
      route: "/api/account/sessions/revoke",
      target: {
        uid: decodedToken.uid
      }
    });

    return NextResponse.json({ revoked: true });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Session revocation failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}
