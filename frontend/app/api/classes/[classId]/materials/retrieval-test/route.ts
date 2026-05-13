import { NextRequest, NextResponse } from "next/server";
import { retrieveCourseContext } from "@/lib/retrieval";
import { TutorKnowledgeHttpError, authorizeClassAccess } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    const body = await request.json() as { materialId?: string; query?: string };
    const query = String(body.query ?? "").trim();
    const materialId = String(body.materialId ?? "").trim();

    if (!query) {
      return NextResponse.json({ error: "Add a student question before testing retrieval." }, { status: 400 });
    }

    const { classSnapshot, uid } = await authorizeClassAccess(request, classId, "viewMaterials");
    const professorName = String(classSnapshot.data()?.teacherName ?? classSnapshot.data()?.professorName ?? "").trim();
    const retrieval = await retrieveCourseContext(
      {
        classId,
        professorId: uid,
        professorName
      },
      query,
      5,
      [],
      materialId ? { materialId } : {}
    );

    const topScore = Math.max(...retrieval.hits.map((hit) => hit.score), 1);

    return NextResponse.json({
      confidence: retrieval.confidence,
      results: retrieval.hits.map((hit) => ({
        chunkId: hit.chunk.id,
        chunkIndex: hit.chunk.chunkIndex,
        chunkLabel: hit.chunk.label || hit.chunk.id,
        confidence: Math.max(0, Math.min(0.99, hit.score / topScore * 0.92)),
        excerpt: hit.chunk.excerpt ?? hit.chunk.content.slice(0, 240),
        materialId: hit.document.id,
        title: buildRetrievalResultTitle(hit.document.title, hit.chunk.sectionHeading ?? hit.chunk.label)
      }))
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    console.error("Tutor knowledge retrieval test failed.", caughtError);
    return NextResponse.json({ error: "Tutor knowledge retrieval test failed." }, { status: 500 });
  }
}

function buildRetrievalResultTitle(title: string, section: string | undefined) {
  const normalizedSection = section?.trim();

  return normalizedSection ? `${title} > ${normalizedSection}` : title;
}
