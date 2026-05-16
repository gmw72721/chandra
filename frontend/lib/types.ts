export type Role = "student" | "teacher" | "assistant" | "system";
export type StudentMessageMode = "ask" | "work";

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

export type PdfMaterialMetadata = {
  materialId: string;
  classId: string;
  courseId: string;
  professorId: string;
  teacherId: string;
  title: string;
  materialType: string;
  contentType: string;
  fileName: string;
  fileSize: number;
  storageBucket: string;
  storagePath: string;
  storageUri: string;
  fullPdfBucket?: string | null;
  fullPdfPath?: string | null;
  fullPdfUri?: string | null;
  fullPdfMimeType?: string | null;
  fullPdfSize?: number | null;
  fullPdfSha256?: string | null;
  sourceKind: "file" | "storage" | "url";
  ocrProvider: string;
  ocrSource: string;
  ocrConfidence?: number | null;
  pageCount: number;
  characterCount: number;
};

export type PdfOcrPageMetadata = {
  materialId: string;
  classId: string;
  courseId: string;
  professorId: string;
  teacherId: string;
  title: string;
  materialType: string;
  pageNumber: number;
  pageStart: number;
  pageEnd: number;
  ocrText: string;
  ocrProvider: string;
  ocrSource: string;
  ocrConfidence?: number | null;
  storageBucket: string;
  storagePath: string;
  fullPdfBucket?: string | null;
  fullPdfPath?: string | null;
  fullPdfUri?: string | null;
  fullPdfMimeType?: string | null;
  fullPdfSize?: number | null;
  fullPdfSha256?: string | null;
  pageAssetBucket?: string | null;
  pageAssetPath?: string | null;
  pageAssetUri?: string | null;
  pageAssetMimeType?: string | null;
  pageAssetSize?: number | null;
  pageAssetSha256?: string | null;
  pageAssetStorageBucket?: string | null;
  pageAssetStoragePath?: string | null;
  pageAssetSizeBytes?: number | null;
  pageAssetChecksumSha256?: string | null;
};

export type PdfDetectedProblemMetadata = {
  materialId: string;
  classId: string;
  courseId: string;
  professorId: string;
  teacherId: string;
  title: string;
  materialType: string;
  problemNumber: string;
  pageStart: number;
  pageEnd: number;
  problemText: string;
  source: string;
  confidence?: number | null;
  ocrProvider: string;
  ocrSource: string;
  storageBucket: string;
  storagePath: string;
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
  attachments?: MessageAttachment[];
  createdAt: string;
  debugInfo?: TutorDebugInfo;
  langGraphTrace?: TutorTrace;
  learningStrategyTelemetry?: LearningStrategyTelemetry;
  retrievalConfidence?: RetrievalConfidence;
  sources?: TutorSource[];
  studentMessageMode?: StudentMessageMode;
  structuredOutput?: TutorStructuredOutput;
};

export type MessageAttachment = {
  id: string;
  conversationId: string;
  messageId?: string | null;
  studentId: string;
  classId: string;
  fileName: string;
  fileType: "image" | "pdf";
  mimeType: string;
  fileSize: number;
  storageKey: string;
  uploadStatus: "uploading" | "ready" | "failed";
  extractedText?: string | null;
  pageCount?: number | null;
  createdAt: unknown;
  updatedAt: unknown;
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
  contextMemory?: ChatContextMemory;
  contextUpdatedAt?: unknown;
  problemLabel?: string;
  problemNumber?: string;
  problemSummary?: string;
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
  chatBlocked: boolean;
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
  studentResponse?: string;
  mainChat?: string;
  answer?: string;
  problem?: string;
  hint?: string;
  keyIdea?: string;
  rule?: string;
  method?: string;
  /**
   * Legacy input only. New tutor responses should put conceptual reasoning in
   * studentResponse, keyIdea, rule, sourceContext, or hint instead of rendering
   * a separate Explanation section.
   */
  explanation?: string;
  example?: string;
  sourceContext?: string;
  checkWork?: string;
};

export type TutorStructuredSectionKey =
  | "studentResponse"
  | "problem"
  | "hint"
  | "keyIdea"
  | "rule"
  | "method"
  | "example"
  | "sourceContext"
  | "checkWork";

export type TutorStructuredMetadata = {
  hintLevel: "none" | "small_hint" | "guided_step" | "worked_example" | "refusal";
  choiceDisplay?: "problem_selection" | "support_path_uncertainty";
  problemNumber?: string;
  problemSummary?: string;
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
  sectionOrder?: TutorStructuredSectionKey[];
  confusionPrompt?: string;
  confusionChoices?: TutorConfusionChoice[];
  metadata: TutorStructuredMetadata;
};

export type TutorConfusionChoice = {
  description?: string;
  id: string;
  label: string;
  message: string;
};

export type TutorSource = {
  id?: string;
  title: string;
  materialType: string;
  citationsRequired?: boolean;
  pageEnd?: number;
  pageNumber?: number;
  pageStart?: number;
  pdfId?: string;
  printedPageEnd?: number;
  printedPageNumber?: number;
  printedPageStart?: number;
  sourceItemLabel?: string;
  problemNumber?: string;
  problemNumbers?: string[];
  reason?: string;
  retrievalReason?: string;
  sourceId?: string;
  usedAs?: KnowledgeItemUsedAs;
};

export type KnowledgeItemKind = "problem" | "pdf_page" | "student_upload";

export type KnowledgeItemUsedAs =
  | "active_problem"
  | "problem_source"
  | "supporting_context"
  | "definition_reference"
  | "theorem_reference"
  | "example_reference"
  | "student_attempt";

export type KnowledgeUiColorToken = "blue" | "neutral" | "purple" | "green" | "orange";

export type KnowledgeItem = {
  id: string;
  chatId: string;
  classId?: string;
  assignmentId?: string;
  kind: KnowledgeItemKind;
  sourceName: string;
  sourceId?: string;
  fileType?: "image" | "pdf";
  pdfId?: string;
  page?: number;
  problemId?: string;
  content?: string;
  ocrText?: string;
  summary?: string;
  usedAs: KnowledgeItemUsedAs;
  uiColor?: KnowledgeUiColorToken;
  reason: string;
  linkedProblemId?: string;
  createdAt: unknown;
  updatedAt: unknown;
};

export type ConversationReviewStatus =
  | "new"
  | "reviewed"
  | "needs_follow_up"
  | "misunderstanding_spotted"
  | "good_learning_moment"
  | "ai_answer_needs_review";

export type StudentFeedbackKind = "general" | "prompted" | "usage_request";

export type StudentFeedbackPromptReason =
  | "assistant_count"
  | "confusion_signal"
  | "low_confidence"
  | "source_heavy";

export type StudentFeedbackRating = "helpful" | "not_helpful" | "confusing" | "incorrect" | "other";

export type StudentFeedbackStatus = "new" | "reviewed" | "resolved";

export type StudentFeedback = {
  id: string;
  classId: string;
  conversationId: string;
  messageId?: string | null;
  studentId: string;
  studentEmail: string;
  studentName: string;
  kind: StudentFeedbackKind;
  promptReason?: StudentFeedbackPromptReason;
  rating?: StudentFeedbackRating;
  comment: string;
  status: StudentFeedbackStatus;
  studentVisibleResponse?: string;
  studentVisibleResponseSentAt?: unknown;
  teacherNote?: string;
  createdAt: unknown;
  updatedAt: unknown;
  reviewedAt?: unknown;
  resolvedAt?: unknown;
  reviewedBy?: string | null;
  usageAllowanceDayBucket?: string;
  usageAllowancePercent?: number;
};

export type StudentFeedbackSummary = {
  totalCount: number;
  openCount: number;
  latestCreatedAt: unknown;
  latestRating?: StudentFeedbackRating;
  latestStatus?: StudentFeedbackStatus;
};

export type TeacherConversationReview = {
  conversationId: string;
  classId: string;
  teacherId: string;
  status: ConversationReviewStatus;
  followUpDueAt?: unknown;
  privateNote: string;
  studentVisibleNote?: string;
  studentVisibleNoteSentAt?: unknown;
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
  answerSeekingReviewCount: number;
  assistantMessageCount: number;
  lowConfidenceMessageCount: number;
  noSourceAssistantMessageCount: number;
  safetyReviewCount: number;
  studentReplyAfterTeacherNote: boolean;
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
  feedback: StudentFeedback[];
  feedbackSummary: StudentFeedbackSummary;
  learningSignals: TeacherConversationLearningSignalSummary;
  sourceAudit: TeacherConversationSourceAuditSummary;
  latestRetrievalConfidence?: RetrievalConfidence;
  review: TeacherConversationReview;
  reviewStatus: ConversationReviewStatus;
};

export type TutorTrace = {
  activeProblemDecision?: {
    completedParts?: string[];
    confidence?: string;
    currentPart?: string;
    isActualProblem?: boolean;
    problemSource?: string;
    problemText?: string;
    reason?: string;
    relationToPreviousProblem?: string;
    visibleParts?: string[];
  };
  activeMaterialId?: string;
  activePage?: number;
  activeProblemNumbers?: string[];
  decisionSource?: string;
  failedSearchesSkipped?: string[];
  finishReason?: string;
  inputTokenBreakdown?: TutorInputTokenSection[];
  knowledgeItems?: KnowledgeItem[];
  memoryUsed?: boolean;
  modelCallUsage?: TutorModelCallUsage[];
  primaryStudentResponse?: string;
  contextGroundedResponse?: string;
  problemUnderstandingState?: TutorProblemUnderstandingState;
  responseMode?: string;
  retrievalDecision?: Record<string, unknown>;
  retrievalDiagnostics?: Array<Record<string, unknown>>;
  retrievalReason?: string;
  referenceExpansionDiagnostics?: Array<Record<string, unknown>>;
  answerSeekingAssessment?: Record<string, unknown>;
  supportIntents?: Array<Record<string, unknown>>;
  additionalSupportIntents?: Array<Record<string, unknown>>;
  readySupportBundle?: Record<string, unknown>;
  scheduledBackgroundJobs?: Array<Record<string, unknown>>;
  supportBundleAction?: Record<string, unknown>;
  searchLedger?: Array<Record<string, unknown>>;
  searchQueries: string[];
  selectedMetadataRecords?: Array<Record<string, unknown>>;
  selectedPages: Array<{
    citationLabel?: string;
    docId?: string;
    materialType?: string;
    pageEnd?: number;
    pageStart?: number;
    printedPageEnd?: number;
    printedPageStart?: number;
    problemNumbers?: string[];
    retrievalMode?: string;
    retrievalReason?: string;
    searchQuery?: string;
    title?: string;
  }>;
  stages: string[];
  toolCallCount: number;
  tutorPlan?: Record<string, unknown>;
};

export type UnderstandingLevel = 0 | 1 | 2 | 3 | 4;

export type UnderstandingState = {
  activeProblemId: string;
  level: UnderstandingLevel;
  reasons: string[];
  lastUpdatedAt: Date;
};

export type TutorProblemUnderstandingState = {
  activeProblemId?: string;
  understandingLevel?: number;
  level?: number;
  reasons?: string[];
  conceptsUnderstood?: string[];
  completedSteps?: string[];
  completedParts?: string[];
  currentPart?: string;
  currentStep?: string;
  currentStepStatus?: string;
  knownConfusions?: string[];
  lastHintSummary?: string;
  lastStudentAttemptSummary?: string;
  problemStatus?: string;
  updatedAt?: unknown;
  visibleParts?: string[];
};

export type TutorApiResponse = {
  aiUsageStatus?: StudentAiUsageStatus;
  assistantMessageId?: string;
  conversationId?: string;
  debugInfo?: TutorDebugInfo;
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

export type TutorDebugTokens = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type TutorModelCallUsage = {
  inputTokens: number;
  model: string;
  outputTokens: number;
  purpose: string;
  reasoningEffort?: string;
  reasoningTokens: number;
  stage: string;
  totalTokens: number;
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

export type TutorDebugInfo = {
  actualTokens: TutorDebugTokens;
  backendRequestCount: number;
  inputTokenBreakdown?: TutorInputTokenSection[];
  modelCallUsage?: TutorModelCallUsage[];
  durationMs: number;
  estimatedTokens: TutorDebugTokens;
  finishReason?: string;
  modelId: string;
  provider: string;
  providerRequestCount: number;
  requestId: string;
  searchQueryCount: number;
  selectedPageCount: number;
  stageCount: number;
  stages: string[];
  toolCallCount: number;
  totalRequestCount: number;
};

export type StudentAiUsageStatus = {
  blocked: boolean;
  dailyLimit?: number;
  dailyUsed?: number;
  nearLimit: boolean;
  resetHint: string;
  dailyResetAt?: string;
  todayPercentRemaining: number;
  weekPercentRemaining: number;
  weeklyResetAt?: string;
  weeklyLimit?: number;
  weeklyUsed?: number;
};

export type UsageSummary = {
  dailyUsed: number;
  dailyLimit: number;
  weeklyUsed: number;
  weeklyLimit: number;
  todayPercentLeft: number;
  weekPercentLeft: number;
};

export type ChatContextMemory = {
  activePdfId?: string;
  activePdfName?: string;
  activeProblemId?: string;
  activePageNumber?: number;
  currentProblem?: {
    label?: string;
    problemNumber?: string;
    title?: string;
    sourceName?: string;
    sourceType?: "class_material" | "pasted_problem" | "student_upload";
    pageNumber?: number;
    sectionTitle?: string;
    ocrConfidence?: number;
    problemText?: string;
  };
  savedProblems?: Array<{
    label?: string;
    problemNumber?: string;
    title?: string;
    sourceName?: string;
    sourceType?: "class_material" | "pasted_problem" | "student_upload";
    pageNumber?: number;
    sectionTitle?: string;
    ocrConfidence?: number;
    problemText?: string;
  }>;
  sourcesUsed?: Array<{
    id?: string;
    sourceName?: string;
    sourceType?: "class_material" | "pasted_problem" | "student_upload";
    fileType?: "image" | "pdf";
    pageNumber?: number;
    sourceItemLabel?: string;
    problemNumber?: string;
    label?: string;
    supportType?: string;
  }>;
  unconfirmedSources?: Array<{
    id?: string;
    sourceName?: string;
    sourceType?: "class_material" | "pasted_problem" | "student_upload";
    fileType?: "image" | "pdf";
    pageNumber?: number;
    sourceItemLabel?: string;
    problemNumber?: string;
    label?: string;
    supportType?: string;
  }>;
  failedSearches?: Array<{
    query: string;
    reason?: string;
    timestamp?: string;
  }>;
  searchResults?: Array<{
    query: string;
    retrievalReason?: string;
    resultCount?: number;
    pages: Array<{
      citationLabel?: string;
      materialType?: string;
      pageEnd?: number;
      pageNumber?: number;
      problemNumbers?: string[];
      sourceName?: string;
    }>;
  }>;
  retrievalReason?: string;
  rawSourceIds?: string[];
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

export type TeacherProblemLevelDistribution = {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
};

export type TeacherProblemStudentRow = {
  conversationCount: number;
  conversationIds: string[];
  latestUnderstandingLevel: UnderstandingLevel;
  lastActive: unknown;
  lastActiveLabel?: string;
  openConversationId?: string;
  studentEmail: string;
  studentId: string;
  studentName: string;
  studentMessageCount: number;
};

export type TeacherProblemSummaryRow = {
  averageConversationsPerStudent: number;
  averageUnderstandingLevel: number;
  commonConfusions: string[];
  conversationCount: number;
  conversationIds: string[];
  id: string;
  label: string;
  lastActive: unknown;
  levelDistribution: TeacherProblemLevelDistribution;
  openConversationId?: string;
  studentCount: number;
  students: TeacherProblemStudentRow[];
  totalStudentMessages: number;
};
