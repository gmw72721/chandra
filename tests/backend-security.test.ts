import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("FastAPI chat authorizes Firebase scope instead of trusting client courseId", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(source, /async def chat\(request: ChatRequest, authorization: (?:str \| None|Optional\[str\]) = Header/);
  assert.match(source, /scope = authorize_tutor_chat_request\(request, authorization\)/);
  assert.match(source, /course_id = scope\["classId"\]/);
  assert.match(source, /class_id = str\(profile\.get\("classId"\) or ""\)\.strip\(\)/);
  assert.match(source, /authorize_class_teacher\(class_id, authorization, decoded_token=decoded_token\)/);
  assert.doesNotMatch(source, /retrieve_course_context\(request\.courseId/);
});

test("FastAPI chat accepts omitted modelId from the current student UI", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(source, /modelId: (?:str \| None|Optional\[str\]) = None/);
  assert.match(source, /async def call_openrouter\(model_id: (?:str \| None|Optional\[str\])/);
});

test("material extraction routes require teacher authorization", () => {
  const nextSource = readFileSync(join(repoRoot, "frontend/app/api/materials/extract/route.ts"), "utf8");
  const fastApiSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(nextSource, /await authorizeClassTeacher\(request, classId\)/);
  assert.match(nextSource, /Choose a class before extracting material text/);
  assert.match(fastApiSource, /classId: str = Form\(\.\.\.\)/);
  assert.match(fastApiSource, /authorization: (?:str \| None|Optional\[str\]) = Header\(default=None\)/);
  assert.match(fastApiSource, /authorize_class_teacher\(classId, authorization\)/);
});

test("FastAPI stream errors include a diagnostic instead of a blank fallback", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(source, /traceback\.print_exc\(\)/);
  assert.match(source, /describe_stream_error\(error\)/);
  assert.match(source, /error\.__class__\.__name__/);
});

test("Next chat route uses the private backend base URL for FastAPI", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const envExample = readFileSync(join(repoRoot, "config/env.example"), "utf8");

  assert.match(source, /process\.env\.BACKEND_API_BASE_URL/);
  assert.match(source, /BACKEND_API_BASE_URL is required in production/);
  assert.doesNotMatch(source, /process\.env\.NEXT_PUBLIC_API_BASE_URL/);
  assert.match(envExample, /BACKEND_API_BASE_URL=http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_API_BASE_URL/);
});

test("LangGraph backend requires shared-secret protection", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const envExample = readFileSync(join(repoRoot, "config/env.example"), "utf8");

  assert.match(source, /def authorize_internal_backend_request/);
  assert.match(source, /BACKEND_SHARED_SECRET is required/);
  assert.match(source, /Invalid backend shared secret/);
  assert.match(routeSource, /BACKEND_SHARED_SECRET is required for tutor backend requests/);
  assert.match(envExample, /BACKEND_SHARED_SECRET=/);
});

test("backend shared-secret comparison is timing-safe", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(source, /import hmac/);
  assert.match(source, /hmac\.compare_digest\(x_chandra_internal_secret or "", expected_secret\)/);
});

test("FastAPI CORS origins are environment-configurable for production", () => {
  const source = readFileSync(join(repoRoot, "backend/main.py"), "utf8");
  const envExample = readFileSync(join(repoRoot, "config/env.example"), "utf8");
  const deployScript = readFileSync(join(repoRoot, "scripts/deploy-backend-cloudrun.sh"), "utf8");

  assert.match(source, /BACKEND_CORS_ORIGINS/);
  assert.match(source, /FRONTEND_ORIGIN/);
  assert.match(envExample, /BACKEND_CORS_ORIGINS=/);
  assert.match(envExample, /NEXT_INTERNAL_BASE_URL=/);
  assert.match(deployScript, /FRONTEND_ORIGIN/);
  assert.match(deployScript, /NEXT_INTERNAL_BASE_URL/);
  assert.match(deployScript, /BACKEND_CORS_ORIGINS/);
});

test("production backend internal URLs and OpenRouter referer do not silently fall back to localhost", () => {
  const toolsSource = readFileSync(join(repoRoot, "backend/agent/tools.py"), "utf8");
  const assetsSource = readFileSync(join(repoRoot, "backend/retrieval/pdf_page_assets.py"), "utf8");
  const openRouterSource = readFileSync(join(repoRoot, "backend/agent/openrouter_client.py"), "utf8");
  const fastApiSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");
  const appHosting = readFileSync(join(repoRoot, "apphosting.yaml"), "utf8");
  const inviteRoute = readFileSync(join(repoRoot, "frontend/app/api/teacher-invites/route.ts"), "utf8");

  assert.match(toolsSource, /raise RuntimeError\("NEXT_INTERNAL_BASE_URL or FRONTEND_ORIGIN is required/);
  assert.match(assetsSource, /raise RuntimeError\("NEXT_INTERNAL_BASE_URL or FRONTEND_ORIGIN is required/);
  assert.match(openRouterSource, /OPENROUTER_HTTP_REFERER or FRONTEND_ORIGIN is required in production/);
  assert.match(fastApiSource, /OPENROUTER_HTTP_REFERER or FRONTEND_ORIGIN is required in production/);
  assert.match(inviteRoute, /publicFrontendOrigin/);
  assert.match(inviteRoute, /FRONTEND_ORIGIN is required in production to create teacher invite links/);
  assert.match(appHosting, /FRONTEND_ORIGIN/);
  assert.match(appHosting, /https:\/\/chandra-frontend--chandra-f6e13\.us-central1\.hosted\.app/);
});

test("chat routes enforce bounded request sizes before backend work", () => {
  const nextSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const fastApiSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(nextSource, /readJsonRequest\(request\)/);
  assert.match(nextSource, /code: "CHAT_REQUEST_INVALID"/);
  assert.match(nextSource, /maxChatMessagesPerRequest = 40/);
  assert.match(nextSource, /maxChatMessageCharacters = 12000/);
  assert.match(nextSource, /maxChatRequestCharacters = 60000/);
  assert.match(nextSource, /\.min\(1\)\.max\(maxChatMessagesPerRequest\)/);
  assert.match(nextSource, /totalCharacters > maxChatRequestCharacters/);
  assert.match(fastApiSource, /MAX_CHAT_MESSAGES_PER_REQUEST = 40/);
  assert.match(fastApiSource, /MAX_TOTAL_MESSAGE_CHARS = 100000/);
  assert.match(fastApiSource, /MAX_MODEL_RESPONSE_TOKENS = 8000/);
  assert.match(fastApiSource, /MAX_PROVIDER_MESSAGE_CONTENT_CHARS = 60000/);
  assert.match(fastApiSource, /max_message_content_chars=MAX_PROVIDER_MESSAGE_CONTENT_CHARS/);
  assert.match(fastApiSource, /maxTokens: Optional\[int\] = Field\(default=None, ge=1, le=MAX_MODEL_RESPONSE_TOKENS\)/);
  assert.match(fastApiSource, /validate_message_payload_size\(request\.messages\)/);
});

test("student chat classifies oversized backend requests explicitly", () => {
  const nextSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(nextSource, /TUTOR_BACKEND_REQUEST_TOO_LARGE/);
  assert.match(nextSource, /This chat is too large to send/);
  assert.match(nextSource, /status === 413/);
  assert.match(nextSource, /normalizedDetail\.includes\("too large"\)/);
});

test("material extraction and ingestion reject oversized uploads and text", () => {
  const nextExtractSource = readFileSync(join(repoRoot, "frontend/app/api/materials/extract/route.ts"), "utf8");
  const tutorKnowledgeSource = readFileSync(join(repoRoot, "frontend/lib/tutor-knowledge-server.ts"), "utf8");
  const fastApiSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(tutorKnowledgeSource, /maxTutorKnowledgeFileBytes = 500 \* 1024 \* 1024/);
  assert.match(tutorKnowledgeSource, /maxTutorKnowledgePastedTextCharacters = 250000/);
  assert.match(tutorKnowledgeSource, /file\.size > maxTutorKnowledgeFileBytes/);
  assert.match(tutorKnowledgeSource, /assertTutorKnowledgeTextWithinLimit\(pastedText\)/);
  assert.match(nextExtractSource, /validateTutorKnowledgeFile\(file\)/);
  assert.match(nextExtractSource, /assertTutorKnowledgeTextWithinLimit\(text, "Extracted material text"\)/);
  assert.match(fastApiSource, /MAX_MATERIAL_UPLOAD_BYTES = 500 \* 1024 \* 1024/);
  assert.match(fastApiSource, /read_upload_file_with_limit\(file\)/);
  assert.match(fastApiSource, /enforce_extracted_text_size\(text\)/);
});

test("Firestore class settings rules accept the current teacher settings schema", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /"quoteSourcePassages"/);
  assert.match(rules, /sourceUsage\.quoteSourcePassages is bool/);
  assert.match(rules, /modelSettings\.responseLength in \["short", "medium", "long", "extended"\]/);
  assert.match(rules, /"openingMessage"/);
  assert.match(rules, /request\.resource\.data\.openingMessage is string/);
  assert.match(rules, /"studentFacingInstructions"/);
  assert.match(rules, /request\.resource\.data\.studentFacingInstructions is string/);
});

test("Firestore user theme preference updates only validate theme fields", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /function validProfileThemePreferenceUpdate\(\)/);
  assert.match(rules, /affectedKeys\(\)\.hasOnly\(\[\s*"appearance",\s*"themeColor"\s*\]\)/);
  assert.match(rules, /validOptionalProfileAppearance\(request\.resource\.data\)/);
  assert.match(rules, /validOptionalProfileThemeColor\(request\.resource\.data\)/);
  assert.match(rules, /validProfileUpdate\(userId\)\s*\|\|\s*validProfileThemePreferenceUpdate\(\)/);
});

test("Firestore profile class membership fields are server-owned", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /request\.resource\.data\.role == "student"\s*&& !request\.resource\.data\.keys\(\)\.hasAny\(\["classId", "classIds"\]\)/);
  assert.match(rules, /request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly\(\[\s*"displayName",\s*"appearance",\s*"themeColor"\s*\]\)/);
  assert.match(rules, /function isStudentInClass\(classId\)/);
});

test("Firestore student material reads honor source visibility", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /function isStudentVisibleMaterial\(data\)/);
  assert.match(rules, /data\.status == "ready"/);
  assert.match(rules, /data\.teacherOnly != true/);
  assert.match(rules, /!\(data\.visibility in \["teacher-only", "hidden"\]\)/);
  assert.match(rules, /isStudentInClass\(classId\) && isStudentVisibleMaterial\(resource\.data\)/);
  assert.match(rules, /isStudentInClass\(classId\) && isStudentVisibleMaterialDocument\(classId, materialId\)/);
});

test("students load sanitized class summaries instead of full class policy documents", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const studentClassesRoute = readFileSync(join(repoRoot, "frontend/app/api/student/classes/route.ts"), "utf8");

  assert.match(rules, /allow get: if isClassTeacher\(\)/);
  assert.match(studentSource, /!firebaseReady \|\| !activeCourseId \|\| !isTeacherPreview/);
  assert.match(studentSource, /fetchStudentClasses\(token\)/);
  assert.match(studentClassesRoute, /openingMessage/);
  assert.match(studentClassesRoute, /normalizeTeacherClassAppearance/);
  assert.doesNotMatch(studentClassesRoute, /behaviorInstructions/);
  assert.doesNotMatch(studentClassesRoute, /answerPolicy/);
  assert.doesNotMatch(studentClassesRoute, /sourceUsage/);
});

test("account settings route updates profile fields server-side for students and teachers", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/account/settings/route.ts"), "utf8");

  assert.match(source, /adminAuth!\.verifyIdToken\(token\)/);
  assert.match(source, /const shouldUpdateDisplayName = bodyHasKey\(body, "displayName"\)/);
  assert.match(source, /normalizeDisplayName\(body\.displayName\)/);
  assert.match(source, /normalizeTeacherClassAppearance/);
  assert.match(source, /normalizeTeacherClassThemeColor/);
  assert.match(source, /profileUpdates\.displayName = displayName/);
  assert.match(source, /shouldUpdateDisplayName && displayName !== currentDisplayName/);
  assert.match(source, /adminAuth!\.updateUser\(decodedToken\.uid, \{ displayName \}\)/);
  assert.match(source, /where\("teacherId", "==", uid\)/);
  assert.match(source, /collectionGroup\("students"\)/);
});

test("browser-requested app icons are served instead of logging 404s", () => {
  const faviconRoute = readFileSync(join(repoRoot, "frontend/app/favicon.ico/route.ts"), "utf8");
  const appleIconRoute = readFileSync(join(repoRoot, "frontend/app/apple-touch-icon.png/route.ts"), "utf8");
  const applePrecomposedIconRoute = readFileSync(
    join(repoRoot, "frontend/app/apple-touch-icon-precomposed.png/route.ts"),
    "utf8"
  );
  const iconResponseSource = readFileSync(join(repoRoot, "frontend/lib/icon-response.ts"), "utf8");

  assert.match(faviconRoute, /createIconResponse/);
  assert.match(appleIconRoute, /createIconResponse/);
  assert.match(applePrecomposedIconRoute, /createIconResponse/);
  assert.match(iconResponseSource, /Content-Type": "image\/svg\+xml/);
  assert.match(iconResponseSource, /Cache-Control": "public, max-age=31536000, immutable"/);
});
