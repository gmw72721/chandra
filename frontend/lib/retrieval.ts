import { adminDb } from "./firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import {
  createSourceMetadata,
  exactLookupLocatorsFromText,
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
import { VertexEmbeddingError, createVertexEmbedding, type VertexEmbeddingResult } from "./vertex-embeddings";
import type { RetrievalRankingResult, RetrievalSourceHint } from "./retrieval-ranking";

export type CourseRetrievalResult = {
  confidence: RetrievalConfidence;
  hasIndexedMaterials: boolean;
  hits: RetrievalHit[];
  sources: TutorSource[];
  timings?: CourseRetrievalTimings;
};

export type CourseRetrievalScope = {
  classId: string;
  professorId: string;
  professorName?: string;
};

export type CourseRetrievalTimings = {
  exactLookupChunkCount?: number;
  exactLookupChunkSearchMs?: number;
  exactLookupMaterialReadCount?: number;
  exactLookupReason?: string;
  exactLookupMaterialLoadMs?: number;
  fallbackKeywordLoadMs?: number;
  fallbackRankingMs?: number;
  hasIndexedMaterialsCheckMs?: number;
  queryEmbeddingCacheHit?: boolean;
  queryEmbeddingMs?: number;
  totalMs: number;
  vectorCandidateBuildMs?: number;
  vectorCandidateCount?: number;
  vectorMaterialReadCount?: number;
  vectorRankingMs?: number;
  vectorSearchMs?: number;
};

type CachedMaterialDocument = {
  document: SourceDocument;
  materialType: string;
  teacherId: string;
  title: string;
};

const queryEmbeddingCacheMaxEntries = 256;
const exactLookupChunkQueryLimit = 40;
const queryEmbeddingCache = new Map<string, Promise<VertexEmbeddingResult | undefined>>();

export async function retrieveCourseContext(
  scope: CourseRetrievalScope,
  query: string,
  limit = 5,
  sourceHints: RetrievalSourceHint[] = [],
  options: { materialId?: string } = {}
): Promise<CourseRetrievalResult> {
  const totalStartedAt = performance.now();
  const timings: Partial<CourseRetrievalTimings> = {};
  const { classId, professorId } = normalizeRetrievalScope(scope);
  const staticCandidates = toCandidates(documents.filter((document) => document.courseId === classId));
  const queryEmbeddingStartedAt = performance.now();
  const queryEmbedding = await createQueryEmbedding(query);
  timings.queryEmbeddingMs = elapsedMs(queryEmbeddingStartedAt);
  timings.queryEmbeddingCacheHit = Boolean(queryEmbedding?.cacheHit);
  const exactLookupLocators = exactLookupLocatorsFromText(query);
  const shouldUseTargetedExactLookup = Boolean(
    !options.materialId
      && (
        exactLookupLocators.problemNumbers.length
        || exactLookupLocators.sectionMarkers.length
        || exactLookupLocators.pageNumbers.length
      )
  );
  const shouldIncludeKeywordCandidates = shouldUseTargetedExactLookup || Boolean(options.materialId);
  const vectorCandidates = queryEmbedding?.values.length
    ? await getVectorMaterialCandidates({
        classId,
        limit: Math.max(limit * 10, 50),
        materialId: options.materialId,
        professorId,
        queryVector: queryEmbedding.values,
        timings
      })
    : [];
  let classDocuments: SourceDocument[] | null = null;
  let exactLookupCandidates: ReturnType<typeof toCandidates> = [];

  if (vectorCandidates.length && shouldIncludeKeywordCandidates) {
    const exactLookupMaterialLoadStartedAt = performance.now();
    if (options.materialId) {
      classDocuments = await getClassMaterialDocuments({ classId, materialId: options.materialId, professorId });
      timings.exactLookupMaterialLoadMs = elapsedMs(exactLookupMaterialLoadStartedAt);
      timings.exactLookupReason = "materialId";
    } else {
      exactLookupCandidates = await getExactLookupChunkCandidates({
        classId,
        locators: exactLookupLocators,
        professorId,
        timings
      });
      timings.exactLookupChunkSearchMs = elapsedMs(exactLookupMaterialLoadStartedAt);
      timings.exactLookupReason = exactLookupReason(exactLookupLocators);
    }
  }

  const keywordCandidates = classDocuments ? toCandidates(classDocuments) : exactLookupCandidates;
  let ranked: RetrievalRankingResult | null = null;

  if (vectorCandidates.length) {
    const vectorRankingStartedAt = performance.now();
    ranked = rankMaterialChunks({
        candidates: deduplicateCandidates([...staticCandidates, ...vectorCandidates, ...keywordCandidates]),
        limit,
        query,
        queryVector: queryEmbedding?.values,
        sourceHints
      });
    timings.vectorRankingMs = elapsedMs(vectorRankingStartedAt);
  }

  if (!ranked || !ranked.hits.length) {
    const fallbackKeywordLoadStartedAt = performance.now();
    classDocuments ??= await getClassMaterialDocuments({ classId, materialId: options.materialId, professorId });
    timings.fallbackKeywordLoadMs = elapsedMs(fallbackKeywordLoadStartedAt);
    const fallbackRankingStartedAt = performance.now();
    ranked = rankMaterialChunks({
      candidates: [...staticCandidates, ...toCandidates(classDocuments)],
      limit,
      query,
      queryVector: queryEmbedding?.values,
      sourceHints
    });
    timings.fallbackRankingMs = elapsedMs(fallbackRankingStartedAt);
  }

  let hasIndexedMaterials: boolean;
  if (classDocuments) {
    hasIndexedMaterials = hasReadyChunks(classDocuments);
  } else if (vectorCandidates.length > 0) {
    hasIndexedMaterials = true;
  } else {
    const hasIndexedMaterialsStartedAt = performance.now();
    hasIndexedMaterials = await hasReadyClassMaterialChunks({ classId, professorId });
    timings.hasIndexedMaterialsCheckMs = elapsedMs(hasIndexedMaterialsStartedAt);
  }

  return {
    confidence: ranked.confidence,
    hasIndexedMaterials,
    hits: ranked.hits,
    sources: createSourceMetadata(ranked.hits),
    timings: {
      ...timings,
      totalMs: elapsedMs(totalStartedAt)
    }
  };
}

async function createQueryEmbedding(query: string) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return undefined;
  }

  const cacheKey = queryEmbeddingCacheKey(trimmedQuery);
  const cachedEmbedding = queryEmbeddingCache.get(cacheKey);

  if (cachedEmbedding) {
    queryEmbeddingCache.delete(cacheKey);
    queryEmbeddingCache.set(cacheKey, cachedEmbedding);
    const embedding = await cachedEmbedding;
    return embedding ? { ...embedding, cacheHit: true } : embedding;
  }

  const pendingEmbedding = createVertexEmbedding({
    taskType: "RETRIEVAL_QUERY",
    text: trimmedQuery
  }).catch((caughtError) => {
    queryEmbeddingCache.delete(cacheKey);
    throw caughtError;
  });

  queryEmbeddingCache.set(cacheKey, pendingEmbedding);
  trimQueryEmbeddingCache();

  try {
    const embedding = await pendingEmbedding;
    return embedding ? { ...embedding, cacheHit: false } : embedding;
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      console.warn("Vertex AI query embedding failed. Falling back to keyword tutor knowledge retrieval.", caughtError);
      return undefined;
    }

    throw caughtError;
  }
}

function queryEmbeddingCacheKey(query: string) {
  return [
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "",
    process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    process.env.VERTEX_EMBEDDING_MODEL ?? "gemini-embedding-2",
    process.env.VERTEX_EMBEDDING_DIMENSIONS ?? "768",
    "RETRIEVAL_QUERY",
    query
  ].join("\u001f");
}

function trimQueryEmbeddingCache() {
  while (queryEmbeddingCache.size > queryEmbeddingCacheMaxEntries) {
    const oldestKey = queryEmbeddingCache.keys().next().value;

    if (!oldestKey) {
      return;
    }

    queryEmbeddingCache.delete(oldestKey);
  }
}

async function getVectorMaterialCandidates({
  classId,
  limit,
  materialId,
  professorId,
  queryVector,
  timings
}: {
  classId: string;
  limit: number;
  materialId?: string;
  professorId: string;
  queryVector: number[];
  timings?: Partial<CourseRetrievalTimings>;
}) {
  if (!adminDb) {
    return [];
  }
  const db = adminDb;

  try {
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

    const vectorSearchStartedAt = performance.now();
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
    if (timings) {
      timings.vectorSearchMs = elapsedMs(vectorSearchStartedAt);
    }

    const vectorCandidateBuildStartedAt = performance.now();
    const candidates = await Promise.all(
      snapshot.docs.map(async (chunkDoc) => {
        const chunkData = chunkDoc.data();
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

        if (readProfessorId(chunkData) !== professorId) {
          return null;
        }

        const chunk = normalizeChunk({
          chunkData,
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

    const filteredCandidates = candidates.filter(
      (candidate): candidate is NonNullable<(typeof candidates)[number]> => candidate !== null
    );
    if (timings) {
      timings.vectorCandidateBuildMs = elapsedMs(vectorCandidateBuildStartedAt);
      timings.vectorCandidateCount = filteredCandidates.length;
      timings.vectorMaterialReadCount = materialDocumentCache.size;
    }

    return filteredCandidates;
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

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
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

function deduplicateCandidates(candidates: ReturnType<typeof toCandidates>) {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = [candidate.document.id, candidate.chunk.id].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
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

async function getExactLookupChunkCandidates({
  classId,
  locators,
  professorId,
  timings
}: {
  classId: string;
  locators: ReturnType<typeof exactLookupLocatorsFromText>;
  professorId: string;
  timings?: Partial<CourseRetrievalTimings>;
}) {
  if (!adminDb) {
    return [];
  }
  const db = adminDb;

  const searchSpecs = [
    { field: "problemNumbers", values: locators.problemNumbers.slice(0, 30) },
    { field: "sectionMarkers", values: locators.sectionMarkers.slice(0, 30) },
    { field: "pageNumbers", values: locators.pageNumbers.slice(0, 30) }
  ].filter((spec) => spec.values.length > 0);

  if (!searchSpecs.length) {
    return [];
  }

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

  try {
    const snapshots = await Promise.all(
      searchSpecs.map((spec) =>
        db
          .collectionGroup("chunks")
          .where("professorId", "==", professorId)
          .where("classId", "==", classId)
          .where(spec.field, "array-contains-any", spec.values)
          .limit(exactLookupChunkQueryLimit)
          .get()
          .catch((caughtError) => {
            console.warn(`Exact lookup chunk query failed for ${spec.field}.`, caughtError);
            return null;
          })
      )
    );
    const chunkDocs = snapshots.flatMap((snapshot) => snapshot?.docs ?? []);
    const candidates = await Promise.all(
      chunkDocs.map(async (chunkDoc) => {
        const materialRef = chunkDoc.ref.parent.parent;

        if (!materialRef) {
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

        const chunkData = chunkDoc.data();

        if (readProfessorId(chunkData) !== professorId) {
          return null;
        }

        const chunk = normalizeChunk({
          chunkData,
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
    const filteredCandidates = candidates.filter(
      (candidate): candidate is NonNullable<(typeof candidates)[number]> => candidate !== null
    );
    const deduplicatedCandidates = deduplicateCandidates(filteredCandidates);

    if (timings) {
      timings.exactLookupChunkCount = deduplicatedCandidates.length;
      timings.exactLookupMaterialReadCount = materialDocumentCache.size;
    }

    return deduplicatedCandidates.slice(0, exactLookupChunkQueryLimit);
  } catch (caughtError) {
    console.warn("Targeted exact lookup failed. Continuing with vector candidates.", caughtError);
    return [];
  }
}

function exactLookupReason(locators: ReturnType<typeof exactLookupLocatorsFromText>) {
  return [
    locators.problemNumbers.length ? "problemNumbers" : "",
    locators.sectionMarkers.length ? "sectionMarkers" : "",
    locators.pageNumbers.length ? "pageNumbers" : ""
  ].filter(Boolean).join(",") || "none";
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

      const teacherId = readProfessorId(material);

      if (!isStudentVisibleReadyMaterial(material) || teacherId !== professorId) {
        return null;
      }

      const chunksSnapshot = await materialDoc.ref.collection("chunks").get();
      const materialType = materialTypeForKind(String(material.materialType ?? material.kind ?? "notes"));
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
              materialType,
              teacherId,
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
    filePath: readOptionalString(material.filePath),
    fileUrl: readOptionalString(material.fileUrl),
    pageAssetPrefix: readOptionalString(material.pageAssetPrefix ?? material.page_asset_prefix),
    pageAssetStorageBucket: readOptionalString(
      material.pageAssetStorageBucket
        ?? material.page_asset_storage_bucket
        ?? material.storageBucket
    ),
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
  const rawPageStart = readOptionalNumber(chunkData.pageStart ?? chunkData.page_start ?? chunkData.pageNumber);
  const rawPageEnd = readOptionalNumber(chunkData.pageEnd ?? chunkData.page_end ?? rawPageStart);
  const pageStart = rawPageStart && rawPageEnd ? Math.min(rawPageStart, rawPageEnd) : rawPageStart;
  const pageEnd = rawPageStart && rawPageEnd ? Math.max(rawPageStart, rawPageEnd) : rawPageEnd;
  const pageNumber = pageStart ?? readOptionalNumber(chunkData.pageNumber);
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
    pageAssetPrefix: readOptionalString(chunkData.pageAssetPrefix ?? chunkData.page_asset_prefix),
    pageAssetStorageBucket: readOptionalString(
      chunkData.pageAssetStorageBucket
        ?? chunkData.page_asset_storage_bucket
    ),
    pageEnd,
    pageNumber,
    pageNumbers: readNumberArray(chunkData.pageNumbers),
    pageStart,
    problemNumbers,
    professorId: readProfessorId(chunkData) || teacherId,
    professorName: readOptionalString(chunkData.professorName ?? chunkData.professor_name),
    sectionHeading: readOptionalString(chunkData.sectionHeading ?? chunkData.section),
    sectionMarkers: readStringArray(chunkData.sectionMarkers),
    sourceType: readOptionalSourceType(chunkData.sourceType ?? chunkData.source_type),
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

function readNumberArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const numbers = value.map(Number).filter((numberValue) => Number.isFinite(numberValue) && numberValue > 0);
  return numbers.length ? numbers : undefined;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.map((item) => String(item).trim()).filter(Boolean);
  return values.length ? values : undefined;
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

function readOptionalSourceType(value: unknown): SourceChunk["sourceType"] {
  const text = String(value ?? "").trim();

  return text === "text" || text === "page-image" || text === "mixed" || text === "pasted"
    ? text
    : undefined;
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
