import { randomUUID } from "crypto";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { PDFParse } from "pdf-parse";
import { PDFDocument } from "pdf-lib";
import { adminAuth, adminDb, adminStorage, assertFirebaseAdminReady } from "./firebase-admin";
import { attachPdfSlicesToChunks } from "./pdf-embedding-chunks";
import {
  classifyTutorKnowledgePage,
  chunkTutorKnowledgePages,
  chunkTutorKnowledgeText,
  getTutorKnowledgeSourceMode,
  isTutorKnowledgeKind,
  supportedTutorKnowledgeExtensions,
  type TutorKnowledgeChunk,
  type TutorKnowledgePage
} from "./tutor-knowledge";
import { TutorKnowledgeHttpError } from "./tutor-knowledge-errors";
import { materialTypeForKind, problemNumbersFromText } from "./retrieval-ranking";
import type { TutorKnowledgePriority } from "./types";
import {
  VertexEmbeddingError,
  createVertexEmbedding,
  createVertexEmbeddings,
  isVertexEmbeddingConfigured,
  type VertexEmbeddingResult
} from "./vertex-embeddings";

export type TutorKnowledgePreview = {
  extractedCharacterCount: number;
  pastedCharacterCount: number;
  totalCharacterCount: number;
  chunkCount: number;
  previewText: string;
  sourceMode: "file" | "pasted" | "file-and-pasted";
  fileName: string;
  contentType: string;
  fileSize: number;
  pageCount: number;
  visualPageCount: number;
};

const supportedContentTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/csv",
  "text/x-markdown"
]);
const embeddingConcurrencyLimit = 4;

export { TutorKnowledgeHttpError } from "./tutor-knowledge-errors";

type MaterialJobStep =
  | "upload_received"
  | "reading_file"
  | "chunking_material"
  | "embedding_chunks"
  | "saving_to_class"
  | "ready"
  | "failed";

type MaterialJobProgressUpdate = {
  completedChunks?: number;
  detail: string;
  error?: string;
  percent: number;
  step: MaterialJobStep;
  totalChunks?: number;
};

export type TutorKnowledgeSourceSettings = {
  activeForStudents: boolean;
  priority: TutorKnowledgePriority;
  requireCitations: boolean;
  teacherOnly: boolean;
};

export type TutorKnowledgeDetailChunk = {
  id: string;
  excerpt: string;
  label: string;
  pageEnd?: number | null;
  pageStart?: number | null;
  problemNumbers: string[];
  sectionHeading: string;
};

export type TutorKnowledgeDetails = {
  materialId: string;
  relatedTopics: string[];
  sampleChunks: TutorKnowledgeDetailChunk[];
};

export async function authorizeClassTeacher(request: Request, classId: string) {
  const token = getBearerToken(request);

  if (!token) {
    throw new TutorKnowledgeHttpError("Sign in as the class teacher to manage tutor knowledge.", 401);
  }

  assertFirebaseAdminReady();

  const decodedToken = await adminAuth!.verifyIdToken(token);
  const classSnapshot = await adminDb!.collection("classes").doc(classId).get();

  if (!classSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Class not found.", 404);
  }

  if (classSnapshot.data()?.teacherId !== decodedToken.uid) {
    throw new TutorKnowledgeHttpError("Only the class teacher can manage tutor knowledge.", 403);
  }

  return { classSnapshot, uid: decodedToken.uid };
}

export async function buildTutorKnowledgePreview(formData: FormData): Promise<TutorKnowledgePreview> {
  const file = readOptionalFile(formData);
  const pastedText = String(formData.get("text") ?? "").trim();

  if (!file && !pastedText) {
    throw new TutorKnowledgeHttpError("Add a supported file or paste tutor knowledge text before previewing.", 400);
  }

  const ingestion = await buildTutorKnowledgeIngestion({
    docId: "preview",
    file,
    pastedText,
    title: file?.name ?? "Pasted tutor knowledge"
  });
  const searchableText = ingestion.searchableText;

  if (!searchableText && !ingestion.chunks.length) {
    throw new TutorKnowledgeHttpError("No tutor knowledge text was found. This file may be scanned or image-only.", 400);
  }

  return {
    extractedCharacterCount: ingestion.extractedText.trim().length,
    pastedCharacterCount: pastedText.length,
    totalCharacterCount: searchableText.length,
    chunkCount: ingestion.chunks.length,
    previewText: searchableText.slice(0, 1800),
    sourceMode: getTutorKnowledgeSourceMode({
      hasFile: Boolean(file),
      hasPastedText: Boolean(pastedText)
    }),
    fileName: file?.name ?? "",
    contentType: file?.type ?? "",
    fileSize: file?.size ?? 0,
    pageCount: ingestion.pageCount,
    visualPageCount: ingestion.visualPageCount
  };
}

export async function saveTutorKnowledge({
  classId,
  formData,
  jobId,
  professorName,
  teacherId
}: {
  classId: string;
  formData: FormData;
  jobId?: string;
  professorName?: string;
  teacherId: string;
}) {
  const title = String(formData.get("title") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const file = readOptionalFile(formData);
  const pastedText = String(formData.get("text") ?? "").trim();

  if (!title) {
    throw new TutorKnowledgeHttpError("Add a title before saving tutor knowledge.", 400);
  }

  if (!isTutorKnowledgeKind(kind)) {
    throw new TutorKnowledgeHttpError("Choose a valid tutor knowledge type.", 400);
  }

  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc();
  const updateProgress = createMaterialJobProgressWriter({
    classId,
    jobId,
    materialId: materialRef.id,
    teacherId,
    title
  });

  await updateProgress({
    detail: "Upload received. Starting server-side processing.",
    percent: 15,
    step: "upload_received"
  });
  const ingestion = await buildTutorKnowledgeIngestion({
    docId: materialRef.id,
    file,
    pastedText,
    title,
    updateProgress
  });
  const searchableText = ingestion.searchableText;
  const chunks = ingestion.chunks;
  let fileMetadata = {};

  try {
    fileMetadata = file ? await uploadTutorKnowledgeFile({ classId, file, materialId: materialRef.id }) : {};
  } catch (caughtError) {
    await updateProgress({
      detail: "Tutor knowledge processing failed before it was ready.",
      error: caughtError instanceof Error ? caughtError.message : String(caughtError),
      percent: 100,
      step: "failed"
    });
    throw caughtError;
  }

  const materialType = materialTypeForKind(kind);
  const sourceSettings = defaultSourceSettingsForKind(kind);

  await materialRef.set({
    classId,
    class_id: classId,
    course_id: classId,
    title,
    kind,
    materialType,
    professorId: teacherId,
    professorName: professorName ?? "",
    professor_id: teacherId,
    professor_name: professorName ?? "",
    teacherId,
    activeForStudents: sourceSettings.activeForStudents,
    citationsRequired: sourceSettings.requireCitations,
    priority: sourceSettings.priority,
    requireCitations: sourceSettings.requireCitations,
    studentVisible: sourceSettings.activeForStudents,
    teacherOnly: sourceSettings.teacherOnly,
    visibility: sourceSettings.teacherOnly
      ? "teacher-only"
      : sourceSettings.activeForStudents
        ? "student-visible"
        : "hidden",
    ...fileMetadata,
    characterCount: searchableText.length,
    chunkCount: chunks.length,
    embeddingProvider: "vertex-ai",
    embeddingStatus: isVertexEmbeddingConfigured() ? "processing" : "not-configured",
    status: "processing",
    addedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    pageCount: ingestion.pageCount,
    sourceMode: getTutorKnowledgeSourceMode({
      hasFile: Boolean(file),
      hasPastedText: Boolean(pastedText)
    }),
    ...(pastedText ? { textSource: pastedText } : {}),
    visualPageCount: ingestion.visualPageCount
  });

  try {
    await writeChunks({
      classId,
      chunks,
      materialId: materialRef.id,
      materialType,
      onEmbeddingProgress: async ({ completed, total }) => {
        await updateProgress({
          completedChunks: completed,
          detail: `Calling Gemini embeddings for chunk ${completed} of ${total}.`,
          percent: Math.min(90, 50 + Math.round((completed / Math.max(total, 1)) * 40)),
          step: "embedding_chunks",
          totalChunks: total
        });
      },
      professorName,
      teacherId,
      title
    });

    await updateProgress({
      completedChunks: chunks.length,
      detail: "Saving vectors, source metadata, and class visibility.",
      percent: 95,
      step: "saving_to_class",
      totalChunks: chunks.length
    });
    await materialRef.update({
      embeddingStatus: isVertexEmbeddingConfigured() ? "ready" : "not-configured",
      indexedAt: FieldValue.serverTimestamp(),
      status: "ready"
    });
    await updateProgress({
      completedChunks: chunks.length,
      detail: "Tutor knowledge is ready for students in this class.",
      percent: 100,
      step: "ready",
      totalChunks: chunks.length
    });
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      await writeChunks({
        classId,
        chunks,
        materialId: materialRef.id,
        materialType,
        professorName,
        skipEmbeddings: true,
        teacherId,
        title
      });
      await materialRef.update(buildEmbeddingFailureMaterialMetadata(caughtError));
      await updateProgress({
        completedChunks: 0,
        detail: "Gemini embeddings failed. The source was not saved for student use.",
        error: caughtError.cause instanceof Error ? caughtError.cause.message : caughtError.message,
        percent: 100,
        step: "failed",
        totalChunks: chunks.length
      });
      const embeddingFailureDetail =
        caughtError.cause instanceof Error ? caughtError.cause.message : caughtError.message;
      throw new TutorKnowledgeHttpError(
        `Gemini embeddings failed: ${embeddingFailureDetail}`,
        502
      );
    }

    await updateProgress({
      detail: "Tutor knowledge processing failed before it was ready.",
      error: caughtError instanceof Error ? caughtError.message : String(caughtError),
      percent: 100,
      step: "failed"
    });
    throw caughtError;
  }

  return {
    id: materialRef.id,
    characterCount: searchableText.length,
    chunkCount: chunks.length
  };
}

export async function deleteTutorKnowledge({
  classId,
  materialId
}: {
  classId: string;
  materialId: string;
}) {
  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc(materialId);
  const materialSnapshot = await materialRef.get();

  if (!materialSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const filePath = String(materialSnapshot.data()?.filePath ?? "");

  if (filePath) {
    await adminStorage!.bucket().file(filePath).delete({ ignoreNotFound: true });
  }

  const chunksSnapshot = await materialRef.collection("chunks").get();
  await deleteDocumentsInBatches(chunksSnapshot.docs.map((chunkDoc) => chunkDoc.ref));
  await materialRef.delete();
}

export async function updateTutorKnowledgeSettings({
  classId,
  materialId,
  settings
}: {
  classId: string;
  materialId: string;
  settings: Partial<TutorKnowledgeSourceSettings>;
}) {
  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc(materialId);
  const materialSnapshot = await materialRef.get();

  if (!materialSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const currentSettings = sourceSettingsFromMaterial(materialSnapshot.data() ?? {});
  const normalizedSettings = normalizeTutorKnowledgeSourceSettings({
    ...currentSettings,
    ...settings
  });

  await materialRef.update({
    activeForStudents: normalizedSettings.activeForStudents,
    citationsRequired: normalizedSettings.requireCitations,
    priority: normalizedSettings.priority,
    requireCitations: normalizedSettings.requireCitations,
    studentVisible: normalizedSettings.activeForStudents,
    teacherOnly: normalizedSettings.teacherOnly,
    updatedAt: FieldValue.serverTimestamp(),
    visibility: normalizedSettings.teacherOnly
      ? "teacher-only"
      : normalizedSettings.activeForStudents
        ? "student-visible"
        : "hidden"
  });

  return {
    id: materialId,
    ...normalizedSettings
  };
}

export async function getTutorKnowledgeDetails({
  classId,
  materialId
}: {
  classId: string;
  materialId: string;
}): Promise<TutorKnowledgeDetails> {
  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc(materialId);
  const materialSnapshot = await materialRef.get();

  if (!materialSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const chunksSnapshot = await materialRef.collection("chunks").orderBy("chunkIndex").limit(500).get().catch(() =>
    materialRef.collection("chunks").orderBy("order").limit(500).get()
  );
  const chunks = chunksSnapshot.docs.map((chunkDoc) => {
    const chunk = chunkDoc.data();
    const excerpt = String(chunk.excerpt ?? chunk.chunk_text ?? chunk.chunkText ?? chunk.content ?? "").trim();
    const sectionHeading = String(chunk.sectionHeading ?? chunk.section ?? "").trim();

    return {
      id: chunkDoc.id,
      excerpt,
      label: String(chunk.label ?? `Chunk ${Number(chunk.chunkIndex ?? 0) + 1}`).trim(),
      pageEnd: readOptionalNumber(chunk.pageEnd ?? chunk.page_end),
      pageStart: readOptionalNumber(chunk.pageStart ?? chunk.page_start ?? chunk.pageNumber),
      problemNumbers: readProblemNumbers(chunk.problemNumbers),
      sectionHeading
    };
  });

  return {
    materialId,
    relatedTopics: detectRelatedTopics(chunks, materialSnapshot.data() ?? {}),
    sampleChunks: chunks.filter((chunk) => chunk.excerpt).slice(0, 4)
  };
}

export async function reprocessTutorKnowledge({
  classId,
  materialId,
  teacherId
}: {
  classId: string;
  materialId: string;
  teacherId: string;
}) {
  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc(materialId);
  const materialSnapshot = await materialRef.get();

  if (!materialSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const material = materialSnapshot.data() ?? {};
  const title = String(material.title ?? "").trim() || "Tutor knowledge";
  const kind = String(material.kind ?? "").trim();
  const professorName = String(material.professorName ?? material.professor_name ?? "").trim();
  const file = await readStoredMaterialFile(material);
  const textSource = String(material.textSource ?? "").trim();
  const fallbackText = file ? "" : await readExistingChunkText(materialRef);

  if (!isTutorKnowledgeKind(kind)) {
    throw new TutorKnowledgeHttpError("Tutor knowledge has an invalid source type.", 400);
  }

  if (!file && !textSource && !fallbackText) {
    throw new TutorKnowledgeHttpError("No original source content is available to reprocess.", 400);
  }

  const ingestion = await buildTutorKnowledgeIngestion({
    docId: materialId,
    file,
    pastedText: textSource || fallbackText,
    title
  });
  const chunks = ingestion.chunks;
  const materialType = materialTypeForKind(kind);

  await materialRef.update({
    characterCount: ingestion.searchableText.length,
    chunkCount: chunks.length,
    embeddingStatus: isVertexEmbeddingConfigured() ? "processing" : "not-configured",
    pageCount: ingestion.pageCount,
    reprocessedAt: FieldValue.serverTimestamp(),
    status: "processing",
    visualPageCount: ingestion.visualPageCount
  });

  const existingChunksSnapshot = await materialRef.collection("chunks").get();
  await deleteDocumentsInBatches(existingChunksSnapshot.docs.map((chunkDoc) => chunkDoc.ref));

  try {
    await writeChunks({
      classId,
      chunks,
      materialId,
      materialType,
      professorName,
      teacherId,
      title
    });

    await materialRef.update({
      embeddingStatus: isVertexEmbeddingConfigured() ? "ready" : "not-configured",
      indexedAt: FieldValue.serverTimestamp(),
      status: "ready"
    });
  } catch (caughtError) {
    if (caughtError instanceof VertexEmbeddingError) {
      await writeChunks({
        classId,
        chunks,
        materialId,
        materialType,
        professorName,
        skipEmbeddings: true,
        teacherId,
        title
      });
      await materialRef.update(buildEmbeddingFailureMaterialMetadata(caughtError));
      throw new TutorKnowledgeHttpError(`Gemini embeddings failed: ${caughtError.message}`, 502);
    }

    throw caughtError;
  }

  return {
    id: materialId,
    characterCount: ingestion.searchableText.length,
    chunkCount: chunks.length
  };
}

async function uploadTutorKnowledgeFile({
  classId,
  file,
  materialId
}: {
  classId: string;
  file: File;
  materialId: string;
}) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const safeFileName = sanitizeFileName(file.name);
  const filePath = `classes/${classId}/materials/${materialId}/original/${safeFileName}`;
  const downloadToken = randomUUID();
  const storageFile = adminStorage!.bucket().file(filePath);

  try {
    await storageFile.save(buffer, {
      contentType: file.type || contentTypeFromFileName(file.name),
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: downloadToken
        }
      },
      resumable: false
    });
  } catch (caughtError) {
    console.error("Tutor knowledge original file upload failed.", caughtError);

    throw new TutorKnowledgeHttpError(
      caughtError instanceof Error
        ? `Original PDF file could not be saved: ${caughtError.message}`
        : "Original PDF file could not be saved.",
      502
    );
  }

  const bucketName = adminStorage!.bucket().name;
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return {
    fileName: file.name,
    filePath,
    fileUrl: `https://storage.googleapis.com/${bucketName}/${encodedPath}`,
    contentType: file.type || contentTypeFromFileName(file.name),
    fileSize: file.size
  };
}

function defaultSourceSettingsForKind(kind: string): TutorKnowledgeSourceSettings {
  const materialType = materialTypeForKind(kind);
  const teacherOnly = materialType === "practice-solutions";

  return {
    activeForStudents: !teacherOnly,
    priority: materialType === "assignment" || materialType === "practice-problems" || materialType === "reading"
      ? "primary"
      : "normal",
    requireCitations: true,
    teacherOnly
  };
}

function sourceSettingsFromMaterial(material: Record<string, unknown>): TutorKnowledgeSourceSettings {
  const defaultSettings = defaultSourceSettingsForKind(String(material.kind ?? material.materialType ?? ""));

  return {
    activeForStudents: readBooleanWithDefault(
      material.activeForStudents ?? material.studentVisible,
      defaultSettings.activeForStudents
    ),
    priority: isTutorKnowledgePriority(material.priority) ? material.priority : defaultSettings.priority,
    requireCitations: readBooleanWithDefault(
      material.requireCitations ?? material.citationsRequired,
      defaultSettings.requireCitations
    ),
    teacherOnly: readBooleanWithDefault(material.teacherOnly, defaultSettings.teacherOnly)
  };
}

function normalizeTutorKnowledgeSourceSettings(settings: TutorKnowledgeSourceSettings): TutorKnowledgeSourceSettings {
  return {
    activeForStudents: Boolean(settings.activeForStudents) && !settings.teacherOnly,
    priority: isTutorKnowledgePriority(settings.priority) ? settings.priority : "normal",
    requireCitations: Boolean(settings.requireCitations),
    teacherOnly: Boolean(settings.teacherOnly)
  };
}

function isTutorKnowledgePriority(value: unknown): value is TutorKnowledgePriority {
  return value === "primary" || value === "normal" || value === "low";
}

function readBooleanWithDefault(value: unknown, defaultValue: boolean) {
  return typeof value === "boolean" ? value : defaultValue;
}

function readOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

function readProblemNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 6);
}

function detectRelatedTopics(
  chunks: Array<Pick<TutorKnowledgeDetailChunk, "label" | "problemNumbers" | "sectionHeading">>,
  material: Record<string, unknown>
) {
  const topicCounts = new Map<string, number>();

  addTopicCandidate(topicCounts, String(material.kind ?? ""));
  addTopicCandidate(topicCounts, String(material.materialType ?? ""));

  for (const chunk of chunks) {
    addTopicCandidate(topicCounts, chunk.sectionHeading);

    for (const problemNumber of chunk.problemNumbers.slice(0, 3)) {
      addTopicCandidate(topicCounts, `Problem ${problemNumber}`);
    }

    if (!chunk.sectionHeading) {
      addTopicCandidate(topicCounts, chunk.label);
    }
  }

  return Array.from(topicCounts.entries())
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([topic]) => topic)
    .slice(0, 8);
}

function addTopicCandidate(topicCounts: Map<string, number>, value: string) {
  const topic = normalizeTopicCandidate(value);

  if (!topic) {
    return;
  }

  topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
}

function normalizeTopicCandidate(value: string) {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/^uploaded excerpt$/i, "")
    .replace(/^knowledge chunk \d+$/i, "")
    .replace(/^pasted tutor knowledge chunk \d+$/i, "")
    .trim();

  if (!normalized || normalized.length < 3 || normalized.length > 72) {
    return "";
  }

  return normalized
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readStoredMaterialFile(material: Record<string, unknown>) {
  const filePath = String(material.filePath ?? "").trim();
  const fileName = String(material.fileName ?? "source").trim() || "source";

  if (!filePath) {
    return null;
  }

  const [buffer] = await adminStorage!.bucket().file(filePath).download();
  const fileBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return new File([fileBytes], fileName, {
    type: String(material.contentType ?? "") || contentTypeFromFileName(fileName)
  });
}

async function readExistingChunkText(
  materialRef: DocumentReference
) {
  const chunksSnapshot = await materialRef.collection("chunks").orderBy("chunkIndex").get().catch(() =>
    materialRef.collection("chunks").orderBy("order").get()
  );

  return chunksSnapshot.docs
    .map((chunkDoc) => String(chunkDoc.data().chunk_text ?? chunkDoc.data().content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

async function buildTutorKnowledgeIngestion({
  docId,
  file,
  pastedText,
  title,
  updateProgress
}: {
  docId: string;
  file: File | null;
  pastedText: string;
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  await updateProgress?.({
    detail: file
      ? "Reading the uploaded file and extracting usable text."
      : "Reading pasted tutor knowledge text.",
    percent: 25,
    step: "reading_file"
  });
  const fileIngestion = file
    ? await extractChunksFromFile({
        docId,
        file,
        title
      })
    : {
        chunks: [] as TutorKnowledgeChunk[],
        extractedText: "",
        pageCount: 0,
        visualPageCount: 0
      };
  const pastedChunks = pastedText
    ? chunkTutorKnowledgeText(pastedText, {
        docId,
        labelPrefix: "Pasted tutor knowledge chunk",
        sourceType: "pasted",
        title
      })
    : [];
  const chunks = [...fileIngestion.chunks, ...pastedChunks].map((chunk, order) => ({
    ...chunk,
    order
  }));
  const searchableText = [fileIngestion.extractedText, pastedText].filter((text) => text.trim()).join("\n\n").trim();

  await updateProgress?.({
    detail: `Built ${chunks.length} tutor knowledge chunk${chunks.length === 1 ? "" : "s"} for this class.`,
    percent: 50,
    step: "chunking_material",
    totalChunks: chunks.length
  });

  return {
    chunks,
    extractedText: fileIngestion.extractedText,
    pageCount: fileIngestion.pageCount,
    searchableText,
    visualPageCount: fileIngestion.visualPageCount
  };
}

async function extractChunksFromFile({
  docId,
  file,
  title
}: {
  docId: string;
  file: File;
  title: string;
}) {
  validateFile(file);
  const buffer = Buffer.from(await file.arrayBuffer());

  if (!isPdfFile(file)) {
    const extractedText = buffer.toString("utf8").trim();
    return {
      chunks: chunkTutorKnowledgeText(extractedText, {
        docId,
        sourceType: "text",
        title
      }),
      extractedText,
      pageCount: 0,
      visualPageCount: 0
    };
  }

  const pages = await extractPdfPages(buffer);
  const chunks = chunkTutorKnowledgePages({
    docId,
    pages,
    title
  });

  return {
    chunks: await attachPdfSlicesToChunks({
      chunks,
      pdfBytes: buffer
    }),
    extractedText: pages.map((page) => page.text.trim()).filter(Boolean).join("\n\n"),
    pageCount: pages.length,
    visualPageCount: pages.filter((page) => classifyTutorKnowledgePage(page) !== "text-heavy").length
  };
}

async function extractPdfPages(buffer: Buffer): Promise<TutorKnowledgePage[]> {
  const pageInfoByNumberPromise = extractPdfPageInfo(buffer);
  let pages = await extractPdfTextPages(buffer, { lineEnforce: true }).catch(() =>
    extractPdfTextPages(buffer, { lineEnforce: false }).catch(async () =>
      visualPdfPagesFromPageInfo(await pageInfoByNumberPromise)
    )
  );
  const pageInfoByNumber = await pageInfoByNumberPromise;

  if (!pages.length) {
    pages = visualPdfPagesFromPageInfo(pageInfoByNumber);
  }

  if (!pages.length) {
    throw new TutorKnowledgeHttpError(
      "We could not inspect this PDF. Try a non-password-protected PDF or paste the content manually.",
      400
    );
  }

  return pages.map((page) => {
    const text = page.text.trim();
    const pageInfo = pageInfoByNumber.get(page.num);
    const pageArea = pageInfo?.area ?? 0;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length >= 3).length;

    return {
      metrics: {
        embeddedImageCount: 0,
        imageCoverageRatio: text ? 0 : 1,
        lineCount,
        pageArea,
        textDensity: pageArea ? wordCount / pageArea : 0
      },
      isVisual: !text,
      pageNumber: page.num,
      text
    };
  });
}

async function extractPdfTextPages(buffer: Buffer, options: { lineEnforce: boolean }) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText({
      lineEnforce: options.lineEnforce,
      pageJoiner: ""
    });

    return result.pages.map((page) => ({
      num: page.num,
      text: page.text
    }));
  } catch {
    throw new TutorKnowledgeHttpError(
      "We could not read this PDF. Try a non-password-protected PDF or paste the content manually.",
      400
    );
  } finally {
    await parser.destroy();
  }
}

async function extractPdfPageInfo(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const info = await parser.getInfo({ parsePageInfo: true });

    return new Map(
      (info.pages ?? []).map((page) => [
        page.pageNumber,
        {
          area: page.width * page.height,
          height: page.height,
          width: page.width
        }
      ])
    );
  } catch {
    return extractPdfPageInfoWithPdfLib(buffer);
  } finally {
    await parser.destroy();
  }
}

async function extractPdfPageInfoWithPdfLib(buffer: Buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });

    return new Map(
      pdf.getPages().map((page, index) => {
        const { height, width } = page.getSize();

        return [
          index + 1,
          {
            area: width * height,
            height,
            width
          }
        ];
      })
    );
  } catch {
    return new Map<number, { area: number; height: number; width: number }>();
  }
}

function visualPdfPagesFromPageInfo(pageInfoByNumber: Map<number, { area: number; height: number; width: number }>) {
  return Array.from(pageInfoByNumber.keys())
    .sort((first, second) => first - second)
    .map((num) => ({
      num,
      text: ""
    }));
}

function readOptionalFile(formData: FormData) {
  const file = formData.get("file");

  if (!file || !(file instanceof File) || !file.name) {
    return null;
  }

  validateFile(file);
  return file;
}

function validateFile(file: File) {
  const extension = getFileExtension(file.name);
  const supportedExtension = supportedTutorKnowledgeExtensions.some((item) => item === extension);
  const supportedContentType = !file.type || supportedContentTypes.has(file.type);

  if (!supportedExtension || !supportedContentType) {
    throw new TutorKnowledgeHttpError("Only PDF, TXT, MD, and CSV files are supported.", 400);
  }
}

async function writeChunks({
  classId,
  chunks,
  materialId,
  materialType,
  onEmbeddingProgress,
  professorName,
  skipEmbeddings = false,
  teacherId,
  title
}: {
  classId: string;
  chunks: TutorKnowledgeChunk[];
  materialId: string;
  materialType: string;
  onEmbeddingProgress?: (progress: { completed: number; total: number }) => Promise<void>;
  professorName?: string;
  skipEmbeddings?: boolean;
  teacherId: string;
  title: string;
}) {
  let completedEmbeddings = 0;
  const embeddings = skipEmbeddings
    ? []
    : await createVertexEmbeddings(
        chunks.map((chunk) => ({
          file: chunk.pdfPart ?? chunk.pageImage,
          taskType: "RETRIEVAL_DOCUMENT",
          text: chunk.content,
          title
        })),
        {
          onProgress: async ({ completed, total }) => {
            completedEmbeddings = completed;
            await onEmbeddingProgress?.({ completed, total });
          }
        }
      );

  const chunkRefs = await mapWithConcurrency(chunks, embeddingConcurrencyLimit, async (chunk, index) => {
    const chunkId = `chunk_${String(index + 1).padStart(4, "0")}`;
    const data = await prepareTutorKnowledgeChunkData({
      classId,
      chunk,
      chunkId,
      chunkIndex: index,
      embedding: embeddings[index],
      materialId,
      materialType,
      professorName,
      skipEmbedding: skipEmbeddings,
      teacherId,
      title
    });

    if (skipEmbeddings) {
      completedEmbeddings += 1;
      await onEmbeddingProgress?.({
        completed: completedEmbeddings,
        total: chunks.length
      });
    }

    return {
      data,
      ref: adminDb!
        .collection("classes")
        .doc(classId)
        .collection("materials")
        .doc(materialId)
        .collection("chunks")
        .doc(chunkId)
    };
  });

  for (let index = 0; index < chunkRefs.length; index += 450) {
    const batch = adminDb!.batch();

    chunkRefs.slice(index, index + 450).forEach((chunkRef) => {
      batch.set(chunkRef.ref, chunkRef.data);
    });

    await batch.commit();
  }
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrencyLimit: number,
  mapItem: (item: TItem, index: number) => Promise<TResult>
) {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrencyLimit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapItem(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

export async function prepareTutorKnowledgeChunkData({
  classId,
  chunk,
  chunkId,
  chunkIndex = chunk.order,
  createEmbedding = createVertexEmbedding,
  embedding,
  materialId,
  materialType,
  professorName,
  skipEmbedding = false,
  teacherId,
  title
}: {
  classId: string;
  chunk: TutorKnowledgeChunk;
  chunkId?: string;
  chunkIndex?: number;
  createEmbedding?: typeof createVertexEmbedding;
  embedding?: VertexEmbeddingResult;
  materialId: string;
  materialType: string;
  professorName?: string;
  skipEmbedding?: boolean;
  teacherId: string;
  title: string;
}) {
  const professorId = requireProfessorId(teacherId);
  const normalizedProfessorName = professorName?.trim() ?? "";
  const chunkEmbedding = embedding ?? (skipEmbedding
    ? undefined
    : await createEmbedding({
        file: chunk.pdfPart ?? chunk.pageImage,
        taskType: "RETRIEVAL_DOCUMENT",
        text: chunk.content,
        title
      }));
  const { pageImage: _pageImage, pdfPart: _pdfPart, ...storedChunk } = chunk;
  const pageNumber = chunk.pageStart ?? extractPageNumber(chunk.label);
  const sectionHeading = chunk.section ?? extractSectionHeading(chunk.content);

  return {
    ...storedChunk,
    classId,
    class_id: classId,
    chunkId: chunkId ?? "",
    chunkIndex,
    chunk_text: chunk.chunkText ?? chunk.content,
    course_id: classId,
    createdAt: FieldValue.serverTimestamp(),
    doc_id: chunk.docId ?? materialId,
    docId: chunk.docId ?? materialId,
    hasPageImage: Boolean(chunk.pageImage),
    hasPdfPart: Boolean(chunk.pdfPart),
    materialId,
    materialType,
    excerpt: buildChunkExcerpt(chunk.chunkText ?? chunk.content),
    page_end: chunk.pageEnd ?? pageNumber,
    page_start: chunk.pageStart ?? pageNumber,
    pageEnd: chunk.pageEnd ?? pageNumber,
    pageNumber,
    pageStart: chunk.pageStart ?? pageNumber,
    problemNumbers: problemNumbersFromText(`${chunk.label}\n${chunk.content}`),
    professorId,
    professorName: normalizedProfessorName,
    professor_id: professorId,
    professor_name: normalizedProfessorName,
    section: sectionHeading,
    sectionHeading,
    teacherId: professorId,
    title,
    ...buildChunkEmbeddingMetadata(chunkEmbedding)
  };
}

export function buildEmbeddingFailureMaterialMetadata(error: VertexEmbeddingError) {
  return {
    embeddingError: error.cause instanceof Error ? error.cause.message : error.message,
    embeddingFailedAt: FieldValue.serverTimestamp(),
    embeddingStatus: "failed",
    status: "needs-review"
  };
}

function createMaterialJobProgressWriter({
  classId,
  jobId,
  materialId,
  teacherId,
  title
}: {
  classId: string;
  jobId?: string;
  materialId: string;
  teacherId: string;
  title: string;
}): (progress: MaterialJobProgressUpdate) => Promise<void> {
  const normalizedJobId = jobId?.trim() ?? "";

  if (!normalizedJobId) {
    return async () => {};
  }

  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(normalizedJobId)) {
    throw new TutorKnowledgeHttpError("Invalid tutor knowledge progress job id.", 400);
  }

  const jobRef = adminDb!.collection("classes").doc(classId).collection("materialJobs").doc(normalizedJobId);

  return async (progress: MaterialJobProgressUpdate) => {
    await jobRef.set(
      {
        classId,
        completedChunks: progress.completedChunks ?? null,
        detail: progress.detail,
        error: progress.error ?? null,
        materialId,
        percent: Math.max(0, Math.min(100, progress.percent)),
        professorId: teacherId,
        step: progress.step,
        title,
        totalChunks: progress.totalChunks ?? null,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  };
}

function buildChunkEmbeddingMetadata(embedding: VertexEmbeddingResult | undefined) {
  if (!embedding?.values.length) {
    return {};
  }

  return {
    embedding: FieldValue.vector(embedding.values),
    embeddingCreatedAt: FieldValue.serverTimestamp(),
    embeddingDimensions: embedding.dimensions,
    embeddingModel: embedding.model,
    embeddingProvider: embedding.provider,
    embeddingTaskType: embedding.taskType
  };
}

function buildChunkExcerpt(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();

  return normalized.length > 260 ? `${normalized.slice(0, 257).trimEnd()}...` : normalized;
}

function requireProfessorId(professorId: string) {
  const normalizedProfessorId = professorId.trim();

  if (!normalizedProfessorId) {
    throw new TutorKnowledgeHttpError("Embedded tutor knowledge requires professor_id metadata.", 400);
  }

  return normalizedProfessorId;
}

function extractPageNumber(label: string) {
  const match = label.match(/\bpage\s+(\d{1,4})\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function extractSectionHeading(content: string) {
  const [firstSentence] = content.split(/(?<=[.!?])\s+/);
  const heading = firstSentence?.trim() ?? "";

  if (!heading || heading.length > 90) {
    return "";
  }

  return heading;
}

async function deleteDocumentsInBatches(
  refs: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>[]
) {
  for (let index = 0; index < refs.length; index += 450) {
    const batch = adminDb!.batch();

    refs.slice(index, index + 450).forEach((ref) => {
      batch.delete(ref);
    });

    await batch.commit();
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || getFileExtension(file.name) === ".pdf";
}

function contentTypeFromFileName(fileName: string) {
  const extension = getFileExtension(fileName);

  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".md") {
    return "text/markdown";
  }

  if (extension === ".csv") {
    return "text/csv";
  }

  return "text/plain";
}

function sanitizeFileName(fileName: string) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "tutor-knowledge-file";
}
