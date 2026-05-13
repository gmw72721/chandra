import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildChatRetrievalQuery, getLatestStudentQuestion, getRecentSourceHints } from "../frontend/lib/chat-retrieval-query.ts";
import {
  buildLearningStrategyTelemetry,
  inferLearningStrategyObservedOutcome,
  stripTeacherOnlyTutorResponseFields
} from "../frontend/lib/learning-strategy-telemetry.ts";
import { assistantContentWithSources } from "../frontend/lib/provider-source-context.ts";
import { resolveStudentChatClassId, StudentChatScopeError } from "../frontend/lib/student-chat-scope.ts";
import { assistantMessageBlocks } from "../frontend/lib/chat-message-format.ts";
import { buildChatContextMemory } from "../frontend/lib/chat-context-memory.ts";
import { normalizeTutorResponse } from "../frontend/lib/tutor-response.ts";
import { buildUnderstandingState, safeUnderstandingReasons } from "../frontend/lib/understanding-state.ts";

const repoRoot = process.cwd();

test("student saved classId is used automatically", () => {
  assert.equal(
    resolveStudentChatClassId({
      requestedCourseId: undefined,
      savedClassId: "class-algebra"
    }),
    "class-algebra"
  );
});

test("student cannot override courseId with a conflicting client value", () => {
  assert.equal(
    resolveStudentChatClassId({
      requestedCourseId: "class-physics",
      savedClassId: "class-algebra"
    }),
    "class-algebra"
  );
});

test("student without a saved class gets an authorization error", () => {
  assert.throws(
    () => resolveStudentChatClassId({ requestedCourseId: "class-physics", savedClassId: "" }),
    (error) => error instanceof StudentChatScopeError && error.status === 403
  );
});

test("model selector is hidden from student chat", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.doesNotMatch(source, /htmlFor="model"/);
  assert.doesNotMatch(source, /modelOptions/);
  assert.doesNotMatch(source, /customModelStorageKey/);
});

test("student settings can return to chat view", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(source, /Back to chat/);
  assert.match(source, /setStudentMainView\(\(currentView\) => \(currentView === "settings" \? "chat" : "settings"\)\)/);
  assert.match(source, /onBackToChat=\{\(\) => setStudentMainView\("chat"\)\}/);
});

test("student chat posts the saved class and auth token to the tutor API", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const apiClientSource = readFileSync(join(repoRoot, "frontend/lib/api-client.ts"), "utf8");

  assert.match(source, /const activeCourseId = isTeacherPreview \? queryClassId \?\? "" : profile\?\.classId \?\? ""/);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /courseId: activeCourseId/);
  assert.match(apiClientSource, /return path\.startsWith\("\/"\) \? path : `\/\$\{path\}`/);
  assert.doesNotMatch(apiClientSource, /NEXT_PUBLIC_API_BASE_URL/);
});

test("teacher preview accepts co-teachers and does not load student-only history", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const tutorChatAuthSource = readFileSync(join(repoRoot, "frontend/lib/tutor-chat-auth.ts"), "utf8");
  const fastApiSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(tutorChatAuthSource, /allowedTeacherIds\.has\(decodedToken\.uid\)/);
  assert.match(tutorChatAuthSource, /role === "owner" \|\| role === "co-teacher"/);
  assert.match(studentSource, /if \(!isTeacherPreview\) \{\s*try \{\s*setConversationSummaries/s);
  assert.match(fastApiSource, /def is_class_teacher/);
  assert.match(fastApiSource, /co_teacher\.get\("role"\) in \{"owner", "co-teacher"\}/);
});

test("teacher preview debug mode is gated to teachers and stripped from student responses", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const telemetrySource = readFileSync(join(repoRoot, "frontend/lib/learning-strategy-telemetry.ts"), "utf8");

  assert.match(studentSource, /isTeacherPreview \? \([\s\S]*student-debug-settings-card/);
  assert.match(studentSource, /debugEnabled=\{isTeacherPreview && isTeacherDebugMode\}/);
  assert.match(studentSource, /MessageDebugDetails/);
  assert.match(routeSource, /preparedRequest\.scope\.role !== "teacher"/);
  assert.match(routeSource, /debugInfo: buildTutorDebugInfo/);
  assert.match(routeSource, /actualTokens/);
  assert.match(routeSource, /inputTokenBreakdown/);
  assert.match(routeSource, /totalRequestCount/);
  assert.match(studentSource, /message-debug-input-breakdown/);
  assert.match(studentSource, /Inspect section/);
  assert.match(telemetrySource, /delete studentSafeResponse\.debugInfo/);
});

test("student chat persists and resumes class-scoped conversations", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const studentConversationRouteSource = readFileSync(join(repoRoot, "frontend/app/api/student/conversations/route.ts"), "utf8");
  const studentMessageRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/student/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );

  assert.match(routeSource, /conversationId: safeDocumentIdSchema\.optional\(\)/);
  assert.match(routeSource, /prepareStudentConversationPersistence/);
  assert.match(routeSource, /loadConversationMessagesForTutor/);
  assert.match(routeSource, /saveAssistantMessage/);
  assert.match(routeSource, /withConversationMetadata/);
  assert.match(persistenceSource, /buildChatContextMemory/);
  assert.match(persistenceSource, /updateConversationMetadata/);
  assert.doesNotMatch(persistenceSource, /collection\("conversations"\)/);
  assert.doesNotMatch(persistenceSource, /collection\("messages"\)/);
  assert.match(persistenceSource, /studentEmail: String\(profile\.email \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(studentSource, /fetchStudentConversationSummaries/);
  assert.match(studentSource, /fetchStudentConversationMessages/);
  assert.match(studentSource, /conversationId: activeSelectedConversationId \|\| undefined/);
  assert.match(studentConversationRouteSource, /authorizeTutorChatRequest/);
  assert.match(studentConversationRouteSource, /listStudentConversations/);
  assert.match(studentMessageRouteSource, /authorizeTutorChatRequest/);
  assert.match(studentMessageRouteSource, /listStudentConversationMessages/);
});

test("student PDF homework attachments are scoped, extracted, and sent with chat messages", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const chatRouteSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const attachmentServerSource = readFileSync(join(repoRoot, "frontend/lib/student-attachments-server.ts"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const typesSource = readFileSync(join(repoRoot, "frontend/lib/types.ts"), "utf8");
  const attachmentRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/student/conversations/[conversationId]/attachments/route.ts"),
    "utf8"
  );

  assert.match(typesSource, /export type MessageAttachment/);
  assert.match(studentSource, /student-composer-add/);
  assert.match(studentSource, /uploadHomeworkAttachmentWithProgress/);
  assert.match(studentSource, /attachmentIds: sentAttachmentIds/);
  assert.match(studentSource, /maxComposerAttachments = 3/);
  assert.match(studentSource, /allowedComposerAttachmentExtensions = \["\.pdf", "\.png", "\.jpg", "\.jpeg", "\.webp"\]/);
  assert.match(studentSource, /Upload a PDF, PNG, JPG, JPEG, or WEBP homework file/);
  assert.match(attachmentRouteSource, /request\.formData\(\)/);
  assert.match(attachmentRouteSource, /maxStudentAttachmentFileBytes/);
  assert.match(attachmentRouteSource, /content-length/);
  assert.match(attachmentRouteSource, /status: 413/);
  assert.match(attachmentRouteSource, /uploadStudentConversationAttachment/);
  assert.match(attachmentServerSource, /export function maxStudentAttachmentFileBytes/);
  assert.match(attachmentServerSource, /function validateAttachmentMetadata\(file: File\)/);
  assert.match(attachmentServerSource, /const allowedType = validateAttachmentMetadata\(file\)/);
  assert.match(attachmentServerSource, /student-uploads/);
  assert.match(attachmentServerSource, /scope\.classId/);
  assert.match(attachmentServerSource, /scope\.uid/);
  assert.match(attachmentServerSource, /matchesMagicBytes/);
  assert.match(attachmentServerSource, /extractAttachmentText/);
  assert.match(attachmentServerSource, /image\/png/);
  assert.match(attachmentServerSource, /image\/jpeg/);
  assert.match(attachmentServerSource, /image\/webp/);
  assert.match(attachmentServerSource, /PDFParse/);
  assert.match(attachmentServerSource, /extractedText/);
  assert.match(chatRouteSource, /attachmentIds: z\.array\(safeDocumentIdSchema\)/);
  assert.match(chatRouteSource, /appendAttachmentContextToStudentMessage/);
  assert.match(chatRouteSource, /buildStudentAttachmentFilePayloads/);
  assert.match(chatRouteSource, /directAttachmentFilePayloadsFromMessages/);
  assert.match(chatRouteSource, /chatMessageAttachmentSchema/);
  assert.match(chatRouteSource, /const storageKey = String\(attachment\.storageKey \?\? ""\)\.trim\(\)/);
  assert.match(chatRouteSource, /!storageKey/);
  assert.match(chatRouteSource, /defaultMimeTypeForAttachment/);
  assert.match(chatRouteSource, /studentAttachmentFiles/);
  assert.match(chatRouteSource, /Extracted text:/);
  assert.match(persistenceSource, /listConversationMessagesWithHydratedAttachments/);
  assert.match(persistenceSource, /listPostgresConversationAttachments/);
  assert.match(persistenceSource, /mergeMessageAttachmentRecords/);
  assert.match(studentSource, /studentProvidedSourceLabel/);
  assert.match(studentSource, /Student-provided/);
});

test("student attachment uploads fail loudly instead of hiding uninspectable files", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const chatRouteSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const attachmentServerSource = readFileSync(join(repoRoot, "frontend/lib/student-attachments-server.ts"), "utf8");

  assert.match(chatRouteSource, /attachmentRequiresBinaryModelPayload/);
  assert.match(chatRouteSource, /oversizedAttachmentModelMessage/);
  assert.match(chatRouteSource, /too large for Chandra to inspect directly/);
  assert.match(chatRouteSource, /textOnlyStudentAttachmentPayload/);
  assert.match(chatRouteSource, /normalizeAttachmentDataUrlForModel/);
  assert.match(studentSource, /Wait for attachments to finish uploading before sending\./);
  assert.match(studentSource, /normalizeComposerAttachmentMimeType/);
  assert.match(attachmentServerSource, /normalizeAttachmentMimeType/);
  assert.match(studentSource, /attachment\.error \? <small>\{attachment\.error\}<\/small> : null/);
});

test("student view does not pin teacher assignment guidance above chat", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.doesNotMatch(source, /className="student-teacher-instructions"/);
  assert.doesNotMatch(source, /Class\s+instructions/);
  assert.doesNotMatch(source, /formatPinnedTeacherInstructions\(activeClass\)/);
  assert.doesNotMatch(source, /Show your work\. Do not use decimals unless asked\./);
});

test("student opening message is class-specific and professor editable", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const managerSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/route.ts"), "utf8");

  assert.match(source, /buildInitialStudentMessages\(activeClass\)/);
  assert.match(source, /normalizeOpeningMessage\(teacherClass\?\.openingMessage/);
  assert.doesNotMatch(source, /Hi\. I can help you work through the assignment step by step\. What problem are you on\?/);
  assert.match(managerSource, /name="openingMessage"/);
  assert.match(managerSource, /Student opening message/);
  assert.match(routeSource, /openingMessage: tutorDefaults\.openingMessage/);
});

test("student-facing class instructions are explicit settings and tutor prompt context", () => {
  const managerSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const classesSource = readFileSync(join(repoRoot, "frontend/lib/classes.ts"), "utf8");

  assert.match(managerSource, /name="studentFacingInstructions"/);
  assert.match(managerSource, /Student-facing instructions/);
  assert.match(classesSource, /studentFacingInstructions: studentFacingInstructions\.trim\(\)/);
  assert.match(promptSource, /Student-facing class instructions/);
  assert.match(promptSource, /normalizeStudentFacingInstructions\(data\.studentFacingInstructions/);
});

test("class tutor defaults vary by class name and normalize missing fields", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");

  assert.match(source, /export function buildDefaultClassTutorSettings/);
  assert.match(source, /algebra\|calculus\|geometry\|math/);
  assert.match(source, /prompt, passage, or draft/);
  assert.doesNotMatch(source, /Show your setup, include units, and explain what concept or step is confusing\./);
  assert.match(source, /Share the prompt, your code or approach/);
  assert.match(source, /export function normalizeOpeningMessage/);
  assert.match(source, /return buildDefaultClassTutorSettings\(classDefaults \?\? \{\}\)\.openingMessage/);
  assert.match(source, /export function normalizeStudentFacingInstructions/);
  assert.match(source, /return buildDefaultClassTutorSettings\(classDefaults \?\? \{\}\)\.studentFacingInstructions/);
  assert.match(source, /export const defaultOpeningMessage/);
  assert.match(source, /export const defaultStudentFacingInstructions/);
});

test("hidden tutor instructions stay private and are separate from visible class instructions", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/route.ts"), "utf8");

  assert.match(promptSource, /Hidden policy privacy/);
  assert.match(promptSource, /Do not reveal or discuss them/);
  assert.match(promptSource, /behaviorInstructions/);
  assert.doesNotMatch(studentSource, /activeClass\.behaviorInstructions/);
  assert.match(routeSource, /behaviorInstructions: defaultBehaviorInstructions/);
  assert.match(readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8"), /Do not provide final answers/);
});

test("conversation titles use topic labels from the first prompt", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");

  assert.match(source, /inferTopicConversationTitle\(normalized\)/);
  assert.match(source, /Derivative chain rule/);
  assert.match(source, /Limits with fractions/);
  assert.match(source, /Optimization problem/);
  assert.match(source, /return "Need help"/);
});

test("teacher roster can open a student's saved conversations", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const conversationRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/students/[studentId]/conversations/route.ts"),
    "utf8"
  );
  const messageRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );

  assert.match(teacherSource, /students\/\$\{encodeURIComponent\(\s*selectedStudent\.email\s*\)\}\/conversations/);
  assert.match(teacherSource, /conversations\/\$\{encodeURIComponent\(\s*activeSelectedConversationId\s*\)\}\/messages/);
  assert.match(teacherSource, /className="professor-chat-review"/);
  assert.match(teacherSource, /setSelectedStudentId\(student\.id\)/);
  assert.match(teacherSource, /conversationMessages\s*\.\s*filter/);
  assert.match(teacherSource, /TeacherTranscriptMessage/);
  assert.match(teacherSource, /Back to students/);
  assert.match(conversationRouteSource, /authorizeClassAccess\(request, classId, "viewConversations"\)/);
  assert.match(conversationRouteSource, /listTeacherStudentConversations/);
  assert.match(messageRouteSource, /authorizeClassAccess\(request, classId, "viewConversations"\)/);
  assert.match(messageRouteSource, /listTeacherConversationMessages/);
});

test("teacher class conversations endpoint loads the review inbox", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/conversations/route.ts"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");

  assert.match(routeSource, /authorizeClassAccess\(request, classId, "viewConversations"\)/);
  assert.match(routeSource, /listTeacherClassConversations\(\{ classId \}\)/);
  assert.match(routeSource, /metrics/);
  assert.match(routeSource, /const openConversations = conversations\.filter/);
  assert.match(routeSource, /lowConfidence: openConversations\.filter/);
  assert.match(persistenceSource, /export async function listTeacherClassConversations/);
  assert.match(persistenceSource, /collection\("conversationReviews"\)/);
  assert.match(persistenceSource, /getConversationSourceAudit/);
  assert.match(teacherSource, /\/api\/classes\/\$\{encodeURIComponent\(activeClassId\)\}\/conversations/);
  assert.match(teacherSource, /setClassConversations\(data\.conversations \?\? \[\]\)/);
});

test("teacher conversation review PATCH stores teacher-only metadata", () => {
  const routeSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/conversations/[conversationId]/review/route.ts"),
    "utf8"
  );
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");

  assert.match(routeSource, /authorizeClassAccess\(request, classId, "reviewConversations"\)/);
  assert.match(routeSource, /privateNote: String\(data\.privateNote \?\? ""\)\.slice\(0, 1000\)/);
  assert.match(routeSource, /updateTeacherConversationReview/);
  assert.match(persistenceSource, /export async function updateTeacherConversationReview/);
  assert.match(persistenceSource, /collection\("conversationReviews"\)\s*\.doc\(conversationId\)/);
  assert.match(persistenceSource, /privateNote: privateNote\.slice\(0, maxTeacherReviewNoteLength\)/);
  assert.match(teacherSource, /saveConversationReview/);
  assert.match(teacherSource, /\/review`/);
});

test("private conversation review data is not written to student-readable conversation docs", () => {
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const createConversationStart = persistenceSource.indexOf("async function createOrVerifyStudentConversation");
  const createConversationEnd = persistenceSource.indexOf("async function verifyStudentConversation");
  const createConversationSource = persistenceSource.slice(createConversationStart, createConversationEnd);

  assert.match(persistenceSource, /collection\("conversationReviews"\)/);
  assert.doesNotMatch(createConversationSource, /privateNote|reviewStatus|conversationReviews/);
});

test("teacher transcript messages include retrieval confidence", () => {
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const messageRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );
  const typesSource = readFileSync(join(repoRoot, "frontend/lib/types.ts"), "utf8");

  assert.match(typesSource, /retrievalConfidence\?: RetrievalConfidence/);
  assert.match(persistenceSource, /retrievalConfidence: normalizeRetrievalConfidence\(message\.retrievalConfidence\)/);
  assert.match(messageRouteSource, /listTeacherConversationMessages/);
});

test("teacher transcript uses student chat markdown formatting and readable source labels", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const messageFormatSource = readFileSync(join(repoRoot, "frontend/lib/chat-message-format.ts"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(teacherSource, /import ReactMarkdown from "react-markdown"/);
  assert.match(teacherSource, /remarkMath/);
  assert.match(teacherSource, /rehypeKatex/);
  assert.match(teacherSource, /assistantMessageBlocks\(message\)/);
  assert.match(teacherSource, /messageBlocks\.map/);
  assert.match(teacherSource, /condensedSourceLabels\(message\.sources\)/);
  assert.match(messageFormatSource, /export function assistantMessageBlocks/);
  assert.match(messageFormatSource, /export function assistantStructuredSections/);
  assert.match(styles, /\.teacher-transcript-message/);
  assert.match(styles, /\.teacher-dashboard\[data-appearance="dark"\] \.teacher-transcript-sources span/);
});

test("teacher roster active status uses Firebase presence and sortable activity columns", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const authSource = readFileSync(join(repoRoot, "frontend/lib/auth.ts"), "utf8");
  const serverSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(authSource, /startUserPresenceHeartbeat/);
  assert.match(authSource, /doc\(db, "userPresence", user\.uid\)/);
  assert.match(authSource, /safelyWriteUserPresence/);
  assert.match(authSource, /console\.warn\("User presence update failed\."/);
  assert.doesNotMatch(authSource, /\{ merge: true \}/);
  assert.match(serverSource, /collection\("userPresence"\)/);
  assert.match(serverSource, /presence\?\.isOnline \? "active"/);
  assert.doesNotMatch(serverSource, /activity\.questionsToday > 0 \? "active"/);
  assert.match(teacherSource, /activity: "Activity"/);
  assert.match(teacherSource, /lastActive: "Last active"/);
  assert.match(teacherSource, /sortRosterRows\(filteredRosterRows, rosterSort\)/);
  assert.match(teacherSource, /rosterPageSize = 10/);
  assert.match(teacherSource, /roster-activity-cell/);
  assert.match(styles, /\.roster-activity-cell/);
});

test("conversation Firestore rules are class-scoped and server-write-only", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /match \/conversations\/\{conversationId\}/);
  assert.match(rules, /match \/conversationReviews\/\{conversationId\}/);
  assert.match(rules, /isTargetClassTeacher\(classId\)/);
  assert.match(rules, /resource\.data\.studentId == request\.auth\.uid/);
  assert.match(rules, /match \/messages\/\{messageId\}/);
  assert.match(rules, /documents\/classes\/\$\(classId\)\/conversations\/\$\(conversationId\)/);
  assert.match(rules, /allow write: if false/);
});

test("source labels render under tutor messages", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const messageFormatSource = readFileSync(join(repoRoot, "frontend/lib/chat-message-format.ts"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(source, /className="message-sources"/);
  assert.match(source, /sourceChipDetails\(message\)/);
  assert.match(messageFormatSource, /function formatSourceLabel/);
  assert.match(styles, /\.message-sources/);
});

test("student chat response normalization preserves structured output", () => {
  const response = normalizeTutorResponse({
    content: "Use substitution first. What expression should u equal?",
    retrievalConfidence: "high",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "Use substitution first.",
        nextStep: "What expression should u equal?"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "high",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.equal(response.message, "Use substitution first. What expression should u equal?");
  assert.equal(response.content, "Use substitution first. What expression should u equal?");
  assert.deepEqual(response.structuredOutput, {
    sections: {
      answer: "Use substitution first.",
      nextStep: "What expression should u equal?"
    },
    metadata: {
      hintLevel: "guided_step",
      mode: "guided_problem_solving",
      sourceConfidence: "high",
      studentActionNeeded: "try_next_step"
    }
  });
});

test("student chat response normalization preserves valid confusion choices", () => {
  const response = normalizeTutorResponse({
    content: "I see a few possible starting points for this rank problem. Pick one and I'll focus there.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
      },
      confusionPrompt: "I see a few possible starting points for this rank problem. Pick one and I'll focus there.",
      confusionChoices: [
        { id: "notation", label: "Notation", message: "Help me understand the notation." },
        { id: "first-step", label: "First step", message: "Help me choose the first step." },
        { id: "check-work", label: "Check my work", message: "Check my algebra so far." },
        { id: "smaller-hint", label: "Smaller hint", message: "Give me a smaller hint." }
      ],
      metadata: {
        hintLevel: "small_hint",
        mode: "clarification",
        sourceConfidence: "low",
        studentActionNeeded: "answer_question"
      }
    }
  });

  assert.equal(
    response.structuredOutput?.confusionPrompt,
    "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
  );
  assert.deepEqual(response.structuredOutput?.confusionChoices, [
    { id: "notation", label: "Notation", message: "Help me understand the notation." },
    { id: "first-step", label: "First step", message: "Help me choose the first step." },
    { id: "check-work", label: "Check my work", message: "Check my algebra so far." },
    { id: "smaller-hint", label: "Smaller hint", message: "Give me a smaller hint." }
  ]);
});

test("student chat response normalization makes confusion choice prompt authoritative", () => {
  const response = normalizeTutorResponse({
    content: "I can help with Problem 2.14, but I need to know which part you want to start with.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "I can help with Problem 2.14, but I need to know which part you want to start with.",
        nextStep: "Choose one: the setup from Exercise 2.13, part (i), or part (ii)."
      },
      confusionPrompt:
        "I see a few possible starting points for this rank problem. Pick one and I'll focus there.",
      confusionChoices: [
        {
          id: "setup",
          label: "Start with the setup",
          message: "Help me identify the maps, spaces, and rank facts from Exercise 2.13."
        },
        {
          id: "part-i",
          label: "Work on part (i)",
          message: "Help me start part (i) without giving the full proof."
        },
        {
          id: "part-ii",
          label: "Work on part (ii)",
          message: "Help me understand the first move for part (ii)."
        }
      ]
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "I see a few possible starting points for this rank problem. Pick one and I'll focus there."
  });
});

test("student chat response normalization drops invalid confusion choice payloads", () => {
  const response = normalizeTutorResponse({
    content: "Pick a direction.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "Pick a direction."
      },
      confusionChoices: [
        { id: "one", label: "One", message: "Help me with one." },
        { id: "two", label: "", message: "Help me with two." },
        { id: "three", label: "Three", message: "" }
      ],
      metadata: {
        hintLevel: "small_hint",
        mode: "clarification",
        sourceConfidence: "low",
        studentActionNeeded: "answer_question"
      }
    } as never
  });

  assert.equal(response.structuredOutput?.confusionChoices, undefined);
});

test("student chat response normalization unwraps object-shaped section text", () => {
  const response = normalizeTutorResponse({
    content: "I'm checking the exact problem 2.16 now.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: { text: "I'm checking the exact problem 2.16 now." },
        nextStep: "{'text': 'Send the page or a photo.'}"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    } as never
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "I'm checking the exact problem 2.16 now."
  });
});

test("student chat response normalization preserves problem section", () => {
  const response = normalizeTutorResponse({
    content: "If you want, I can help you start.",
    retrievalConfidence: "high",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "If you want, I can help you start.",
        problem: "Exercise 2.14: prove the two rank inequalities."
      },
      metadata: {
        hintLevel: "none",
        mode: "source_lookup",
        sourceConfidence: "high",
        studentActionNeeded: "none"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "If you want, I can help you start.",
    problem: "Exercise 2.14: prove the two rank inequalities."
  });
});

test("student chat response normalization moves status text out of problem section", () => {
  const response = normalizeTutorResponse({
    content: "You said: 2.20",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        problem:
          "You said: 2.20\n\n" +
          "I'm checking which problem 2.20 refers to so I can help with the right one. Please send the page or textbook name if you have it."
      },
      sectionOrder: ["problem"],
      metadata: {
        hintLevel: "guided_step",
        mode: "clarification",
        sourceConfidence: "low",
        studentActionNeeded: "paste_problem"
      }
    }
  });

  assert.equal(response.structuredOutput?.sections.problem, undefined);
  assert.match(response.structuredOutput?.sections.answer ?? "", /You said: 2\.20/);
});

test("student assistant renderer shows problem before answer even when section order says otherwise", () => {
  const blocks = assistantMessageBlocks({
    content: "If you want, I can help you start.",
    createdAt: new Date().toISOString(),
    id: "assistant-problem-first",
    role: "assistant",
    structuredOutput: {
      sectionOrder: ["answer", "problem"],
      sections: {
        answer: "If you want, I can help you start.",
        problem: "Exercise 2.16: prove the quotient isomorphism."
      },
      metadata: {
        hintLevel: "none",
        mode: "source_lookup",
        sourceConfidence: "high",
        studentActionNeeded: "none"
      }
    }
  });

  assert.deepEqual(blocks, [
    {
      content: "Exercise 2.16: prove the quotient isomorphism.",
      kind: "problem",
      label: "Problem"
    },
    {
      content: "If you want, I can help you start.",
      kind: "answer"
    }
  ]);
});

test("student assistant renderer repairs unhelpful section order", () => {
  const blocks = assistantMessageBlocks({
    content: "Let's work it step by step.",
    createdAt: new Date().toISOString(),
    id: "assistant-order-repair",
    role: "assistant",
    structuredOutput: {
      sectionOrder: ["hint", "nextStep", "answer", "formula"],
      sections: {
        answer: "Let's work it step by step.",
        formula: "Matrix columns are transformed basis vectors.",
        hint: "Apply the transformation to the first basis vector.",
        nextStep: "Send the first transformation from Exercise 2.3."
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["answer", "hint", "formula", "next-step"]
  );
});

test("student chat response normalization converts old flat structured output", () => {
  const response = normalizeTutorResponse({
    content: "Use substitution first. What expression should u equal?",
    retrievalConfidence: "high",
    sources: [],
    structuredOutput: {
      answer: "Use substitution first.",
      hintLevel: "guided_step",
      mode: "guided_problem_solving",
      nextQuestion: "What expression should u equal?",
      sourceConfidence: "high",
      studentActionNeeded: "try_next_step"
    } as never
  });

  assert.deepEqual(response.structuredOutput, {
    sections: {
      answer: "Use substitution first.",
      nextStep: "What expression should u equal?"
    },
    metadata: {
      hintLevel: "guided_step",
      mode: "guided_problem_solving",
      sourceConfidence: "high",
      studentActionNeeded: "try_next_step"
    }
  });
});

test("student chat response normalization preserves empty structured answer", () => {
  const response = normalizeTutorResponse({
    content: "Hint: Use the vector-space operations.\n\nYour next step: What is the addition operation?",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "",
        hint: "Use the vector-space operations.",
        nextStep: "What is the addition operation?"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "",
    hint: "Use the vector-space operations.",
    nextStep: "What is the addition operation?"
  });
});

test("student chat response normalization removes duplicated next step", () => {
  const response = normalizeTutorResponse({
    content: "I can take another look. What would you like me to focus on?",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "I can take another look. What would you like me to focus on?",
        nextStep: "I can take another look. What would you like me to focus on?"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "clarification",
        sourceConfidence: "low",
        studentActionNeeded: "answer_question"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "I can take another look. What would you like me to focus on?"
  });
});

test("student chat response normalization avoids duplicate hint and next-step wording", () => {
  const response = normalizeTutorResponse({
    content: "You are connecting the prompt to the rule that applies here.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "You are connecting the prompt to the rule that applies here.",
        hint: "Focus on the condition in the prompt that tells you which rule applies.",
        nextStep: "Focus on the condition in the prompt that tells you which rule applies."
      },
      metadata: {
        hintLevel: "small_hint",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "You are connecting the prompt to the rule that applies here.",
    hint: "Focus on the condition in the prompt that tells you which rule applies."
  });
});

test("student chat response normalization removes a hint repeated by the orientation", () => {
  const response = normalizeTutorResponse({
    content: "You are identifying the condition in the prompt that tells you which rule applies.",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "You are identifying the condition in the prompt that tells you which rule applies.",
        hint: "Identify the condition in the prompt that tells you which rule applies.",
        nextStep: "Write down the one condition you found."
      },
      metadata: {
        hintLevel: "small_hint",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "You are identifying the condition in the prompt that tells you which rule applies.",
    nextStep: "Write down the one condition you found."
  });
});

test("student assistant renderer suppresses duplicate structured sections", () => {
  const blocks = assistantMessageBlocks({
    content: "I can take another look. What would you like me to focus on?",
    createdAt: new Date().toISOString(),
    id: "assistant-duplicate-sections",
    role: "assistant",
    structuredOutput: {
      sections: {
        answer: "I can take another look. What would you like me to focus on?",
        nextStep: "Your next step: I can take another look. What would you like me to focus on?"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "clarification",
        sourceConfidence: "low",
        studentActionNeeded: "answer_question"
      }
    }
  });

  assert.deepEqual(blocks, [
    {
      content: "I can take another look. What would you like me to focus on?",
      kind: "answer"
    }
  ]);
});

test("student chat source lookup does not render a next step section", () => {
  const response = normalizeTutorResponse({
    content: "I found it: resume, printed page 1 in your notes.",
    retrievalConfidence: "high",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "I found it: resume, printed page 1 in your notes.",
        nextStep: "If you want, I can also pull out a specific section from page 1."
      },
      metadata: {
        hintLevel: "none",
        mode: "source_lookup",
        sourceConfidence: "high",
        studentActionNeeded: "review_source"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "I found it: resume, printed page 1 in your notes."
  });

  const blocks = assistantMessageBlocks({
    content: "I found it: resume, printed page 1 in your notes.",
    createdAt: new Date().toISOString(),
    id: "assistant-source-lookup",
    role: "assistant",
    structuredOutput: {
      sections: {
        answer: "I found it: resume, printed page 1 in your notes.",
        nextStep: "If you want, I can also pull out a specific section from page 1."
      },
      metadata: {
        hintLevel: "none",
        mode: "source_lookup",
        sourceConfidence: "high",
        studentActionNeeded: "review_source"
      }
    }
  });

  assert.deepEqual(blocks, [
    {
      content: "I found it: resume, printed page 1 in your notes.",
      kind: "answer"
    }
  ]);
});

test("student chat keeps source context out of problem section", () => {
  const response = normalizeTutorResponse({
    content: "Problem:\n2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations.",
    retrievalConfidence: "high",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "",
        problem:
          "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations. " +
          "That's the exact Exercise 2.18 on printed page 80."
      },
      metadata: {
        hintLevel: "none",
        mode: "source_lookup",
        sourceConfidence: "high",
        studentActionNeeded: "review_source"
      }
    }
  });

  assert.equal(
    response.structuredOutput?.sections.problem,
    "2.18. Assuming the polynomial bases [1,x,x^2], find the matrix representations."
  );
  assert.equal(response.structuredOutput?.sections.answer, "That's the exact Exercise 2.18 on printed page 80.");
});

test("student chat keeps quick lookup messages when final answer arrives", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /quickResponseContent\(event\)/);
  assert.match(studentSource, /function quickResponseContent/);
  assert.doesNotMatch(studentSource, /current\.filter\(\(message\) => message\.id !== quickResponseMessageId\)/);
});

test("student chat appends final assistant response after quick response", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /quickResponseMessageId = quickResponseMessageId \|\| `quick-\$\{studentMessage\.id\}`/);
  assert.match(studentSource, /upsertFinalAssistantMessage\(current, assistantMessage\)/);
  assert.doesNotMatch(studentSource, /hasSameVisibleAssistantAnswer/);
  assert.doesNotMatch(studentSource, /quickResponseIndex/);
});

test("student chat response normalization repairs split decimal example next step", () => {
  const response = normalizeTutorResponse({
    content:
      "Would you like to try Example 2.4\n1 together, starting with how to build the first column of the transition matrix?",
    retrievalConfidence: "low",
    sources: [],
    structuredOutput: {
      sections: {
        answer: "Would you like to try Example 2.4",
        nextStep: "1 together, starting with how to build the first column of the transition matrix?"
      },
      metadata: {
        hintLevel: "guided_step",
        mode: "guided_problem_solving",
        sourceConfidence: "low",
        studentActionNeeded: "try_next_step"
      }
    }
  });

  assert.deepEqual(response.structuredOutput?.sections, {
    answer: "Would you like to try Example 2.4.1 together, starting with how to build the first column of the transition matrix?"
  });
});

test("student assistant renderer falls back for old messages without structured output", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const messageFormatSource = readFileSync(join(repoRoot, "frontend/lib/chat-message-format.ts"), "utf8");

  assert.match(source, /assistantMessageBlocks\(message\)/);
  assert.match(messageFormatSource, /return message\.structuredOutput \? message\.structuredOutput\.sections\.answer : message\.content/);
  assert.match(source, /messageBlocks\.map/);
  assert.match(messageFormatSource, /assistantStructuredSections\(message: ChatMessage\)/);
  assert.match(messageFormatSource, /Your next step/);
  assert.doesNotMatch(source, /hintLevel|studentActionNeeded|sourceConfidence/);
});

test("tutor prompt keeps simple greetings as natural chat replies", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const backendSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");

  assert.match(promptSource, /For simple greetings or check-ins/);
  assert.match(backendSource, /For simple greetings or check-ins/);
  assert.match(graphSource, /For simple greetings or check-ins/);
  assert.match(promptSource, /one short chat message/);
});

test("active profile context creates teacher-only learning strategy telemetry", () => {
  const telemetry = buildLearningStrategyTelemetry({
    profileContext: {
      digest: "Try next: quick table before equations",
      strategies: [{ label: "quick table before equations", source: "strategiesToTryNext" }]
    },
    response: normalizeTutorResponse({
      content: "Let's make a quick table before choosing the equations. What should the first row show?",
      retrievalConfidence: "low",
      sources: []
    })
  });

  assert.equal(telemetry.profileUsed, true);
  assert.equal(telemetry.selectedStrategy, "quick table before equations");
  assert.equal(telemetry.tutorMove, "ask_guiding_question");
  assert.equal(telemetry.expectedStudentAction, "answer_question");
});

test("missing active profile context records profileUsed false without strategy details", () => {
  const telemetry = buildLearningStrategyTelemetry({
    profileContext: { digest: "", strategies: [] },
    response: normalizeTutorResponse({
      content: "Try the next algebra step and tell me what you get.",
      retrievalConfidence: "low",
      sources: []
    })
  });

  assert.equal(telemetry.profileUsed, false);
  assert.equal(telemetry.selectedStrategy, undefined);
});

test("structured tutor output maps to learning strategy tutor move and expected action", () => {
  const telemetry = buildLearningStrategyTelemetry({
    profileContext: {
      digest: "Try next: ask for visible work",
      strategies: []
    },
    response: normalizeTutorResponse({
      content: "Your first line is close. Show the next step you would revise.",
      retrievalConfidence: "low",
      sources: [],
      structuredOutput: {
        sections: {
          answer: "Your first line is close."
        },
        metadata: {
          hintLevel: "guided_step",
          mode: "check_work",
          sourceConfidence: "low",
          studentActionNeeded: "show_attempt"
        }
      }
    })
  });

  assert.equal(telemetry.tutorMove, "check_work");
  assert.equal(telemetry.expectedStudentAction, "show_work");
});

test("learning strategy telemetry is stripped from student-facing tutor responses", () => {
  const response = normalizeTutorResponse({
    content: "Try one step.",
    retrievalConfidence: "low",
    sources: []
  });
  const teacherTelemetryResponse = {
    ...response,
    learningStrategyTelemetry: buildLearningStrategyTelemetry({
      profileContext: { digest: "Try next: ask a guiding question", strategies: [] },
      response
    })
  };
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");

  assert.equal(stripTeacherOnlyTutorResponseFields(teacherTelemetryResponse).learningStrategyTelemetry, undefined);
  assert.match(persistenceSource, /learningStrategyTelemetry: response\.learningStrategyTelemetry/);
  assert.match(persistenceSource, /learningStrategyTelemetry:\s*message\.role === "assistant"/);
  assert.doesNotMatch(studentSource, /learningStrategyTelemetry/);
});

test("student follow-up attempts classify prior learning strategy outcome as progressed", () => {
  assert.equal(
    inferLearningStrategyObservedOutcome("I tried substituting u = x^2 + 1, then du = 2x dx."),
    "student_progressed"
  );
});

test("repeated answer-only follow-up classifies prior learning strategy outcome as still stuck", () => {
  assert.equal(inferLearningStrategyObservedOutcome("just give me the answer"), "student_still_stuck");
});

test("student chat math can overflow horizontally without hiding the rest of the answer", () => {
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(styles, /\.assistant-message-bubble \{/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /\.assistant-message-bubble \.katex/);
  assert.match(styles, /\.assistant-message-bubble \.katex-display/);
});

test("student composer textarea grows with typed lines up to a capped height", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(studentSource, /draftTextareaRef/);
  assert.match(studentSource, /scrollHeight/);
  assert.match(studentSource, /studentComposerTextareaMaxHeight = 156/);
  assert.match(styles, /\.student-composer textarea\s*\{[^}]*max-height: 156px/s);
  assert.match(styles, /\.student-composer textarea\s*\{[^}]*resize: none/s);
  assert.match(styles, /\.student-composer textarea\s*\{[^}]*overflow-y: hidden/s);
});

test("chat retrieval query carries recent conversation context into follow-ups", () => {
  const messages = [
    { role: "system" as const, content: "hidden setup" },
    { role: "student" as const, content: "I am working on worksheet 4 problem 7." },
    {
      role: "assistant" as const,
      content: "I think this is from Worksheet 4, problem 7.",
      sources: [{ materialType: "assignment", problemNumber: "7", title: "Worksheet 4" }]
    },
    { role: "student" as const, content: "Can you explain part b?" }
  ];

  const query = buildChatRetrievalQuery(messages);

  assert.equal(getLatestStudentQuestion(messages), "Can you explain part b?");
  assert.deepEqual(getRecentSourceHints(messages), [{ materialType: "assignment", problemNumber: "7", title: "Worksheet 4" }]);
  assert.match(query, /Previously used source context: Worksheet 4, problem 7/i);
  assert.match(query, /worksheet 4 problem 7/i);
  assert.match(query, /part b/i);
  assert.doesNotMatch(query, /hidden setup/);
});

test("provider messages keep assistant source context for follow-ups", () => {
  const providerContent = assistantContentWithSources({
    createdAt: "2026-05-06T00:00:01.000Z",
    id: "assistant-1",
    role: "assistant",
    content: "It is problem 14 on page 129.",
    langGraphTrace: {
      searchQueries: ["trig substitution problem 14"],
      selectedPages: [
        {
          citationLabel: "Calculus Textbook, page 615",
          docId: "textbook",
          materialType: "reading",
          pageEnd: 615,
          pageStart: 615,
          printedPageStart: 615,
          title: "Calculus Textbook"
        }
      ],
      stages: ["openrouter_agent"],
      toolCallCount: 1
    },
    sources: [
      {
        materialType: "practice-problems",
        pageNumber: 129,
        problemNumber: "14",
        title: "Paul Dawkins Calculus - Practice Problems"
      }
    ]
  });

  assert.match(providerContent, /Previously cited source context/);
  assert.match(providerContent, /Paul Dawkins Calculus - Practice Problems/);
  assert.match(providerContent, /problem 14/);
  assert.match(providerContent, /page 129/);
  assert.match(providerContent, /Previously selected PDF pages/);
  assert.match(providerContent, /Calculus Textbook/);
  assert.match(providerContent, /printed page 615/);
  assert.match(providerContent, /material type reading/);
});

test("show my work mode marks student attempts for provider feedback", () => {
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(studentSource, /studentMessageMode/);
  assert.match(studentSource, /Show my work/);
  assert.match(routeSource, /studentMessageMode: z\.enum\(\["ask", "work"\]\)\.optional\(\)/);
  assert.match(promptSource, /Student message mode: Show my work/);
  assert.match(promptSource, /reasoning-focused feedback/);
  assert.match(promptSource, /message\.studentMessageMode !== "work"/);
});

test("chat context memory saves only cited sources as sources used", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:21:00.000Z",
      id: "assistant-1",
      role: "assistant",
      content: "Use the example on page 159.",
      langGraphTrace: {
        searchQueries: ["similar derivative linear operator example"],
        selectedPages: [
          {
            docId: "acme",
            materialType: "reading",
            pageStart: 159,
            printedPageStart: 159,
            title: "ACME VOL 1"
          },
          {
            docId: "acme",
            materialType: "reading",
            pageStart: 99,
            printedPageStart: 99,
            title: "ACME VOL 1"
          }
        ],
        stages: ["pdf_search"],
        toolCallCount: 1
      },
      sources: [{ materialType: "reading", pageNumber: 159, title: "ACME VOL 1" }]
    }
  ]);

  assert.deepEqual(context.sourcesUsed, [
    {
      id: undefined,
      sourceName: "ACME VOL 1",
      sourceType: "class_material",
      pageNumber: 159,
      problemNumber: undefined,
      label: "p. 159"
    }
  ]);
});

test("chat context memory keeps sources from earlier assistant messages", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:21:00.000Z",
      id: "assistant-1",
      role: "assistant",
      content: "Use the theorem on page 640.",
      sources: [{ materialType: "reading", pageNumber: 640, title: "ACME VOL 1" }]
    },
    {
      createdAt: "2026-05-12T08:23:00.000Z",
      id: "assistant-2",
      role: "assistant",
      content: "It's Problem 2.15 on page 98.",
      sources: [{ materialType: "assignment", pageNumber: 98, title: "ACME VOL 1", problemNumber: "2.15" }]
    }
  ]);

  assert.deepEqual(context.sourcesUsed, [
    {
      id: undefined,
      sourceName: "ACME VOL 1",
      sourceType: "class_material",
      pageNumber: 98,
      problemNumber: "2.15",
      label: "p. 98 · Problem 2.15"
    },
    {
      id: undefined,
      sourceName: "ACME VOL 1",
      sourceType: "class_material",
      pageNumber: 640,
      problemNumber: undefined,
      label: "p. 640"
    }
  ]);
});

test("chat context memory dedupes the same saved problem across trace variants", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:21:00.000Z",
      id: "assistant-1",
      role: "assistant",
      content: "Problem:\n2.14. Given the setup of Exercise 2.13, prove the inequalities.",
      structuredOutput: {
        sections: {
          answer: "",
          problem: "2.14. Given the setup of Exercise 2.13, prove the inequalities."
        },
        metadata: {
          hintLevel: "none",
          mode: "source_lookup",
          problemNumber: "2.14",
          sourceConfidence: "high",
          studentActionNeeded: "none"
        }
      },
      sources: [{ materialType: "reading", pageNumber: 98, title: "ACME VOL 1", problemNumber: "2.14" }]
    },
    {
      createdAt: "2026-05-12T08:22:00.000Z",
      id: "assistant-2",
      role: "assistant",
      content: "Problem:\n2.14. Given the setup of Exercise 2.13, prove the following inequalities.",
      langGraphTrace: {
        knowledgeItems: [
          {
            chatId: "conversation-1",
            content: "2.14. Given the setup of Exercise 2.13, prove the following inequalities.",
            createdAt: "2026-05-12T08:22:00.000Z",
            id: "knowledge-problem-variant",
            kind: "problem",
            page: 98,
            problemId: "2.14",
            reason: "Student asked: problem 2.14",
            sourceId: "acme",
            sourceName: "ACME VOL 1",
            updatedAt: "2026-05-12T08:22:00.000Z",
            usedAs: "active_problem"
          }
        ],
        searchQueries: [],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      },
      sources: [{ materialType: "reading", pageNumber: 98, title: "ACME VOL 1", problemNumber: "2.14" }]
    }
  ]);

  assert.equal(context.savedProblems?.length, 1);
  assert.equal(context.savedProblems?.[0]?.problemNumber, "2.14");
  assert.equal(context.savedProblems?.[0]?.sourceName, "ACME VOL 1");
  assert.equal(context.savedProblems?.[0]?.pageNumber, 98);
});

test("chat context memory includes pdf knowledge items as sources used", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:22:00.000Z",
      id: "assistant-2",
      role: "assistant",
      content: "Here is a similar example.",
      langGraphTrace: {
        knowledgeItems: [
          {
            chatId: "conversation-1",
            createdAt: "2026-05-12T08:22:00.000Z",
            id: "knowledge-example-page",
            kind: "pdf_page",
            ocrText: "Example 4. Compare ranks after composing two maps.",
            page: 159,
            pdfId: "acme",
            problemId: "Example 4",
            reason: "Chandra used this page as an example reference.",
            sourceId: "acme",
            sourceName: "ACME VOL 1",
            updatedAt: "2026-05-12T08:22:00.000Z",
            usedAs: "example_reference"
          }
        ],
        searchQueries: ["worked example rank composition"],
        selectedPages: [],
        stages: ["pdf_search"],
        toolCallCount: 1
      }
    }
  ]);

  assert.deepEqual(context.sourcesUsed, [
    {
      id: "acme",
      sourceName: "ACME VOL 1",
      sourceType: "class_material",
      pageNumber: 159,
      problemNumber: undefined,
      label: "p. 159"
    }
  ]);
});

test("chat context memory includes student upload sources", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:22:00.000Z",
      id: "assistant-2",
      role: "assistant",
      content: "I can use the uploaded problem photo.",
      langGraphTrace: {
        knowledgeItems: [
          {
            chatId: "conversation-1",
            createdAt: "2026-05-12T08:22:00.000Z",
            id: "knowledge-upload",
            kind: "student_upload",
            reason: "Student uploaded problem or source context for this chat.",
            sourceId: "attachment-1",
            sourceName: "problem-photo.png",
            summary: "Student uploaded image: problem-photo.png.",
            updatedAt: "2026-05-12T08:22:00.000Z",
            usedAs: "problem_source"
          }
        ],
        searchQueries: [],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      }
    }
  ]);

  assert.deepEqual(context.sourcesUsed, [
    {
      id: "attachment-1",
      sourceName: "problem-photo.png",
      sourceType: "student_upload",
      pageNumber: undefined,
      problemNumber: undefined,
      label: "Student upload · problem-photo.png"
    }
  ]);
});

test("chat context memory saves pasted problems as current problems", () => {
  const context = buildChatContextMemory([
    {
      createdAt: "2026-05-12T08:22:00.000Z",
      id: "assistant-2",
      role: "assistant",
      content: "Let's work one step at a time.",
      langGraphTrace: {
        knowledgeItems: [
          {
            chatId: "conversation-1",
            content: "Problem 3.7. Prove that if A is invertible, then rank(AB) = rank(B).",
            createdAt: "2026-05-12T08:22:00.000Z",
            id: "knowledge-problem",
            kind: "problem",
            problemId: "3.7",
            reason: "Student pasted a problem statement.",
            sourceName: "Pasted problem",
            updatedAt: "2026-05-12T08:22:00.000Z",
            usedAs: "active_problem"
          }
        ],
        searchQueries: [],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      }
    }
  ]);

  assert.equal(context.currentProblem?.problemNumber, "3.7");
  assert.equal(context.currentProblem?.sourceName, "Pasted problem");
  assert.equal(context.currentProblem?.sourceType, "pasted_problem");
  assert.match(context.currentProblem?.problemText ?? "", /rank\(AB\)/);
  assert.equal(context.sourcesUsed?.[0]?.label, "Pasted problem");
});

test("student chat does not surface raw backend fetch failures", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /classifyUnexpectedChatError\(caughtError\)/);
  assert.match(source, /TUTOR_BACKEND_UNREACHABLE/);
  assert.match(source, /Chandra is having trouble connecting\. Try again in a moment\./);
  assert.doesNotMatch(source, /I could not reach Chandra's tutor backend/);
  assert.doesNotMatch(source, /npm run dev:api/);
  assert.doesNotMatch(source, /check `BACKEND_API_BASE_URL`/);
});

test("student chat errors include stable codes and student-safe messages", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const auditSource = readFileSync(join(repoRoot, "frontend/lib/audit-log.ts"), "utf8");

  assert.match(source, /errorCode: chatError\.code/);
  assert.match(source, /Code: \$\{error\.code\}/);
  assert.match(source, /writeChatErrorReference\(\{/);
  assert.match(auditSource, /collection\("chatErrorReferences"\)/);
  assert.match(source, /CHAT_SIGN_IN_REQUIRED/);
  assert.match(source, /CHAT_CLASS_NOT_FOUND/);
  assert.match(source, /CHAT_CONVERSATION_NOT_FOUND/);
  assert.match(source, /TUTOR_BACKEND_AUTH_FAILED/);
  assert.match(source, /TUTOR_BACKEND_SETUP_INCOMPLETE/);
  assert.match(source, /TUTOR_BACKEND_TIMEOUT/);
  assert.match(source, /TUTOR_BACKEND_RATE_LIMITED/);
  assert.match(source, /TUTOR_BACKEND_STREAM_FAILED/);
});

test("student chat accepts legacy null structured output in message history", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /structuredOutput: z[\s\S]*\]\)\s*\.nullable\(\)\s*\.optional\(\)/);
});

test("student chat route schema accepts structured output with confusion choices in history", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /const tutorConfusionChoiceSchema = z\.object/);
  assert.match(source, /confusionPrompt: z\.string\(\)\.max\(240\)\.optional\(\)/);
  assert.match(source, /confusionChoices: z\.array\(tutorConfusionChoiceSchema\)\.min\(2\)\.max\(6\)\.optional\(\)/);
});

test("student chat tolerates partial structured output in message history", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /z\.record\(z\.unknown\(\)\)/);
  assert.match(source, /event\.type === "quick_response"/);
  assert.match(source, /normalizeStructuredTutorOutput\(event\.structuredOutput, message\)/);
});

test("student UI renders confusion choice buttons and sends the selected message", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(source, /function TutorConfusionChoices/);
  assert.match(source, /message\.structuredOutput\?\.confusionChoices/);
  assert.match(source, /visibleConfusionPrompt/);
  assert.match(source, /sameDisplayedText\(block\.content, confusionPrompt\)/);
  assert.match(source, /assistant-confusion-choice-description/);
  assert.match(source, /onChoiceSelect\(choice\.message\)/);
  assert.match(source, /void sendStudentMessage\(choiceMessage\)/);
  assert.match(source, /aria-label=\{`Send: \$\{choice\.message\}`\}/);
  assert.match(styles, /\.assistant-confusion-choice-grid\s*\{\s*display: grid;/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\);/);
});

test("teacher debug mode exposes tutor behavior controls in the composer", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /function TutorDebugComposerControl/);
  assert.match(source, /Force confusion choices/);
  assert.match(source, /Force retrieval/);
  assert.match(source, /Force no retrieval/);
  assert.match(source, /forcedTutorDebugAiUsageStatus\(tutorDebugOptions\)/);
  assert.match(source, /showUsageHeader = !isTeacherPreview \|\| \(isTeacherDebugMode && Boolean\(debugAiUsageStatus\)\)/);
  assert.match(source, /showExactSearches = isTeacherPreview && isTeacherDebugMode/);
  assert.match(source, /label: "Exact searches"/);
  assert.match(source, /label: "Primary tutor turn"/);
  assert.match(source, /label: "Tutor plan"/);
  assert.match(source, /label: "Understanding state"/);
  assert.match(source, /label: "Selected pages"/);
  assert.match(source, /debugOptions:\s*[\s\S]*forceStudentView: tutorDebugOptions\.forceStudentView/);
  assert.match(source, /forceConfusionChoices: tutorDebugOptions\.forceConfusionChoices/);
  assert.match(source, /forceNoRetrieval: tutorDebugOptions\.forceNoRetrieval/);
  assert.match(source, /forceRetrieval: tutorDebugOptions\.forceRetrieval/);
  assert.match(routeSource, /forceConfusionChoices: scope\.role === "teacher" && data\.debugOptions\?\.forceConfusionChoices === true/);
  assert.match(routeSource, /forceNoRetrieval: scope\.role === "teacher" && data\.debugOptions\?\.forceNoRetrieval === true/);
  assert.match(routeSource, /forceRetrieval: scope\.role === "teacher" && data\.debugOptions\?\.forceRetrieval === true/);
  assert.match(source, /forceAiUsageNearLimit: tutorDebugOptions\.forceAiUsageNearLimit/);
  assert.match(source, /forceAiUsageBlocked: tutorDebugOptions\.forceAiUsageBlocked/);
  assert.match(source, /forceStudentView: false/);
  assert.match(source, /forceAiUsageBlocked: false/);
  assert.match(source, /forceAiUsageNearLimit: false/);
  assert.match(source, /forceNoRetrieval: false/);
  assert.match(source, /forceRetrieval: false/);
  assert.match(routeSource, /const chatDebugOptionsSchema = z\.object/);
  assert.match(routeSource, /preparedRequest\.debugOptions\.forceStudentView/);
  assert.match(routeSource, /withTutorDebugResponseOverrides/);
  assert.match(routeSource, /forcedTutorDebugAiUsageStatus/);
  assert.doesNotMatch(routeSource, /debug-setup/);
  assert.doesNotMatch(routeSource, /What part should Chandra focus on\?/);
});

test("streamed backend setup failures map to setup incomplete errors", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /normalizedDetail\.includes\("openrouter_api_key"\)/);
  assert.match(source, /normalizedDetail\.includes\("openrouter_http_referer"\)/);
  assert.match(source, /normalizedDetail\.includes\("frontend_origin"\)/);
  assert.match(source, /normalizedDetail\.includes\("next_internal_base_url"\)/);
  assert.match(source, /return "TUTOR_BACKEND_SETUP_INCOMPLETE";/);
});

test("student AI limits are token-budget based and student-safe", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");
  const settingsSource = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const typesSource = readFileSync(join(repoRoot, "frontend/lib/types.ts"), "utf8");

  assert.match(settingsSource, /perHour: 50_000/);
  assert.match(settingsSource, /perDay: 400_000/);
  assert.match(settingsSource, /perWeek: 1_600_000/);
  assert.doesNotMatch(usageSource, /limit: limits\.perHour/);
  assert.match(settingsSource, /tokenLimits: defaultAiTokenLimitSettings/);
  assert.doesNotMatch(usageSource, /ipPerFiveMinutes/);
  assert.doesNotMatch(usageSource, /ipPerHour/);
  assert.match(usageSource, /estimateAiRequestTokens/);
  assert.match(usageSource, /normalizeAiTokenUsage/);
  assert.match(usageSource, /studentStatus: buckets\.length \? studentStatusFromBuckets\(buckets\) : null/);
  assert.match(usageSource, /const usedTokens = bucket\.actualTotalTokens/);
  assert.match(usageSource, /bucket\.actualTotalTokens \+ estimatedTokens > bucket\.limit/);
  assert.doesNotMatch(usageSource, /bucket\.actualTotalTokens \+ bucket\.reservedTokens \+ estimatedTokens > bucket\.limit/);
  assert.match(usageSource, /blockedRealUsageStatus\(buckets\)/);
  assert.match(routeSource, /reserveAiTokenUsage/);
  assert.match(routeSource, /tokenLimits: classModelSettings\?\.tokenLimits/);
  assert.match(routeSource, /finalizeAiTokenUsage/);
  assert.match(routeSource, /aiUsageReservation/);
  assert.match(routeSource, /actualTokenUsageFromTutorPayload/);
  assert.match(routeSource, /CHAT_AI_USAGE_EXHAUSTED/);
  assert.match(studentSource, /todayPercentRemaining/);
  assert.match(studentSource, /weekPercentRemaining/);
  assert.match(studentSource, /% left/);
  assert.doesNotMatch(typesSource, /tokenUsage\?:/);
});

test("student chat header uses compact context and tutoring time popovers", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const stylesSource = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");
  const typesSource = readFileSync(join(repoRoot, "frontend/lib/types.ts"), "utf8");
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");

  assert.match(studentSource, /type HeaderDropdown = "context" \| "feedback" \| "understanding" \| "usage" \| null/);
  assert.match(studentSource, /Context/);
  assert.match(studentSource, /Tutoring time · \$\{usageSummary\.todayPercentLeft\}% left/);
  assert.match(studentSource, /Tutoring time: \$\{usageSummary\.todayPercentLeft\}% left today/);
  assert.match(studentSource, /Loading tutoring time/);
  assert.match(studentSource, /Tutoring time unavailable/);
  assert.match(studentSource, /errorMessage=\{aiUsageError\}/);
  assert.match(studentSource, /kind="tutoringTime"/);
  assert.match(studentSource, /student-header-usage-percent/);
  assert.match(studentSource, /student-header-control-label/);
  assert.match(studentSource, /Feedback/);
  assert.match(studentSource, /showUsageHeader \? \(\s*<div className="student-header-control-wrap">[\s\S]*student-usage-popover/);
  assert.doesNotMatch(studentSource, /const StudentAiUsagePanel/);
  assert.doesNotMatch(studentSource, /StudentAiUsageMeter/);
  assert.doesNotMatch(studentSource, /student-ai-usage-meters/);
  assert.match(studentSource, /StudentContextPopover/);
  assert.match(studentSource, /StudentUsagePopover/);
  assert.match(studentSource, /You have \$\{summary\.todayPercentLeft\}% of today's tutoring time left\./);
  assert.match(studentSource, /Uploads use more tutoring time\./);
  assert.match(studentSource, /Long explanations use more tutoring time\./);
  assert.match(studentSource, /Asking many follow-up questions uses more tutoring time\./);
  assert.match(studentSource, /formatTutoringResetLabel/);
  assert.match(studentSource, /resetAt=\{status\.dailyResetAt\}/);
  assert.match(studentSource, /resetAt=\{status\.weeklyResetAt\}/);
  assert.match(studentSource, /Loading weekly tutoring time/);
  assert.doesNotMatch(studentSource, /Weekly tutoring time resets Monday\./);
  assert.match(studentSource, /Ask professor for more time/);
  assert.doesNotMatch(studentSource, /credits used/);
  assert.doesNotMatch(studentSource, /100% left/);
  assert.match(studentSource, /StudentFeedbackPopover/);
  assert.doesNotMatch(studentSource, /StudentFeedbackModal/);
  assert.doesNotMatch(studentSource, /student-feedback-modal-backdrop/);
  assert.match(studentSource, /No course material is being referenced yet/);
  assert.match(studentSource, /Problems saved/);
  assert.match(studentSource, /Full problem text is not available yet/);
  assert.match(studentSource, /Sources/);
  assert.match(studentSource, /savedProblems/);
  assert.doesNotMatch(studentSource, /Advanced details/);
  assert.match(studentSource, /student_requested_problem: "Student requested this problem"/);
  assert.match(studentSource, /document\.addEventListener\("pointerdown", handleDocumentPointerDown\)/);
  assert.match(studentSource, /event\.key === "Escape"/);
  assert.match(stylesSource, /\.student-header-popover \{/);
  assert.match(stylesSource, /\.student-header-control-label/);
  assert.match(stylesSource, /max-width: 0/);
  assert.match(stylesSource, /\.student-usage-header-control \.student-header-control-label \{/);
  assert.match(stylesSource, /\.student-usage-header-control \.student-header-usage-percent/);
  assert.match(stylesSource, /\.student-header-control:hover \.student-header-control-label/);
  assert.match(stylesSource, /\.student-workspace-shell\[data-appearance="dark"\] \.student-header-control/);
  assert.match(stylesSource, /\.student-workspace-shell\[data-appearance="dark"\] \.student-header-popover/);
  assert.match(stylesSource, /position: absolute/);
  assert.match(stylesSource, /\.student-context-popover/);
  assert.match(stylesSource, /\.student-usage-popover/);
  assert.match(stylesSource, /\.student-feedback-popover/);
  assert.doesNotMatch(stylesSource, /\.student-feedback-modal-backdrop/);
  assert.match(stylesSource, /width: min\(420px, calc\(100vw - 32px\)\)/);
  assert.match(typesSource, /export type ChatContextMemory/);
  assert.match(typesSource, /export type UsageSummary/);
  assert.match(usageSource, /dailyUsed/);
  assert.match(usageSource, /weeklyLimit/);
});

test("student chat access controls and request quotas run before backend calls", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const authSource = readFileSync(join(repoRoot, "frontend/lib/tutor-chat-auth.ts"), "utf8");
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");
  const settingsSource = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");
  const backendSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(authSource, /normalizeTutorAccessSettings/);
  assert.match(authSource, /Your teacher has paused chat for this class/);
  assert.match(authSource, /studentSupport/);
  assert.match(authSource, /chatBlocked/);
  assert.match(routeSource, /reserveAiTokenUsage\(\{[\s\S]*provider: "langgraph"[\s\S]*requestLimits: classModelSettings\?\.requestLimits/);
  assert.match(routeSource, /const response = await fetch\(`\$\{langGraphBackendBaseUrl\(\)\}\/api\/langgraph\/chat`/);
  assert.match(routeSource, /if \(!reader\) \{\s*await releaseAiTokenReservationSafely\(preparedRequest\.aiUsageReservation, requestId\)/);
  assert.match(usageSource, /collection\("aiUsageRequestBuckets"\)/);
  assert.match(usageSource, /requestCount: FieldValue\.increment\(1\)/);
  assert.match(usageSource, /collection\("aiUsageEvents"\)/);
  assert.match(usageSource, /modelId/);
  assert.match(usageSource, /provider/);
  assert.match(settingsSource, /perStudentDaily: 50/);
  assert.match(settingsSource, /perStudentWeekly: 250/);
  assert.match(settingsSource, /perClassDaily: 3_000/);
  assert.match(settingsSource, /teacherPreviewDaily: 50/);
  assert.match(backendSource, /aiUsageReservation: Optional\[dict\[str, Any\]\] = None/);
  assert.match(backendSource, /enforce_ai_usage_reservation\(request\.aiUsageReservation, student_id=scope\["uid"\] if scope\["role"\] == "student" else None\)/);
  assert.match(backendSource, /async def chat\(request: ChatRequest[\s\S]*enforce_ai_usage_reservation\(request\.aiUsageReservation, student_id=scope\["uid"\] if scope\["role"\] == "student" else None\)[\s\S]*call_openrouter/);
});

test("teacher preview is allowed when class chat is paused but still uses preview quota", () => {
  const authSource = readFileSync(join(repoRoot, "frontend/lib/tutor-chat-auth.ts"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(authSource, /if \(role === "teacher"\)[\s\S]*return \{ classId, \.\.\.classScope, role, uid: decodedToken\.uid \}/);
  assert.match(routeSource, /role: scope\.role/);
  assert.match(routeSource, /studentId: scope\.role === "student" \? scope\.uid : undefined/);
  assert.match(studentSource, /!isTeacherPreview && activeClass\?\.studentChatEnabled === false/);
  assert.match(studentSource, /Your teacher has paused chat for this class\./);
});

test("paused student accounts can read saved conversations but cannot compose", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const classesRouteSource = readFileSync(join(repoRoot, "frontend/app/api/student/classes/route.ts"), "utf8");
  const conversationsRouteSource = readFileSync(join(repoRoot, "frontend/app/api/student/conversations/route.ts"), "utf8");
  const aiUsageRouteSource = readFileSync(join(repoRoot, "frontend/app/api/student/ai-usage/route.ts"), "utf8");
  const messagesRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/student/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );
  const attachmentsRouteSource = readFileSync(
    join(repoRoot, "frontend/app/api/student/conversations/[conversationId]/attachments/route.ts"),
    "utf8"
  );

  assert.match(classesRouteSource, /chatBlocked: boolean/);
  assert.match(classesRouteSource, /getStudentChatBlocked/);
  assert.match(aiUsageRouteSource, /enforceStudentChatAccess: false/);
  assert.match(conversationsRouteSource, /enforceStudentChatAccess: false/);
  assert.match(messagesRouteSource, /enforceStudentChatAccess: false/);
  assert.match(attachmentsRouteSource, /enforceStudentChatAccess: false/);
  assert.match(studentSource, /activeClass\?\.chatBlocked[\s\S]*Chat is paused for this account/);
  assert.match(studentSource, /disabled=\{studentChatPaused\}/);
  assert.match(studentSource, /disabled=\{isSending \|\| studentChatPaused\}/);
});

test("AI request quota day buckets reset by UTC day", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");

  assert.match(usageSource, /function dayBucketKey\(date: Date\)/);
  assert.match(usageSource, /date\.toISOString\(\)\.slice\(0, 10\)\.replace\(\s*\/-\/g,\s*""\s*\)/);
  assert.match(usageSource, /export function buildAiUsageDayBucketKey/);
});

test("student tutoring-time buckets are anchored to first class AI use", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");
  const dataSource = readFileSync(join(repoRoot, "frontend/lib/data/usage.ts"), "utf8");
  const migrationSource = readFileSync(join(repoRoot, "migrations/002_core_app_tables.sql"), "utf8");
  const typesSource = readFileSync(join(repoRoot, "frontend/lib/types.ts"), "utf8");

  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS ai_usage_anchors/);
  assert.match(migrationSource, /PRIMARY KEY \(class_id, student_id\)/);
  assert.match(dataSource, /INSERT INTO ai_usage_anchors/);
  assert.match(dataSource, /ON CONFLICT \(class_id, student_id\) DO NOTHING/);
  assert.match(usageSource, /ensureStudentAiUsageAnchor\(\{ classId, now, studentId: quotaUserId \}\)/);
  assert.match(usageSource, /getStudentAiUsageAnchor\(\{ classId, studentId \}\)/);
  assert.match(usageSource, /dayBucketDurationMs = 24 \* 60 \* 60 \* 1000/);
  assert.match(usageSource, /weekBucketDurationMs = 7 \* dayBucketDurationMs/);
  assert.match(usageSource, /bucketKey: `anchored_\$\{anchorMillis\}_\$\{elapsedPeriods\}`/);
  assert.match(usageSource, /buildAnchoredAiUsageBucketKey/);
  assert.match(usageSource, /buildAnchoredAiUsageResetAt/);
  assert.match(usageSource, /dailyResetAt = anchoredBucketResetAt\(bucket\.bucketKey, "day"\)/);
  assert.match(usageSource, /weeklyResetAt = anchoredBucketResetAt\(bucket\.bucketKey, "week"\)/);
  assert.match(typesSource, /dailyResetAt\?: string/);
  assert.match(typesSource, /weeklyResetAt\?: string/);
});

test("student chat verbose settings leave room for math-heavy examples", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");

  assert.match(source, /return 900/);
  assert.match(source, /return 2200/);
  assert.match(source, /return 4200/);
  assert.match(source, /return 7000/);
  assert.match(source, /"veryDetailed"/);
});

test("student chat does not drop generated answers when assistant persistence fails", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /saveAssistantMessageWithoutBlockingTutorResponse/);
  assert.match(source, /await saveAssistantMessage\(/);
  assert.match(source, /catch \(caughtError\)/);
  assert.match(source, /CHAT_CONVERSATION_ID_INVALID/);
  assert.match(source, /withConversationMetadata\(tutorResponse, preparedRequest\.persistence\)/);
});

test("student chat does not fail when optional prep data is unavailable", () => {
  const source = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");

  assert.match(source, /getStudentLearningProfileContextForTutor/);
  assert.match(source, /Student learning profile skipped for tutor chat/);
  assert.match(source, /prepareStudentConversationPersistenceForTutor/);
  assert.match(source, /Student conversation persistence skipped before tutor chat/);
  assert.match(source, /emptyLearningStrategyProfileContext\(\)/);
  assert.match(source, /return null/);
});

test("student learning profile context is sent privately to backend", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const backendSource = readFileSync(join(repoRoot, "backend/main.py"), "utf8");

  assert.match(routeSource, /studentLearningProfileContext: privateBackendLearningProfileContext\(studentLearningProfileContext\)/);
  assert.match(routeSource, /strategiesToTryNext/);
  assert.match(routeSource, /availableStrategies/);
  assert.match(backendSource, /studentLearningProfileContext: Optional\[dict\[str, Any\]\] = None/);
  assert.match(backendSource, /student_profile_context=request\.studentLearningProfileContext/);
});

test("pdf tool prompt uses textbook readings for solving help", () => {
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/chat/route.ts"), "utf8");
  const promptSource = readFileSync(join(repoRoot, "frontend/lib/prompts.ts"), "utf8");
  const graphSource = readFileSync(join(repoRoot, "backend/agent/graph.py"), "utf8");

  assert.match(routeSource, /indexed PostgreSQL OCR metadata/);
  assert.match(routeSource, /search_pdf_pages\(\{ query, retrieval_reason \}\)/);
  assert.match(routeSource, /For exact task lookup, search assignment\/problem PDFs first/);
  assert.match(routeSource, /For any concrete assignment, pasted problem, or prompt, check the exact class source before helping/);
  assert.match(routeSource, /For textbook section\/chapter requests, search `textbook reading` plus the exact marker and topic words/);
  assert.match(routeSource, /first call search_pdf_pages/);
  assert.match(routeSource, /quick_response/);
  assert.match(routeSource, /OCR metadata records/);
  assert.match(routeSource, /support inspection rather than giving a correctness verdict/);
  assert.match(promptSource, /support inspection rather than giving a correctness verdict/);
  assert.match(routeSource, /avoid student-facing verdict labels/);
  assert.match(promptSource, /avoid student-facing verdict labels/);
  assert.match(routeSource, /One place to tighten is/);
  assert.match(promptSource, /What would make this implication valid/);
  assert.match(routeSource, /source-text lookup/);
  assert.match(routeSource, /quote the requested visible source item exactly/);
  assert.match(routeSource, /ask what they tried or where they are stuck/);
  assert.match(routeSource, /bare stuck\/start follow-up/);
  assert.match(routeSource, /do not provide task-specific starts/);
  assert.match(routeSource, /give me an example of what I can say/);
  assert.match(routeSource, /proof scaffolds, or all-parts breakdowns/);
  assert.match(routeSource, /meaningfully different/);
  assert.match(routeSource, /Never use `Example:` for homework-ready wording/);
  assert.match(routeSource, /explain like I am 5/);
  assert.match(routeSource, /Do not reveal the full solution, final answer, final artifact/);
  assert.match(promptSource, /ask what they tried or where they are stuck/);
  assert.match(promptSource, /brief orientation sentence plus one conceptual hint/);
  assert.match(promptSource, /use optional sections only when they add new value/);
  assert.match(promptSource, /never output sections just because the schema supports them/);
  assert.match(promptSource, /vague stuck messages like `I am lost`/);
  assert.match(promptSource, /one short orientation or nudge plus one clear question/);
  assert.match(promptSource, /if the main answer already gives the key clue, equation, theorem, or method, omit Hint/);
  assert.match(promptSource, /If Hint already gives the action, omit the next step/);
  assert.match(promptSource, /previous hint was unhelpful, repetitive, too vague, or did not add more/);
  assert.match(promptSource, /specific missing object, definition, target space, assumption, comparison, representation, or notation choice/);
  assert.match(promptSource, /broad concept explanations or topic overviews, usually answer in plain prose without Hint/);
  assert.match(promptSource, /duplicated main answer plus Hint/);
  assert.match(promptSource, /specific problem, page, or passage, treat it as source lookup/);
  assert.match(promptSource, /For problem-statement lookup, first identify the exact academic exercise\/question\/task statement/);
  assert.match(routeSource, /Before using `Problem:`/);
  assert.match(routeSource, /lookup\/checking status/);
  assert.match(promptSource, /do not provide task-specific starting points/);
  assert.match(promptSource, /`what can I say`/);
  assert.match(promptSource, /clearly different similar example/);
  assert.match(promptSource, /Do not complete the student's exact task/);
  assert.match(promptSource, /complete one small piece/);
  assert.match(promptSource, /brief orientation, one targeted hint, one concrete next step/);
  assert.match(routeSource, /relationships, family conflict, emotional support, unrelated coding/);
  assert.match(routeSource, /Briefly redirect those to course material/);
  assert.match(routeSource, /unrelated uploaded photos or personal images such as pets/);
  assert.match(routeSource, /also use search_pdf_pages when the student asks for a specific class source item/);
  assert.match(promptSource, /Treat student uploads as class context only/);
  assert.match(promptSource, /Do not describe, rate, compliment, identify, or discuss unrelated uploaded photos/);
  assert.match(routeSource, /quote the requested visible text exactly/);
  assert.match(routeSource, /generic copyright grounds/);
  assert.match(promptSource, /quoteSourcePassages/);
  assert.match(routeSource, /conceptual method\/example questions/);
  assert.match(routeSource, /For find-similar-example requests/);
  assert.match(routeSource, /do not search only the assigned problem number/);
  assert.match(routeSource, /one per distinct need/);
  assert.match(routeSource, /worked example`, `example`, `textbook reading`, `lecture notes`, `method`/);
  assert.match(routeSource, /For solving help, method teaching, or source-text lookup/);
  assert.match(readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8"), /studentSearchPurposeLabel/);
  assert.match(readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8"), /Finding the exact problem/);
  assert.match(readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8"), /Looking for a method or rule/);
  assert.match(readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8"), /Looking for a similar example/);
  assert.match(routeSource, /Default to one clean answer plus useful optional sections/);
  assert.match(routeSource, /Choose the student-facing order of the answer and sections/);
  assert.match(routeSource, /Use `Hint:` when the student is stuck or asks how to start/);
  assert.match(routeSource, /use optional sections only when they add new value/);
  assert.match(routeSource, /never output sections just because the schema supports them/);
  assert.match(routeSource, /vague stuck messages like `I am lost`/);
  assert.match(routeSource, /main answer already gives the key clue, equation, theorem, or method, omit `Hint:`/);
  assert.match(routeSource, /If `Hint:` already gives the action, omit `nextStep`/);
  assert.match(routeSource, /previous hint was unhelpful, repetitive, too vague, or did not add more/);
  assert.match(routeSource, /make this hint narrower instead of repeating it/);
  assert.match(routeSource, /broad concept explanations or topic overviews, usually answer in plain prose without `Hint:`/);
  assert.match(routeSource, /duplicated main answer plus `Hint:`/);
  assert.match(routeSource, /use at most one nudge plus one question/);
  assert.match(routeSource, /prefer one concise reply or one short `Hint:` and leave `nextStep` empty/);
  assert.match(routeSource, /Use `Check your work:` only when the student shows work/);
  assert.match(routeSource, /Keep it neutral and process-focused/);
  assert.match(routeSource, /1-2 is often enough, and 3-4 is fine/);
  assert.match(routeSource, /Do not write `Source:`, `Sources:`/);
  assert.match(routeSource, /Do not write `Answer:`, `Question:`/);
  assert.match(promptSource, /Direct-answer requests and submission-ready wording for the exact task should be refused/);
  assert.match(promptSource, /similar example or the student's attempted step/);
  assert.match(promptSource, /Only help with this class, its materials/);
  assert.match(promptSource, /unrelated code/);
  assert.match(graphSource, /primary tutor turn/);
  assert.match(graphSource, /bare stuck\/start follow-up/);
  assert.match(graphSource, /Depth 1 uses one short answer or Hint plus one question, especially for vague stuck messages like `I am lost`/);
  assert.match(graphSource, /answer already gives the key clue, equation, theorem, or method, omit hint/);
  assert.match(graphSource, /If hint already gives the action, omit nextStep/);
  assert.match(graphSource, /previous hint was unhelpful, repetitive, too vague, or did not add more/);
  assert.match(graphSource, /one new concrete distinction, prerequisite idea, or narrower sub-question/);
  assert.match(graphSource, /never output sections just because the schema supports them/);
  assert.match(graphSource, /PostgreSQL OCR metadata/);
  assert.match(graphSource, /bare numbered references like `problem 2\.14`/);
  assert.match(graphSource, /follow-ups to prior source-backed answers/);
  assert.match(graphSource, /Answer directly only for greetings/);
  assert.match(graphSource, /ROUTER_REASONING_EFFORT = "low"/);
});

test("student feedback is submitted through server routes and kept separate from teacher private notes", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const feedbackServerSource = readFileSync(join(repoRoot, "frontend/lib/student-feedback-server.ts"), "utf8");
  const studentFeedbackRoute = readFileSync(join(repoRoot, "frontend/app/api/student/feedback/route.ts"), "utf8");
  const teacherFeedbackRoute = readFileSync(
    join(repoRoot, "frontend/app/api/classes/[classId]/feedback/[feedbackId]/route.ts"),
    "utf8"
  );

  assert.match(studentSource, /student-feedback-button/);
  assert.match(studentSource, /StudentFeedbackPopover/);
  assert.doesNotMatch(studentSource, /student-feedback-modal-backdrop/);
  assert.match(studentSource, /buildFeedbackPromptCandidate/);
  assert.match(studentSource, /!response\.ok/);
  assert.match(studentFeedbackRoute, /authorizeStudentFeedbackRequest/);
  assert.match(feedbackServerSource, /authorizeStudentFeedbackRequest/);
  assert.doesNotMatch(feedbackServerSource, /assertStudentChatAccess/);
  assert.match(studentFeedbackRoute, /createStudentFeedback/);
  assert.match(teacherFeedbackRoute, /authorizeClassAccess\(request, classId, "reviewConversations"\)/);
  assert.match(teacherFeedbackRoute, /updateTeacherStudentFeedback/);
  assert.match(feedbackServerSource, /collection\("studentFeedback"\)/);
  assert.match(feedbackServerSource, /conversationId/);
  assert.match(feedbackServerSource, /messageId/);
  assert.match(feedbackServerSource, /teacherNote/);
  assert.match(feedbackServerSource, /checkFirestoreRateLimit/);
  assert.doesNotMatch(feedbackServerSource, /conversationReviews/);
  assert.doesNotMatch(feedbackServerSource, /privateNote/);
});

test("student feedback prompt avoids nagging while covering learning signals", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");

  assert.match(studentSource, /assistantReplyCount >= 4/);
  assert.match(studentSource, /confusionSignalPattern/);
  assert.match(studentSource, /retrievalConfidence === "low"/);
  assert.match(studentSource, /sources\?\.length \?\? 0\) >= 3/);
  assert.match(studentSource, /feedbackPromptShownToday/);
  assert.match(studentSource, /studentFeedbackPrompt:\$\{classId\}:\$\{conversationId\}/);
  assert.match(studentSource, /finally \{\s*sendInFlightRef\.current = false;\s*setIsSending\(false\);\s*setChatProgress\(null\);/s);
});

test("student context saves the exact problem before falling back to page OCR", () => {
  const contextMemorySource = readFileSync(join(repoRoot, "frontend/lib/chat-context-memory.ts"), "utf8");
  const problemTextBlock = contextMemorySource.slice(
    contextMemorySource.indexOf("const pageOcrText ="),
    contextMemorySource.indexOf("const problem: NonNullable")
  );

  assert.ok(
    problemTextBlock.indexOf("message.structuredOutput?.sections?.problem") <
      problemTextBlock.indexOf("extractProblemTextFromPageOcr")
  );
  assert.match(contextMemorySource, /const problem: NonNullable<ChatContextMemory\["currentProblem"\]> \| undefined = activeProblemNumber \|\| problemText/);
  assert.match(contextMemorySource, /extractProblemTextFromPageOcr\(pageOcrText, activeProblemNumber\)/);
  assert.match(contextMemorySource, /function extractProblemTextFromPageOcr/);
});

test("student understanding helper is empty before active problem and initializes at level zero", () => {
  assert.equal(buildUnderstandingState([]), null);
  assert.equal(
    buildUnderstandingState([
      {
        id: "assistant-placeholder",
        role: "assistant",
        content: "What are you working on?",
        createdAt: "2026-05-12T00:00:00.000Z",
        langGraphTrace: {
          problemUnderstandingState: {
            activeProblemId: "unknown",
            understandingLevel: 0,
            updatedAt: "2026-05-12T00:00:00.000Z"
          },
          searchQueries: [],
          selectedPages: [],
          stages: [],
          toolCallCount: 0
        }
      }
    ]),
    null
  );

  assert.equal(
    buildUnderstandingState([
      {
        id: "assistant-lookup",
        role: "assistant",
        content: "I'm checking the class materials for problem 2/20.",
        createdAt: "2026-05-12T00:00:00.000Z",
        langGraphTrace: {
          problemUnderstandingState: {
            activeProblemId: "problem-lookup-only",
            reasons: ["Requested problem 2/20 after earlier asking for problem 2.24."],
            understandingLevel: 0,
            updatedAt: "2026-05-12T00:00:00.000Z"
          },
          retrievalReason: "student_requested_problem",
          searchQueries: [],
          selectedPages: [],
          stages: [],
          toolCallCount: 0,
          tutorPlan: {
            needsRetrieval: true,
            retrievalReason: "student_requested_problem",
            studentIntent: "specific_question"
          }
        }
      }
    ]),
    null
  );

  const state = buildUnderstandingState([
    {
      id: "assistant-1",
      role: "assistant",
      content: "Problem:\nProblem 3.9. Prove that a rotation in R^2 is orthonormal.",
      createdAt: "2026-05-12T00:00:00.000Z",
      langGraphTrace: {
        problemUnderstandingState: {
          activeProblemId: "problem-3-9",
          understandingLevel: 0,
          lastHintSummary: "Chandra has not seen your work yet.",
          updatedAt: "2026-05-12T00:00:00.000Z"
        },
        searchQueries: [],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      }
    }
  ]);

  assert.equal(state?.level, 0);
  assert.deepEqual(state?.reasons, ["Chandra has the problem, but has not seen your work on it yet."]);
});

test("student understanding reasons stay process-focused and safe", () => {
  assert.deepEqual(
    safeUnderstandingReasons(
      {
        activeProblemId: "problem-setup",
        understandingLevel: 2,
        conceptsUnderstood: ["the main object in the problem"],
        knownConfusions: ["the key justification"],
        lastHintSummary: "Your answer is correct.",
        lastStudentAttemptSummary: "You showed an attempt, but the key justification is still missing."
      },
      2
    ),
    [
      "You have part of the setup; the next update depends on the main idea you use.",
      "You showed an attempt, but the key justification is still missing",
      "You identified the main object in the problem.",
      "Next, clarify the key justification."
    ]
  );

  assert.deepEqual(
    safeUnderstandingReasons(
      {
        activeProblemId: "problem-image",
        understandingLevel: 1,
        reasons: [
          "Student asked how the concept relates to real-world applications, then specified data science.",
          "Image means the set of outputs that can actually be produced; in data science, these are the reachable predictions or transformed results."
        ]
      },
      1
    ),
    [
      "Chandra has the problem and still needs to see your next step or attempt.",
      "Student asked how the concept relates to real-world applications, then specified data science",
      "Chandra is checking how you use image in this problem."
    ]
  );

  const closeState = buildUnderstandingState([
    {
      id: "assistant-close",
      role: "assistant",
      content: "Problem:\nProblem close. Check the notation in your final line.",
      createdAt: "2026-05-12T00:00:00.000Z",
      langGraphTrace: {
        problemUnderstandingState: {
          activeProblemId: "problem-close",
          understandingLevel: 4,
          reasons: ["You are close and mostly need cleanup."],
          updatedAt: "2026-05-12T00:00:00.000Z"
        },
        searchQueries: [],
        selectedPages: [],
        stages: [],
        toolCallCount: 0
      }
    }
  ]);

  assert.equal(closeState?.level, 4);
  assert.deepEqual(closeState?.reasons, ["You are close; Chandra is mostly checking notation, justification, or cleanup."]);
});

test("student understanding UI sits beside knowledge and keeps safe copy", () => {
  const studentSource = readFileSync(join(repoRoot, "frontend/app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.ok(studentSource.indexOf("<KnowledgeIconButton") < studentSource.indexOf("<UnderstandingLevelButton"));
  assert.match(studentSource, /aria-describedby=\{hasState \? undefined : emptyTooltipId\}/);
  assert.match(studentSource, /aria-disabled=\{!hasState\}/);
  assert.match(studentSource, /data-understanding-level=\{state\?\.level\}/);
  assert.match(studentSource, /<span className="student-header-control-label">Understanding<\/span>/);
  assert.doesNotMatch(studentSource, /`Understanding \$\{state\?\.level\}`/);
  assert.match(studentSource, /Understanding starts once a problem is loaded\./);
  assert.match(studentSource, /role="tooltip"/);
  assert.match(studentSource, /student-header-popover student-understanding-popover student-understanding-empty-tooltip/);
  assert.match(studentSource, /student-popover-empty/);
  assert.match(studentSource, /Chandra estimates how much support you need for this problem\./);
  assert.match(studentSource, /<h3>Updates<\/h3>/);
  assert.doesNotMatch(studentSource, /Why it changed/);
  assert.match(studentSource, /This is not a grade\./);
  const popoverSource = studentSource.slice(
    studentSource.indexOf("const UnderstandingPopover"),
    studentSource.indexOf("function knowledgeRoleFromSectionKind")
  );
  assert.doesNotMatch(popoverSource, /\b(?:correct|incorrect|answer)\b/i);
  assert.match(styles, /\.student-understanding-control/);
  assert.match(styles, /\.student-understanding-control\[aria-disabled="true"\]/);
  assert.match(styles, /\.student-understanding-empty-tooltip/);
  assert.match(styles, /:hover \+ \.student-understanding-empty-tooltip/);
  assert.match(styles, /\.student-understanding-popover/);
  assert.match(styles, /data-understanding-level="0"/);
  assert.match(styles, /data-understanding-level="4"/);
  assert.match(styles, /#0b66a0/);
  assert.match(styles, /#65d68c/);
});
