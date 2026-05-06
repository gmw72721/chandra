import { adminDb } from "./firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import {
  createSourceMetadata,
  materialTypeForKind,
  problemNumbersFromText,
  rankMaterialChunks
} from "./retrieval-ranking";
import { documents } from "./sample-data";
import type {
  RetrievalConfidence,
  RetrievalHit,
  SourceChunk,
  SourceDocument,
  TutorSource
} from "./types";
import { VertexEmbeddingError, createVertexEmbedding } from "./vertex-embeddings";
import type { RetrievalSourceHint } from "./retrieval-ranking";

export type CourseRetrievalResult = {
  confidence: RetrievalConfidence;
  hasIndexedMaterials: boolean;
  hits: RetrievalHit[];
  sources: TutorSource[];
};

export type CourseRetrievalScope = {
  classId: string;
  professorId: string;
  professorName?: string;
};

export async function retrieveCourseContext(
  scope: CourseRetrievalScope,
  query: string,
  limit = 5,
  sourceHints: RetrievalSourceHint[] = [],
  options: { materialId?: string } = {}
): Promise<CourseRetrievalResult> {
  const { classId, professorId } = normalizeRetrievalScope(scope);
  const courseId = classId;
  const staticDocuments = documents.filter((document) => document.courseId === courseId);
  const staticCandidates = toCandidates(staticDocuments.filter((document) => document.status === "ready"));
  const queryEmbedding = await createQueryEmbedding(query);
  const vectorCandidates = queryEmbedding?.values.length
    ? await getVectorMaterialCandidates({
        classId,
        limit: Math.max(limit * 10, 50),
        materialId: options.materialId,
        professorId,
        queryVector: queryEmbedding.values
      })
    : [];
  let ranked = vectorCandidates.length
    ? rankMaterialChunks({
        candidates: [...staticCandidates, ...vectorCandidates],
        limit,
        query,
        queryVector: queryEmbedding?.values,
        sourceHints
      })
    : null;
  let classDocuments: SourceDocument[] | null = null;

  if (!ranked || !ranked.hits.length) {
    classDocuments = await getClassMaterialDocuments({ classId, materialId: options.materialId, professorId });
    ranked = rankMaterialChunks({
      candidates: [...staticCandidates, ...toCandidates(classDocuments)],
      limit,
      query,
      queryVector: queryEmbedding?.values,
      sourceHints
    });
  }

  const hasIndexedMaterials = classDocuments
    ? hasReadyChunks(classDocuments)
    : vectorCandidates.length > 0 || (await hasReadyClassMaterialChunks({ classId, professorId }));

  return {
    confidence: ranked.confidence,
    hasIndexedMaterials,
    hits: ranked.hits,
    sources: createSourceMetadata(ranked.hits)
  };
}

async function createQueryEmbedding(query: string) {
  try {
    return await createVertexEmbedding({
      taskType: "RETRIEVAL_QUERY",
      text: query
    });
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      console.warn("Vertex AI query embedding failed. Falling back to keyword tutor knowledge retrieval.", caughtError);
      return undefined;
    }

    throw caughtError;
  }
}

async function getVectorMaterialCandidates({
  classId,
  limit,
  materialId,
  professorId,
  queryVector
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  queryVector: number[];
}) {
  if (!adminDb) {
    return [];
  }

  try {
    type CachedMaterialDocument = {
      document: SourceDocument;
      materialType: string;
      teacherId: string;
      title: string;
    };
    const materialDocumentCache = new Map<string, Promise<CachedMaterialDocument | null>>();
    const getCachedMaterialDocument = (materialRef: DocumentReference, materialId: string) => {
      const cachedDocument = materialDocumentCache.get(materialRef.path);

      if (cachedDocument) {
        return cachedDocument;
      }

      const materialDocument = materialRef.get().then((materialDoc) => {
        if (!materialDoc.exists) {
          return null;
        }

        const material = materialDoc.data() ?? {};

        if (!isStudentVisibleReadyMaterial(material)) {
          return null;
        }

        const document = normalizeMaterialDocument({
          classId,
          material,
          materialId
        });

        return {
          document,
          materialType: document.materialType ?? materialTypeForKind(document.kind),
          teacherId: document.teacherId ?? "",
          title: document.title
        };
      });

      materialDocumentCache.set(materialRef.path, materialDocument);
      return materialDocument;
    };

    const snapshot = await adminDb
      .collectionGroup("chunks")
      .where("professorId", "==", professorId)
      .where("classId", "==", classId)
      .findNearest({
        distanceMeasure: "COSINE",
        distanceResultField: "vectorDistance",
        limit: Math.min(limit, 1000),
        queryVector,
        vectorField: "embedding"
      })
      .get();

    const candidates = await Promise.all(
      snapshot.docs.map(async (chunkDoc) => {
        const materialRef = chunkDoc.ref.parent.parent;

        if (!materialRef) {
          return null;
        }

        if (materialId && materialRef.id !== materialId) {
          return null;
        }

        const classRef = materialRef.parent.parent;

        if (classRef?.id !== classId) {
          return null;
        }

        const cachedMaterial = await getCachedMaterialDocument(materialRef, materialRef.id);

        if (!cachedMaterial || cachedMaterial.teacherId !== professorId) {
          return null;
        }

        if (readProfessorId(chunkDoc.data()) !== professorId) {
          return null;
        }

        const chunk = normalizeChunk({
          chunkData: chunkDoc.data(),
          chunkId: chunkDoc.id,
          classId,
          materialId: materialRef.id,
          materialType: cachedMaterial.materialType,
          teacherId: cachedMaterial.teacherId,
          title: cachedMaterial.title
        });

        if (!chunk.content) {
          return null;
        }

        return { chunk, document: cachedMaterial.document };
      })
    );

    return candidates.filter((candidate): candidate is NonNullable<(typeof candidates)[number]> => candidate !== null);
  } catch (caughtError) {
    console.warn(
      [
        "Firestore Vector Search failed. Falling back to keyword tutor knowledge retrieval.",
        isLikelyMissingVectorIndex(caughtError)
          ? "The chunks collection group likely needs a vector index on professorId + classId + embedding."
          : ""
      ]
        .filter(Boolean)
        .join(" "),
      caughtError
    );
    return [];
  }
}

function toCandidates(sourceDocuments: SourceDocument[]) {
  return sourceDocuments
    .filter((document) => document.status === "ready")
    .flatMap((document) =>
      document.chunks.map((chunk) => ({
        chunk,
        document
      }))
    );
}

function hasReadyChunks(sourceDocuments: SourceDocument[]) {
  return sourceDocuments.some((document) => document.status === "ready" && document.chunks.length > 0);
}

async function hasReadyClassMaterialChunks({ classId, professorId }: { classId: string; professorId: string }) {
  if (!adminDb) {
    return false;
  }

  const snapshot = await adminDb
    .collection("classes")
    .doc(classId)
    .collection("materials")
    .where("status", "==", "ready")
    .where("professorId", "==", professorId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

async function getClassMaterialDocuments({
  classId,
  materialId,
  professorId
}: {
  classId: string;
  materialId?: string;
  professorId: string;
}): Promise<SourceDocument[]> {
  if (!adminDb) {
    return [];
  }

  const materialsCollection = adminDb.collection("classes").doc(classId).collection("materials");
  const materialsSnapshot = materialId
    ? {
        docs: [await materialsCollection.doc(materialId).get()].filter((materialDoc) => materialDoc.exists)
      }
    : await materialsCollection.where("status", "==", "ready").get();
  const materialDocuments: Array<SourceDocument | null> = await Promise.all(
    materialsSnapshot.docs.map(async (materialDoc) => {
      const material = materialDoc.data();

      if (!material) {
        return null;
      }

      if (!isStudentVisibleReadyMaterial(material) || readProfessorId(material) !== professorId) {
        return null;
      }

      const chunksSnapshot = await materialDoc.ref.collection("chunks").get();
      const document = normalizeMaterialDocument({
        classId,
        material,
        materialId: materialDoc.id,
        chunks: chunksSnapshot.docs
          .map((chunkDoc) =>
            normalizeChunk({
              chunkData: chunkDoc.data(),
              chunkId: chunkDoc.id,
              classId,
              materialId: materialDoc.id,
              materialType: materialTypeForKind(String(material.materialType ?? material.kind ?? "notes")),
              teacherId: readProfessorId(material),
              title: String(material.title ?? "Uploaded material")
            })
          )
          .filter((chunk) => chunk.content && chunk.teacherId === professorId)
      });

      return document;
    })
  );

  return materialDocuments.filter((document): document is SourceDocument => document !== null);
}

function normalizeMaterialDocument({
  chunks = [],
  classId,
  material,
  materialId
}: {
  chunks?: SourceChunk[];
  classId: string;
  material: Record<string, unknown>;
  materialId: string;
}): SourceDocument {
  const materialType = materialTypeForKind(String(material.materialType ?? material.kind ?? "notes"));
  const title = String(material.title ?? "Uploaded material");
  const createdAt = formatFirestoreDate(material.createdAt ?? material.addedAt);

  return {
    chunks,
    classId,
    courseId: classId,
    id: materialId,
    kind: normalizeMaterialKind(materialType),
    materialType,
    professorId: readProfessorId(material),
    professorName: readOptionalString(material.professorName ?? material.professor_name),
    activeForStudents: readBooleanWithDefault(material.activeForStudents ?? material.studentVisible, true),
    citationsRequired: readBooleanWithDefault(material.citationsRequired ?? material.requireCitations, true),
    priority: normalizePriority(material.priority),
    status: material.status === "ready" ? "ready" : "processing",
    teacherOnly: material.teacherOnly === true || material.visibility === "teacher-only",
    teacherId: readProfessorId(material),
    title,
    uploadedAt: createdAt
  };
}

function normalizeChunk({
  chunkData,
  chunkId,
  classId,
  materialId,
  materialType,
  teacherId,
  title
}: {
  chunkData: Record<string, unknown>;
  chunkId: string;
  classId: string;
  materialId: string;
  materialType: string;
  teacherId: string;
  title: string;
}): SourceChunk {
  const content = String(chunkData.content ?? chunkData.chunk_text ?? "");
  const problemNumbers = Array.isArray(chunkData.problemNumbers)
    ? chunkData.problemNumbers.map(String)
    : problemNumbersFromText(`${chunkData.label ?? ""}\n${content}`);

  return {
    id: chunkId,
    classId: String(chunkData.classId ?? classId),
    chunkIndex: readOptionalNumberAllowZero(chunkData.chunkIndex),
    content,
    documentId: materialId,
    excerpt: readOptionalString(chunkData.excerpt),
    label: String(chunkData.label ?? chunkData.sectionHeading ?? "Uploaded excerpt"),
    materialId: String(chunkData.materialId ?? materialId),
    materialType: String(chunkData.materialType ?? materialType),
    pageNumber: readOptionalNumber(chunkData.pageNumber ?? chunkData.page_start ?? chunkData.pageStart),
    problemNumbers,
    professorId: readProfessorId(chunkData) || teacherId,
    professorName: readOptionalString(chunkData.professorName ?? chunkData.professor_name),
    sectionHeading: readOptionalString(chunkData.sectionHeading ?? chunkData.section),
    teacherId: readProfessorId(chunkData) || teacherId,
    title: String(chunkData.title ?? title),
    vector: readEmbeddingVector(chunkData.embedding),
    vectorDistance: readOptionalNumber(chunkData.vectorDistance)
  };
}

export function normalizeRetrievalScope(scope: CourseRetrievalScope) {
  const classId = scope.classId.trim();
  const professorId = scope.professorId.trim();

  if (!classId) {
    throw new Error("Vector retrieval requires class_id metadata.");
  }

  if (!professorId) {
    throw new Error("Vector retrieval requires professor_id metadata.");
  }

  return {
    classId,
    professorId,
    professorName: scope.professorName?.trim() || undefined
  };
}

function readProfessorId(data: Record<string, unknown>) {
  return String(data.professorId ?? data.professor_id ?? data.teacherId ?? "").trim();
}

function normalizeMaterialKind(kind: string): SourceDocument["kind"] {
  const normalizedKind = kind.toLowerCase();

  if (normalizedKind === "assignment" || normalizedKind === "practice-problems") {
    return "assignment";
  }

  if (normalizedKind === "example" || normalizedKind === "worked-example" || normalizedKind === "practice-solutions") {
    return "worked-example";
  }

  if (normalizedKind === "reading" || normalizedKind === "textbook") {
    return "textbook";
  }

  return "lecture-notes";
}

function readOptionalNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function readOptionalNumberAllowZero(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function readOptionalString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function readBooleanWithDefault(value: unknown, defaultValue: boolean) {
  return typeof value === "boolean" ? value : defaultValue;
}

function normalizePriority(value: unknown) {
  return value === "primary" || value === "low" ? value : "normal";
}

function readEmbeddingVector(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(Number).filter((numberValue) => Number.isFinite(numberValue));
  }

  if (value && typeof value === "object" && "toArray" in value && typeof value.toArray === "function") {
    return value.toArray().map(Number).filter((numberValue: number) => Number.isFinite(numberValue));
  }

  return undefined;
}

function formatFirestoreDate(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  return new Date().toISOString();
}

function isStudentVisibleReadyMaterial(material: Record<string, unknown>) {
  return (
    material.status === "ready" &&
    material.activeForStudents !== false &&
    material.studentVisible !== false &&
    material.teacherOnly !== true &&
    material.visibility !== "teacher-only" &&
    material.visibility !== "hidden" &&
    material.private !== true
  );
}

function isLikelyMissingVectorIndex(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /index|FAILED_PRECONDITION|requires/i.test(message);
}
