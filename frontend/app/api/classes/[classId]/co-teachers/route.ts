import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { classAccessRoleOptions, normalizeClassAccessRole } from "@/lib/class-settings";
import { getAccountByEmail, getAccountById } from "@/lib/data/accounts";
import { removeCoTeacher, updateCoTeacherRole, upsertCoTeacher } from "@/lib/data/classes";
import { tryPostgresData } from "@/lib/data/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

type CoTeacherRouteParams = {
  classId: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<CoTeacherRouteParams> }
) {
  try {
    const { classId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as {
      email?: unknown;
      role?: unknown;
      uid?: unknown;
    };
    const role = normalizeAssignableRole(body.role);
    const targetTeacher = await resolveTeacher(body.uid, body.email);

    if (!targetTeacher.uid) {
      return NextResponse.json({ error: "Choose an existing teacher account." }, { status: 404 });
    }

    if (targetTeacher.uid === uid) {
      return NextResponse.json({ error: "You cannot change your own class access here." }, { status: 400 });
    }

    await tryPostgresData("class.co_teacher.write", () =>
      upsertCoTeacher({
        classId,
        displayName: targetTeacher.displayName,
        email: targetTeacher.email,
        invitedBy: uid,
        role,
        teacherId: targetTeacher.uid
      })
    );
    await adminDb!.collection("classes").doc(classId).set(
      {
        coTeacherIds: FieldValue.arrayUnion(targetTeacher.uid),
        coTeachers: {
          [targetTeacher.uid]: {
            displayName: targetTeacher.displayName,
            email: targetTeacher.email,
            role,
            uid: targetTeacher.uid
          }
        }
      },
      { merge: true }
    );

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "class.co_teacher.added",
      metadata: { role },
      route: "/api/classes/[classId]/co-teachers",
      target: {
        classId,
        targetUid: targetTeacher.uid
      }
    });

    return NextResponse.json({
      coTeacher: {
        displayName: targetTeacher.displayName,
        email: targetTeacher.email,
        role,
        uid: targetTeacher.uid
      }
    });
  } catch (caughtError) {
    return coTeacherErrorResponse(caughtError, "Co-teacher update failed.");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<CoTeacherRouteParams> }
) {
  try {
    const { classId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as {
      role?: unknown;
      uid?: unknown;
    };
    const targetUid = String(body.uid ?? "").trim();
    const role = normalizeAssignableRole(body.role);

    if (!targetUid) {
      return NextResponse.json({ error: "Choose a co-teacher." }, { status: 400 });
    }

    if (targetUid === uid) {
      return NextResponse.json({ error: "You cannot demote yourself." }, { status: 400 });
    }

    await tryPostgresData("class.co_teacher.role.write", () =>
      updateCoTeacherRole({ classId, role, teacherId: targetUid })
    );
    await adminDb!.collection("classes").doc(classId).update({
      [`coTeachers.${targetUid}.role`]: role
    });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "class.co_teacher.updated",
      metadata: { role },
      route: "/api/classes/[classId]/co-teachers",
      target: {
        classId,
        targetUid
      }
    });

    return NextResponse.json({ role, uid: targetUid });
  } catch (caughtError) {
    return coTeacherErrorResponse(caughtError, "Co-teacher update failed.");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<CoTeacherRouteParams> }
) {
  try {
    const { classId } = await params;
    const { email: actorEmail, uid } = await authorizeClassTeacher(request, classId);
    const body = (await request.json().catch(() => ({}))) as {
      uid?: unknown;
    };
    const targetUid = String(body.uid ?? "").trim();

    if (!targetUid) {
      return NextResponse.json({ error: "Choose a co-teacher." }, { status: 400 });
    }

    if (targetUid === uid) {
      return NextResponse.json({ error: "You cannot remove yourself from this class." }, { status: 400 });
    }

    await tryPostgresData("class.co_teacher.remove.write", () => removeCoTeacher({ classId, teacherId: targetUid }));
    await adminDb!.collection("classes").doc(classId).update({
      coTeacherIds: FieldValue.arrayRemove(targetUid),
      [`coTeachers.${targetUid}`]: FieldValue.delete()
    });

    await writeAuditLog({
      actor: { email: actorEmail, uid },
      eventType: "class.co_teacher.removed",
      route: "/api/classes/[classId]/co-teachers",
      target: {
        classId,
        targetUid
      }
    });

    return NextResponse.json({ uid: targetUid });
  } catch (caughtError) {
    return coTeacherErrorResponse(caughtError, "Co-teacher removal failed.");
  }
}

function normalizeAssignableRole(value: unknown) {
  const role = normalizeClassAccessRole(value);

  if (role === "owner" || !classAccessRoleOptions.includes(role)) {
    return "co-teacher";
  }

  return role;
}

async function resolveTeacher(uidValue: unknown, emailValue: unknown) {
  const uid = String(uidValue ?? "").trim();
  const email = String(emailValue ?? "").trim().toLowerCase();
  const postgresTeacher = await tryPostgresData("class.co_teacher.resolve", async () => {
    const account = uid ? await getAccountById(uid) : email ? await getAccountByEmail(email) : null;

    if (!account || account.role !== "teacher") {
      return null;
    }

    return {
      displayName: account.displayName || account.email || "Teacher",
      email: account.email.trim().toLowerCase(),
      uid: account.id
    };
  });

  if (postgresTeacher) {
    return postgresTeacher;
  }

  const snapshot = uid
    ? await adminDb!.collection("users").doc(uid).get()
    : email
      ? (await adminDb!.collection("users").where("email", "==", email).limit(1).get()).docs[0]
      : null;
  const data = snapshot?.data();

  if (!snapshot?.exists || data?.role !== "teacher") {
    return { displayName: "", email, uid: "" };
  }

  return {
    displayName: String(data.displayName ?? data.email ?? "Teacher").trim(),
    email: String(data.email ?? email).trim().toLowerCase(),
    uid: snapshot.id
  };
}

function coTeacherErrorResponse(caughtError: unknown, fallbackMessage: string) {
  if (caughtError instanceof TutorKnowledgeHttpError) {
    return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
