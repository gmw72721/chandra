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
import { normalizeTutorResponse } from "../frontend/lib/tutor-response.ts";

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
  assert.match(routeSource, /saveAssistantMessage/);
  assert.match(routeSource, /withConversationMetadata/);
  assert.match(persistenceSource, /collection\("classes"\)/);
  assert.match(persistenceSource, /collection\("conversations"\)/);
  assert.match(persistenceSource, /collection\("messages"\)/);
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
  assert.match(studentSource, /allowedComposerAttachmentExtensions = \["\.pdf"\]/);
  assert.match(studentSource, /Only text-readable PDF homework files are supported/);
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
  assert.match(attachmentServerSource, /PDFParse/);
  assert.match(attachmentServerSource, /extractedText/);
  assert.match(chatRouteSource, /attachmentIds: z\.array\(safeDocumentIdSchema\)/);
  assert.match(chatRouteSource, /appendAttachmentContextToStudentMessage/);
  assert.match(chatRouteSource, /Extracted text:/);
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
  assert.match(teacherSource, /Back to roster/);
  assert.match(conversationRouteSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(conversationRouteSource, /listTeacherStudentConversations/);
  assert.match(messageRouteSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(messageRouteSource, /listTeacherConversationMessages/);
});

test("teacher class conversations endpoint loads the review inbox", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const routeSource = readFileSync(join(repoRoot, "frontend/app/api/classes/[classId]/conversations/route.ts"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "frontend/lib/student-conversations-server.ts"), "utf8");

  assert.match(routeSource, /authorizeClassTeacher\(request, classId\)/);
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

  assert.match(routeSource, /authorizeClassTeacher\(request, classId\)/);
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
  assert.match(persistenceSource, /retrievalConfidence: normalizeRetrievalConfidence\(data\.retrievalConfidence\)/);
  assert.match(messageRouteSource, /listTeacherConversationMessages/);
});

test("teacher transcript uses student chat markdown formatting and readable source labels", () => {
  const teacherSource = readFileSync(join(repoRoot, "frontend/components/TeacherClassManager.tsx"), "utf8");
  const messageFormatSource = readFileSync(join(repoRoot, "frontend/lib/chat-message-format.ts"), "utf8");
  const styles = readFileSync(join(repoRoot, "frontend/app/styles.css"), "utf8");

  assert.match(teacherSource, /import ReactMarkdown from "react-markdown"/);
  assert.match(teacherSource, /remarkMath/);
  assert.match(teacherSource, /rehypeKatex/);
  assert.match(teacherSource, /assistantMessageAnswerContent\(message\)/);
  assert.match(teacherSource, /structuredSections\.map/);
  assert.match(teacherSource, /condensedSourceLabels\(message\.sources\)/);
  assert.match(messageFormatSource, /export function assistantStructuredSections/);
  assert.match(styles, /\.teacher-transcript-message/);
  assert.match(styles, /\.teacher-dashboard\[data-appearance="dark"\] \.teacher-transcript-sources span/);
});

test("teacher roster active status uses Firebase presence and combines activity columns", () => {
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
  assert.match(teacherSource, /<span>Activity<\/span>/);
  assert.doesNotMatch(teacherSource, /<span>Status<\/span>\s*<span>Last active<\/span>/);
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
  assert.match(source, /condensedSourceLabels\(message\.sources\)/);
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

  assert.match(source, /assistantMessageAnswerContent\(message\)/);
  assert.match(messageFormatSource, /return message\.structuredOutput \? message\.structuredOutput\.sections\.answer : message\.content/);
  assert.match(source, /answerContent \? \(/);
  assert.match(source, /assistantStructuredSections\(message\)/);
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

  assert.match(settingsSource, /perDay: 300_000/);
  assert.match(settingsSource, /perWeek: 1_200_000/);
  assert.doesNotMatch(settingsSource, /perHour:/);
  assert.doesNotMatch(usageSource, /limits\.perHour/);
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
  assert.match(usageSource, /collection\("aiUsageRequestBuckets"\)/);
  assert.match(usageSource, /requestCount: FieldValue\.increment\(1\)/);
  assert.match(usageSource, /collection\("aiUsageEvents"\)/);
  assert.match(usageSource, /modelId/);
  assert.match(usageSource, /provider/);
  assert.match(settingsSource, /perStudentDaily: 100/);
  assert.match(settingsSource, /perClassDaily: 3_000/);
  assert.match(settingsSource, /teacherPreviewDaily: 50/);
  assert.match(backendSource, /enforce_ai_usage_reservation\(request\.aiUsageReservation\)/);
  assert.match(backendSource, /async def chat\(request: ChatRequest[\s\S]*enforce_ai_usage_reservation\(request\.aiUsageReservation\)[\s\S]*call_openrouter/);
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

test("AI request quota day buckets reset by UTC day", () => {
  const usageSource = readFileSync(join(repoRoot, "frontend/lib/ai-usage-limits.ts"), "utf8");

  assert.match(usageSource, /function dayBucketKey\(date: Date\)/);
  assert.match(usageSource, /date\.toISOString\(\)\.slice\(0, 10\)\.replace\(\s*\/-\/g,\s*""\s*\)/);
  assert.match(usageSource, /export function buildAiUsageDayBucketKey/);
});

test("student chat response length settings leave room for math-heavy examples", () => {
  const source = readFileSync(join(repoRoot, "frontend/lib/class-settings.ts"), "utf8");

  assert.match(source, /return 900/);
  assert.match(source, /return 2200/);
  assert.match(source, /return 4200/);
  assert.match(source, /return 7000/);
  assert.match(source, /"extended"/);
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

  assert.match(routeSource, /search the assignment\/problem PDF first/);
  assert.match(routeSource, /Do not search textbook\/readings unless no task-source match is found/);
  assert.match(routeSource, /concrete assignment or problem, including a fully pasted question or prompt/);
  assert.match(routeSource, /Check problem PDFs, worksheets, assignments, labs, prompts, practice problems, readings, and textbook sections before helping/);
  assert.match(routeSource, /textbook section or chapter/);
  assert.match(routeSource, /do not assume a particular textbook title/);
  assert.match(routeSource, /query generically with `textbook reading`/);
  assert.match(routeSource, /use the tool first to check whether the exact task appears in class materials/);
  assert.match(routeSource, /prefer queries that target the reading or method/);
  assert.match(routeSource, /Do not repeat the exact task\/source search/);
  assert.match(routeSource, /use those pages and do not search again/);
  assert.match(routeSource, /do not complete their exact task/);
  assert.match(routeSource, /similar textbook\/readings\/example task/);
  assert.match(routeSource, /verify it before affirming it/);
  assert.match(promptSource, /verify it before affirming it/);
  assert.match(routeSource, /Source-backed help does not override the attempt-first rule/);
  assert.match(routeSource, /treat that as source lookup, not solving help/);
  assert.match(routeSource, /only supplies a specific problem\/exercise\/page\/title reference without asking for solving help/);
  assert.match(routeSource, /quote the full visible problem statement exactly/);
  assert.match(routeSource, /bare references like `problem 3\.4`/);
  assert.match(routeSource, /first ask what they have tried or where they are stuck/);
  assert.match(routeSource, /do not provide task-specific starting points/);
  assert.match(routeSource, /give me an example of what I can say/);
  assert.match(routeSource, /proof scaffolds, or all-parts breakdowns/);
  assert.match(routeSource, /meaningfully different facts, data, prompt details, or requirements/);
  assert.match(routeSource, /how a source, example, prior exercise, hint, rubric, rule, method, or instructor note gives, supports, covers, applies to, or connects/);
  assert.match(routeSource, /part, half, subquestion, requirement, or step of their exact assigned task/);
  assert.match(routeSource, /Ask one targeted question or explain a prerequisite concept without applying it to the exact task/);
  assert.match(routeSource, /Do not state what this gives them, what it proves, which part it completes, what to write next/);
  assert.match(routeSource, /help the student identify their own next move/);
  assert.match(routeSource, /Never use `Example:` to provide homework-ready wording/);
  assert.match(routeSource, /explain like I am 5' is not a student attempt/);
  assert.match(routeSource, /do not reveal a full solution, final answer, final artifact/);
  assert.match(promptSource, /ask what they tried or where they are stuck/);
  assert.match(promptSource, /specific problem, page, or passage, treat it as source lookup/);
  assert.match(promptSource, /For problem-statement lookup, give the text but do not solve it or ask for an attempt first/);
  assert.match(promptSource, /do not provide task-specific starting points/);
  assert.match(promptSource, /`what can I say`/);
  assert.match(promptSource, /clearly different similar example/);
  assert.match(promptSource, /Do not complete the student's exact task/);
  assert.match(promptSource, /not the exact next move/);
  assert.match(routeSource, /relationships, family conflict, emotional support, unrelated coding/);
  assert.match(routeSource, /Briefly redirect those to course material/);
  assert.match(routeSource, /quote the relevant passage exactly/);
  assert.match(routeSource, /generic copyright grounds/);
  assert.match(promptSource, /quoteSourcePassages/);
  assert.match(routeSource, /For conceptual method questions such as when to use a technique/);
  assert.match(routeSource, /For solving help and method teaching/);
  assert.match(routeSource, /Use fewer sections whenever the answer is clear without them/);
  assert.match(routeSource, /Choose optional sections from the student's intent/);
  assert.match(routeSource, /Use `Hint:` when the student is stuck or asks how to start/);
  assert.match(routeSource, /Use `Check your work:` only when the student shows work/);
  assert.match(routeSource, /Use at most two optional labeled sections/);
  assert.match(routeSource, /Do not write `Source:`, `Sources:`, or `Based on selected class material`/);
  assert.match(routeSource, /Do not write `Answer:`, `Question:`/);
  assert.match(promptSource, /Direct-answer requests and submission-ready wording for the exact task should be refused/);
  assert.match(promptSource, /similar example or the student's attempted step/);
  assert.match(promptSource, /Only help with this class, its materials/);
  assert.match(promptSource, /unrelated code/);
  assert.match(graphSource, /PDF retrieval router/);
  assert.match(graphSource, /worksheet, assignment, textbook/);
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
  assert.match(studentSource, /StudentFeedbackModal/);
  assert.match(studentSource, /buildFeedbackPromptCandidate/);
  assert.match(studentSource, /!response\.ok/);
  assert.match(studentFeedbackRoute, /authorizeStudentFeedbackRequest/);
  assert.match(feedbackServerSource, /authorizeStudentFeedbackRequest/);
  assert.doesNotMatch(feedbackServerSource, /assertStudentChatAccess/);
  assert.match(studentFeedbackRoute, /createStudentFeedback/);
  assert.match(teacherFeedbackRoute, /authorizeClassTeacher/);
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
