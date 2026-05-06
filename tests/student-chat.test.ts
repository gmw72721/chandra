import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildChatRetrievalQuery, getLatestStudentQuestion, getRecentSourceHints } from "../lib/chat-retrieval-query.ts";
import { assistantContentWithSources } from "../lib/provider-source-context.ts";
import { resolveStudentChatClassId, StudentChatScopeError } from "../lib/student-chat-scope.ts";

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
  const source = readFileSync(join(repoRoot, "app/student/page.tsx"), "utf8");

  assert.doesNotMatch(source, /htmlFor="model"/);
  assert.doesNotMatch(source, /modelOptions/);
  assert.doesNotMatch(source, /customModelStorageKey/);
});

test("student chat posts the saved class and auth token to the tutor API", () => {
  const source = readFileSync(join(repoRoot, "app/student/page.tsx"), "utf8");
  const apiClientSource = readFileSync(join(repoRoot, "lib/api-client.ts"), "utf8");

  assert.match(source, /const activeCourseId = isTeacherPreview \? queryClassId \?\? "" : profile\?\.classId \?\? ""/);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /courseId: activeCourseId/);
  assert.match(apiClientSource, /return path\.startsWith\("\/"\) \? path : `\/\$\{path\}`/);
  assert.doesNotMatch(apiClientSource, /NEXT_PUBLIC_API_BASE_URL/);
});

test("student chat persists and resumes class-scoped conversations", () => {
  const routeSource = readFileSync(join(repoRoot, "app/api/chat/route.ts"), "utf8");
  const studentSource = readFileSync(join(repoRoot, "app/student/page.tsx"), "utf8");
  const persistenceSource = readFileSync(join(repoRoot, "lib/student-conversations-server.ts"), "utf8");
  const studentConversationRouteSource = readFileSync(join(repoRoot, "app/api/student/conversations/route.ts"), "utf8");
  const studentMessageRouteSource = readFileSync(
    join(repoRoot, "app/api/student/conversations/[conversationId]/messages/route.ts"),
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

test("student view pins teacher assignment guidance above chat", () => {
  const source = readFileSync(join(repoRoot, "app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "app/styles.css"), "utf8");

  assert.match(source, /className="student-teacher-instructions"/);
  assert.match(source, /Teacher instructions/);
  assert.match(source, /formatPinnedTeacherInstructions\(activeClass\.defaultAssignmentContext\)/);
  assert.match(styles, /\.student-teacher-instructions/);
});

test("conversation titles use topic labels from the first prompt", () => {
  const source = readFileSync(join(repoRoot, "lib/student-conversations-server.ts"), "utf8");

  assert.match(source, /inferTopicConversationTitle\(normalized\)/);
  assert.match(source, /Derivative chain rule/);
  assert.match(source, /Limits with fractions/);
  assert.match(source, /Optimization problem/);
  assert.match(source, /return "Need help"/);
});

test("teacher roster can open a student's saved conversations", () => {
  const teacherSource = readFileSync(join(repoRoot, "components/TeacherClassManager.tsx"), "utf8");
  const conversationRouteSource = readFileSync(
    join(repoRoot, "app/api/classes/[classId]/students/[studentId]/conversations/route.ts"),
    "utf8"
  );
  const messageRouteSource = readFileSync(
    join(repoRoot, "app/api/classes/[classId]/conversations/[conversationId]/messages/route.ts"),
    "utf8"
  );

  assert.match(teacherSource, /students\/\$\{encodeURIComponent\(\s*selectedStudent\.email\s*\)\}\/conversations/);
  assert.match(teacherSource, /conversations\/\$\{encodeURIComponent\(\s*activeSelectedConversationId\s*\)\}\/messages/);
  assert.match(teacherSource, /className="professor-chat-review"/);
  assert.match(teacherSource, /setSelectedStudentId\(student\.id\)/);
  assert.match(teacherSource, /conversationMessages\.map/);
  assert.match(teacherSource, /Back to roster/);
  assert.match(conversationRouteSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(conversationRouteSource, /listTeacherStudentConversations/);
  assert.match(messageRouteSource, /authorizeClassTeacher\(request, classId\)/);
  assert.match(messageRouteSource, /listTeacherConversationMessages/);
});

test("conversation Firestore rules are class-scoped and server-write-only", () => {
  const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");

  assert.match(rules, /match \/conversations\/\{conversationId\}/);
  assert.match(rules, /isTargetClassTeacher\(classId\)/);
  assert.match(rules, /resource\.data\.studentId == request\.auth\.uid/);
  assert.match(rules, /match \/messages\/\{messageId\}/);
  assert.match(rules, /documents\/classes\/\$\(classId\)\/conversations\/\$\(conversationId\)/);
  assert.match(rules, /allow write: if false/);
});

test("source labels render under tutor messages", () => {
  const source = readFileSync(join(repoRoot, "app/student/page.tsx"), "utf8");
  const styles = readFileSync(join(repoRoot, "app/styles.css"), "utf8");

  assert.match(source, /className="message-sources"/);
  assert.match(source, /formatSourceLabel/);
  assert.match(styles, /\.message-sources/);
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
  const source = readFileSync(join(repoRoot, "app/api/chat/route.ts"), "utf8");

  assert.match(source, /classifyUnexpectedChatError\(caughtError\)/);
  assert.match(source, /TUTOR_BACKEND_UNREACHABLE/);
  assert.match(source, /Chandra is having trouble connecting\. Try again in a moment\./);
  assert.doesNotMatch(source, /I could not reach Chandra's tutor backend/);
  assert.doesNotMatch(source, /npm run dev:api/);
  assert.doesNotMatch(source, /check `BACKEND_API_BASE_URL`/);
});

test("student chat errors include stable codes and student-safe messages", () => {
  const source = readFileSync(join(repoRoot, "app/api/chat/route.ts"), "utf8");

  assert.match(source, /errorCode: chatError\.code/);
  assert.match(source, /Code: \$\{error\.code\}/);
  assert.match(source, /CHAT_SIGN_IN_REQUIRED/);
  assert.match(source, /CHAT_CLASS_NOT_FOUND/);
  assert.match(source, /CHAT_CONVERSATION_NOT_FOUND/);
  assert.match(source, /TUTOR_BACKEND_AUTH_FAILED/);
  assert.match(source, /TUTOR_BACKEND_SETUP_INCOMPLETE/);
  assert.match(source, /TUTOR_BACKEND_TIMEOUT/);
  assert.match(source, /TUTOR_BACKEND_RATE_LIMITED/);
  assert.match(source, /TUTOR_BACKEND_STREAM_FAILED/);
});

test("pdf tool prompt uses textbook readings for solving help", () => {
  const routeSource = readFileSync(join(repoRoot, "app/api/chat/route.ts"), "utf8");
  const promptSource = readFileSync(join(repoRoot, "lib/prompts.ts"), "utf8");

  assert.match(routeSource, /search the problem PDF first/);
  assert.match(routeSource, /Do not search textbook\/readings unless no problem-set match is found/);
  assert.match(routeSource, /prefer queries that target the reading or method/);
  assert.match(routeSource, /Do not repeat the exact problem\/source search/);
  assert.match(routeSource, /use those pages and do not search again/);
  assert.match(routeSource, /do not solve their exact problem/);
  assert.match(routeSource, /similar textbook\/readings\/example problem/);
  assert.match(routeSource, /relationships, family conflict, emotional support, unrelated coding/);
  assert.match(routeSource, /Briefly redirect those to course material/);
  assert.match(routeSource, /include one short quote of 20 words or fewer/);
  assert.match(routeSource, /For conceptual method questions such as when to use a technique/);
  assert.match(routeSource, /For solving help and method teaching/);
  assert.match(promptSource, /Do not continue solving their exact problem/);
  assert.match(promptSource, /similar textbook\/readings\/example problem/);
  assert.match(promptSource, /Only help with this class/);
  assert.match(promptSource, /Do not write unrelated code/);
  assert.match(promptSource, /search the problem PDF first/);
  assert.match(promptSource, /Do not only point the student to pages/);
  assert.match(promptSource, /method teaching/);
  assert.match(promptSource, /search textbook\/readings\/examples so the explanation can use the class wording/);
  assert.match(promptSource, /previously cited source context/);
});
