import { createHash } from "node:crypto";
import { FieldValue, type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { anonymizeStudentConversations } from "@/lib/data/conversations";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const recentAuthMaxAgeSeconds = 5 * 60;

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before deleting your account." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    const decodedToken = await adminAuth!.verifyIdToken(token);

    if (!hasRecentAuthentication(decodedToken.auth_time)) {
      return NextResponse.json({ error: "Reauthenticate before deleting your account." }, { status: 401 });
    }

    const userReference = adminDb!.collection("users").doc(decodedToken.uid);
    const userSnapshot = await userReference.get();
    const profile = userSnapshot.data() ?? {};
    const role = String(profile.role ?? "").trim();
    const email = normalizeEmail(profile.email || decodedToken.email);
    const displayName = String(profile.displayName ?? decodedToken.name ?? "").trim();

    if (!userSnapshot.exists || !["student", "teacher"].includes(role)) {
      return NextResponse.json({ error: "Account profile was not found." }, { status: 404 });
    }

    if (role === "teacher") {
      const activeOwnedClasses = await activeTeacherOwnedClasses(decodedToken.uid);

      if (activeOwnedClasses.length) {
        await writeAuditLog({
          actor: { email, uid: decodedToken.uid },
          eventType: "account.delete.blocked_active_teacher_classes",
          metadata: {
            activeClassCount: activeOwnedClasses.length
          },
          route: "/api/account/delete",
          target: {
            uid: decodedToken.uid
          }
        });

        return NextResponse.json(
          { error: "Transfer or delete active classes before deleting your teacher account." },
          { status: 409 }
        );
      }

      await removeTeacherAccountReferences({ email, uid: decodedToken.uid });
    } else {
      await anonymizeStudentAccountData({
        displayName,
        email,
        uid: decodedToken.uid
      });
    }

    await userReference.delete();
    await adminDb!.collection("userPresence").doc(decodedToken.uid).delete().catch(() => undefined);
    await adminAuth!.revokeRefreshTokens(decodedToken.uid);
    await adminAuth!.deleteUser(decodedToken.uid);
    await writeAuditLog({
      actor: { email, uid: decodedToken.uid },
      eventType: "account.deleted",
      metadata: {
        role
      },
      route: "/api/account/delete",
      target: {
        uid: decodedToken.uid
      }
    });

    return NextResponse.json({ deleted: true });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Account deletion failed." }, { status: 500 });
  }
}

async function activeTeacherOwnedClasses(uid: string) {
  const snapshot = await adminDb!
    .collection("classes")
    .where("teacherId", "==", uid)
    .get();

  return snapshot.docs.filter((classDoc) => {
    const data = classDoc.data();
    const status = String(data.status ?? "").trim().toLowerCase();
    return !data.archivedAt && !data.deletedAt && status !== "archived" && status !== "deleted";
  });
}

async function removeTeacherAccountReferences({ email, uid }: { email: string; uid: string }) {
  const coTeacherClassesSnapshot = await adminDb!
    .collection("classes")
    .where("coTeacherIds", "array-contains", uid)
    .get();
  const batch = adminDb!.batch();

  coTeacherClassesSnapshot.docs.forEach((classDoc) => {
    batch.set(
      classDoc.ref,
      {
        coTeacherIds: FieldValue.arrayRemove(uid),
        [`coTeachers.${uid}`]: FieldValue.delete()
      },
      { merge: true }
    );
  });

  await batch.commit();
  await writeAuditLog({
    actor: { email, uid },
    eventType: "account.delete.teacher_references_removed",
    metadata: {
      coTeacherClassCount: coTeacherClassesSnapshot.size
    },
    route: "/api/account/delete",
    target: { uid }
  });
}

async function anonymizeStudentAccountData({
  displayName,
  email,
  uid
}: {
  displayName: string;
  email: string;
  uid: string;
}) {
  const anonymizedId = `deleted-${hashForId(uid).slice(0, 16)}`;
  const anonymizedLabel = "Deleted student";
  const rosterSnapshots = email
    ? await adminDb!.collectionGroup("students").where("email", "==", email).get()
    : { docs: [] as QueryDocumentSnapshot[] };
  const updatedConversations = await anonymizeStudentConversations({
    anonymizedId,
    anonymizedLabel,
    deletedStudentDisplayName: displayName,
    email,
    originalEmailHash: email ? hashForId(email) : "",
    studentId: uid
  });

  await deleteDocumentsInBatches(rosterSnapshots.docs.map((studentDoc) => studentDoc.ref));
  await writeAuditLog({
    actor: { email, uid },
    eventType: "account.delete.student_data_anonymized",
    metadata: {
      conversationCount: updatedConversations.length,
      rosterEntryCount: rosterSnapshots.docs.length
    },
    route: "/api/account/delete",
    target: { uid }
  });
}

async function deleteDocumentsInBatches(references: DocumentReference[]) {
  for (let index = 0; index < references.length; index += 450) {
    const batch = adminDb!.batch();
    references.slice(index, index + 450).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

function hasRecentAuthentication(authTime: unknown) {
  const authTimeSeconds = Number(authTime ?? 0);

  return authTimeSeconds > 0 && Date.now() / 1000 - authTimeSeconds <= recentAuthMaxAgeSeconds;
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hashForId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
