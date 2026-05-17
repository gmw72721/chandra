import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("conversation and message writes use Postgres without Firestore conversation fallback", () => {
  const conversations = source("frontend/lib/student-conversations-server.ts");
  const data = source("frontend/lib/data/conversations.ts");

  assert.match(conversations, /upsertConversation/);
  assert.match(conversations, /addPostgresMessage/);
  assert.match(conversations, /getConversationById/);
  assert.match(conversations, /listPostgresConversationMessages/);
  assert.match(conversations, /updateConversationMetadata/);
  assert.doesNotMatch(conversations, /collection\("conversations"\)/);
  assert.doesNotMatch(conversations, /collection\("messages"\)/);
  assert.match(data, /INSERT INTO conversations/);
  assert.match(data, /INSERT INTO messages/);
  assert.match(data, /UPDATE conversations[\s\S]*metadata = metadata \|\|/);
});

test("message metadata fields and attachment metadata stay in Postgres while files stay in storage", () => {
  const conversations = source("frontend/lib/student-conversations-server.ts");
  const attachments = source("frontend/lib/student-attachments-server.ts");
  const data = source("frontend/lib/data/conversations.ts");
  const migration = source("migrations/002_core_app_tables.sql");

  for (const field of [
    "attachments",
    "debugInfo",
    "langGraphTrace",
    "learningStrategyTelemetry",
    "retrievalConfidence",
    "sources",
    "structuredOutput"
  ]) {
    assert.match(conversations, new RegExp(field));
  }

  assert.match(attachments, /upsertMessageAttachment/);
  assert.match(attachments, /listConversationAttachments/);
  assert.match(attachments, /getConversationAttachment/);
  assert.match(attachments, /deleteAttachmentMetadata/);
  assert.match(attachments, /adminStorage/);
  assert.match(data, /INSERT INTO message_attachments/);
  assert.match(migration, /attachments JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
});

test("feedback, reviews, support, and learning profiles write Postgres-first with Firestore fallback", () => {
  const feedback = source("frontend/lib/student-feedback-server.ts");
  const conversations = source("frontend/lib/student-conversations-server.ts");
  const profiles = source("frontend/lib/student-learning-profiles-server.ts");
  const data = source("frontend/lib/data/student-records.ts");

  assert.match(feedback, /upsertStudentFeedback/);
  assert.match(feedback, /listFeedback/);
  assert.match(feedback, /collection\("studentFeedback"\)/);
  assert.match(conversations, /upsertConversationReview/);
  assert.match(conversations, /listConversationReviews/);
  assert.match(conversations, /upsertStudentSupport/);
  assert.match(conversations, /listStudentSupport/);
  assert.match(conversations, /collection\("conversationReviews"\)/);
  assert.match(conversations, /collection\("studentSupport"\)/);
  assert.match(profiles, /upsertStudentLearningProfile/);
  assert.match(profiles, /addLearningProfileRevision/);
  assert.match(profiles, /getStudentLearningProfileById/);
  assert.match(profiles, /collection\("studentLearningProfiles"\)/);
  assert.match(data, /INSERT INTO student_feedback/);
  assert.match(data, /INSERT INTO conversation_reviews/);
  assert.match(data, /INSERT INTO student_support/);
  assert.match(data, /INSERT INTO student_learning_profiles/);
  assert.match(data, /INSERT INTO learning_profile_revisions/);
});

test("chat route keeps Firebase Auth and uses Postgres-backed conversation persistence", () => {
  const chatRoute = source("frontend/app/api/chat/route.ts");
  const conversations = source("frontend/lib/student-conversations-server.ts");

  assert.match(chatRoute, /authorizeTutorChatRequest/);
  assert.match(chatRoute, /prepareStudentConversationPersistence/);
  assert.match(chatRoute, /saveAssistantMessage/);
  assert.match(conversations, /verifyStudentConversation/);
  assert.match(conversations, /upsertConversation/);
  assert.match(conversations, /addPostgresMessage/);
});

test("PDF retrieval remains on the Postgres structured PDF search tables", () => {
  const route = source("frontend/app/api/internal/pdf-page-search/route.ts");
  const ocr = source("frontend/lib/pdf-ocr-postgres.ts");
  const migration = source("migrations/001_pdf_ocr_metadata.sql");

  assert.match(route, /searchStructuredPdfMetadata/);
  assert.doesNotMatch(route, /searchPdfOcrMetadata\(/);
  assert.match(ocr, /export async function searchPdfOcrMetadata/);
  assert.match(ocr, /export async function searchStructuredPdfMetadata/);
  assert.match(ocr, /export async function replacePdfOcrMetadata/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_materials/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pdf_pages/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS content_embeddings/);
});
