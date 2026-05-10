export type Role = "student" | "teacher" | "assistant" | "system";

export type ModelOption = {
  id: string;
  label: string;
  provider: "openrouter" | "local" | "demo";
  description: string;
};

export type TutorPolicy = {
  id: string;
  courseId: string;
  title: string;
  visibleToStudent: boolean;
  instructions: string[];
  refusalStyle: string;
  retrievalGuidance: string;
};

export type SourceDocument = {
  id: string;
  courseId: string;
  title: string;
  kind: "lecture-notes" | "textbook" | "worked-example" | "assignment";
  status: "ready" | "processing" | "needs-review";
  uploadedAt: string;
  activeForStudents?: boolean;
  classId?: string;
  citationsRequired?: boolean;
  materialType?: string;
  filePath?: string;
  fileUrl?: string;
  priority?: TutorKnowledgePriority;
  professorId?: string;
  professorName?: string;
  teacherId?: string;
  teacherOnly?: boolean;
  chunks: SourceChunk[];
};

export type SourceChunk = {
  id: string;
  documentId: string;
  label: string;
  content: string;
  classId?: string;
  chunkIndex?: number;
  chunkText?: string;
  docId?: string;
  excerpt?: string;
  materialId?: string;
  materialType?: string;
  pageEnd?: number;
  pageNumber?: number;
  pageStart?: number;
  problemNumbers?: string[];
  professorId?: string;
  professorName?: string;
  section?: string;
  sectionHeading?: string;
  teacherId?: string;
  title?: string;
  vector?: number[];
  vectorDistance?: number;
};

export type TutorKnowledgePriority = "primary" | "normal" | "low";

export type Course = {
  id: string;
  name: string;
  section: string;
  activePolicyId: string;
  allowedModelIds: string[];
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  langGraphTrace?: TutorTrace;
  learningStrategyTelemetry?: LearningStrategyTelemetry;
  retrievalConfidence?: RetrievalConfidence;
  sources?: TutorSource[];
  structuredOutput?: TutorStructuredOutput;
};

export type Conversation = {
  id: string;
  courseId: string;
  studentName: string;
  assignment: string;
  modelId: string;
  messages: ChatMessage[];
  tags: string[];
  lastActiveAt: string;
};

export type StudentConversationSummary = {
  id: string;
  classId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  teacherId: string;
  teacherName?: string;
  title: string;
  modelId: string;
  createdAt: unknown;
  updatedAt: unknown;
  lastMessageAt: unknown;
  messageCount: number;
  assignment?: string;
  tags?: string[];
};

export type StudentRosterActivitySummary = {
  conversationCount: number;
  displayName: string;
  lastActiveAt: string;
  lastChatTopic: string;
  questionsPerDay: number;
  questionsToday: number;
  recentConversations: Array<{
    id: string;
    lastMessageAt: unknown;
    messageCount: number;
    title: string;
  }>;
  status: "active" | "inactive" | "no_activity";
  studentId: string;
  studentEmail: string;
  teacherNotes: string;
  totalQuestions: number;
};

export type RetrievalHit = {
  chunk: SourceChunk;
  document: SourceDocument;
  score: number;
  matchedProblemNumber?: string;
};

export type RetrievalConfidence = "high" | "medium" | "low";

export type TutorStructuredSections = {
  answer: string;
  hint?: string;
  explanation?: string;
  formula?: string;
  example?: string;
  checkWork?: string;
  sourceNote?: string;
  nextStep?: string;
};

export type TutorStructuredMetadata = {
  hintLevel: "none" | "small_hint" | "guided_step" | "worked_example" | "refusal";
  sourceConfidence: "high" | "medium" | "low";
  studentActionNeeded:
    | "none"
    | "show_attempt"
    | "try_next_step"
    | "answer_question"
    | "review_source"
    | "paste_problem"
    | "ask_teacher";
  mode:
    | "guided_problem_solving"
    | "socratic"
    | "check_work"
    | "reading_helper"
    | "exam_review"
    | "source_lookup"
    | "direct_answer_refusal"
    | "clarification"
    | "off_topic_redirect";
};

export type TutorStructuredOutput = {
  sections: TutorStructuredSections;
  metadata: TutorStructuredMetadata;
};

export type TutorSource = {
  title: string;
  materialType: string;
  citationsRequired?: boolean;
  pageNumber?: number;
  problemNumber?: string;
};

export type ConversationReviewStatus =
  | "new"
  | "reviewed"
  | "needs_follow_up"
  | "misunderstanding_spotted"
  | "good_learning_moment"
  | "ai_answer_needs_review";

export type TeacherConversationReview = {
  conversationId: string;
  classId: string;
  teacherId: string;
  status: ConversationReviewStatus;
  privateNote: string;
  reviewedAt: unknown;
  updatedAt: unknown;
  flags: string[];
};

export type TeacherConversationSourceAuditSummary = {
  sourceCount: number;
  sources: TutorSource[];
  noSourceUsedWarning: boolean;
  lowSourceConfidence: boolean;
  learningSignals: TeacherConversationLearningSignalSummary;
  latestRetrievalConfidence?: RetrievalConfidence;
};

export type TeacherConversationLearningSignalSummary = {
  assistantMessageCount: number;
  lowConfidenceMessageCount: number;
  noSourceAssistantMessageCount: number;
  askTeacherCount: number;
  pasteProblemCount: number;
  reviewSourceCount: number;
  showAttemptCount: number;
  guidedStepCount: number;
  workedExampleCount: number;
  stuckOutcomeCount: number;
  progressedOutcomeCount: number;
  disengagedOutcomeCount: number;
  latestStudentActionNeeded?: TutorStructuredMetadata["studentActionNeeded"];
  latestHintLevel?: TutorStructuredMetadata["hintLevel"];
  latestMode?: TutorStructuredMetadata["mode"];
};

export type TeacherConversationReviewSummary = {
  conversationId: string;
  id: string;
  classId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  teacherId: string;
  teacherName?: string;
  title: string;
  messageCount: number;
  lastMessageAt: unknown;
  topic: string;
  modelId: string;
  learningSignals: TeacherConversationLearningSignalSummary;
  sourceAudit: TeacherConversationSourceAuditSummary;
  latestRetrievalConfidence?: RetrievalConfidence;
  review: TeacherConversationReview;
  reviewStatus: ConversationReviewStatus;
};

export type TutorTrace = {
  finishReason?: string;
  inputTokenBreakdown?: TutorInputTokenSection[];
  searchQueries: string[];
  selectedPages: Array<{
    citationLabel?: string;
    docId?: string;
    materialType?: string;
    pageEnd?: number;
    pageStart?: number;
    printedPageEnd?: number;
    printedPageStart?: number;
    title?: string;
  }>;
  stages: string[];
  toolCallCount: number;
};

export type TutorInputTokenSection = {
  characters?: number;
  detail?: string;
  estimatedTokens: number;
  id: string;
  kind: string;
  label: string;
  purpose?: string;
  stage?: string;
};

export type TutorApiResponse = {
  assistantMessageId?: string;
  conversationId?: string;
  message: string;
  content: string;
  hintLevel?: string;
  langGraphTrace?: TutorTrace;
  learningStrategyTelemetry?: LearningStrategyTelemetry;
  mode?: string;
  studentActionNeeded?: string;
  sources: TutorSource[];
  structuredOutput?: TutorStructuredOutput;
  retrievalConfidence: RetrievalConfidence;
};

export type LearningStrategyTutorMove =
  | "ask_guiding_question"
  | "small_hint"
  | "worked_example"
  | "check_work"
  | "source_grounded_explanation"
  | "refusal_redirect"
  | "clarification";

export type LearningStrategyExpectedStudentAction =
  | "answer_question"
  | "try_next_step"
  | "show_work"
  | "revise_step"
  | "review_source"
  | "paste_problem";

export type LearningStrategyObservedOutcome =
  | "unknown"
  | "student_progressed"
  | "student_still_stuck"
  | "student_disengaged";

export type LearningStrategyTelemetry = {
  profileUsed: boolean;
  selectedStrategy?: string;
  selectedStrategyId?: string;
  reasonSelected?: string;
  tutorMove: LearningStrategyTutorMove;
  expectedStudentAction: LearningStrategyExpectedStudentAction;
  observedOutcome?: LearningStrategyObservedOutcome;
};

export type StudentLearningProfileConfidence = "low" | "medium" | "high";

export type StudentLearningStrategyStatus =
  | "try_next"
  | "currently_testing"
  | "appears_helpful"
  | "appears_unhelpful"
  | "inconclusive"
  | "retired";

export type StudentLearningEvidenceObservationType =
  | "learning_signal"
  | "strategy_helpful"
  | "strategy_unhelpful"
  | "improvement"
  | "open_question";

export type StudentLearningTriedStrategy = {
  id: string;
  strategy: string;
  reasonTried: string;
  firstTriedAt: string;
  lastObservedAt: string;
  status: StudentLearningStrategyStatus;
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextAction: string;
};

export type StudentLearningEvidence = {
  conversationId: string;
  messageId?: string;
  date?: string;
  observationType: StudentLearningEvidenceObservationType;
  note: string;
};

export type StudentLearningProfileContent = {
  summary: string;
  learningSignals: string[];
  effectiveSupports: string[];
  lessEffectiveSupports: string[];
  strategiesToTryNext: string[];
  avoid: string[];
  openQuestions: string[];
  notableImprovements: string[];
  profileChangeNotes: string[];
  triedStrategies: StudentLearningTriedStrategy[];
  evidence: StudentLearningEvidence[];
};

export type StudentLearningProfileDocument = {
  id: string;
  classId: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  active: boolean;
  teacherReviewed: boolean;
  confidence: StudentLearningProfileConfidence;
  updatedAt: unknown;
  lastReviewedAt: unknown;
  lastUpdateAttemptAt: unknown;
  lastSuccessfulUpdateAt: unknown;
  pendingConversationCount: number;
  pendingStudentMessageCount: number;
  minimumConversationsForUpdate: number;
  minimumStudentMessagesForUpdate: number;
  activeProfile?: StudentLearningProfileContent | null;
  draftProfile?: StudentLearningProfileContent | null;
};

export type TeacherOverviewStatusTone =
  | "active"
  | "ai-review"
  | "draft"
  | "failed"
  | "follow-up"
  | "high"
  | "inactive"
  | "ink"
  | "new"
  | "note"
  | "processing"
  | "ready"
  | "teacher-only";

export type TeacherClassOverviewMetricSummary = {
  activeNow: number;
  averageQuestionsPerStudentPerDay: number;
  conversationCountPreviousDay: number;
  draftLearningProfiles: number;
  missingLearningProfiles: number;
  noActivity: number;
  questionsPreviousDay: number;
  questionsToday: number;
  reviewedLearningProfiles: number;
  totalConversations: number;
  totalStudents: number;
};

export type TeacherClassOverviewSummary = {
  activeStudentsToday: number;
  body: string;
  conversationCountToday: number;
  questionsToday: number;
  title: string;
  topTopics: string[];
};

export type TeacherClassOverviewPriorityRow = {
  action: "addNote" | "openRoster" | "viewChats";
  actionLabel: string;
  id: string;
  issue: string;
  status: string;
  studentEmail: string;
  studentId: string;
  studentName: string;
  tone: TeacherOverviewStatusTone;
};

export type TeacherClassOverviewRecentActivityRow = {
  conversationId: string;
  id: string;
  lastMessageAt: unknown;
  lastMessageLabel: string;
  messageCount: number;
  studentId: string;
  studentName: string;
  title: string;
};

export type TeacherClassOverviewReviewQueueRow = {
  conversationId: string;
  id: string;
  issue: string;
  lastMessageAt: unknown;
  lastMessageLabel: string;
  meta: string;
  sourceLabel: string;
  sourceCount: number;
  status: string;
  studentId: string;
  studentName: string;
  suggestedAction: string;
  title: string;
  tone: TeacherOverviewStatusTone;
};

export type TeacherClassOverviewLearningProfileRow = {
  id: string;
  meta: string;
  status: string;
  studentEmail: string;
  studentId: string;
  studentName: string;
  tone: TeacherOverviewStatusTone;
};

export type TeacherClassOverviewKnowledgeStat = {
  label: string;
  tone: TeacherOverviewStatusTone;
  value: number;
};

export type TeacherClassOverviewActionPriority = "critical" | "high" | "medium" | "low";

export type TeacherClassOverviewNextAction = {
  action:
    | "addKnowledge"
    | "addStudent"
    | "openKnowledge"
    | "openRoster"
    | "openStudentView"
    | "reviewConversations"
    | "reviewLearningProfiles"
    | "testRetrieval"
    | "viewStudentChats";
  detail: string;
  conversationId?: string;
  evidenceConversationIds?: string[];
  id: string;
  label: string;
  priority: TeacherClassOverviewActionPriority;
  rationale: string[];
  studentEmail?: string;
  studentId?: string;
  studentName?: string;
  tone: TeacherOverviewStatusTone;
};

export type TeacherClassOverview = {
  classId: string;
  date: string;
  dateLabel: string;
  generatedAt: string;
  knowledgeStatus: TeacherClassOverviewKnowledgeStat[];
  learningProfileRows: TeacherClassOverviewLearningProfileRow[];
  metrics: TeacherClassOverviewMetricSummary;
  nextActions: TeacherClassOverviewNextAction[];
  priorityRows: TeacherClassOverviewPriorityRow[];
  recentActivityRows: TeacherClassOverviewRecentActivityRow[];
  reviewQueueRows: TeacherClassOverviewReviewQueueRow[];
  summary: TeacherClassOverviewSummary;
  timezone: string;
};
