import { NextRequest, NextResponse } from "next/server";
import { defaultStructuredPdfEmbeddingDim } from "@/lib/pdf-ingestion-config";
import {
  isPdfOcrPostgresConfigured,
  searchStructuredPdfMetadata
} from "@/lib/pdf-ocr-postgres";
import { retrieveCourseContext } from "@/lib/retrieval";
import { TutorKnowledgeHttpError, authorizeClassAccess } from "@/lib/tutor-knowledge-server";
import { VertexEmbeddingError, createVertexEmbeddings } from "@/lib/vertex-embeddings";

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
    const structuredPdfResults = materialId
      ? await searchStructuredPdfForRetrievalTest({
          classId,
          materialId,
          professorId: uid,
          query
        })
      : [];

    if (structuredPdfResults.length) {
      const topScore = Math.max(...structuredPdfResults.map((hit) => hit.score), 1);

      return NextResponse.json({
        confidence: structuredPdfResults.some((hit) => hit.retrievalMode === "exact_problem" || hit.retrievalMode === "exact_page")
          ? "high"
          : "medium",
        results: structuredPdfResults.map((hit) => ({
          chunkId: hit.sourceId || `${hit.materialId}:page-${hit.pageStart}`,
          chunkIndex: undefined,
          chunkLabel: hit.itemLabel || hit.itemNumber || hit.embeddingLevel || `Page ${hit.pageStart}`,
          confidence: Math.max(0, Math.min(0.99, hit.score / topScore * 0.92)),
          excerpt: hit.chunkText.slice(0, 240),
          materialId: hit.materialId,
          title: buildRetrievalResultTitle(hit.title, hit.itemLabel || hit.itemNumber || hit.embeddingLevel)
        }))
      });
    }

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

async function searchStructuredPdfForRetrievalTest({
  classId,
  materialId,
  professorId,
  query
}: {
  classId: string;
  materialId: string;
  professorId: string;
  query: string;
}) {
  if (!isPdfOcrPostgresConfigured()) {
    return [];
  }

  const queryEmbedding = shouldUseStructuredVectorSearch(query)
    ? await createStructuredPdfQueryEmbedding(query)
    : undefined;
  const structuredResults = await searchStructuredPdfMetadata({
    classId,
    limit: 5,
    materialId,
    professorId,
    query,
    queryVector: queryEmbedding?.values
  });

  return structuredResults;
}

async function createStructuredPdfQueryEmbedding(query: string) {
  try {
    const [embedding] = await createVertexEmbeddings(
      [{ taskType: "RETRIEVAL_QUERY", text: query }],
      { dimensions: defaultStructuredPdfEmbeddingDim }
    );

    if (embedding?.values.length && embedding.values.length !== defaultStructuredPdfEmbeddingDim) {
      console.warn(
        `Structured PDF retrieval-test query embedding has ${embedding.values.length} dimensions; expected ${defaultStructuredPdfEmbeddingDim}.`
      );
      return undefined;
    }

    return embedding;
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      console.warn("Structured PDF retrieval-test embedding failed. Returning lexical results only.", caughtError);
      return undefined;
    }

    throw caughtError;
  }
}

function shouldUseStructuredVectorSearch(query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return !(
    /^(?:problem|exercise|question|number|no\.?|#)?\s*\d{1,3}(?:\s*\.\s*\d{1,3}[a-z]?)?\s*[?.!]?$/.test(normalized)
    || /^(?:page|pg\.?|p\.?|printed\s+page)\s*#?\s*\d{1,4}\s*[?.!]?$/.test(normalized)
  );
}
