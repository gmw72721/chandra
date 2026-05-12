import { NextResponse } from "next/server";
import { listActiveMaterialJobsByClass, listClassMaterials, type MaterialJobRecord, type MaterialRecord } from "@/lib/data/materials";
import { PostgresDataError } from "@/lib/data/postgres";
import { authorizeClassTeacher, TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string }> }
) {
  try {
    const { classId } = await params;
    await authorizeClassTeacher(request, classId);
    const [materials, activeJobs] = await Promise.all([
      listClassMaterials(classId),
      listActiveMaterialJobsByClass(classId)
    ]);
    const activeJobByMaterialId = new Map(
      activeJobs.flatMap((job) => (job.materialId ? [[job.materialId, job]] : []))
    );

    return NextResponse.json({
      materials: materials.map((material) => materialRecordToApi(material, activeJobByMaterialId.get(material.id)))
    });
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    if (caughtError instanceof PostgresDataError) {
      return NextResponse.json({ error: caughtError.message }, { status: 503 });
    }

    console.error("Class materials load failed.", caughtError);
    return NextResponse.json({ error: "Class materials load failed." }, { status: 500 });
  }
}

function materialRecordToApi(material: MaterialRecord, activeJob?: MaterialJobRecord) {
  return {
    id: material.id,
    title: material.title,
    kind: material.kind,
    activeForStudents: material.activeForStudents,
    citationsRequired: material.citationsRequired,
    fileName: material.fileName ?? undefined,
    filePath: material.storagePath ?? undefined,
    fileUrl: material.fileUrl ?? material.storageUri ?? undefined,
    contentType: material.contentType ?? undefined,
    fileSize: material.fileSize,
    characterCount: material.characterCount,
    chunkCount: material.chunkCount,
    metadata: material.metadata,
    ocrPageCount: numberFromMetadata(material.metadata.ocrPageCount),
    pageCount: numberFromMetadata(material.metadata.pageCount),
    priority: material.priority,
    requireCitations: material.citationsRequired,
    sourceMode: material.sourceMode,
    status: material.status,
    teacherOnly: material.teacherOnly,
    visualPageCount: numberFromMetadata(material.metadata.visualPageCount),
    addedAt: material.createdAt.toISOString(),
    processingJob: activeJob ? materialJobRecordToApi(activeJob) : undefined
  };
}

function materialJobRecordToApi(job: MaterialJobRecord) {
  return {
    id: job.id,
    classId: job.classId,
    completedChunks: job.completedChunks ?? undefined,
    detail: job.detail,
    error: job.error ?? undefined,
    materialId: job.materialId ?? undefined,
    percent: job.percent,
    step: job.step,
    title: typeof job.metadata.title === "string" ? job.metadata.title : undefined,
    totalChunks: job.totalChunks ?? undefined,
    updatedAt: job.updatedAt.toISOString()
  };
}

function numberFromMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
