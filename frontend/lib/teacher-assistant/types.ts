export type TeacherAssistantRole = "assistant";

export type TeacherAssistantMessage = {
  content: string;
  role: TeacherAssistantRole;
};

export type TeacherAssistantAction =
  | {
      href: string;
      kind: "navigate";
      label: string;
      newTab?: boolean;
    }
  | {
      kind: "confirmation";
      pendingActionId: string;
      summary: string;
      toolName: string;
    }
  | {
      kind: "toolResult";
      summary: string;
      toolName: string;
    };

export type TeacherAssistantResponse = {
  actions: TeacherAssistantAction[];
  messages: TeacherAssistantMessage[];
  sessionId: string;
};

export type AssistantTurnInput = {
  assistantContextId?: string;
  actorEmail?: string;
  actorUid: string;
  classId: string;
  message: string;
  runTool?: (toolName: string, args: Record<string, unknown>) => Promise<TeacherAssistantToolResult>;
  sanitizedContext?: {
    allowedToolNames: string[];
    classId: string;
    expiresAt: number;
    toolPolicy?: {
      maxToolCalls: number;
      reason: string;
    };
    sessionId: string;
  };
  sessionId: string;
};

export type AssistantEvent =
  | {
      content: string;
      type: "message";
    }
  | {
      action: TeacherAssistantAction;
      type: "action";
    };

export type TeacherAssistantProvider = {
  send(input: AssistantTurnInput): AsyncIterable<AssistantEvent>;
};

export type TeacherAssistantToolResult = {
  action?: TeacherAssistantAction;
  content?: string;
  data?: Record<string, unknown>;
  status: "success" | "confirmation_required" | "rejected" | "unavailable" | "error";
  summary: string;
  toolName: string;
};

export type TeacherAssistantConfirmationRequest = {
  decision: "approved" | "rejected";
  pendingActionId: string;
};
