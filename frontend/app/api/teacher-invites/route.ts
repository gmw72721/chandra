import { createHash, randomBytes } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { getAccountProfile } from "@/lib/data/server";
import {
  createTeacherInvitePostgres,
  getTeacherInvitePostgres,
  listTeacherInvitesPostgres,
  revokeTeacherInvitePostgres,
  type TeacherInviteRecord
} from "@/lib/data/operational";
import { isPostgresConfigured, shouldFallbackToFirestoreWhenPostgresFails } from "@/lib/data/postgres";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const inviteTtlDays = 30;

type AuthorizedTeacher = {
  email: string;
  uid: string;
};

export async function GET(request: Request) {
  try {
    const teacher = await authorizeTeacherInviteRequest(request, "list active invites");
    const frontendOrigin = publicFrontendOrigin(request);
    const postgresInvites = await readPostgresInvites(teacher.uid);

    if (postgresInvites.length) {
      return NextResponse.json({
        invites: postgresInvites
          .map((invite) => inviteRecordToResponse(invite, frontendOrigin))
          .sort((firstInvite, secondInvite) => secondInvite.createdAt.localeCompare(firstInvite.createdAt))
      });
    }

    const snapshot = await adminDb!
      .collection("teacherInvites")
      .where("createdByUid", "==", teacher.uid)
      .get();
    const invites = snapshot.docs
      .map((inviteDoc) => inviteDocToResponse(inviteDoc.id, inviteDoc.data(), frontendOrigin))
      .sort((firstInvite, secondInvite) => secondInvite.createdAt.localeCompare(firstInvite.createdAt));

    return NextResponse.json({ invites });
  } catch (caughtError) {
    return teacherInviteErrorResponse(caughtError, "Teacher invite list failed.");
  }
}

export async function POST(request: Request) {
  try {
    const teacher = await authorizeTeacherInviteRequest(request, "create an invite");

    const inviteToken = randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(inviteToken);
    const expiresAtDate = new Date(Date.now() + inviteTtlDays * 24 * 60 * 60 * 1000);
    const inviteUrl = buildTeacherInviteUrl(publicFrontendOrigin(request), inviteToken);

    const postgresInvite = await writePostgresInvite({
      createdBy: teacher.uid,
      createdByEmail: teacher.email,
      expiresAt: expiresAtDate,
      tokenHash
    });

    if (!postgresInvite) {
      await adminDb!.collection("teacherInvites").doc(tokenHash).set({
        createdAt: FieldValue.serverTimestamp(),
        createdByEmail: teacher.email,
        createdByUid: teacher.uid,
        expiresAt: Timestamp.fromDate(expiresAtDate),
        revokedAt: null,
        tokenHash
      });
    }

    await writeAuditLog({
      actor: {
        email: teacher.email,
        uid: teacher.uid
      },
      eventType: "teacher_invite.created",
      metadata: {
        expiresAt: expiresAtDate.toISOString()
      },
      route: "/api/teacher-invites",
      target: {
        inviteId: tokenHash
      }
    });

    return NextResponse.json({
      expiresAt: expiresAtDate.toISOString(),
      inviteId: tokenHash,
      inviteUrl
    });
  } catch (caughtError) {
    return teacherInviteErrorResponse(caughtError, "Teacher invite creation failed.");
  }
}

export async function DELETE(request: Request) {
  try {
    const teacher = await authorizeTeacherInviteRequest(request, "revoke an invite");
    const body = (await request.json().catch(() => ({}))) as { inviteId?: unknown };
    const inviteId = String(body.inviteId ?? "").trim();

    if (!/^[a-f0-9]{64}$/i.test(inviteId)) {
      return NextResponse.json({ error: "Choose an invite to revoke." }, { status: 400 });
    }

    const inviteReference = adminDb!.collection("teacherInvites").doc(inviteId);
    const postgresInvite = await readPostgresInvite(inviteId);
    const inviteSnapshot = postgresInvite ? null : await inviteReference.get();
    const invite = inviteSnapshot?.data();

    if (
      (!postgresInvite && !inviteSnapshot?.exists)
      || (postgresInvite && postgresInvite.createdBy !== teacher.uid)
      || (!postgresInvite && invite?.createdByUid !== teacher.uid)
    ) {
      return NextResponse.json({ error: "Choose an invite to revoke." }, { status: 404 });
    }

    if (postgresInvite?.usedAt || invite?.usedAt) {
      return NextResponse.json({ error: "Used invites cannot be revoked." }, { status: 409 });
    }

    if (postgresInvite && !postgresInvite.revokedAt) {
      await revokePostgresInvite({ id: inviteId, revokedBy: teacher.uid, revokedByEmail: teacher.email });
    }

    if (!postgresInvite && !invite?.revokedAt) {
      await inviteReference.set(
        {
          revokedAt: FieldValue.serverTimestamp(),
          revokedByEmail: teacher.email,
          revokedByUid: teacher.uid
        },
        { merge: true }
      );
    }

    await writeAuditLog({
      actor: {
        email: teacher.email,
        uid: teacher.uid
      },
      eventType: "teacher_invite.revoked",
      route: "/api/teacher-invites",
      target: {
        inviteId
      }
    });

    return NextResponse.json({ revoked: true });
  } catch (caughtError) {
    return teacherInviteErrorResponse(caughtError, "Teacher invite revoke failed.");
  }
}

async function authorizeTeacherInviteRequest(request: Request, action: string): Promise<AuthorizedTeacher> {
  const token = getBearerToken(request);

  if (!token) {
    throw new TeacherInviteRouteError(`Sign in as a teacher to ${action}.`, 401);
  }

  assertFirebaseAdminAuthReady();
  const decodedToken = await adminAuth!.verifyIdToken(token);
  const postgresProfile = await getAccountProfile(decodedToken.uid);
  const profileSnapshot = postgresProfile ? null : await adminDb!.collection("users").doc(decodedToken.uid).get();
  const profile = postgresProfile ?? profileSnapshot?.data();

  if ((!postgresProfile && !profileSnapshot?.exists) || profile?.role !== "teacher") {
    throw new TeacherInviteRouteError(`Use a teacher account to ${action}.`, 403);
  }

  return {
    email: String(profile.email ?? decodedToken.email ?? "").trim().toLowerCase(),
    uid: decodedToken.uid
  };
}

async function readPostgresInvites(teacherId: string) {
  if (!isPostgresConfigured()) {
    return [];
  }

  try {
    return await listTeacherInvitesPostgres(teacherId);
  } catch (caughtError) {
    if (!shouldFallbackToFirestoreWhenPostgresFails()) {
      throw caughtError;
    }

    console.warn("Teacher invite Postgres list failed; using Firestore fallback.", caughtError);
    return [];
  }
}

async function readPostgresInvite(inviteId: string) {
  if (!isPostgresConfigured()) {
    return null;
  }

  try {
    return await getTeacherInvitePostgres(inviteId);
  } catch (caughtError) {
    if (!shouldFallbackToFirestoreWhenPostgresFails()) {
      throw caughtError;
    }

    console.warn("Teacher invite Postgres read failed; using Firestore fallback.", caughtError);
    return null;
  }
}

async function writePostgresInvite(input: {
  createdBy: string;
  createdByEmail: string;
  expiresAt: Date;
  tokenHash: string;
}) {
  if (!isPostgresConfigured()) {
    return null;
  }

  try {
    return await createTeacherInvitePostgres(input);
  } catch (caughtError) {
    if (!shouldFallbackToFirestoreWhenPostgresFails()) {
      throw caughtError;
    }

    console.warn("Teacher invite Postgres create failed; using Firestore fallback.", caughtError);
    return null;
  }
}

async function revokePostgresInvite(input: { id: string; revokedBy: string; revokedByEmail: string }) {
  if (!isPostgresConfigured()) {
    return null;
  }

  try {
    return await revokeTeacherInvitePostgres(input);
  } catch (caughtError) {
    if (!shouldFallbackToFirestoreWhenPostgresFails()) {
      throw caughtError;
    }

    console.warn("Teacher invite Postgres revoke failed; using Firestore fallback.", caughtError);
    return null;
  }
}

class TeacherInviteRouteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function hashInviteToken(inviteToken: string) {
  return createHash("sha256").update(inviteToken).digest("hex");
}

function inviteDocToResponse(inviteId: string, invite: Record<string, unknown>, frontendOrigin: string) {
  const expiresAt = invite.expiresAt instanceof Timestamp ? invite.expiresAt.toDate() : null;
  const usedAt = invite.usedAt instanceof Timestamp ? invite.usedAt.toDate() : null;
  const revokedAt = invite.revokedAt instanceof Timestamp ? invite.revokedAt.toDate() : null;
  const createdAt = invite.createdAt instanceof Timestamp ? invite.createdAt.toDate() : null;
  const now = Date.now();
  const status = usedAt
    ? "used"
    : revokedAt
      ? "revoked"
      : expiresAt && expiresAt.getTime() <= now
        ? "expired"
        : "active";

  return {
    createdAt: createdAt?.toISOString() ?? "",
    expiresAt: expiresAt?.toISOString() ?? "",
    inviteId,
    inviteUrl: status === "active" ? buildTeacherInviteUrl(frontendOrigin, inviteId) : "",
    revokedAt: revokedAt?.toISOString() ?? "",
    status,
    usedAt: usedAt?.toISOString() ?? "",
    usedByEmail: normalizeEmail(invite.usedByEmail),
    usedByUid: String(invite.usedByUid ?? "").trim()
  };
}

function inviteRecordToResponse(invite: TeacherInviteRecord, frontendOrigin: string) {
  const now = Date.now();
  const status = invite.usedAt
    ? "used"
    : invite.revokedAt
      ? "revoked"
      : invite.expiresAt && invite.expiresAt.getTime() <= now
        ? "expired"
        : invite.status;

  return {
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt?.toISOString() ?? "",
    inviteId: invite.id,
    inviteUrl: status === "active" ? buildTeacherInviteUrl(frontendOrigin, invite.id) : "",
    revokedAt: invite.revokedAt?.toISOString() ?? "",
    status,
    usedAt: invite.usedAt?.toISOString() ?? "",
    usedByEmail: normalizeEmail(invite.metadata.usedByEmail),
    usedByUid: invite.usedBy
  };
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function teacherInviteErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TeacherInviteRouteError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  const message = caughtError instanceof Error ? caughtError.message : "";

  if (message.includes("Firebase Admin is not configured")) {
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (message.includes("FRONTEND_ORIGIN")) {
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

function publicFrontendOrigin(request: Request) {
  const configuredOrigin = (process.env.FRONTEND_ORIGIN ?? process.env.NEXT_PUBLIC_APP_ORIGIN ?? "").trim();

  if (configuredOrigin) {
    return configuredOrigin.replace(/\/$/, "");
  }

  const requestOrigin = new URL(request.url).origin;

  if (process.env.NODE_ENV === "production" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(requestOrigin)) {
    throw new Error("FRONTEND_ORIGIN is required in production to create teacher invite links.");
  }

  return requestOrigin;
}

function buildTeacherInviteUrl(frontendOrigin: string, inviteToken: string) {
  const inviteUrl = new URL("/auth", frontendOrigin);
  inviteUrl.searchParams.set("role", "teacher");
  inviteUrl.searchParams.set("teacherInvite", inviteToken);

  return inviteUrl.toString();
}
