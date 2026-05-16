import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { isIP } from "net";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { adminAuth, adminDb, adminStorage, assertFirebaseAdminReady } from "./firebase-admin";
import {
  buildPdfOcrMetadataRecords,
  runGoogleDocumentAiPdfOcr
} from "./google-document-ai-ocr";
import {
  emptyClassAccessPermissions,
  normalizeClassAccessPermissions,
  normalizeClassAccessRole,
  sourceDefaultsForMaterialKind,
  type ClassAccessPermission
} from "./class-settings";
import {
  assertPdfOcrPostgresConfigured,
  deletePdfOcrMetadata,
  getPdfOcrPool,
  getPdfPageAssetRecords,
  replacePdfOcrMetadata
} from "./pdf-ocr-postgres";
import { syncPdfPagesToAgentSearch, type AgentSearchSyncSummary } from "./gemini-enterprise-sync";
import {
  chunkTutorKnowledgeText,
  getTutorKnowledgeSourceMode,
  isTutorKnowledgeKind,
  supportedTutorKnowledgeExtensions,
  type TutorKnowledgeChunk
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
import { firebaseConfig } from "./firebase-config";
import {
  canonicalOriginalPdfPath,
  canonicalPdfPageAssetPath,
  deleteGcsPdfAssetPrefix,
  downloadGcsPdfAssetBuffer,
  getGcsPdfAssetsBucketName,
  isGcsPdfAssetsBucket,
  saveGcsPdfAsset
} from "./gcs-pdf-page-assets";
import { getClassSnapshotPostgresFirst, tryPostgresData } from "./data/server";
import {
  deleteMaterial,
  getMaterialById,
  updateMaterialStatus,
  updateMaterialVisibility,
  upsertMaterial,
  upsertMaterialJob
} from "./data/materials";

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
  fileSha256?: string;
  filePath?: string;
  fileSize: number;
  fileUrl?: string;
  originalSourceUrl?: string;
  sourceKind: "file" | "storage" | "url";
  sourceUrl?: string;
  storageBucket?: string;
};

type UploadedStorageSource = {
  file: File | null;
  metadata: TutorKnowledgeOriginalSource;
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
const pdfPageAssetSaveConcurrencyLimit = 4;
const maxTutorKnowledgeFileBytes = 500 * 1024 * 1024;
const maxTutorKnowledgePastedTextCharacters = 250000;
const maxTutorKnowledgeUrlRedirects = 4;

export { TutorKnowledgeHttpError } from "./tutor-knowledge-errors";

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
  | "ocr_material"
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

export async function authorizeClassAccess(
  request: Request,
  classId: string,
  permission: ClassAccessPermission
) {
  const token = getBearerToken(request);

  if (!token) {
    throw new TutorKnowledgeHttpError("Sign in as class staff to use this class.", 401);
  }

  assertFirebaseAdminReady();

  const decodedToken = await adminAuth!.verifyIdToken(token);
  const classSnapshot = await getClassSnapshotPostgresFirst(classId);

  if (!classSnapshot.exists) {
    throw new TutorKnowledgeHttpError("Class not found.", 404);
  }

  const classData = classSnapshot.data;
  const access = readClassAccess(classData, decodedToken.uid);

  if (!access.permissions[permission]) {
    throw new TutorKnowledgeHttpError("You do not have permission to use this class feature.", 403);
  }

  return {
    accessRole: access.role,
    classSnapshot: {
      id: classSnapshot.id,
      exists: classSnapshot.exists,
      data: () => classData
    },
    email: decodedToken.email,
    permissions: access.permissions,
    uid: decodedToken.uid
  };
}

export async function authorizeClassTeacher(request: Request, classId: string) {
  const authorization = await authorizeClassAccess(request, classId, "manageClassSettings");

  if (authorization.accessRole !== "owner" && authorization.accessRole !== "co-teacher") {
    throw new TutorKnowledgeHttpError("Only the class teacher can manage tutor knowledge.", 403);
  }

  return authorization;
}

function readClassAccess(classData: Record<string, unknown>, uid: string) {
  if (classData.teacherId === uid) {
    return {
      permissions: normalizeClassAccessPermissions({}, "owner"),
      role: "owner" as const
    };
  }

  const coTeacher = readCoTeacher(classData.coTeachers, uid);
  const role = normalizeClassAccessRole(coTeacher?.role);

  if (!coTeacher || role === "owner") {
    return {
      permissions: { ...emptyClassAccessPermissions },
      role: "viewer" as const
    };
  }

  return {
    permissions: normalizeClassAccessPermissions(coTeacher.permissions ?? coTeacher, role),
    role
  };
}

function readCoTeacher(coTeachers: unknown, uid: string): Record<string, unknown> | null {
  if (!coTeachers || typeof coTeachers !== "object" || Array.isArray(coTeachers)) {
    return null;
  }

  const coTeacher = (coTeachers as Record<string, unknown>)[uid];

  if (!coTeacher || typeof coTeacher !== "object" || Array.isArray(coTeacher)) {
    return null;
  }

  return coTeacher as Record<string, unknown>;
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
  const materialType = materialTypeForKind(kind);
  const initialSourceSettings = normalizeTutorKnowledgeSourceSettings(defaultSourceSettingsForKind(kind));
  const sourceMode = getTutorKnowledgeSourceMode({
    hasFile: Boolean(file || sourceUrl || storagePath),
    hasPastedText: Boolean(pastedText)
  });

  await tryPostgresData("material.metadata.initial.write", () =>
    upsertMaterial({
      id: materialRef.id,
      classId,
      teacherId,
      title,
      kind,
      activeForStudents: initialSourceSettings.activeForStudents,
      citationsRequired: initialSourceSettings.requireCitations,
      materialType,
      metadata: {
        professorName: professorName ?? "",
        sourceKind: file || storagePath ? "file" : sourceUrl ? "url" : "pasted"
      },
      priority: initialSourceSettings.priority,
      sourceMode,
      status: "processing",
      teacherOnly: initialSourceSettings.teacherOnly
    })
  );

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
  let fileMetadata: Partial<TutorKnowledgeOriginalSource> = {};

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
      ?? (
        file
          ? await uploadTutorKnowledgeFile({ classId, file, materialId: materialRef.id, updateProgress })
          : sourceUrl
            ? await uploadTutorKnowledgeUrlAsPdfSource({
                classId,
                materialId: materialRef.id,
                sourceUrl,
                title,
                updateProgress
              })
            : {}
      )
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
  const classSnapshot = await getClassSnapshotPostgresFirst(classId);
  const configuredSourceDefaults = sourceDefaultsForMaterialKind(classSnapshot.data.sourceDefaults, kind);
  const sourceSettings = normalizeTutorKnowledgeSourceSettings({
    ...defaultSourceSettingsForKind(kind),
    activeForStudents: configuredSourceDefaults.activeForStudents,
    priority: configuredSourceDefaults.priority,
    requireCitations: configuredSourceDefaults.citationsRequired,
    teacherOnly: configuredSourceDefaults.teacherOnly
  });

  await tryPostgresData("material.metadata.processing.write", () =>
    upsertMaterial({
      id: materialRef.id,
      classId,
      teacherId,
      title,
      kind,
      activeForStudents: sourceSettings.activeForStudents,
      citationsRequired: sourceSettings.requireCitations,
      contentType: fileMetadata.contentType ?? null,
      fileName: fileMetadata.fileName ?? null,
      fileSize: fileMetadata.fileSize ?? 0,
      fileUrl: fileMetadata.fileUrl ?? null,
      materialType,
      metadata: {
        professorName: professorName ?? "",
        sourceKind: fileMetadata.sourceKind ?? (sourceUrl ? "url" : pastedText ? "pasted" : "file")
      },
      priority: sourceSettings.priority,
      sourceMode,
      status: "processing",
      storageBucket: fileMetadata.storageBucket ?? null,
      storagePath: fileMetadata.filePath ?? null,
      teacherOnly: sourceSettings.teacherOnly
    })
  );

  if (
    fileMetadata.filePath
    && fileMetadata.storageBucket
    && isPdfSource(fileMetadata.fileName ?? sourceFile?.name ?? "", fileMetadata.contentType ?? sourceFile?.type ?? "")
  ) {
    const pdfContentType = fileMetadata.contentType ?? sourceFile?.type ?? "application/pdf";
    const pdfFileName = fileMetadata.fileName ?? sourceFile?.name ?? title;

    try {
      return await savePdfTutorKnowledgeOcrMetadata({
        classId,
        contentType: pdfContentType || "application/pdf",
        fileName: pdfFileName,
        fileSize: fileMetadata.fileSize ?? sourceFile?.size ?? 0,
        kind,
        materialId: materialRef.id,
        materialRef,
        materialType,
        pastedText,
        professorName,
        sourceKind: fileMetadata.sourceKind ?? "file",
        sourceSettings,
        storageBucket: fileMetadata.storageBucket,
        storagePath: fileMetadata.filePath,
        storageSha256: fileMetadata.fileSha256,
        teacherId,
        title,
        updateProgress
      });
    } catch (caughtError) {
      const errorMessage = caughtError instanceof Error ? caughtError.message : String(caughtError);

      await markMaterialProcessingFailed({
        errorMessage,
        materialId: materialRef.id,
        updateProgress
      });
      throw caughtError;
    }
  }

  const ingestion = await buildTutorKnowledgeIngestion({
    docId: materialRef.id,
    file: sourceFile,
    pastedText,
    sourceUrl,
    title,
    updateProgress
  });
  const searchableText = ingestion.searchableText;
  const chunks = ingestion.chunks;

  if (!searchableText && !chunks.length) {
    throw new TutorKnowledgeHttpError("No tutor knowledge text was found. This source may be private, scanned, or unsupported.", 400);
  }

  await tryPostgresData("material.metadata.write", () =>
    upsertMaterial({
      id: materialRef.id,
      classId,
      teacherId,
      title,
      kind,
      activeForStudents: sourceSettings.activeForStudents,
      citationsRequired: sourceSettings.requireCitations,
      contentType: fileMetadata.contentType ?? null,
      fileName: fileMetadata.fileName ?? null,
      fileSize: fileMetadata.fileSize ?? 0,
      fileUrl: fileMetadata.fileUrl ?? null,
      materialType,
      metadata: {
        professorName: professorName ?? "",
        sourceKind: fileMetadata.sourceKind ?? "pasted",
        textSource: pastedText || undefined,
        visualPageCount: ingestion.visualPageCount
      },
      priority: sourceSettings.priority,
      sourceMode: getTutorKnowledgeSourceMode({
        hasFile: Boolean(sourceFile || sourceUrl),
        hasPastedText: Boolean(pastedText)
      }),
      status: "processing",
      storageBucket: fileMetadata.storageBucket ?? null,
      storagePath: fileMetadata.filePath ?? null,
      teacherOnly: sourceSettings.teacherOnly
    })
  );

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
      hasFile: Boolean(sourceFile || sourceUrl),
      hasPastedText: Boolean(pastedText)
    }),
    ...ingestion.sourceMetadata,
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
      status: "ready"
    });
    await tryPostgresData("material.status.ready", () =>
      updateMaterialStatus({
        characterCount: searchableText.length,
        chunkCount: chunks.length,
        id: materialRef.id,
        status: "ready"
      })
    );
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
      await tryPostgresData("material.status.failed", () =>
        updateMaterialStatus({ id: materialRef.id, status: "failed" })
      );
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

async function savePdfTutorKnowledgeOcrMetadata({
  classId,
  contentType,
  fileName,
  fileSize,
  kind,
  materialId,
  materialRef,
  materialType,
  pastedText,
  professorName,
  sourceKind,
  sourceSettings,
  storageBucket,
  storagePath,
  storageSha256,
  teacherId,
  title,
  updateProgress
}: {
  classId: string;
  contentType: string;
  fileName: string;
  fileSize: number;
  kind: string;
  materialId: string;
  materialRef: DocumentReference;
  materialType: string;
  pastedText: string;
  professorName?: string;
  sourceKind: TutorKnowledgeOriginalSource["sourceKind"];
  sourceSettings: TutorKnowledgeSourceSettings;
  storageBucket: string;
  storagePath: string;
  storageSha256?: string;
  teacherId: string;
  title: string;
  updateProgress: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  assertPdfOcrPostgresConfigured();
  await updateProgress({
    detail: "Saving the canonical PDF in dedicated page asset storage.",
    percent: 35,
    step: "ocr_material"
  });

  const canonicalFullPdf = await saveCanonicalOriginalPdfAsset({
    classId,
    contentType: contentType || "application/pdf",
    fileName,
    materialId,
    sourceFileSize: fileSize,
    sourceStorageBucket: storageBucket,
    sourceStoragePath: storagePath,
    sourceStorageSha256: storageSha256
  });
  const canonicalStorageBucket = canonicalFullPdf.bucket;
  const canonicalStoragePath = canonicalFullPdf.path;

  await updateProgress({
    detail: "Running Google Document AI OCR on the canonical PDF.",
    percent: 40,
    step: "ocr_material"
  });

  const ocr = await runGoogleDocumentAiPdfOcr({
    classId,
    materialId,
    mimeType: contentType || "application/pdf",
    onProgress: async (progress) => {
      if (progress.phase === "started") {
        await updateProgress({
          detail: `Running Google Document AI OCR on ${progress.totalShards ?? 1} PDF shard${progress.totalShards === 1 ? "" : "s"}.`,
          percent: 41,
          totalChunks: progress.totalShards,
          step: "ocr_material"
        });
        return;
      }

      if (progress.phase === "processing") {
        const completed = progress.completedShards ?? 0;
        const total = progress.totalShards ?? 1;
        await updateProgress({
          completedChunks: completed,
          detail: `OCR shard ${completed} of ${total} complete${progress.pageStart && progress.pageEnd ? ` (pages ${progress.pageStart}-${progress.pageEnd})` : ""}.`,
          percent: Math.min(49, 41 + Math.round((completed / Math.max(total, 1)) * 8)),
          totalChunks: total,
          step: "ocr_material"
        });
      }
    },
    storageBucket: canonicalStorageBucket,
    storagePath: canonicalStoragePath
  });
  const records = buildPdfOcrMetadataRecords({
    classId,
    contentType: contentType || "application/pdf",
    fileName,
    fileSize,
    fullPdfBucket: canonicalFullPdf.bucket,
    fullPdfMimeType: canonicalFullPdf.mimeType,
    fullPdfPath: canonicalFullPdf.path,
    fullPdfSha256: canonicalFullPdf.sha256,
    fullPdfSize: canonicalFullPdf.size,
    fullPdfUri: canonicalFullPdf.uri,
    materialId,
    materialType,
    ocr,
    sourceKind,
    storageBucket: canonicalStorageBucket,
    storagePath: canonicalStoragePath,
    teacherId,
    title
  });

  if (!records.pages.length) {
    throw new TutorKnowledgeHttpError("Google Document AI OCR did not return any PDF pages.", 502);
  }

  await updateProgress({
    completedChunks: 0,
    detail: "Saving exact single-page PDF assets for OCR pages.",
    percent: 50,
    step: "ocr_material",
    totalChunks: records.pages.length
  });
  await saveCanonicalPdfPageAssets({
    classId,
    materialId,
    pages: records.pages,
    storageBucket: canonicalStorageBucket,
    storagePath: canonicalStoragePath
  });

  await updateProgress({
    detail: "Saving OCR page and problem metadata to PostgreSQL.",
    percent: 65,
    step: "saving_to_class",
    totalChunks: records.pages.length
  });
  await replacePdfOcrMetadata({
    material: records.material,
    pages: records.pages,
    problems: records.problems
  });
  const agentSearchSync = await syncSavedPdfPagesToAgentSearch({
    classId,
    pages: records.pages.map((page) => ({
      materialId: page.materialId,
      pageNumber: page.pageNumber
    })),
    teacherId,
    updateProgress
  });
  await tryPostgresData("material.pdf.metadata.write", () =>
    upsertMaterial({
      id: materialId,
      classId,
      teacherId,
      title,
      kind,
      activeForStudents: sourceSettings.activeForStudents,
      citationsRequired: sourceSettings.requireCitations,
      contentType: contentType || "application/pdf",
      fileName,
      fileSize,
      fileUrl: canonicalFullPdf.uri,
      materialType,
      metadata: {
        ocrInputShardCount: ocr.inputShardCount,
        ocrInputShardPageCount: ocr.inputShardPageCount,
        ocrOutputPrefix: ocr.outputPrefix,
        ocrPageCount: records.pageCount,
        ocrProblemCount: records.problems.length,
        ocrProvider: records.material.ocrProvider,
        ocrSource: records.material.ocrSource,
        pageCount: records.pageCount,
        agentSearchImportedCount: agentSearchSync.importedCount,
        agentSearchOperationNames: agentSearchSync.operationNames,
        agentSearchSkippedReason: agentSearchSync.skippedReason || undefined,
        agentSearchSyncStatus: agentSearchSync.status,
        professorName: professorName ?? "",
        sourceKind,
        textSource: pastedText || undefined,
        visualPageCount: records.pageCount
      },
      priority: sourceSettings.priority,
      searchMetadataSource: "postgres",
      sourceMode: getTutorKnowledgeSourceMode({
        hasFile: true,
        hasPastedText: Boolean(pastedText)
      }),
      status: "ready",
      storageBucket: canonicalStorageBucket,
      storagePath: canonicalStoragePath,
      storageUri: records.material.storageUri,
      teacherOnly: sourceSettings.teacherOnly
    })
  );

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
    characterCount: records.characterCount + pastedText.length,
    chunkCount: 0,
    contentType: contentType || "application/pdf",
    embeddingProvider: "none",
    embeddingStatus: "not-configured",
    fileName,
    filePath: canonicalStoragePath,
    fileSize,
    fileUrl: canonicalFullPdf.uri,
    fullPdfBucket: canonicalFullPdf.bucket,
    fullPdfPath: canonicalFullPdf.path,
    fullPdfUri: canonicalFullPdf.uri,
    fullPdfMimeType: canonicalFullPdf.mimeType,
    fullPdfSize: canonicalFullPdf.size,
    fullPdfSha256: canonicalFullPdf.sha256,
    indexedAt: FieldValue.serverTimestamp(),
    ocrInputShardCount: ocr.inputShardCount,
    ocrInputShardPageCount: ocr.inputShardPageCount,
    ocrOutputPrefix: ocr.outputPrefix,
    ocrPageCount: records.pageCount,
    ocrProblemCount: records.problems.length,
    ocrProvider: records.material.ocrProvider,
    ocrSource: records.material.ocrSource,
    ocrConfidence: records.material.ocrConfidence,
    pageCount: records.pageCount,
    agentSearchImportedCount: agentSearchSync.importedCount,
    agentSearchOperationNames: agentSearchSync.operationNames,
    agentSearchSkippedReason: agentSearchSync.skippedReason || "",
    agentSearchSyncStatus: agentSearchSync.status,
    searchMetadataSource: "postgres",
    sourceKind,
    sourceMode: getTutorKnowledgeSourceMode({
      hasFile: true,
      hasPastedText: Boolean(pastedText)
    }),
    status: "ready",
    storageBucket: canonicalStorageBucket,
    ...(pastedText ? { textSource: pastedText } : {}),
    visualPageCount: records.pageCount,
    addedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  });

  await updateProgress({
    completedChunks: records.pages.length,
    detail: "PDF OCR metadata is ready for retrieval.",
    percent: 100,
    step: "ready",
    totalChunks: records.pages.length
  });

  return {
    id: materialId,
    characterCount: records.characterCount + pastedText.length,
    chunkCount: 0
  };
}

async function syncSavedPdfPagesToAgentSearch({
  classId,
  pages,
  teacherId,
  updateProgress
}: {
  classId: string;
  pages: Array<{ materialId: string; pageNumber: number }>;
  teacherId: string;
  updateProgress: (progress: MaterialJobProgressUpdate) => Promise<void>;
}): Promise<AgentSearchSyncSummary> {
  const pageCount = pages.length;

  await updateProgress({
    completedChunks: 0,
    detail: "Sending single-page PDFs to Gemini Agent Search.",
    percent: 78,
    step: "saving_to_class",
    totalChunks: pageCount
  });

  try {
    const persistedPages = await getPdfPageAssetRecords({
      classId,
      professorId: teacherId,
      pages
    });

    const summary = await syncPdfPagesToAgentSearch({
      pages: persistedPages,
      pool: getPdfOcrPool()
    });

    await updateProgress({
      completedChunks: pageCount,
      detail: agentSearchSyncProgressDetail(summary),
      percent: 85,
      step: "saving_to_class",
      totalChunks: pageCount
    });

    return summary;
  } catch (caughtError) {
    console.error("Gemini Agent Search PDF page sync failed.", caughtError);

    const message = caughtError instanceof Error ? caughtError.message : String(caughtError);

    await updateProgress({
      completedChunks: 0,
      detail: "Gemini Agent Search sync failed; PostgreSQL OCR metadata remains available.",
      error: message,
      percent: 85,
      step: "saving_to_class",
      totalChunks: pageCount
    });

    return {
      importedCount: 0,
      operationNames: [],
      skippedReason: message,
      status: "failed"
    };
  }
}

function agentSearchSyncProgressDetail(summary: AgentSearchSyncSummary) {
  if (summary.status === "import_requested") {
    return `Requested Gemini Agent Search import for ${summary.importedCount} single-page PDF${summary.importedCount === 1 ? "" : "s"}.`;
  }

  if (summary.status === "skipped" && summary.skippedReason) {
    return `Gemini Agent Search sync skipped: ${summary.skippedReason}.`;
  }

  if (summary.status === "disabled") {
    return "Gemini Agent Search sync is disabled.";
  }

  if (summary.status === "not-configured") {
    return `Gemini Agent Search sync is not configured: ${summary.skippedReason}.`;
  }

  return "Gemini Agent Search sync did not import new pages.";
}

async function saveCanonicalOriginalPdfAsset({
  classId,
  contentType,
  fileName,
  materialId,
  sourceFileSize,
  sourceStorageBucket,
  sourceStoragePath,
  sourceStorageSha256
}: {
  classId: string;
  contentType: string;
  fileName: string;
  materialId: string;
  sourceFileSize: number;
  sourceStorageBucket: string;
  sourceStoragePath: string;
  sourceStorageSha256?: string;
}) {
  const bucketName = getGcsPdfAssetsBucketName();
  const path = canonicalOriginalPdfPath({
    classId,
    materialId,
    safeFileName: sanitizeFileName(fileName)
  });

  if (sourceStorageBucket === bucketName && sourceStoragePath === path) {
    return {
      bucket: bucketName,
      path,
      uri: `gs://${bucketName}/${path}`,
      mimeType: contentType || "application/pdf",
      size: sourceFileSize,
      sha256: sourceStorageSha256 ?? ""
    };
  }

  const sourceBuffer = await downloadTutorKnowledgeStorageBuffer({
    storageBucket: sourceStorageBucket,
    storagePath: sourceStoragePath
  });

  return saveGcsPdfAsset({
    bucketName,
    buffer: sourceBuffer,
    contentType: contentType || "application/pdf",
    metadata: {
      sourceStorageBucket,
      sourceStoragePath
    },
    path
  });
}

async function saveCanonicalPdfPageAssets({
  classId,
  materialId,
  pages,
  storageBucket,
  storagePath
}: {
  classId: string;
  materialId: string;
  pages: Array<Parameters<typeof replacePdfOcrMetadata>[0]["pages"][number]>;
  storageBucket: string;
  storagePath: string;
}) {
  const sourceBuffer = await downloadGcsPdfAssetBuffer({ bucketName: storageBucket, path: storagePath });
  const sourcePdf = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  const sourcePageCount = sourcePdf.getPageCount();

  await mapWithConcurrency(pages, pdfPageAssetSaveConcurrencyLimit, async (page) => {
    const pageIndex = page.pageNumber - 1;

    if (pageIndex < 0 || pageIndex >= sourcePageCount) {
      throw new TutorKnowledgeHttpError(`OCR returned page ${page.pageNumber}, but the stored PDF has ${sourcePageCount} pages.`, 502);
    }

    const pagePdf = await PDFDocument.create();
    const [copiedPage] = await pagePdf.copyPages(sourcePdf, [pageIndex]);
    pagePdf.addPage(copiedPage);

    const pageBuffer = Buffer.from(await pagePdf.save());
    const pageAssetStoragePath = canonicalPdfPageAssetPath({
      classId,
      materialId,
      pageNumber: page.pageNumber
    });
    const pageAsset = await saveGcsPdfAsset({
      bucketName: storageBucket,
      buffer: pageBuffer,
      contentType: "application/pdf",
      metadata: {
        sourcePageNumber: String(page.pageNumber)
      },
      path: pageAssetStoragePath
    });

    page.pageAssetBucket = pageAsset.bucket;
    page.pageAssetPath = pageAsset.path;
    page.pageAssetUri = pageAsset.uri;
    page.pageAssetMimeType = pageAsset.mimeType;
    page.pageAssetSize = pageAsset.size;
    page.pageAssetSha256 = pageAsset.sha256;
    page.pageAssetStorageBucket = pageAsset.bucket;
    page.pageAssetStoragePath = pageAsset.path;
    page.pageAssetSizeBytes = pageAsset.size;
    page.pageAssetChecksumSha256 = pageAsset.sha256;
  });
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

  const postgresMaterial = materialSnapshot.exists
    ? null
    : await tryPostgresData("material.delete.read", () => getMaterialById(materialId));

  if (!materialSnapshot.exists && !postgresMaterial) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const material = materialSnapshot.exists
    ? materialSnapshot.data() ?? {}
    : {
        filePath: postgresMaterial?.storagePath,
        storageBucket: postgresMaterial?.storageBucket
      };
  const filePath = String(material.filePath ?? "");
  const storageBucket = String(material.storageBucket ?? "").trim();
  const [chunksSnapshot, jobsSnapshot] = await Promise.all([
    materialRef.collection("chunks").get(),
    adminDb!
      .collection("classes")
      .doc(classId)
      .collection("materialJobs")
      .where("materialId", "==", materialId)
      .get()
  ]);

  await deleteMaterialStorageFiles({ classId, filePath, materialId, storageBucket });
  await deletePdfOcrMetadata(materialId);
  await tryPostgresData("material.delete", () => deleteMaterial(materialId));
  await deleteDocumentsInBatches([
    ...chunksSnapshot.docs.map((chunkDoc) => chunkDoc.ref),
    ...jobsSnapshot.docs.map((jobDoc) => jobDoc.ref)
  ]);
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
  const postgresMaterial = materialSnapshot.exists
    ? null
    : await tryPostgresData("material.visibility.read", () => getMaterialById(materialId));

  if (!materialSnapshot.exists && !postgresMaterial) {
    throw new TutorKnowledgeHttpError("Tutor knowledge not found.", 404);
  }

  const currentSettings = materialSnapshot.exists
    ? sourceSettingsFromMaterial(materialSnapshot.data() ?? {})
    : {
        activeForStudents: postgresMaterial!.activeForStudents,
        priority: postgresMaterial!.priority,
        requireCitations: postgresMaterial!.citationsRequired,
        teacherOnly: postgresMaterial!.teacherOnly
      };
  const normalizedSettings = normalizeTutorKnowledgeSourceSettings({
    ...currentSettings,
    ...settings
  });

  if (materialSnapshot.exists) {
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
  }
  await tryPostgresData("material.visibility.write", () =>
    updateMaterialVisibility({
      activeForStudents: normalizedSettings.activeForStudents,
      citationsRequired: normalizedSettings.requireCitations,
      id: materialId,
      priority: normalizedSettings.priority,
      teacherOnly: normalizedSettings.teacherOnly
    })
  );

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
    docId: materialId,
    file,
    pastedText: textSource || fallbackText,
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
  const contentType = file.type || contentTypeFromFileName(file.name);
  await updateProgress?.({
    detail: isPdfSource(file.name, contentType)
      ? "Saving the original PDF to dedicated page asset storage."
      : "Saving the original source file to Firebase Storage.",
    percent: 20,
    step: "upload_received"
  });
  const buffer = Buffer.from(await file.arrayBuffer());
  const safeFileName = sanitizeFileName(file.name);
  const filePath = `classes/${classId}/materials/${materialId}/original/${safeFileName}`;

  if (isPdfSource(file.name, contentType)) {
    try {
      const asset = await saveGcsPdfAsset({
        buffer,
        contentType: contentType || "application/pdf",
        metadata: {
          classId,
          materialId,
          sourceKind: "teacher-upload"
        },
        path: canonicalOriginalPdfPath({
          classId,
          materialId,
          safeFileName
        })
      });

      return {
        fileName: file.name,
        filePath: asset.path,
        fileSha256: asset.sha256,
        fileUrl: `https://storage.googleapis.com/${asset.bucket}/${asset.path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`,
        contentType: asset.mimeType,
        fileSize: asset.size,
        sourceKind: "file",
        storageBucket: asset.bucket
      } satisfies TutorKnowledgeOriginalSource;
    } catch (caughtError) {
      console.error("Tutor knowledge original PDF GCS upload failed.", caughtError);

      throw new TutorKnowledgeHttpError(
        caughtError instanceof Error
          ? `Original PDF file could not be saved: ${caughtError.message}`
          : "Original PDF file could not be saved.",
        502
      );
    }
  }

  const downloadToken = randomUUID();
  const storageFile = adminStorage!.bucket().file(filePath);

  try {
    await storageFile.save(buffer, {
      contentType,
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
    contentType,
    fileSize: file.size,
    sourceKind: "file",
    storageBucket: bucketName
  } satisfies TutorKnowledgeOriginalSource;
}

async function uploadTutorKnowledgeUrlAsPdfSource({
  classId,
  materialId,
  sourceUrl,
  title,
  updateProgress
}: {
  classId: string;
  materialId: string;
  sourceUrl: string;
  title: string;
  updateProgress?: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  await updateProgress?.({
    detail: "Downloading the URL and preparing a PDF source.",
    percent: 20,
    step: "upload_received"
  });

  const downloaded = await downloadTutorKnowledgeUrl(sourceUrl);
  const originalContentType = downloaded.contentType || contentTypeFromFileName(downloaded.fileName);
  const isDownloadedPdf = isPdfSource(downloaded.fileName, originalContentType);
  const pdfBuffer = isDownloadedPdf
    ? downloaded.buffer
    : await createPdfFromDownloadedUrlSource({
        buffer: downloaded.buffer,
        contentType: originalContentType,
        fileName: downloaded.fileName,
        finalUrl: downloaded.finalUrl,
        title
      });
  const pdfFileName = isDownloadedPdf
    ? ensurePdfFileName(downloaded.fileName)
    : pdfFileNameForUrlSource(downloaded.fileName, title);
  const safeFileName = sanitizeFileName(pdfFileName);

  try {
    const asset = await saveGcsPdfAsset({
      buffer: pdfBuffer,
      contentType: "application/pdf",
      metadata: {
        classId,
        materialId,
        originalContentType,
        originalSourceUrl: sourceUrl,
        sourceKind: "url",
        sourceUrl: downloaded.finalUrl
      },
      path: canonicalOriginalPdfPath({
        classId,
        materialId,
        safeFileName
      })
    });

    return {
      contentType: asset.mimeType,
      fileName: pdfFileName,
      filePath: asset.path,
      fileSha256: asset.sha256,
      fileSize: asset.size,
      fileUrl: `https://storage.googleapis.com/${asset.bucket}/${asset.path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`,
      originalSourceUrl: sourceUrl,
      sourceKind: "url",
      sourceUrl: downloaded.finalUrl,
      storageBucket: asset.bucket
    } satisfies TutorKnowledgeOriginalSource;
  } catch (caughtError) {
    console.error("Tutor knowledge URL PDF upload failed.", caughtError);

    throw new TutorKnowledgeHttpError(
      caughtError instanceof Error
        ? `URL source PDF could not be saved: ${caughtError.message}`
        : "URL source PDF could not be saved.",
      502
    );
  }
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
  const materialStoragePrefix = `classes/${classId}/materials/${materialId}/`;
  const firebaseBuckets = new Map<string, ReturnType<typeof resolveTutorKnowledgeStorageBucket>>();
  const defaultFirebaseBucket = resolveTutorKnowledgeStorageBucket();
  firebaseBuckets.set(defaultFirebaseBucket.name, defaultFirebaseBucket);

  if (storageBucket && !isGcsPdfAssetsBucket(storageBucket)) {
    const requestedBucket = resolveTutorKnowledgeStorageBucket(storageBucket);
    firebaseBuckets.set(requestedBucket.name, requestedBucket);
  }

  await Promise.all(
    Array.from(firebaseBuckets.values()).map(async (bucket) => {
      const [files] = await bucket.getFiles({ prefix: materialStoragePrefix });
      const filePaths = new Set(files.map((file) => file.name));

      if (filePath && !isGcsPdfAssetsBucket(storageBucket)) {
        filePaths.add(filePath);
      }

      await Promise.all(Array.from(filePaths).map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
    })
  );

  if (filePath && isGcsPdfAssetsBucket(storageBucket)) {
    await deleteGcsPdfAssetPrefix({
      bucketName: storageBucket,
      prefix: materialStoragePrefix
    });
    return;
  }

  await deleteGcsPdfAssetPrefix({
    bucketName: getGcsPdfAssetsBucketName(),
    prefix: materialStoragePrefix
  }).catch(() => {});
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

  const buffer = await downloadTutorKnowledgeStorageBuffer({ storageBucket, storagePath: filePath });
  const fileBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return new File([fileBytes], fileName, {
    type: String(material.contentType ?? "") || contentTypeFromFileName(fileName)
  });
}

async function downloadTutorKnowledgeStorageBuffer({
  storageBucket,
  storagePath
}: {
  storageBucket?: string;
  storagePath: string;
}) {
  if (isGcsPdfAssetsBucket(storageBucket)) {
    return downloadGcsPdfAssetBuffer({ bucketName: storageBucket, path: storagePath });
  }

  const [buffer] = await resolveTutorKnowledgeStorageBucket(storageBucket).file(storagePath).download();
  return buffer;
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
}): Promise<UploadedStorageSource> {
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
  const bucketName = bucket.name;
  const encodedPath = storagePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const metadataResult = {
    contentType,
    fileName,
    filePath: storagePath,
    fileSize,
    fileUrl: `https://storage.googleapis.com/${bucketName}/${encodedPath}`,
    sourceKind: "storage",
    storageBucket: bucketName
  } satisfies TutorKnowledgeOriginalSource;

  if (isPdfSource(fileName, contentType)) {
    return {
      file: null,
      metadata: metadataResult
    };
  }

  const [buffer] = await storageFile.download();
  const fileBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return {
    file: new File([fileBytes], fileName, { type: contentType }),
    metadata: metadataResult
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
  docId,
  file,
  pastedText,
  sourceUrl,
  title,
  updateProgress
}: {
  docId: string;
  file: File | null;
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
        docId,
        sourceUrl: normalizedSourceUrl,
        title
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
    sourceMetadata: urlIngestion.metadata,
    visualPageCount: urlIngestion.visualPageCount + fileIngestion.visualPageCount
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

  throw new TutorKnowledgeHttpError(
    "PDF files are indexed through Document AI OCR and PostgreSQL metadata, not Firestore tutor-knowledge chunks.",
    400
  );
}

async function extractChunksFromUrl({
  docId,
  sourceUrl,
  title
}: {
  docId: string;
  sourceUrl: string;
  title: string;
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
    throw new TutorKnowledgeHttpError(
      "PDF URLs are not ingested as Firestore tutor-knowledge chunks. Upload the PDF so it can be indexed through Document AI OCR and PostgreSQL metadata.",
      400
    );
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
  const embeddings = skipEmbeddings
    ? []
    : await createVertexEmbeddings(
        chunks.map((chunk) => ({
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
        taskType: "RETRIEVAL_DOCUMENT",
        text: chunk.content,
        title
      }));
  const pageNumber = chunk.pageStart ?? extractPageNumber(chunk.label);
  const sectionHeading = chunk.section ?? extractSectionHeading(chunk.content);

  return {
    ...chunk,
    classId,
    class_id: classId,
    chunkId: chunkId ?? "",
    chunkIndex,
    chunk_text: chunk.chunkText ?? chunk.content,
    course_id: classId,
    createdAt: FieldValue.serverTimestamp(),
    doc_id: chunk.docId ?? materialId,
    docId: chunk.docId ?? materialId,
    hasPageImage: false,
    hasPdfPart: false,
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

async function markMaterialProcessingFailed({
  errorMessage,
  materialId,
  updateProgress
}: {
  errorMessage: string;
  materialId: string;
  updateProgress: (progress: MaterialJobProgressUpdate) => Promise<void>;
}) {
  await Promise.allSettled([
    tryPostgresData("material.status.failed", () =>
      updateMaterialStatus({ id: materialId, status: "failed" })
    ),
    updateProgress({
      detail: "Tutor knowledge processing failed before it was ready.",
      error: errorMessage,
      percent: 100,
      step: "failed"
    })
  ]);
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
    await tryPostgresData("material.job.write", () =>
      upsertMaterialJob({
        classId,
        completedChunks: progress.completedChunks ?? null,
        detail: progress.detail,
        error: progress.error ?? null,
        id: normalizedJobId,
        materialId,
        metadata: { professorId: teacherId },
        percent: progress.percent,
        step: progress.step,
        title,
        totalChunks: progress.totalChunks ?? null
      })
    );
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

async function createPdfFromDownloadedUrlSource({
  buffer,
  contentType,
  fileName,
  finalUrl,
  title
}: {
  buffer: Buffer;
  contentType: string;
  fileName: string;
  finalUrl: string;
  title: string;
}) {
  const extractedText = isHtmlSource(contentType, fileName)
    ? extractReadableHtmlText(buffer.toString("utf8"))
    : buffer.toString("utf8").trim();

  assertTutorKnowledgeTextWithinLimit(extractedText, "Extracted URL text");

  if (!extractedText) {
    throw new TutorKnowledgeHttpError("No readable text was found at this URL.", 400);
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const lineHeight = 14;
  const fontSize = 11;
  const maxLineWidth = pageWidth - margin * 2;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawLine = (line: string, options?: { bold?: boolean; size?: number }) => {
    const size = options?.size ?? fontSize;

    if (y < margin) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }

    page.drawText(sanitizePdfText(line), {
      font: options?.bold ? boldFont : font,
      size,
      x: margin,
      y
    });
    y -= options?.size ? lineHeight + 4 : lineHeight;
  };

  drawLine(title.trim() || fileName || "URL source", { bold: true, size: 15 });
  drawLine(finalUrl, { size: 9 });
  y -= 8;

  for (const paragraph of extractedText.split(/\n{2,}/)) {
    const lines = wrapPdfText(paragraph.replace(/\s+/g, " ").trim(), font, fontSize, maxLineWidth);

    if (!lines.length) {
      y -= lineHeight;
      continue;
    }

    for (const line of lines) {
      drawLine(line);
    }

    y -= 6;
  }

  return Buffer.from(await pdf.save());
}

function wrapPdfText(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const words = sanitizePdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
      currentLine = word;
      continue;
    }

    const pieces = splitLongPdfWord(word, font, fontSize, maxWidth);
    lines.push(...pieces.slice(0, -1));
    currentLine = pieces.at(-1) ?? "";
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function splitLongPdfWord(
  word: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
) {
  const pieces: string[] = [];
  let currentPiece = "";

  for (const character of word) {
    const candidate = `${currentPiece}${character}`;

    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentPiece = candidate;
      continue;
    }

    if (currentPiece) {
      pieces.push(currentPiece);
    }

    currentPiece = character;
  }

  if (currentPiece) {
    pieces.push(currentPiece);
  }

  return pieces;
}

function sanitizePdfText(text: string) {
  return text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ");
}

function ensurePdfFileName(fileName: string) {
  return getFileExtension(fileName) === ".pdf" ? fileName : `${fileName || "url-source"}.pdf`;
}

function pdfFileNameForUrlSource(fileName: string, title: string) {
  const baseName = (title.trim() || fileName || "url-source").replace(/\.[^.]+$/, "");

  return sanitizeFileName(`${baseName}.pdf`);
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
