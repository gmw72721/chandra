import { NextResponse } from "next/server";
import { adminAuth, adminDb, assertFirebaseAdminAuthReady } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Sign in before joining a class." }, { status: 401 });
    }

    assertFirebaseAdminAuthReady();
    await adminAuth!.verifyIdToken(token);

    const body = (await request.json()) as { classCode?: unknown };
    const classCode = normalizeClassCode(String(body.classCode ?? ""));

    if (!classCode) {
      return NextResponse.json({ classId: "" });
    }

    const directClassSnapshot = await adminDb!.collection("classes").doc(classCode).get();

    if (directClassSnapshot.exists) {
      return NextResponse.json({ classId: directClassSnapshot.id });
    }

    const joinCodeSnapshot = await adminDb!
      .collection("classes")
      .where("joinCode", "==", classCode)
      .limit(1)
      .get();
    const joinedClass = joinCodeSnapshot.docs[0];

    if (!joinedClass) {
      return NextResponse.json({ error: "Class code was not found." }, { status: 404 });
    }

    return NextResponse.json({ classId: joinedClass.id });
  } catch {
    return NextResponse.json({ error: "Class code lookup failed." }, { status: 500 });
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeClassCode(classCode: string) {
  const cleanClassCode = classCode.trim();

  if (cleanClassCode.length === 6 && /^[a-z]+$/i.test(cleanClassCode)) {
    return cleanClassCode.toUpperCase();
  }

  return cleanClassCode;
}
