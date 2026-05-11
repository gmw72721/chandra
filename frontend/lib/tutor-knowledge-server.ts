import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { GoogleAuth, type JWTInput } from "google-auth-library";
import { isIP } from "net";
import { PDFDocument } from "pdf-lib";
import { adminAuth, adminDb, adminStorage, assertFirebaseAdminReady } from "./firebase-admin";
import { sourceDefaultsForMaterialKind } from "./class-settings";
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
import { materialTypeForKind, problemNumbersFromText, sectionMarkersFromText } from "./retrieval-ranking";
import type { TutorKnowledgePriority } from "./types";
import {
  VertexEmbeddingError,
  createVertexEmbedding,
  createVertexEmbeddings,
  isVertexEmbeddingConfigured,
  type VertexEmbeddingPart,
  type VertexEmbeddingResult
} from "./vertex-embeddings";
import { firebaseConfig } from "./firebase-config";

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

type TutorKnowledgeOriginalSource = {
  contentType: string;
  fileName: string;
  filePath?: string;
  fileSize: number;
  fileUrl?: string;
  originalSourceUrl?: string;
  sourceKind: "file" | "storage" | "url";
  sourceUrl?: string;
  storageBucket?: string;
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
const defaultPdfPageTranscriptionConcurrencyLimit = 3;
const defaultDocumentAiOcrProcessorId = "5d3fa32c2ebe2a90";
const documentAiOcrMaxAttempts = 6;
const defaultDocumentAiOcrPagesPerRequest = 15;
const maxDocumentAiOcrPagesPerRequest = 15;
const documentAiOcrPagesPerRequest = Math.min(
  maxDocumentAiOcrPagesPerRequest,
  readOptionalPositiveInteger(process.env.DOCUMENT_AI_OCR_PAGES_PER_REQUEST) ?? defaultDocumentAiOcrPagesPerRequest
);
const defaultDocumentAiOcrRequestsPerMinute = 60;
const documentAiOcrRequestIntervalMs = Math.ceil(
  60_000 / (readOptionalPositiveInteger(process.env.DOCUMENT_AI_OCR_REQUESTS_PER_MINUTE) ?? defaultDocumentAiOcrRequestsPerMinute)
);
let nextDocumentAiOcrRequestAt = 0;
const pdfPageProgressUpdateInterval = readOptionalPositiveInteger(process.env.PDF_PAGE_PROGRESS_UPDATE_INTERVAL) ?? 25;
const pdfPageTranscriptionConcurrencyLimit =
  readOptionalPositiveInteger(process.env.PDF_PAGE_TRANSCRIPTION_CONCURRENCY)
  ?? defaultPdfPageTranscriptionConcurrencyLimit;
const maxTutorKnowledgeFileBytes = 500 * 1024 * 1024;
const maxTutorKnowledgePastedTextCharacters = 250000;
const maxTutorKnowledgeUrlRedirects = 4;

export { TutorKnowledgeHttpError } from "./tutor-knowledge-errors";

class PdfJsDomMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  is2D = true;

  constructor(init?: string | number[] | Float32Array | Float64Array | PdfJsDomMatrix) {
    if (!init || typeof init === "string") {
      return;
    }

    const values = Array.from(init instanceof PdfJsDomMatrix ? init.toFloat64Array() : init);
    if (values.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = values;
    } else if (values.length >= 16) {
      this.a = values[0] ?? 1;
      this.b = values[1] ?? 0;
      this.c = values[4] ?? 0;
      this.d = values[5] ?? 1;
      this.e = values[12] ?? 0;
      this.f = values[13] ?? 0;
    }
  }

  get m11() {
    return this.a;
  }

  set m11(value: number) {
    this.a = value;
  }

  get m12() {
    return this.b;
  }

  set m12(value: number) {
    this.b = value;
  }

  get m21() {
    return this.c;
  }

  set m21(value: number) {
    this.c = value;
  }

  get m22() {
    return this.d;
  }

  set m22(value: number) {
    this.d = value;
  }

  get m41() {
    return this.e;
  }

  set m41(value: number) {
    this.e = value;
  }

  get m42() {
    return this.f;
  }

  set m42(value: number) {
    this.f = value;
  }

  multiply(other?: PdfJsDomMatrix | number[]) {
    return new PdfJsDomMatrix(this).multiplySelf(other);
  }

  multiplySelf(other?: PdfJsDomMatrix | number[]) {
    const matrix = new PdfJsDomMatrix(other);
    const a = this.a * matrix.a + this.c * matrix.b;
    const b = this.b * matrix.a + this.d * matrix.b;
    const c = this.a * matrix.c + this.c * matrix.d;
    const d = this.b * matrix.c + this.d * matrix.d;
    const e = this.a * matrix.e + this.c * matrix.f + this.e;
    const f = this.b * matrix.e + this.d * matrix.f + this.f;

    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;

    return this;
  }

  preMultiplySelf(other?: PdfJsDomMatrix | number[]) {
    const matrix = new PdfJsDomMatrix(other);
    return this.setMatrixValue(matrix.multiply(this).toFloat64Array());
  }

  translate(tx = 0, ty = 0) {
    return this.multiply(new PdfJsDomMatrix([1, 0, 0, 1, tx, ty]));
  }

  translateSelf(tx = 0, ty = 0) {
    return this.multiplySelf([1, 0, 0, 1, tx, ty]);
  }

  scale(scaleX = 1, scaleY = scaleX) {
    return this.multiply(new PdfJsDomMatrix([scaleX, 0, 0, scaleY, 0, 0]));
  }

  scaleSelf(scaleX = 1, scaleY = scaleX) {
    return this.multiplySelf([scaleX, 0, 0, scaleY, 0, 0]);
  }

  inverse() {
    return new PdfJsDomMatrix(this).invertSelf();
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) {
      this.a = Number.NaN;
      this.b = Number.NaN;
      this.c = Number.NaN;
      this.d = Number.NaN;
      this.e = Number.NaN;
      this.f = Number.NaN;
      return this;
    }

    const a = this.d / determinant;
    const b = -this.b / determinant;
    const c = -this.c / determinant;
    const d = this.a / determinant;
    const e = (this.c * this.f - this.d * this.e) / determinant;
    const f = (this.b * this.e - this.a * this.f) / determinant;

    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;

    return this;
  }

  setMatrixValue(transformList?: string | number[] | Float32Array | Float64Array) {
    const matrix = new PdfJsDomMatrix(transformList);
    this.a = matrix.a;
    this.b = matrix.b;
    this.c = matrix.c;
    this.d = matrix.d;
    this.e = matrix.e;
    this.f = matrix.f;
    return this;
  }

  toFloat32Array() {
    return Float32Array.from(this.toFloat64Array());
  }

  toFloat64Array() {
    return [this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1];
  }

  toString() {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

function ensurePdfJsDomGlobals() {
  const globalWithPdfJsDom = globalThis as Record<string, unknown>;

  globalWithPdfJsDom.DOMMatrix ??= PdfJsDomMatrix;
}

export function validateTutorKnowledgeFile(file: File) {
  validateFile(file);
}

export function assertTutorKnowledgeTextWithinLimit(text: string, label = "Tutor knowledge text") {
  if (text.length > maxTutorKnowledgePastedTextCharacters) {
    throw new TutorKnowledgeHttpError(
      `${label} is too large. Keep pasted text under ${maxTutorKnowledgePastedTextCharacters.toLocaleString()} characters.`,
      413
    );
  }
}

type MaterialJobStep =
  | "upload_received"
  | "reading_file"
  | "chunking_material"
  | "preparing_pdf_pages"
  | "reading_pdf_pages"
  | "embedding_chunks"
  | "saving_to_class"
  | "deleting_source"
  | "deleting_storage"
  | "deleting_chunks"
  | "deleting_material"
  | "ready"
  | "failed";

type MaterialJobProgressUpdate = {
  completedChunks?: number;
  completedPages?: number;
  detail: string;
  error?: string;
  percent: number;
  step: MaterialJobStep;
  totalChunks?: number;
  totalPages?: number;
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

  const classData = classSnapshot.data() ?? {};
  const coTeacherRole = readCoTeacherRole(classData.coTeachers, decodedToken.uid);

  if (classData.teacherId !== decodedToken.uid && coTeacherRole !== "owner" && coTeacherRole !== "co-teacher") {
    throw new TutorKnowledgeHttpError("Only the class teacher can manage tutor knowledge.", 403);
  }

  return { classSnapshot, email: decodedToken.email, uid: decodedToken.uid };
}

function readCoTeacherRole(coTeachers: unknown, uid: string) {
  if (!coTeachers || typeof coTeachers !== "object" || Array.isArray(coTeachers)) {
    return "";
  }

  const coTeacher = (coTeachers as Record<string, unknown>)[uid];

  if (!coTeacher || typeof coTeacher !== "object" || Array.isArray(coTeacher)) {
    return "";
  }

  const role = (coTeacher as Record<string, unknown>).role;

  return typeof role === "string" ? role : "";
}

export async function buildTutorKnowledgePreview(formData: FormData): Promise<TutorKnowledgePreview> {
  const file = readOptionalFile(formData);
  const pastedText = String(formData.get("text") ?? "").trim();
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();

  if (!file && !pastedText && !sourceUrl) {
    throw new TutorKnowledgeHttpError("Add a supported file, paste a URL, or paste tutor knowledge text before previewing.", 400);
  }

  const ingestion = await buildTutorKnowledgeIngestion({
    docId: "preview",
    file,
    pastedText,
    sourceUrl,
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
      hasFile: Boolean(file || sourceUrl),
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
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();
  const storagePath = String(formData.get("storagePath") ?? "").trim();
  const storageBucket = String(formData.get("storageBucket") ?? "").trim();
  const requestedMaterialId = String(formData.get("materialId") ?? "").trim();

  if (!title) {
    throw new TutorKnowledgeHttpError("Add a title before saving tutor knowledge.", 400);
  }

  if (!isTutorKnowledgeKind(kind)) {
    throw new TutorKnowledgeHttpError("Choose a valid tutor knowledge type.", 400);
  }

  if (requestedMaterialId && !/^[a-zA-Z0-9_-]{8,80}$/.test(requestedMaterialId)) {
    throw new TutorKnowledgeHttpError("Invalid tutor knowledge material id.", 400);
  }

  const materialRef = requestedMaterialId
    ? adminDb!.collection("classes").doc(classId).collection("materials").doc(requestedMaterialId)
    : adminDb!.collection("classes").doc(classId).collection("materials").doc();
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
  let storedSource: Awaited<ReturnType<typeof readUploadedStorageSource>> | null = null;
  let fileMetadata = {};

  try {
    storedSource = storagePath
      ? await readUploadedStorageSource({
          classId,
          materialId: materialRef.id,
          storageBucket,
          storagePath
        })
      : null;
    fileMetadata = storedSource?.metadata
      ?? (file ? await uploadTutorKnowledgeFile({ classId, file, materialId: materialRef.id, updateProgress }) : {})
      ?? {};
  } catch (caughtError) {
    await updateProgress({
      detail: "The original source file could not be saved to Firebase Storage.",
      error: caughtError instanceof Error ? caughtError.message : String(caughtError),
      percent: 100,
      step: "failed"
    });
    throw caughtError;
  }

  const sourceFile = file ?? storedSource?.file ?? null;
  const materialType = materialTypeForKind(kind);
  const classSnapshot = await adminDb!.collection("classes").doc(classId).get();
  const configuredSourceDefaults = sourceDefaultsForMaterialKind(classSnapshot.data()?.sourceDefaults, kind);
  const sourceSettings = normalizeTutorKnowledgeSourceSettings({
    ...defaultSourceSettingsForKind(kind),
    activeForStudents: configuredSourceDefaults.activeForStudents,
    priority: configuredSourceDefaults.priority,
    requireCitations: configuredSourceDefaults.citationsRequired,
    teacherOnly: configuredSourceDefaults.teacherOnly
  });
  const sourceMode = getTutorKnowledgeSourceMode({
    hasFile: Boolean(sourceFile || sourceUrl),
    hasPastedText: Boolean(pastedText)
  });

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
    characterCount: 0,
    chunkCount: 0,
    embeddingProvider: "vertex-ai",
    embeddingStatus: isVertexEmbeddingConfigured() ? "processing" : "not-configured",
    processingCompletedChunks: null,
    processingCompletedPages: null,
    processingDetail: "Upload received. Starting server-side processing.",
    processingError: null,
    processingPercent: 15,
    processingStep: "upload_received",
    processingTotalChunks: null,
    processingTotalPages: null,
    processingUpdatedAt: FieldValue.serverTimestamp(),
    status: "processing",
    addedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    pageCount: 0,
    sourceMode,
    ...(pastedText ? { textSource: pastedText } : {}),
    visualPageCount: 0
  });

  let ingestion: Awaited<ReturnType<typeof buildTutorKnowledgeIngestion>>;

  try {
    ingestion = await buildTutorKnowledgeIngestion({
      classId,
      docId: materialRef.id,
      file: sourceFile,
      materialId: materialRef.id,
      pastedText,
      pageAssetStorageBucket: String((fileMetadata as Partial<TutorKnowledgeOriginalSource>).storageBucket ?? ""),
      sourceUrl,
      title,
      updateProgress
    });
  } catch (caughtError) {
    await materialRef.update({
      embeddingError: caughtError instanceof Error ? caughtError.message : String(caughtError),
      embeddingFailedAt: FieldValue.serverTimestamp(),
      embeddingStatus: "failed",
      processingDetail: "Tutor knowledge processing failed before it was ready.",
      processingError: caughtError instanceof Error ? caughtError.message : String(caughtError),
      processingPercent: 100,
      processingStep: "failed",
      processingUpdatedAt: FieldValue.serverTimestamp(),
      status: "uploaded"
    });
    throw caughtError;
  }

  const searchableText = ingestion.searchableText;
  const chunks = ingestion.chunks;

  if (!searchableText && !chunks.length) {
    await materialRef.update({
      embeddingError: "No tutor knowledge text was found.",
      embeddingFailedAt: FieldValue.serverTimestamp(),
      embeddingStatus: "failed",
      processingDetail: "No tutor knowledge text was found.",
      processingError: "No tutor knowledge text was found.",
      processingPercent: 100,
      processingStep: "failed",
      processingUpdatedAt: FieldValue.serverTimestamp(),
      status: "uploaded"
    });
    throw new TutorKnowledgeHttpError("No tutor knowledge text was found. This source may be private, scanned, or unsupported.", 400);
  }

  await materialRef.update({
    characterCount: searchableText.length,
    chunkCount: chunks.length,
    pageCount: ingestion.pageCount,
    ...ingestion.sourceMetadata,
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
          detail: `Preparing source section ${completed} of ${total}.`,
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
      detail: "Saving this source to the class.",
      percent: 95,
      step: "saving_to_class",
      totalChunks: chunks.length
    });
    await materialRef.update({
      embeddingStatus: isVertexEmbeddingConfigured() ? "ready" : "not-configured",
      indexedAt: FieldValue.serverTimestamp(),
      processingPercent: 100,
      processingStep: "ready",
      processingDetail: "Source is ready for students.",
      processingUpdatedAt: FieldValue.serverTimestamp(),
      status: "ready"
    });
    await updateProgress({
      completedChunks: chunks.length,
      detail: "Source is ready for students.",
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
        detail: "Source preparation failed. The source was not saved for student use.",
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

  const material = materialSnapshot.data() ?? {};
  const filePath = String(material.filePath ?? "");
  const storageBucket = String(material.storageBucket ?? "").trim();

  await updateMaterialDeleteProgress({
    detail: "Delete requested. Preparing to remove this source.",
    materialRef,
    percent: 10,
    step: "deleting_source"
  });

  const [chunksSnapshot, jobsSnapshot] = await Promise.all([
    materialRef.collection("chunks").get(),
    adminDb!
      .collection("classes")
      .doc(classId)
      .collection("materialJobs")
      .where("materialId", "==", materialId)
      .get()
  ]);

  await updateMaterialDeleteProgress({
    detail: "Deleting original source files.",
    materialRef,
    percent: 35,
    step: "deleting_storage"
  });
  await deleteMaterialStorageFiles({ classId, filePath, materialId, storageBucket });

  await updateMaterialDeleteProgress({
    detail: `Deleting ${chunksSnapshot.size} indexed section${chunksSnapshot.size === 1 ? "" : "s"}.`,
    materialRef,
    percent: 70,
    step: "deleting_chunks",
    totalChunks: chunksSnapshot.size
  });
  await deleteDocumentsInBatches([
    ...chunksSnapshot.docs.map((chunkDoc) => chunkDoc.ref),
    ...jobsSnapshot.docs.map((jobDoc) => jobDoc.ref)
  ]);

  await updateMaterialDeleteProgress({
    detail: "Removing source from the class library.",
    materialRef,
    percent: 95,
    step: "deleting_material"
  });
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
  const sourceUrl = String(material.originalSourceUrl ?? material.sourceUrl ?? "").trim();
  const fallbackText = file || sourceUrl ? "" : await readExistingChunkText(materialRef);

  if (!isTutorKnowledgeKind(kind)) {
    throw new TutorKnowledgeHttpError("Tutor knowledge has an invalid source type.", 400);
  }

  if (!file && !sourceUrl && !textSource && !fallbackText) {
    throw new TutorKnowledgeHttpError("No original source content is available to reprocess.", 400);
  }

  const ingestion = await buildTutorKnowledgeIngestion({
    classId,
    docId: materialId,
    file,
    materialId,
    pastedText: textSource || fallbackText,
    pageAssetStorageBucket: String(material.storageBucket ?? ""),
    sourceUrl,
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
    ...ingestion.sourceMetadata,
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
  materialId,
  updateProgress
}: {
  classId: string;
  file: File;
  materialId: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  await updateProgress?.({
    detail: "Saving the original source file to Firebase Storage.",
    percent: 20,
    step: "upload_received"
  });
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
    fileSize: file.size,
    sourceKind: "file",
    storageBucket: bucketName
  };
}

async function deleteMaterialStorageFiles({
  classId,
  filePath,
  materialId,
  storageBucket
}: {
  classId: string;
  filePath: string;
  materialId: string;
  storageBucket?: string;
}) {
  const bucket = resolveTutorKnowledgeStorageBucket(storageBucket);
  const materialStoragePrefix = `classes/${classId}/materials/${materialId}/`;
  const [files] = await bucket.getFiles({ prefix: materialStoragePrefix });
  const filePaths = new Set(files.map((file) => file.name));

  if (filePath) {
    filePaths.add(filePath);
  }

  await Promise.all(
    Array.from(filePaths).map((path) => bucket.file(path).delete({ ignoreNotFound: true }))
  );
}

async function updateMaterialDeleteProgress({
  detail,
  materialRef,
  percent,
  step,
  totalChunks
}: {
  detail: string;
  materialRef: DocumentReference;
  percent: number;
  step: Extract<MaterialJobStep, "deleting_source" | "deleting_storage" | "deleting_chunks" | "deleting_material">;
  totalChunks?: number;
}) {
  await materialRef.update({
    processingCompletedChunks: step === "deleting_chunks" ? 0 : null,
    processingCompletedPages: null,
    processingDetail: detail,
    processingError: null,
    processingPercent: Math.max(0, Math.min(100, percent)),
    processingStep: step,
    processingTotalChunks: totalChunks ?? null,
    processingTotalPages: null,
    processingUpdatedAt: FieldValue.serverTimestamp(),
    status: "deleting"
  });
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
  const storageBucket = String(material.storageBucket ?? "").trim();

  if (!filePath) {
    return null;
  }

  const [buffer] = await resolveTutorKnowledgeStorageBucket(storageBucket).file(filePath).download();
  const fileBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return new File([fileBytes], fileName, {
    type: String(material.contentType ?? "") || contentTypeFromFileName(fileName)
  });
}

async function readUploadedStorageSource({
  classId,
  materialId,
  storageBucket,
  storagePath
}: {
  classId: string;
  materialId: string;
  storageBucket?: string;
  storagePath: string;
}) {
  const expectedPrefix = `classes/${classId}/materials/${materialId}/original/`;

  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    throw new TutorKnowledgeHttpError("Uploaded material storage path is invalid.", 400);
  }

  const bucket = resolveTutorKnowledgeStorageBucket(storageBucket);
  const storageFile = bucket.file(storagePath);
  const [exists] = await storageFile.exists();

  if (!exists) {
    throw new TutorKnowledgeHttpError("Uploaded material file was not found in Storage.", 400);
  }

  const [metadata] = await storageFile.getMetadata();
  const fileName = storagePath.split("/").pop() || "source";
  const contentType = String(metadata.contentType ?? "") || contentTypeFromFileName(fileName);
  const fileSize = Number(metadata.size ?? 0);

  if (fileSize > maxTutorKnowledgeFileBytes) {
    throw new TutorKnowledgeHttpError(
      `Material files must be ${Math.floor(maxTutorKnowledgeFileBytes / 1024 / 1024)} MB or smaller.`,
      413
    );
  }

  validateStoredSourceMetadata({ contentType, fileName, fileSize });
  const [buffer] = await storageFile.download();
  const fileBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const bucketName = bucket.name;
  const encodedPath = storagePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return {
    file: new File([fileBytes], fileName, { type: contentType }),
    metadata: {
      contentType,
      fileName,
      filePath: storagePath,
      fileSize,
      fileUrl: `https://storage.googleapis.com/${bucketName}/${encodedPath}`,
      sourceKind: "storage",
      storageBucket: bucketName
    } satisfies TutorKnowledgeOriginalSource
  };
}

function resolveTutorKnowledgeStorageBucket(storageBucket?: string) {
  const requestedBucket = storageBucket?.trim() ?? "";
  const adminBucket = adminStorage!.bucket();
  const allowedBuckets = new Set(
    [adminBucket.name, firebaseConfig.storageBucket]
      .map((bucketName) => bucketName?.trim())
      .filter((bucketName): bucketName is string => Boolean(bucketName))
  );

  if (!requestedBucket) {
    return adminBucket;
  }

  if (!allowedBuckets.has(requestedBucket)) {
    throw new TutorKnowledgeHttpError("Uploaded material storage bucket is invalid.", 400);
  }

  return adminStorage!.bucket(requestedBucket);
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
  classId,
  docId,
  file,
  materialId,
  pageAssetStorageBucket,
  pastedText,
  sourceUrl,
  title,
  updateProgress
}: {
  classId?: string;
  docId: string;
  file: File | null;
  materialId?: string;
  pageAssetStorageBucket?: string;
  pastedText: string;
  sourceUrl?: string;
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  assertTutorKnowledgeTextWithinLimit(pastedText);
  const normalizedSourceUrl = sourceUrl?.trim() ?? "";
  await updateProgress?.({
    detail: file
      ? "Reading the uploaded file and extracting usable text."
      : normalizedSourceUrl
        ? "Downloading the URL and extracting usable text."
        : "Reading pasted tutor knowledge text.",
    percent: 25,
    step: "reading_file"
  });
  const urlIngestion = normalizedSourceUrl
    ? await extractChunksFromUrl({
        classId,
        docId,
        materialId,
        pageAssetStorageBucket,
        sourceUrl: normalizedSourceUrl,
        title,
        updateProgress
      })
    : {
        chunks: [] as TutorKnowledgeChunk[],
        extractedText: "",
        metadata: {} as Partial<TutorKnowledgeOriginalSource>,
        pageCount: 0,
        visualPageCount: 0
      };
  const fileIngestion = file
    ? await extractChunksFromFile({
        classId,
        docId,
        file,
        materialId,
        pageAssetStorageBucket,
        title,
        updateProgress
      })
    : {
        chunks: [] as TutorKnowledgeChunk[],
        extractedText: "",
        metadata: {},
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
  const chunks = [...urlIngestion.chunks, ...fileIngestion.chunks, ...pastedChunks].map((chunk, order) => ({
    ...chunk,
    order
  }));
  const searchableText = [urlIngestion.extractedText, fileIngestion.extractedText, pastedText]
    .filter((text) => text.trim())
    .join("\n\n")
    .trim();

  await updateProgress?.({
    detail: `Built ${chunks.length} tutor knowledge chunk${chunks.length === 1 ? "" : "s"} for this class.`,
    percent: 50,
    step: "chunking_material",
    totalChunks: chunks.length
  });

  return {
    chunks,
    extractedText: [urlIngestion.extractedText, fileIngestion.extractedText].filter((text) => text.trim()).join("\n\n"),
    pageCount: urlIngestion.pageCount + fileIngestion.pageCount,
    searchableText,
    sourceMetadata: {
      ...urlIngestion.metadata,
      ...fileIngestion.metadata
    },
    visualPageCount: urlIngestion.visualPageCount + fileIngestion.visualPageCount
  };
}

async function extractChunksFromFile({
  classId,
  docId,
  file,
  materialId,
  pageAssetStorageBucket,
  title,
  updateProgress
}: {
  classId?: string;
  docId: string;
  file: File;
  materialId?: string;
  pageAssetStorageBucket?: string;
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
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
      metadata: {},
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
  const visualPdfPageNumbers = pdfPageAssetPageNumbersForChunks(chunks);
  const sourcePdfPromise = visualPdfPageNumbers.length
    ? PDFDocument.load(buffer, { ignoreEncryption: true })
    : Promise.resolve(null);
  const chunksWithPdfParts = visualPdfPageNumbers.length
    ? await sourcePdfPromise.then((sourcePdf) => attachPdfSlicesToChunks({
        chunks,
        pdfBytes: buffer,
        shouldAttachPdfSlice: shouldAttachPdfPartForEmbedding,
        sourcePdf: sourcePdf!
      }))
    : chunks;
  const chunksWithReadableContent = await transcribeVisualPdfChunks({
    chunks: chunksWithPdfParts,
    title,
    updateProgress
  });

  return {
    chunks: chunksWithReadableContent,
    extractedText: extractedTextWithTranscribedVisualChunks(pages, chunksWithReadableContent),
    metadata: {},
    pageCount: pages.length,
    visualPageCount: pages.filter((page) => classifyTutorKnowledgePage(page) !== "text-heavy").length
  };
}

async function extractChunksFromUrl({
  classId,
  docId,
  materialId,
  pageAssetStorageBucket,
  sourceUrl,
  title,
  updateProgress
}: {
  classId?: string;
  docId: string;
  materialId?: string;
  pageAssetStorageBucket?: string;
  sourceUrl: string;
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  const downloaded = await downloadTutorKnowledgeUrl(sourceUrl);
  const contentType = downloaded.contentType || contentTypeFromFileName(downloaded.fileName);
  const metadata = {
    contentType,
    fileName: downloaded.fileName,
    fileSize: downloaded.buffer.byteLength,
    originalSourceUrl: sourceUrl,
    sourceKind: "url" as const,
    sourceUrl: downloaded.finalUrl
  };

  if (isPdfSource(downloaded.fileName, contentType)) {
    const fileBytes = downloaded.buffer.buffer.slice(
      downloaded.buffer.byteOffset,
      downloaded.buffer.byteOffset + downloaded.buffer.byteLength
    ) as ArrayBuffer;
    const file = new File([fileBytes], downloaded.fileName, { type: contentType });
    const extracted = await extractChunksFromFile({
      classId,
      docId,
      file,
      materialId,
      pageAssetStorageBucket,
      title,
      updateProgress
    });

    return {
      ...extracted,
      metadata: {
        ...metadata,
        ...extracted.metadata
      }
    };
  }

  if (isHtmlSource(contentType, downloaded.fileName)) {
    const extractedText = extractReadableHtmlText(downloaded.buffer.toString("utf8"));
    assertTutorKnowledgeTextWithinLimit(extractedText, "Extracted URL text");

    return {
      chunks: chunkTutorKnowledgeText(extractedText, {
        docId,
        labelPrefix: "URL knowledge chunk",
        sourceType: "text",
        title
      }),
      extractedText,
      metadata,
      pageCount: 0,
      visualPageCount: 0
    };
  }

  if (isTextSource(contentType, downloaded.fileName)) {
    const extractedText = downloaded.buffer.toString("utf8").trim();
    assertTutorKnowledgeTextWithinLimit(extractedText, "Extracted URL text");

    return {
      chunks: chunkTutorKnowledgeText(extractedText, {
        docId,
        labelPrefix: "URL knowledge chunk",
        sourceType: "text",
        title
      }),
      extractedText,
      metadata,
      pageCount: 0,
      visualPageCount: 0
    };
  }

  throw new TutorKnowledgeHttpError("This URL is not a supported PDF, HTML, TXT, MD, or CSV source.", 415);
}

async function extractPdfPages(buffer: Buffer): Promise<TutorKnowledgePage[]> {
  let pages = await extractPdfTextPages(buffer, { lineEnforce: true }).catch(() =>
    extractPdfTextPages(buffer, { lineEnforce: false }).catch(async () =>
      visualPdfPagesFromPageInfo(await extractPdfPageInfo(buffer))
    )
  );

  if (!pages.length) {
    pages = visualPdfPagesFromPageInfo(await extractPdfPageInfo(buffer));
  }

  if (!pages.length) {
    throw new TutorKnowledgeHttpError(
      "We could not inspect this PDF. Try a non-password-protected PDF or paste the content manually.",
      400
    );
  }

  return pages.map((page) => {
    const text = page.text.trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length >= 3).length;

    return {
      metrics: {
        embeddedImageCount: 0,
        imageCoverageRatio: text ? 0 : 1,
        lineCount,
        pageArea: 0,
        textDensity: 0
      },
      isVisual: !text,
      pageNumber: page.num,
      text
    };
  });
}

function pdfPageAssetPageNumbersForChunks(chunks: TutorKnowledgeChunk[]) {
  const pageNumbers = new Set<number>();

  for (const chunk of chunks) {
    if (!shouldPrebuildPdfPageAsset(chunk) || !chunk.pageStart || !chunk.pageEnd) {
      continue;
    }

    for (let pageNumber = chunk.pageStart; pageNumber <= chunk.pageEnd; pageNumber += 1) {
      pageNumbers.add(pageNumber);
    }
  }

  return Array.from(pageNumbers).sort((first, second) => first - second);
}

function shouldPrebuildPdfPageAsset(chunk: TutorKnowledgeChunk) {
  return chunk.sourceType === "mixed" || chunk.sourceType === "page-image";
}

function shouldAttachPdfPartForEmbedding(chunk: TutorKnowledgeChunk) {
  return shouldPrebuildPdfPageAsset(chunk);
}

async function transcribeVisualPdfChunks({
  chunks,
  title,
  updateProgress
}: {
  chunks: TutorKnowledgeChunk[];
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  const transcribableChunks = chunks.filter(shouldTranscribePdfChunk);

  if (!transcribableChunks.length) {
    return chunks;
  }

  const documentAiConfig = getDocumentAiOcrConfig();

  if (!documentAiConfig) {
    throw new TutorKnowledgeHttpError(
      "This PDF has visual pages, but Google Document AI OCR is not configured. Add DOCUMENT_AI_OCR_PROCESSOR_ID, GOOGLE_CLOUD_PROJECT, and Google credentials.",
      500
    );
  }

  const accessToken = await getDocumentAiAccessToken();
  let completedPages = 0;
  const transcriptions = new Map<number, string>();
  const ocrBatches = documentAiOcrChunkBatches(transcribableChunks);
  let completedBatches = 0;

  await mapWithConcurrency(ocrBatches, pdfPageTranscriptionConcurrencyLimit, async (batch) => {
    const batchTranscriptions = await transcribePdfPageChunkBatch({
      accessToken,
      batch,
      config: documentAiConfig,
      title
    });

    for (const [order, transcription] of batchTranscriptions) {
      if (transcription) {
        transcriptions.set(order, transcription);
      }
    }

    completedBatches += 1;
    completedPages += batch.chunks.length;
    if (shouldReportPageProgress(completedPages, transcribableChunks.length)) {
      await updateProgress?.({
        completedPages,
        detail: `Running Google Document AI OCR batch ${completedBatches} of ${ocrBatches.length} (${completedPages}/${transcribableChunks.length} pages).`,
        percent: Math.min(49, 30 + Math.round((completedPages / Math.max(transcribableChunks.length, 1)) * 18)),
        step: "reading_pdf_pages",
        totalPages: transcribableChunks.length
      });
    }

  });

  if (!transcriptions.size) {
    if (chunks.some((chunk) => !isWeakPdfChunkContent(chunk.content))) {
      await updateProgress?.({
        completedPages: transcribableChunks.length,
        detail: `Google Document AI OCR did not return text for ${formatPageList(pageNumbersForChunks(transcribableChunks))}. Check those page images if source text is missing.`,
        percent: 49,
        step: "reading_pdf_pages",
        totalPages: transcribableChunks.length
      });
      return chunks;
    }

    throw new TutorKnowledgeHttpError(
      `Google Document AI OCR could not read ${formatPageList(pageNumbersForChunks(transcribableChunks))}. The material was not indexed because those pages would only save placeholder text.`,
      502
    );
  }

  const failedChunks = transcribableChunks.filter((chunk) => !transcriptions.has(chunk.order));

  if (failedChunks.length) {
    await updateProgress?.({
      completedPages: transcribableChunks.length,
      detail: `Google Document AI OCR did not return text for ${formatPageList(pageNumbersForChunks(failedChunks))}. Check those page images if source text is missing.`,
      percent: 49,
      step: "reading_pdf_pages",
      totalPages: transcribableChunks.length
    });
  }

  return chunks.map((chunk) => {
    const transcription = transcriptions.get(chunk.order);

    if (!transcription) {
      return chunk;
    }

    return {
      ...chunk,
      chunkText: transcription,
      content: transcription,
      section: chunk.section || extractSectionHeading(transcription)
    };
  });
}

function pageNumbersForChunks(chunks: TutorKnowledgeChunk[]) {
  return chunks
    .map((chunk) => chunk.pageStart ?? chunk.pageEnd ?? extractPageNumber(chunk.label))
    .filter((pageNumber): pageNumber is number => typeof pageNumber === "number" && Number.isFinite(pageNumber))
    .sort((first, second) => first - second);
}

function formatPageList(pageNumbers: number[]) {
  if (!pageNumbers.length) {
    return "the failed pages";
  }

  const uniquePages = Array.from(new Set(pageNumbers));
  const visiblePages = uniquePages.slice(0, 12).join(", ");
  const remainingCount = uniquePages.length - 12;

  return remainingCount > 0
    ? `pages ${visiblePages}, and ${remainingCount} more`
    : `pages ${visiblePages}`;
}

type DocumentAiOcrChunkBatch = {
  chunks: TutorKnowledgeChunk[];
  pdfPart: NonNullable<TutorKnowledgeChunk["pdfPart"]>;
};

function documentAiOcrChunkBatches(chunks: TutorKnowledgeChunk[]) {
  const sortedChunks = [...chunks].sort((first, second) =>
    (first.pageStart ?? 0) - (second.pageStart ?? 0) || first.order - second.order
  );
  const batches: DocumentAiOcrChunkBatch[] = [];
  let currentChunks: TutorKnowledgeChunk[] = [];

  for (const chunk of sortedChunks) {
    if (currentChunks.length >= documentAiOcrPagesPerRequest) {
      batches.push(documentAiOcrChunkBatch(currentChunks));
      currentChunks = [];
    }

    currentChunks.push(chunk);
  }

  if (currentChunks.length) {
    batches.push(documentAiOcrChunkBatch(currentChunks));
  }

  return batches;
}

function documentAiOcrChunkBatch(chunks: TutorKnowledgeChunk[]): DocumentAiOcrChunkBatch {
  const pdfParts = chunks
    .map((chunk) => chunk.pdfPart)
    .filter((pdfPart): pdfPart is NonNullable<TutorKnowledgeChunk["pdfPart"]> => Boolean(pdfPart));

  return {
    chunks,
    pdfPart: pdfParts.length === 1 ? pdfParts[0] : mergedPdfPartForChunks(chunks)
  };
}

function mergedPdfPartForChunks(chunks: TutorKnowledgeChunk[]): NonNullable<TutorKnowledgeChunk["pdfPart"]> {
  const joinedPdfParts = chunks
    .map((chunk) => chunk.pdfPart)
    .filter((pdfPart): pdfPart is NonNullable<TutorKnowledgeChunk["pdfPart"]> => Boolean(pdfPart));

  if (joinedPdfParts.length !== chunks.length) {
    throw new TutorKnowledgeHttpError("Could not build a Google Document AI OCR page batch.", 500);
  }

  return {
    data: joinedPdfParts.map((pdfPart) => filePartToBase64(pdfPart)).join("\n"),
    mimeType: "application/x-chandra-pdf-part-list"
  };
}

function shouldTranscribePdfChunk(chunk: TutorKnowledgeChunk) {
  if (!chunk.pdfPart || !shouldPrebuildPdfPageAsset(chunk)) {
    return false;
  }

  return isWeakPdfChunkContent(chunk.content);
}

function isWeakPdfChunkContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return true;
  }

  if (/^Visual PDF page \d{1,5} from .+$/i.test(normalized)) {
    return true;
  }

  return normalized.split(/\s+/).filter(Boolean).length < 30;
}

async function transcribePdfPageChunkBatch({
  accessToken,
  batch,
  config,
  title
}: {
  accessToken: string;
  batch: DocumentAiOcrChunkBatch;
  config: DocumentAiOcrConfig;
  title: string;
}) {
  try {
    const result = await processDocumentAiOcrPageBatch({
      accessToken,
      batch,
      config,
      title
    });

    return splitDocumentAiBatchText(result, batch.chunks);
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      throw caughtError;
    }

    console.warn(
      "Google Document AI OCR failed.",
      caughtError instanceof Error ? caughtError.message : String(caughtError)
    );
    return new Map<number, string>();
  }
}

async function processDocumentAiOcrPageBatch({
  accessToken,
  batch,
  config,
  title
}: {
  accessToken: string;
  batch: DocumentAiOcrChunkBatch;
  config: DocumentAiOcrConfig;
  title: string;
}) {
  const documentPdfPart = await documentAiPdfPartForBatch(batch);

  for (let attempt = 0; attempt < documentAiOcrMaxAttempts; attempt += 1) {
    await waitForDocumentAiOcrRequestSlot();

    const response = await fetch(buildDocumentAiProcessUrl(config), {
      body: JSON.stringify({
        fieldMask: "text,pages.layout,pages.pageNumber",
        rawDocument: {
          content: filePartToBase64(documentPdfPart),
          displayName: documentAiDisplayName(`${title} pages ${batch.chunks[0]?.pageStart ?? ""}-${batch.chunks.at(-1)?.pageEnd ?? ""}`),
          mimeType: documentPdfPart.mimeType
        }
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });

    if (response.ok) {
      return await response.json();
    }

    const detail = await response.text();

    if (!shouldRetryDocumentAiOcr(response.status) || attempt === documentAiOcrMaxAttempts - 1) {
      throw new TutorKnowledgeHttpError(
        `Google Document AI OCR failed with ${response.status}: ${detail.slice(0, 400)}`,
        response.status === 404 ? 502 : response.status
      );
    }

    await sleep(documentAiOcrRetryDelayMs(response.headers.get("retry-after"), attempt));
  }

  return "";
}

async function documentAiPdfPartForBatch(batch: DocumentAiOcrChunkBatch) {
  if (batch.pdfPart.mimeType !== "application/x-chandra-pdf-part-list") {
    return batch.pdfPart;
  }

  const mergedPdf = await PDFDocument.create();

  for (const encodedPdfPart of String(batch.pdfPart.data).split("\n").filter(Boolean)) {
    const sourcePdf = await PDFDocument.load(Buffer.from(encodedPdfPart, "base64"), { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(
      sourcePdf,
      Array.from({ length: sourcePdf.getPageCount() }, (_, index) => index)
    );
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return {
    data: await mergedPdf.save(),
    mimeType: "application/pdf"
  };
}

function splitDocumentAiBatchText(payload: unknown, chunks: TutorKnowledgeChunk[]) {
  const documentText = readDocumentAiText(payload);
  const pages = readDocumentAiPages(payload);
  const transcriptions = new Map<number, string>();

  if (!documentText) {
    return transcriptions;
  }

  chunks.forEach((chunk, index) => {
    const page = pages[index];
    const pageText = page ? textForDocumentAiPage(documentText, page) : "";
    transcriptions.set(chunk.order, normalizeTranscribedText(pageText));
  });

  if (Array.from(transcriptions.values()).some(Boolean)) {
    return transcriptions;
  }

  if (chunks.length === 1) {
    transcriptions.set(chunks[0].order, normalizeTranscribedText(documentText));
    return transcriptions;
  }

  const chunkTexts = splitDocumentAiTextEvenly(documentText, chunks.length);

  chunks.forEach((chunk, index) => {
    transcriptions.set(chunk.order, normalizeTranscribedText(chunkTexts[index] ?? ""));
  });

  return transcriptions;
}

function splitDocumentAiTextEvenly(text: string, chunkCount: number) {
  if (chunkCount <= 1) {
    return [text];
  }

  const lines = text.split(/\n+/).filter((line) => line.trim());
  const targetLinesPerChunk = Math.max(1, Math.ceil(lines.length / chunkCount));
  const chunks: string[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    chunks.push(lines.slice(index * targetLinesPerChunk, (index + 1) * targetLinesPerChunk).join("\n"));
  }

  return chunks;
}

async function waitForDocumentAiOcrRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextDocumentAiOcrRequestAt);
  nextDocumentAiOcrRequestAt = scheduledAt + documentAiOcrRequestIntervalMs;
  const waitMs = scheduledAt - now;

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function shouldRetryDocumentAiOcr(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function documentAiOcrRetryDelayMs(retryAfter: string | null, attempt: number) {
  const retryAfterMs = readRetryAfterMs(retryAfter);

  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  return Math.min(60_000, 2_000 * 2 ** attempt);
}

type DocumentAiOcrConfig = {
  location: string;
  processorId: string;
  projectId: string;
};

function getDocumentAiOcrConfig(): DocumentAiOcrConfig | null {
  const projectId = (
    process.env.DOCUMENT_AI_PROJECT_ID
    ?? process.env.GOOGLE_CLOUD_PROJECT
    ?? process.env.FIREBASE_PROJECT_ID
    ?? ""
  ).trim();
  const location = (
    process.env.DOCUMENT_AI_OCR_LOCATION
    ?? process.env.GOOGLE_CLOUD_LOCATION
    ?? "us"
  ).trim();
  const processorId = (
    process.env.DOCUMENT_AI_OCR_PROCESSOR_ID
    ?? defaultDocumentAiOcrProcessorId
  ).trim();

  if (!projectId || !location || !processorId) {
    return null;
  }

  return { location, processorId, projectId };
}

async function getDocumentAiAccessToken() {
  const auth = new GoogleAuth({
    ...(getGoogleCredentials() ? { credentials: getGoogleCredentials() } : {}),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new TutorKnowledgeHttpError("Google auth did not return an access token for Document AI OCR.", 500);
  }

  return token;
}

function getGoogleCredentials(): JWTInput | undefined {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as JWTInput & {
      clientEmail?: string;
      privateKey?: string;
      projectId?: string;
    };

    return {
      client_email: serviceAccount.client_email ?? serviceAccount.clientEmail,
      private_key: (serviceAccount.private_key ?? serviceAccount.privateKey)?.replace(/\\n/g, "\n"),
      project_id: serviceAccount.project_id ?? serviceAccount.projectId
    };
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY ?? process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;

  if (!clientEmail || !privateKey || !projectId) {
    return undefined;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    project_id: projectId
  };
}

function buildDocumentAiProcessUrl({ location, processorId, projectId }: DocumentAiOcrConfig) {
  const endpoint = `${location}-documentai.googleapis.com`;
  const name = [
    "projects",
    projectId,
    "locations",
    location,
    "processors",
    processorId
  ].map(encodeURIComponent).join("/");

  return `https://${endpoint}/v1/${name}:process`;
}

function readDocumentAiText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const document = (payload as { document?: { text?: unknown } }).document;

  return typeof document?.text === "string" ? document.text : "";
}

function readDocumentAiPages(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return [] as Array<{ layout?: { textAnchor?: unknown } }>;
  }

  const document = (payload as { document?: { pages?: unknown } }).document;

  return Array.isArray(document?.pages)
    ? document.pages.filter((page): page is { layout?: { textAnchor?: unknown } } => Boolean(page && typeof page === "object"))
    : [];
}

function textForDocumentAiPage(documentText: string, page: { layout?: { textAnchor?: unknown } }) {
  const textSegments = (page.layout?.textAnchor as { textSegments?: unknown[] } | undefined)?.textSegments;

  if (!Array.isArray(textSegments) || !textSegments.length) {
    return "";
  }

  return textSegments
    .map((segment) => {
      if (!segment || typeof segment !== "object") {
        return "";
      }

      const startIndex = documentAiTextAnchorIndex((segment as { startIndex?: unknown }).startIndex) ?? 0;
      const endIndex = documentAiTextAnchorIndex((segment as { endIndex?: unknown }).endIndex);

      return endIndex === undefined ? "" : documentText.slice(startIndex, endIndex);
    })
    .filter(Boolean)
    .join("\n");
}

function documentAiTextAnchorIndex(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }

  return undefined;
}

function documentAiDisplayName(value: string) {
  return value
    .replace(/[*?[\]%{}'",~=:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Chandra PDF page";
}

function normalizeTranscribedText(text: string) {
  return text
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function filePartToBase64(file: VertexEmbeddingPart) {
  if (typeof file.data !== "string") {
    return Buffer.from(file.data).toString("base64");
  }

  const dataUrlMatch = file.data.match(/^data:[^;]+;base64,(?<base64>.+)$/);

  if (dataUrlMatch?.groups?.base64) {
    return dataUrlMatch.groups.base64;
  }

  return Buffer.from(file.data).toString("base64");
}

function extractedTextWithTranscribedVisualChunks(pages: TutorKnowledgePage[], chunks: TutorKnowledgeChunk[]) {
  const extractedPageText = pages.map((page) => page.text.trim()).filter(Boolean);
  const transcribedText = chunks
    .filter((chunk) => shouldPrebuildPdfPageAsset(chunk) && !isWeakPdfChunkContent(chunk.content))
    .map((chunk) => chunk.content.trim())
    .filter(Boolean);

  return [...extractedPageText, ...transcribedText].join("\n\n");
}

async function extractPdfTextPages(buffer: Buffer, options: { lineEnforce: boolean }) {
  ensurePdfJsDomGlobals();
  const { PDFParse } = await import("pdf-parse");
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
  ensurePdfJsDomGlobals();
  const { PDFParse } = await import("pdf-parse");
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

    return extractPdfPageInfoFromDocument(pdf);
  } catch {
    return new Map<number, { area: number; height: number; width: number }>();
  }
}

function extractPdfPageInfoFromDocument(pdf: PDFDocument) {
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

  if (file.size > maxTutorKnowledgeFileBytes) {
    throw new TutorKnowledgeHttpError(
      `Material files must be ${Math.floor(maxTutorKnowledgeFileBytes / 1024 / 1024)} MB or smaller.`,
      413
    );
  }
}

function validateStoredSourceMetadata({
  contentType,
  fileName,
  fileSize
}: {
  contentType: string;
  fileName: string;
  fileSize: number;
}) {
  const extension = getFileExtension(fileName);
  const supportedExtension = supportedTutorKnowledgeExtensions.some((item) => item === extension);
  const supportedContentType = !contentType || supportedContentTypes.has(contentType);

  if (!supportedExtension || !supportedContentType) {
    throw new TutorKnowledgeHttpError("Only PDF, TXT, MD, and CSV files are supported.", 400);
  }

  if (fileSize > maxTutorKnowledgeFileBytes) {
    throw new TutorKnowledgeHttpError(
      `Material files must be ${Math.floor(maxTutorKnowledgeFileBytes / 1024 / 1024)} MB or smaller.`,
      413
    );
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
  if (!skipEmbeddings && chunks.length) {
    await onEmbeddingProgress?.({ completed: 0, total: chunks.length });
  }

  const embeddings = skipEmbeddings
    ? []
    : await createVertexEmbeddings(
        chunks.map((chunk) => ({
          file: embeddingFileForChunk(chunk),
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
        file: embeddingFileForChunk(chunk),
        taskType: "RETRIEVAL_DOCUMENT",
        text: chunk.content,
        title
      }));
  const { pageImage: _pageImage, pdfPart: _pdfPart, ...storedChunk } = chunk;
  const pageNumber = chunk.pageStart ?? extractPageNumber(chunk.label);
  const canonicalContent = canonicalChunkContent(chunk);
  const sectionHeading = chunk.section ?? extractSectionHeading(canonicalContent);
  const pageStart = chunk.pageStart ?? pageNumber;
  const pageEnd = chunk.pageEnd ?? pageNumber;
  const problemNumbers = problemNumbersFromText(`${chunk.label}\n${canonicalContent}`);
  const sectionMarkers = sectionMarkersFromText(`${chunk.label}\n${sectionHeading}\n${canonicalContent}`);

  return {
    ...storedChunk,
    classId,
    class_id: classId,
    chunkId: chunkId ?? "",
    chunkIndex,
    content: canonicalContent,
    chunk_text: canonicalContent,
    course_id: classId,
    createdAt: FieldValue.serverTimestamp(),
    doc_id: chunk.docId ?? materialId,
    docId: chunk.docId ?? materialId,
    hasPageImage: Boolean(chunk.pageImage),
    hasPdfPart: Boolean(chunk.pdfPart),
    materialId,
    materialType,
    excerpt: buildChunkExcerpt(canonicalContent),
    page_end: pageEnd,
    page_start: pageStart,
    pageEnd,
    pageNumber,
    pageNumbers: pageNumbersForChunk(pageStart, pageEnd),
    pageStart,
    problemNumbers,
    professorId,
    professorName: normalizedProfessorName,
    professor_id: professorId,
    professor_name: normalizedProfessorName,
    section: sectionHeading,
    sectionHeading,
    sectionMarkers,
    teacherId: professorId,
    title,
    ...buildChunkEmbeddingMetadata(chunkEmbedding)
  };
}

function pageNumbersForChunk(pageStart: number | null | undefined, pageEnd: number | null | undefined) {
  if (!pageStart || !pageEnd) {
    return [];
  }

  const firstPage = Math.max(1, Math.min(pageStart, pageEnd));
  const lastPage = Math.max(firstPage, pageEnd);
  const pageCount = Math.min(100, lastPage - firstPage + 1);

  return Array.from({ length: pageCount }, (_item, index) => firstPage + index);
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
  const materialRef = adminDb!.collection("classes").doc(classId).collection("materials").doc(materialId);
  let progressWriteQueue = Promise.resolve();

  const writeProgress = async (progress: MaterialJobProgressUpdate) => {
    const percent = Math.max(0, Math.min(100, progress.percent));
    const materialSnapshot = await materialRef.get();
    const materialData = materialSnapshot.data() ?? {};
    const nextPageCompleted = progress.step === "preparing_pdf_pages"
      ? progress.completedPages ?? 0
      : readProgressNumber(materialData.pageAssetCompletedPages);
    const nextPageTotal = progress.step === "preparing_pdf_pages"
      ? progress.totalPages ?? 0
      : readProgressNumber(materialData.pageAssetTotalPages);
    const nextTutorCompleted = progress.step === "embedding_chunks"
      ? progress.completedChunks ?? 0
      : progress.step === "reading_pdf_pages"
        ? progress.completedPages ?? 0
        : readProgressNumber(materialData.tutorReadCompletedSections);
    const nextTutorTotal = progress.step === "embedding_chunks"
      ? progress.totalChunks ?? 0
      : progress.step === "reading_pdf_pages"
        ? progress.totalPages ?? 0
        : readProgressNumber(materialData.tutorReadTotalSections);
    const pageAssetPercent = nextPageTotal ? Math.round((nextPageCompleted / nextPageTotal) * 100) : null;
    const tutorReadPercent = nextTutorTotal ? Math.round((nextTutorCompleted / nextTutorTotal) * 100) : null;
    const totalPercent = totalMaterialProcessingPercent({
      currentPercent: percent,
      materialStatus: String(materialData.status ?? ""),
      previousPercent: readProgressNumber(materialData.processingPercent),
      pageAssetPercent,
      step: progress.step,
      tutorReadPercent
    });
    const progressDocument = {
      classId,
      completedChunks: progress.completedChunks ?? null,
      completedPages: progress.completedPages ?? null,
      detail: progress.detail,
      error: progress.error ?? null,
      materialId,
      percent,
      professorId: teacherId,
      step: progress.step,
      title,
      totalChunks: progress.totalChunks ?? null,
      totalPages: progress.totalPages ?? null,
      updatedAt: FieldValue.serverTimestamp()
    };
    const materialProgressDocument = {
      ...(progress.step === "preparing_pdf_pages"
        ? {
            pageAssetCompletedPages: progress.completedPages ?? null,
            pageAssetPercent,
            pageAssetTotalPages: progress.totalPages ?? null
          }
        : {}),
      ...(progress.step === "embedding_chunks"
        ? {
            tutorReadCompletedSections: progress.completedChunks ?? null,
            tutorReadPercent,
            tutorReadTotalSections: progress.totalChunks ?? null
          }
        : {}),
      ...(progress.step === "reading_pdf_pages"
        ? {
            tutorReadCompletedSections: progress.completedPages ?? null,
            tutorReadPercent,
            tutorReadTotalSections: progress.totalPages ?? null
          }
        : {}),
      processingCompletedChunks: progress.completedChunks ?? null,
      processingCompletedPages: progress.completedPages ?? null,
      processingDetail: progress.detail,
      processingError: progress.error ?? null,
      processingPercent: totalPercent,
      processingStep: progress.step,
      processingTotalChunks: progress.totalChunks ?? null,
      processingTotalPages: progress.totalPages ?? null,
      processingUpdatedAt: FieldValue.serverTimestamp()
    };

    await jobRef.set(progressDocument, { merge: true });

    await materialRef.update(materialProgressDocument).catch((caughtError) => {
      if (progress.step !== "upload_received") {
        console.warn("Tutor knowledge material progress update failed.", caughtError);
      }
    });
  };

  return async (progress: MaterialJobProgressUpdate) => {
    progressWriteQueue = progressWriteQueue
      .catch(() => {})
      .then(() => writeProgress(progress));

    await progressWriteQueue;
  };
}

function readProgressNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalPositiveInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

function shouldReportPageProgress(completed: number, total: number) {
  return completed === 1
    || completed >= total
    || completed % pdfPageProgressUpdateInterval === 0;
}

function readRetryAfterMs(retryAfter: string | null) {
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryDate = Date.parse(retryAfter);

  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return undefined;
}

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function totalMaterialProcessingPercent({
  currentPercent,
  materialStatus,
  pageAssetPercent,
  previousPercent,
  step,
  tutorReadPercent
}: {
  currentPercent: number;
  materialStatus: string;
  pageAssetPercent: number | null;
  previousPercent: number;
  step: MaterialJobStep;
  tutorReadPercent: number | null;
}) {
  if (
    materialStatus === "deleting"
    || step === "deleting_source"
    || step === "deleting_storage"
    || step === "deleting_chunks"
    || step === "deleting_material"
    || step === "failed"
    || step === "ready"
    || step === "saving_to_class"
    || step === "upload_received"
    || step === "reading_file"
    || step === "chunking_material"
  ) {
    return Math.max(previousPercent, currentPercent);
  }

  const pageContribution = (pageAssetPercent ?? 0) * 0.2;
  const tutorReadContribution = (tutorReadPercent ?? 0) * 0.45;
  const combinedPercent = Math.round(30 + pageContribution + tutorReadContribution);

  return Math.max(previousPercent, Math.min(95, combinedPercent));
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

function canonicalChunkContent(chunk: TutorKnowledgeChunk) {
  return (chunk.content.trim() || chunk.chunkText?.trim() || "").trim();
}

function embeddingFileForChunk(chunk: TutorKnowledgeChunk) {
  return isWeakPdfChunkContent(canonicalChunkContent(chunk))
    ? chunk.pdfPart ?? chunk.pageImage
    : undefined;
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

function isPdfSource(fileName: string, contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/pdf" || getFileExtension(fileName) === ".pdf";
}

function isHtmlSource(contentType: string, fileName: string) {
  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase();

  return normalizedContentType === "text/html" || [".html", ".htm"].includes(getFileExtension(fileName));
}

function isTextSource(contentType: string, fileName: string) {
  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase();

  return supportedContentTypes.has(normalizedContentType) || [".txt", ".md", ".csv"].includes(getFileExtension(fileName));
}

async function downloadTutorKnowledgeUrl(sourceUrl: string) {
  let currentUrl = await validatePublicTutorKnowledgeUrl(sourceUrl);

  for (let redirectCount = 0; redirectCount <= maxTutorKnowledgeUrlRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(currentUrl.toString(), {
        headers: {
          Accept: "application/pdf,text/html,text/plain,text/markdown,text/csv,*/*;q=0.5",
          "User-Agent": "ChandraTutorKnowledgeBot/1.0"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          throw new TutorKnowledgeHttpError("The URL redirected without a location header.", 400);
        }

        currentUrl = await validatePublicTutorKnowledgeUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) {
        throw new TutorKnowledgeHttpError(`The URL could not be downloaded. HTTP ${response.status}.`, 400);
      }

      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const contentLength = Number(response.headers.get("content-length") ?? 0);

      if (contentLength > maxTutorKnowledgeFileBytes) {
        throw new TutorKnowledgeHttpError(
          `URL sources must be ${Math.floor(maxTutorKnowledgeFileBytes / 1024 / 1024)} MB or smaller.`,
          413
        );
      }

      const buffer = await readResponseBodyWithLimit(response);
      const fileName = fileNameFromUrl(currentUrl, contentType);

      if (!isPdfSource(fileName, contentType) && !isHtmlSource(contentType, fileName) && !isTextSource(contentType, fileName)) {
        throw new TutorKnowledgeHttpError("This URL is not a supported PDF, HTML, TXT, MD, or CSV source.", 415);
      }

      return {
        buffer,
        contentType,
        fileName,
        finalUrl: currentUrl.toString()
      };
    } catch (caughtError) {
      if (caughtError instanceof TutorKnowledgeHttpError) {
        throw caughtError;
      }

      throw new TutorKnowledgeHttpError(
        caughtError instanceof Error && caughtError.name === "AbortError"
          ? "The URL download timed out."
          : "The URL could not be downloaded. Make sure it is public and reachable.",
        400
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new TutorKnowledgeHttpError("The URL redirected too many times.", 400);
}

async function validatePublicTutorKnowledgeUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TutorKnowledgeHttpError("Paste a valid HTTP or HTTPS URL.", 400);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new TutorKnowledgeHttpError("Only HTTP and HTTPS URLs are supported.", 400);
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new TutorKnowledgeHttpError("Private, local, and internal URLs are not supported.", 400);
  }

  const addresses = await lookup(parsed.hostname, { all: true }).catch(() => []);

  if (!addresses.length || addresses.some((address) => isPrivateIpAddress(address.address))) {
    throw new TutorKnowledgeHttpError("Private, local, and internal URLs are not supported.", 400);
  }

  parsed.hash = "";
  return parsed;
}

function isRedirectStatus(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readResponseBodyWithLimit(response: Response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;

    if (totalBytes > maxTutorKnowledgeFileBytes) {
      throw new TutorKnowledgeHttpError(
        `URL sources must be ${Math.floor(maxTutorKnowledgeFileBytes / 1024 / 1024)} MB or smaller.`,
        413
      );
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isPrivateIpAddress(normalized)
  );
}

function isPrivateIpAddress(address: string) {
  const version = isIP(address);

  if (version === 0) {
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }

  const parts = address.split(".").map((part) => Number(part));
  const [first, second] = parts;

  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function fileNameFromUrl(url: URL, contentType: string) {
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").trim();
  const fallbackExtension = isPdfSource("", contentType)
    ? ".pdf"
    : isHtmlSource(contentType, "")
      ? ".html"
      : contentType.includes("csv")
        ? ".csv"
        : contentType.includes("markdown")
          ? ".md"
          : ".txt";
  const fileName = pathName && getFileExtension(pathName) ? pathName : `url-source${fallbackExtension}`;

  return sanitizeFileName(fileName);
}

function extractReadableHtmlText(html: string) {
  const withoutHidden = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  return decodeBasicHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeBasicHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
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
