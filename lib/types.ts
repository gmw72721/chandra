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
  sources?: TutorSource[];
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

export type TutorSource = {
  title: string;
  materialType: string;
  citationsRequired?: boolean;
  pageNumber?: number;
  problemNumber?: string;
};

export type TutorTrace = {
  finishReason?: string;
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

export type TutorApiResponse = {
  assistantMessageId?: string;
  conversationId?: string;
  message: string;
  content: string;
  langGraphTrace?: TutorTrace;
  sources: TutorSource[];
  retrievalConfidence: RetrievalConfidence;
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
