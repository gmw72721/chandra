import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("chunks are prepared with embedding metadata", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const vertexSource = readFileSync(join(repoRoot, "frontend/lib/vertex-embeddings.ts"), "utf8");

  assert.match(source, /prepareTutorKnowledgeChunkData/);
  assert.match(source, /taskType: "RETRIEVAL_DOCUMENT"/);
  assert.match(source, /FieldValue\.vector\(embedding\.values\)/);
  assert.match(source, /embeddingModel: embedding\.model/);
  assert.match(source, /embeddingProvider: embedding\.provider/);
  assert.match(source, /embeddingDimensions: embedding\.dimensions/);
  assert.match(source, /professorId/);
  assert.match(source, /professor_id/);
  assert.match(source, /class_id/);
  assert.match(source, /course_id/);
  assert.match(source, /const problemNumbers = problemNumbersFromText/);
  assert.match(source, /pageNumbers: pageNumbersForChunk/);
  assert.match(source, /const sectionMarkers = sectionMarkersFromText/);
  assert.match(source, /page_start: pageStart/);
  assert.match(source, /chunk_text: canonicalContent/);
  assert.match(source, /sectionHeading/);
  assert.match(vertexSource, /gemini-embedding-2/);
  assert.match(vertexSource, /:embedContent/);
  assert.match(vertexSource, /outputDimensionality/);
  assert.match(vertexSource, /inline_data/);
  assert.match(vertexSource, /taskType/);
  assert.match(vertexSource, /GEMINI_EMBEDDING_BATCH_CONCURRENCY/);
  assert.match(source, /embeddingFileForChunk/);
  assert.match(vertexSource, /defaultGeminiEmbeddingBatchSize = 32/);
  assert.match(vertexSource, /defaultGeminiEmbeddingBatchConcurrency = 6/);
});

test("missing professor metadata is rejected before embedding", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /const professorId = requireProfessorId\(teacherId\)/);
  assert.match(source, /Embedded tutor knowledge requires professor_id metadata/);
  assert.match(source, /const chunkEmbedding = embedding \?\?/);
});

test("Vertex embedding failures are handled with material error metadata", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /caughtError instanceof VertexEmbeddingError/);
  assert.match(source, /skipEmbeddings: true/);
  assert.match(source, /buildEmbeddingFailureMaterialMetadata/);
  assert.match(source, /embeddingStatus: "failed"/);
  assert.match(source, /status: "needs-review"/);
  assert.match(source, /Gemini embeddings failed:/);
});

test("student classId scopes vector retrieval", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/retrieval.ts"), "utf8");

  assert.match(source, /collectionGroup\("chunks"\)/);
  assert.match(source, /\.where\("professorId", "==", professorId\)/);
  assert.match(source, /\.where\("classId", "==", classId\)/);
  assert.match(source, /findNearest\(/);
  assert.match(source, /Vector retrieval requires professor_id metadata/);
  assert.match(source, /pageNumbers: readNumberArray/);
});

test("material upload progress is written to professor-scoped job documents", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/route.ts"), "utf8");
  const rulesSource = readFileSync(join(repoRoot, "firestore.rules"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const clientSource = readFileSync(join(repoRoot, "frontend/lib/classes.ts"), "utf8");

  assert.match(routeSource, /formData\.get\("jobId"\)/);
  assert.match(routeSource, /after\(async \(\) =>/);
  assert.match(routeSource, /processing: true/);
  assert.match(source, /createMaterialJobProgressWriter/);
  assert.match(source, /collection\("materialJobs"\)/);
  assert.doesNotMatch(source, /detail: `Preparing PDF page asset \$\{completedPages\} of \$\{safePageNumbers\.length\}\.`/);
  assert.match(source, /step: "reading_pdf_pages"/);
  assert.match(source, /processingPercent: totalPercent/);
  assert.match(source, /processingStep: progress\.step/);
  assert.match(source, /processingCompletedPages: progress\.completedPages/);
  assert.match(source, /let progressWriteQueue = Promise\.resolve\(\)/);
  assert.match(source, /then\(\(\) => writeProgress\(progress\)\)/);
  assert.match(source, /await onEmbeddingProgress\?\.\(\{ completed: 0, total: chunks\.length \}\)/);
  assert.match(source, /step: "embedding_chunks"/);
  assert.match(source, /completedChunks: completed/);
  assert.match(clientSource, /"preparing_pdf_pages"/);
  assert.match(clientSource, /"reading_pdf_pages"/);
  assert.match(clientSource, /subscribeToClassMaterialJobs/);
  assert.match(componentSource, /subscribeToClassMaterialJobs/);
  assert.match(componentSource, /buildLatestMaterialJobProgressMap/);
  assert.match(componentSource, /Open status for \$\{material\.title\}/);
  assert.match(componentSource, /Source status/);
  assert.match(componentSource, /Overall/);
  assert.match(componentSource, /Pages uploaded/);
  assert.match(componentSource, /Tutor read/);
  assert.match(componentSource, /Uploading pages and reading for tutor/);
  assert.match(componentSource, /materialProgressForMaterial/);
  assert.match(source, /pageAssetCompletedPages: progress\.completedPages/);
  assert.match(source, /tutorReadCompletedSections: progress\.completedChunks/);
  assert.match(source, /totalMaterialProcessingPercent/);
  assert.match(componentSource, /`\$\{materialStatusPercent\(material, progress\)\}%`/);
  assert.match(componentSource, /\$\{progress\.completedPages \?\? 0\}\/\$\{progress\.totalPages\}/);
  assert.match(componentSource, /formatCountProgress\(completedPages, totalPages\)/);
  assert.match(componentSource, /formatCountProgress\(completedSections, totalSections\)/);
  assert.match(componentSource, /Google Document AI OCR/);
  assert.match(componentSource, /Math\.round\(\(safeCompleted \/ total\) \* 100\)/);
  assert.match(rulesSource, /match \/materialJobs\/\{jobId\}/);
  assert.match(rulesSource, /allow read: if isTargetClassTeacher\(classId\)/);
  assert.match(rulesSource, /allow write: if false/);
});

test("PDF uploads keep mini PDF slices in-memory for OCR and embeddings", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const chunkTypeSource = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge.ts"), "utf8");

  assert.doesNotMatch(source, /preparePdfPageAssets/);
  assert.doesNotMatch(source, /PDF_PAGE_ASSET_CONCURRENCY/);
  assert.doesNotMatch(source, /bucket\.file\(pdfPageAssetPath\(pageAssetPrefix, pageNumber\)\)\.save/);
  assert.doesNotMatch(source, /buildChunkPageAssetMetadata/);
  assert.match(source, /PDF_PAGE_TRANSCRIPTION_CONCURRENCY/);
  assert.match(source, /defaultPdfPageTranscriptionConcurrencyLimit = 3/);
  assert.match(source, /DOCUMENT_AI_OCR_PAGES_PER_REQUEST/);
  assert.match(source, /defaultDocumentAiOcrPagesPerRequest = 15/);
  assert.match(source, /maxDocumentAiOcrPagesPerRequest = 15/);
  assert.match(source, /DOCUMENT_AI_OCR_REQUESTS_PER_MINUTE/);
  assert.match(source, /defaultDocumentAiOcrRequestsPerMinute = 60/);
  assert.match(source, /waitForDocumentAiOcrRequestSlot/);
  assert.match(source, /PDF_PAGE_PROGRESS_UPDATE_INTERVAL/);
  assert.match(source, /shouldReportPageProgress/);
  assert.match(source, /PDFDocument\.load\(buffer, \{ ignoreEncryption: true \}\)/);
  assert.match(source, /await mapWithConcurrency\(/);
  assert.match(source, /pdfPageAssetPageNumbersForChunks/);
  assert.match(source, /shouldPrebuildPdfPageAsset/);
  assert.match(source, /shouldAttachPdfPartForEmbedding/);
  assert.match(source, /shouldAttachPdfSlice: shouldAttachPdfPartForEmbedding/);
  assert.doesNotMatch(source, /pageAssetPreparations/);
  assert.match(source, /chunk\.sourceType === "mixed" \|\| chunk\.sourceType === "page-image"/);
  assert.match(source, /attachPdfSlicesToChunks/);
  assert.doesNotMatch(source, /classes\/\$\{classId\}\/materials\/\$\{materialId\}\/page-assets\//);
  assert.match(chunkTypeSource, /pageAssetPrefix\?: string/);
  assert.match(chunkTypeSource, /page_asset_prefix\?: string/);
});

test("visual PDF page chunks are transcribed before metadata extraction", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");

  assert.match(source, /transcribeVisualPdfChunks/);
  assert.match(source, /const chunksWithReadableContent = await transcribeVisualPdfChunks/);
  assert.match(source, /chunkText: transcription/);
  assert.match(source, /content: transcription/);
  assert.match(source, /Google Document AI OCR is not configured/);
  assert.match(source, /Google Document AI OCR failed/);
  assert.match(source, /Google Document AI OCR could not read \$\{formatPageList/);
  assert.match(source, /Google Document AI OCR did not return text for \$\{formatPageList/);
  assert.match(source, /Check those page images if source text is missing/);
  assert.match(source, /pageNumbersForChunks/);
  assert.match(source, /formatPageList/);
  assert.match(source, /chunks\.some\(\(chunk\) => !isWeakPdfChunkContent\(chunk\.content\)\)/);
  assert.match(source, /canonicalChunkContent/);
  assert.match(source, /content: canonicalContent/);
  assert.match(source, /const problemNumbers = problemNumbersFromText\(`\$\{chunk\.label\}\\n\$\{canonicalContent\}`\)/);
  assert.match(source, /sectionHeading/);
  assert.match(source, /DOCUMENT_AI_OCR_PROCESSOR_ID/);
  assert.match(source, /defaultDocumentAiOcrProcessorId = "5d3fa32c2ebe2a90"/);
  assert.match(source, /buildDocumentAiProcessUrl/);
  assert.match(source, /rawDocument/);
  assert.match(source, /fieldMask: "text,pages\.layout,pages\.pageNumber"/);
  assert.match(source, /readDocumentAiText/);
  assert.match(source, /step: "reading_pdf_pages"/);
});

test("internal PDF page search does not return Firebase page asset metadata", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-search/route.ts"), "utf8");
  const retrievalSource = readFileSync(join(repoRoot, "frontend/lib/retrieval.ts"), "utf8");
  const agentToolsSource = readFileSync(join(repoRoot, "backend/agent/tools.py"), "utf8");

  assert.doesNotMatch(routeSource, /page_asset_prefix: hit\.chunk\.pageAssetPrefix/);
  assert.doesNotMatch(routeSource, /pageAssetPrefix: hit\.chunk\.pageAssetPrefix/);
  assert.doesNotMatch(routeSource, /page_asset_storage_bucket/);
  assert.match(retrievalSource, /pageAssetPrefix: readOptionalString\(chunkData\.pageAssetPrefix \?\? chunkData\.page_asset_prefix\)/);
  assert.match(retrievalSource, /material\.pageAssetStorageBucket/);
  assert.match(agentToolsSource, /page_asset_prefix = str\(source\.get\("page_asset_prefix"\)/);
  assert.match(agentToolsSource, /result\["pageAssetPrefix"\] = page_asset_prefix/);
});

test("internal PDF page assets return metadata and text only", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/internal/pdf-page-assets/route.ts"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");
  const backendAssetSource = readFileSync(join(repoRoot, "backend/retrieval/pdf_page_assets.py"), "utf8");

  assert.match(routeSource, /return metadataOnlyAsset\(page, pageStart, pageEnd\)/);
  assert.match(routeSource, /chunk_text: compactTextPreview/);
  assert.doesNotMatch(routeSource, /loadPrebuiltPagePdfs/);
  assert.doesNotMatch(routeSource, /extractCachedMiniPdf/);
  assert.doesNotMatch(routeSource, /file_data_url/);
  assert.match(graphSource, /Use only selected PDF text\/metadata below\. PDF files are not attached\./);
  assert.match(graphSource, /selected_page_text = selected_page_text_context\(selected_page_assets\)/);
  assert.match(backendAssetSource, /if not source_pdf_path:/);
  assert.doesNotMatch(backendAssetSource, /source_key = source_pdf_path or page_asset_prefix/);
});

test("material settings PATCH preserves omitted visibility fields", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/[materialId]/route.ts"), "utf8");

  assert.match(source, /settings: Partial<TutorKnowledgeSourceSettings>/);
  assert.match(source, /const currentSettings = sourceSettingsFromMaterial\(materialSnapshot\.data\(\) \?\? \{\}\)/);
  assert.match(source, /\.\.\.currentSettings,\s*\.\.\.settings/s);
  assert.match(source, /readBooleanWithDefault\(\s*material\.activeForStudents \?\? material\.studentVisible/s);
  assert.match(routeSource, /activeForStudents: body\.activeForStudents/);
  assert.match(routeSource, /requireCitations: body\.requireCitations/);
  assert.doesNotMatch(routeSource, /Boolean\(body\.(?:activeForStudents|requireCitations|teacherOnly)\)/);
});

test("new material uploads inherit class source defaults", () => {
  const classSettingsSource = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");
  const serverSource = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const classCreateRoute = readFileSync(join(repoRoot, "frontend/app/api/classes/route.ts"), "utf8");

  assert.match(classSettingsSource, /defaultSourceDefaultsSettings/);
  assert.match(classSettingsSource, /answerKeysTeacherReviewOnly: true/);
  assert.match(classSettingsSource, /sourceDefaultsForMaterialKind/);
  assert.match(classSettingsSource, /Practice Solutions/);
  assert.match(serverSource, /sourceDefaultsForMaterialKind\(classSnapshot\.data\(\)\?\.sourceDefaults, kind\)/);
  assert.match(serverSource, /configuredSourceDefaults\.activeForStudents/);
  assert.match(serverSource, /configuredSourceDefaults\.citationsRequired/);
  assert.match(classCreateRoute, /sourceDefaults: defaultSourceDefaultsSettings/);
});

test("tutor knowledge uploads original files directly to storage with server fallback", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const rulesSource = readFileSync(join(repoRoot, "storage.rules"), "utf8");

  assert.match(componentSource, /uploadBytesResumable/);
  assert.match(componentSource, /\/api\/materials\/upload-session/);
  assert.match(componentSource, /formData\.append\("storagePath", uploadedSource\.storagePath\)/);
  assert.match(componentSource, /formData\.append\("storageBucket", uploadedSource\.storageBucket \?\? ""\)/);
  assert.match(componentSource, /suppressUploadProgress: Boolean\(uploadedSource\)/);
  assert.match(componentSource, /formData\.append\("file", materialFile\)/);
  assert.match(source, /formData\.get\("storagePath"\)/);
  assert.match(source, /formData\.get\("storageBucket"\)/);
  assert.match(source, /resolveTutorKnowledgeStorageBucket\(storageBucket\)/);
  assert.match(source, /firebaseConfig\.storageBucket/);
  assert.match(source, /storageBucket: bucketName/);
  assert.match(source, /uploadTutorKnowledgeFile\(\{ classId, file, materialId: materialRef\.id, updateProgress \}\)/);
  assert.match(source, /Saving the original source file to Firebase Storage/);
  assert.match(source, /adminStorage!\.bucket\(\)\.file\(filePath\)/);
  assert.match(source, /storageFile\.save\(buffer/);
  assert.match(source, /const filePath = `classes\/\$\{classId\}\/materials\/\$\{materialId\}\/original\/\$\{safeFileName\}`/);
  assert.match(source, /sourceKind: "file"/);
  assert.match(rulesSource, /coTeachers\[request\.auth\.uid\]/);
  assert.match(rulesSource, /role in \["owner", "co-teacher"\]/);
});

test("deleting tutor knowledge removes source files, chunks, embeddings, jobs, and material", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/materials/[materialId]/route.ts"), "utf8");

  assert.match(routeSource, /await deleteTutorKnowledge\(\{ classId, materialId \}\)/);
  assert.match(source, /deleteMaterialStorageFiles\(\{ classId, filePath, materialId, storageBucket \}\)/);
  assert.match(source, /resolveTutorKnowledgeStorageBucket\(storageBucket\)\.file\(filePath\)\.download\(\)/);
  assert.match(source, /const materialStoragePrefix = `classes\/\$\{classId\}\/materials\/\$\{materialId\}\/`/);
  assert.doesNotMatch(source, /classes\/\$\{classId\}\/materials\/\$\{materialId\}\/page-assets\//);
  assert.match(source, /bucket\.getFiles\(\{ prefix: materialStoragePrefix \}\)/);
  assert.match(source, /materialRef\.collection\("chunks"\)\.get\(\)/);
  assert.match(source, /collection\("materialJobs"\)[\s\S]*where\("materialId", "==", materialId\)/);
  assert.match(source, /deleteDocumentsInBatches\(\[[\s\S]*chunksSnapshot\.docs[\s\S]*jobsSnapshot\.docs/s);
  assert.match(source, /await materialRef\.delete\(\)/);
  assert.match(source, /embedding: FieldValue\.vector\(embedding\.values\)/);
});

test("tutor knowledge supports guarded URL ingestion", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const componentSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");

  assert.match(componentSource, /Paste URL/);
  assert.match(source, /extractChunksFromUrl/);
  assert.match(source, /downloadTutorKnowledgeUrl/);
  assert.match(source, /validatePublicTutorKnowledgeUrl/);
  assert.match(source, /Private, local, and internal URLs are not supported/);
  assert.match(source, /originalSourceUrl/);
  assert.match(source, /text\/html/);
});
