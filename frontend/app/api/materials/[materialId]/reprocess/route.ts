import { NextRequest, NextResponse } from "next/server";
import {
  TutorKnowledgeHttpError,
  authorizeClassAccess,
  reprocessTutorKnowledge
} from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const { materialId } = await params;
    const body = await request.json().catch(() => ({})) as { classId?: string };
    const classId = String(body.classId ?? request.nextUrl.searchParams.get("classId") ?? "").trim();

    if (!classId) {
      return NextResponse.json({ error: "Choose a class before reprocessing tutor knowledge." }, { status: 400 });
    }

    const { uid } = await authorizeClassAccess(request, classId, "manageMaterials");
    const material = await reprocessTutorKnowledge({ classId, materialId, teacherId: uid });

    return NextResponse.json(material);
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    console.error("Tutor knowledge reprocess failed.", caughtError);
    return NextResponse.json({ error: "Tutor knowledge reprocess failed." }, { status: 500 });
  }
}
