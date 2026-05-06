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
  const nextSource = readFileSync(join(repoRoot, "app/api/materials/extract/route.ts"), "utf8");
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
  const source = readFileSync(join(repoRoot, "app/api/chat/route.ts"), "utf8");
  const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");

  assert.match(source, /process\.env\.BACKEND_API_BASE_URL/);
  assert.doesNotMatch(source, /process\.env\.NEXT_PUBLIC_API_BASE_URL/);
  assert.match(envExample, /BACKEND_API_BASE_URL=http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_API_BASE_URL/);
});
