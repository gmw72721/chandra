import { z } from "zod";
import type { ClassAccessPermission } from "../class-settings.ts";
import type { MaterialRecord } from "../data/materials.ts";
import type { TeacherConversationReviewSummary } from "../types.ts";
import {
  assertPendingTeacherAssistantActionMatches,
  consumePendingTeacherAssistantAction,
  createPendingTeacherAssistantAction,
  readPendingTeacherAssistantAction
} from "./confirmations.ts";
import {
  buildTeacherAssistantTabHref,
  normalizeEmail,
  normalizeRouteToken,
  normalizeTeacherAssistantAiTutorSection,
  normalizeTeacherAssistantSettingsPane,
  normalizeTeacherAssistantSourceSection,
  normalizeTeacherAssistantTab,
  resolveTeacherAssistantNavigation
} from "./routes.ts";
import type {
  TeacherAssistantConfirmationRequest,
  TeacherAssistantToolResult
} from "./types.ts";

type AuthorizedAssistantActor = {
  classData: Record<string, unknown>;
  email?: string;
  uid: string;
};

type NotificationUpdateResult = {
  after: Record<string, boolean>;
  before: Record<string, boolean>;
  changed: boolean;
  summary?: string;
};

type AssistantToolDependencies = {
  applyNotificationSettingsUpdate?: (input: {
    actorEmail?: string;
    actorUid: string;
    classData: Record<string, unknown>;
    classId: string;
    confirmationId: string;
    patch: Record<string, boolean>;
  }) => Promise<NotificationUpdateResult>;
  getClassConversations?: (classId: string) => Promise<TeacherConversationReviewSummary[]>;
  listClassMaterials?: (classId: string) => Promise<MaterialRecord[]>;
  listStudents?: (
    classId: string
  ) => Promise<Array<{ displayName?: string; email?: string; id?: string; name?: string; studentEmail?: string }>>;
};

const classIdSchema = z.object({ classId: z.string().min(1).max(200).optional() }).passthrough();
const tabSchema = classIdSchema.extend({ tab: z.string().min(1) });
const settingsPaneSchema = classIdSchema.extend({ pane: z.string().min(1) });
const sourceSectionSchema = classIdSchema.extend({ section: z.string().min(1) });
const aiTutorSectionSchema = classIdSchema.extend({ section: z.string().min(1) });
const studentNavigationSchema = classIdSchema.extend({
  newTab: z.boolean().optional(),
  studentEmail: z.string().email()
});
const studentQueryNavigationSchema = classIdSchema.extend({
  newTab: z.boolean().optional(),
  query: z.string().min(1).max(200)
});
const searchStudentsSchema = classIdSchema.extend({
  query: z.string().max(200).optional()
});
const conversationNavigationSchema = classIdSchema.extend({
  conversationId: z.string().min(1).max(200),
  newTab: z.boolean().optional()
});
const conversationQueryNavigationSchema = classIdSchema.extend({
  newTab: z.boolean().optional(),
  query: z.string().min(1).max(200)
});
const searchConversationsSchema = classIdSchema.extend({
  query: z.string().max(200).optional(),
  retrievalConfidence: z.string().max(40).optional(),
  status: z.string().max(80).optional(),
  studentEmail: z.string().email().optional()
});
const studentContextSchema = classIdSchema.extend({
  studentEmail: z.string().email()
});
const searchMaterialsSchema = classIdSchema.extend({
  query: z.string().max(200).optional()
});
const studentViewSchema = classIdSchema.extend({
  newTab: z.boolean().optional()
});
const updateNotificationSettingsSchema = classIdSchema.extend({
  patch: z.unknown()
});
const updatePatchSchema = classIdSchema.extend({
  patch: z.unknown()
});
const updateInstructionsSchema = classIdSchema.extend({
  instructions: z.string().max(4000)
});
const notificationPatchSchema = z
  .object({
    followUpReminders: z.boolean().optional(),
    newStudentJoinedClass: z.boolean().optional(),
    weeklyDigest: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one notification setting to update.");

const toolPermissions: Record<string, ClassAccessPermission> = {
  get_review_queue: "viewConversations",
  get_class_materials: "viewMaterials",
  get_class_settings: "manageClassSettings",
  get_student_context: "viewRoster",
  get_teacher_dashboard_summary: "viewOverview",
  get_tutor_settings: "manageClassSettings",
  navigate_ai_tutor_section: "manageClassSettings",
  navigate_settings_pane: "manageClassSettings",
  navigate_sources_section: "viewMaterials",
  navigate_teacher_tab: "viewOverview",
  open_conversation_review: "viewConversations",
  open_conversation_review_by_query: "viewConversations",
  open_student_conversations: "viewConversations",
  open_student_conversations_by_query: "viewConversations",
  open_student_profile: "viewRoster",
  open_student_profile_by_query: "viewRoster",
  open_student_view: "teacherPreviewChat",
  search_conversations: "viewConversations",
  search_materials: "viewMaterials",
  search_students: "viewRoster",
  update_appearance_settings: "manageClassSettings",
  update_class_general_settings: "manageClassSettings",
  update_class_instructions: "manageClassSettings",
  update_notification_settings: "manageClassSettings",
  update_source_defaults: "manageClassSettings",
  update_tutor_access_settings: "manageClassSettings",
  update_tutor_behavior_settings: "manageClassSettings"
};

export function getTeacherAssistantAllowedToolNames(
  permissions: Partial<Record<ClassAccessPermission, boolean>>
) {
  return Object.entries(toolPermissions)
    .filter(([, permission]) => permissions[permission])
    .map(([toolName]) => toolName)
    .sort();
}

export async function executeTeacherAssistantTool(input: {
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
  request: Request;
  toolName: string;
}) {
  const permission = permissionForTool(input.toolName);
  const { authorizeClassAccess } = await import("../tutor-knowledge-server.ts");
  const authorization = await authorizeClassAccess(input.request, input.classId, permission);

  return executeTeacherAssistantToolWithActor({
    actor: {
      classData: authorization.classSnapshot.data(),
      email: authorization.email,
      uid: authorization.uid
    },
    args: input.args,
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: input.toolName
  });
}

export async function executeTeacherAssistantToolWithActor(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
  dependencies?: AssistantToolDependencies;
  toolName: string;
}): Promise<TeacherAssistantToolResult> {
  assertClassIdIsCurrent(input.classId, input.args);

  switch (input.toolName) {
    case "navigate_teacher_tab":
      return navigateTeacherTab(input.args, input.classId);
    case "navigate_settings_pane":
      return navigateSettingsPane(input.args, input.classId);
    case "navigate_sources_section":
      return navigateSourcesSection(input.args, input.classId);
    case "navigate_ai_tutor_section":
      return navigateAiTutorSection(input.args, input.classId);
    case "open_student_profile":
      return openStudentProfile(input.args, input.classId, input.dependencies);
    case "open_student_profile_by_query":
      return openStudentProfileByQuery(input.args, input.classId, input.dependencies);
    case "open_student_conversations":
      return openStudentConversations(input.args, input.classId, input.dependencies);
    case "open_student_conversations_by_query":
      return openStudentConversationsByQuery(input.args, input.classId, input.dependencies);
    case "open_conversation_review":
      return openConversationReview(input.args, input.classId, input.dependencies);
    case "open_conversation_review_by_query":
      return openConversationReviewByQuery(input.args, input.classId, input.dependencies);
    case "open_student_view":
      return openStudentView(input.args, input.classId);
    case "get_teacher_dashboard_summary":
      return getTeacherDashboardSummary(input.classId);
    case "get_review_queue":
      return getReviewQueue(input.classId);
    case "search_students":
      return searchStudents(input.args, input.classId, input.dependencies);
    case "get_student_context":
      return getStudentContext(input.args, input.classId, input.dependencies);
    case "search_conversations":
      return searchConversations(input.args, input.classId, input.dependencies);
    case "get_class_materials":
      return getClassMaterials(input.classId, input.dependencies);
    case "search_materials":
      return searchMaterials(input.args, input.classId, input.dependencies);
    case "get_class_settings":
      return getClassSettings(input.classId, input.actor.classData);
    case "get_tutor_settings":
      return getTutorSettings(input.classId, input.actor.classData);
    case "update_notification_settings":
      return updateNotificationSettings(input);
    case "update_class_general_settings":
      return updateClassGeneralSettings(input);
    case "update_tutor_access_settings":
      return updateTutorAccessSettings(input);
    case "update_tutor_behavior_settings":
      return updateTutorBehaviorSettings(input);
    case "update_class_instructions":
      return updateClassInstructions(input);
    case "update_source_defaults":
      return updateSourceDefaults(input);
    case "update_appearance_settings":
      return updateAppearanceSettings(input);
    default:
      throw new Error(`Unsupported teacher assistant tool: ${input.toolName}`);
  }
}

export async function resolveTeacherAssistantConfirmation(input: {
  confirmation: TeacherAssistantConfirmationRequest;
  request: Request;
}) {
  const pendingAction = await readPendingTeacherAssistantAction(input.confirmation.pendingActionId);

  if (!pendingAction) {
    throw new Error("This assistant confirmation was not found. Ask Chandra to prepare the change again.");
  }

  const permission = permissionForTool(pendingAction.toolName);
  const { authorizeClassAccess } = await import("../tutor-knowledge-server.ts");
  const authorization = await authorizeClassAccess(input.request, pendingAction.classId, permission);

  if (input.confirmation.decision === "rejected") {
    await consumePendingTeacherAssistantAction(pendingAction.id);
    return {
      status: "rejected",
      summary: "Assistant change canceled.",
      toolName: pendingAction.toolName
    } satisfies TeacherAssistantToolResult;
  }

  return executeTeacherAssistantToolWithActor({
    actor: {
      classData: authorization.classSnapshot.data(),
      email: authorization.email,
      uid: authorization.uid
    },
    args: pendingAction.args,
    classId: pendingAction.classId,
    confirmation: input.confirmation,
    toolName: pendingAction.toolName
  });
}

export function permissionForTool(toolName: string): ClassAccessPermission {
  const permission = toolPermissions[toolName];

  if (!permission) {
    throw new Error(`Unsupported teacher assistant tool: ${toolName}`);
  }

  return permission;
}

function navigateTeacherTab(args: Record<string, unknown>, classId: string): TeacherAssistantToolResult {
  const parsed = tabSchema.parse(args);
  const tab = normalizeTeacherAssistantTab(parsed.tab);
  const navigation = resolveTeacherAssistantNavigation({ classId, tab });

  return navigationResult("navigate_teacher_tab", `Open ${tab}.`, navigation.href);
}

function navigateSettingsPane(args: Record<string, unknown>, classId: string): TeacherAssistantToolResult {
  const parsed = settingsPaneSchema.parse(args);
  const pane = normalizeTeacherAssistantSettingsPane(parsed.pane);
  const href = buildTeacherAssistantTabHref("settings", { classId, settingsPane: pane });

  return navigationResult("navigate_settings_pane", `Open settings: ${pane}.`, href);
}

function navigateSourcesSection(args: Record<string, unknown>, classId: string): TeacherAssistantToolResult {
  const parsed = sourceSectionSchema.parse(args);
  const section = normalizeTeacherAssistantSourceSection(parsed.section);
  const href = buildTeacherAssistantTabHref("sources", { classId, sourceSection: section });

  return navigationResult("navigate_sources_section", `Open sources: ${section}.`, href);
}

function navigateAiTutorSection(args: Record<string, unknown>, classId: string): TeacherAssistantToolResult {
  const parsed = aiTutorSectionSchema.parse(args);
  const section = normalizeTeacherAssistantAiTutorSection(parsed.section);
  const href = buildTeacherAssistantTabHref("knowledge", { aiTutorSection: section, classId });

  return navigationResult("navigate_ai_tutor_section", `Open AI tutor: ${section}.`, href);
}

async function openStudentProfile(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = studentNavigationSchema.parse(args);
  const studentEmail = await validateRosterStudent(classId, parsed.studentEmail, dependencies);
  const href = `/teacher/classes/${encodeURIComponent(classId)}/students/${encodeURIComponent(studentEmail)}`;

  return navigationResult("open_student_profile", `Open ${studentEmail}'s profile.`, href, parsed.newTab);
}

async function openStudentProfileByQuery(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = studentQueryNavigationSchema.parse(args);
  const student = await resolveSingleStudentByQuery(classId, parsed.query, dependencies);

  if (!student) {
    return {
      content: "I could not find exactly one matching student. Try a more specific name or email.",
      status: "success",
      summary: "Student profile was not opened because the roster match was empty or ambiguous.",
      toolName: "open_student_profile_by_query"
    };
  }

  const href = `/teacher/classes/${encodeURIComponent(classId)}/students/${encodeURIComponent(student.email)}`;
  return navigationResult(
    "open_student_profile_by_query",
    `Open ${student.displayName || student.email}'s profile.`,
    href,
    parsed.newTab
  );
}

async function openStudentConversations(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = studentNavigationSchema.parse(args);
  const studentEmail = await validateRosterStudent(classId, parsed.studentEmail, dependencies);
  const href = buildTeacherAssistantTabHref("conversations", { classId, student: studentEmail });

  return navigationResult("open_student_conversations", `Open ${studentEmail}'s conversations.`, href, parsed.newTab);
}

async function openStudentConversationsByQuery(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = studentQueryNavigationSchema.parse(args);
  const { searchConversationsTool } = await import("./read-tools.ts");
  const data = await searchConversationsTool(
    {
      classId,
      query: parsed.query
    },
    { listTeacherClassConversations: dependencies?.getClassConversations }
  );
  const matchingStudents = new Map(
    data.results
      .filter((conversation) => conversation.studentEmail)
      .map((conversation) => [
        conversation.studentEmail.trim().toLowerCase(),
        conversation.studentName || conversation.studentEmail
      ])
  );

  if (matchingStudents.size !== 1) {
    return {
      content:
        matchingStudents.size > 1
          ? "I found multiple matching students with conversations. Try a more specific name or email."
          : "I could not find matching saved conversations for that student.",
      status: "success",
      summary: "Student conversations were not opened because the conversation match was empty or ambiguous.",
      toolName: "open_student_conversations_by_query"
    };
  }

  const [[studentEmail, studentName]] = [...matchingStudents.entries()];
  const href = buildTeacherAssistantTabHref("conversations", { classId, student: studentEmail });
  return navigationResult(
    "open_student_conversations_by_query",
    `Open ${studentName}'s conversations.`,
    href,
    parsed.newTab
  );
}

async function openConversationReview(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = conversationNavigationSchema.parse(args);
  const conversationId = normalizeRouteToken(parsed.conversationId);
  const conversations = dependencies?.getClassConversations
    ? await dependencies.getClassConversations(classId)
    : await (async () => {
        const { listTeacherClassConversations } = await import("../student-conversations-server.ts");
        return listTeacherClassConversations({ classId });
      })();
  const conversation = conversations.find((row) => row.id === conversationId);

  if (!conversation) {
    throw new Error("Conversation was not found in this class.");
  }

  const href = buildTeacherAssistantTabHref("conversations", { classId, conversationId });
  return navigationResult("open_conversation_review", `Open conversation "${conversation.title}".`, href, parsed.newTab);
}

async function openConversationReviewByQuery(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = conversationQueryNavigationSchema.parse(args);
  const { searchConversationsTool } = await import("./read-tools.ts");
  const data = await searchConversationsTool(
    {
      classId,
      query: parsed.query
    },
    { listTeacherClassConversations: dependencies?.getClassConversations }
  );

  if (data.results.length !== 1) {
    return {
      content:
        data.results.length > 1
          ? "I found multiple matching conversations. Try a more specific student, topic, or problem."
          : "I could not find a matching conversation in this class.",
      status: "success",
      summary: "Conversation review was not opened because the match was empty or ambiguous.",
      toolName: "open_conversation_review_by_query"
    };
  }

  const conversation = data.results[0];
  const href = buildTeacherAssistantTabHref("conversations", { classId, conversationId: conversation.conversationId });
  return navigationResult(
    "open_conversation_review_by_query",
    `Open conversation "${conversation.title}".`,
    href,
    parsed.newTab
  );
}

function openStudentView(args: Record<string, unknown>, classId: string): TeacherAssistantToolResult {
  const parsed = studentViewSchema.parse(args);
  const href = `/teacher/student-view?classId=${encodeURIComponent(classId)}`;

  return navigationResult("open_student_view", "Open student view.", href, parsed.newTab);
}

async function getTeacherDashboardSummary(classId: string): Promise<TeacherAssistantToolResult> {
  const { getTeacherDashboardSummaryTool } = await import("./read-tools.ts");
  const data = await getTeacherDashboardSummaryTool({ classId });

  return {
    content: `Dashboard summary: ${data.summary.title} ${data.summary.body}`,
    data: data as Record<string, unknown>,
    status: "success",
    summary: data.summary.body,
    toolName: "get_teacher_dashboard_summary"
  };
}

async function resolveSingleStudentByQuery(
  classId: string,
  query: string,
  dependencies?: AssistantToolDependencies
) {
  const { searchStudentsForAssistantWithDependencies } = await import("./read-tools.ts");
  const students = await searchStudentsForAssistantWithDependencies(
    { classId, query },
    {
      listRosterActivity: dependencies?.listStudents
        ? async () => (await dependencies.listStudents?.(classId) ?? []).map((student) => ({
            chatBlocked: false,
            conversationCount: 0,
            displayName: student.displayName ?? student.name ?? student.email ?? student.studentEmail ?? student.id ?? "Student",
            lastActiveAt: "",
            lastChatTopic: "",
            questionsPerDay: 0,
            questionsToday: 0,
            recentConversations: [],
            status: "no_activity" as const,
            studentEmail: student.email ?? student.studentEmail ?? "",
            studentId: student.id ?? student.email ?? student.studentEmail ?? "",
            teacherNotes: "",
            totalQuestions: 0
          }))
        : undefined
    }
  );

  if (students.length !== 1) {
    return null;
  }

  return students[0];
}

async function getReviewQueue(classId: string): Promise<TeacherAssistantToolResult> {
  const { getReviewQueueTool } = await import("./read-tools.ts");
  const data = await getReviewQueueTool({ classId });

  return {
    content: data.count
      ? `${data.count} conversations need review.`
      : "No conversations currently need review.",
    data,
    status: "success",
    summary: data.count ? `${data.count} conversations need review.` : "No conversations currently need review.",
    toolName: "get_review_queue"
  };
}

async function searchStudents(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = searchStudentsSchema.parse(args);
  const { searchStudentsForAssistantWithDependencies } = await import("./read-tools.ts");
  const data = await searchStudentsForAssistantWithDependencies(
    { classId, query: parsed.query ?? "" },
    {
      listRosterActivity: dependencies?.listStudents
        ? async () => (await dependencies.listStudents?.(classId) ?? []).map((student) => ({
            chatBlocked: false,
            conversationCount: 0,
            displayName: student.displayName ?? student.name ?? student.email ?? student.studentEmail ?? student.id ?? "Student",
            lastActiveAt: "",
            lastChatTopic: "",
            questionsPerDay: 0,
            questionsToday: 0,
            recentConversations: [],
            status: "no_activity" as const,
            studentEmail: student.email ?? student.studentEmail ?? "",
            studentId: student.id ?? student.email ?? student.studentEmail ?? "",
            teacherNotes: "",
            totalQuestions: 0
          }))
        : undefined
    }
  );

  return {
    content: data.length ? `Found ${data.length} matching students.` : "No matching students found.",
    data: { classId, students: data },
    status: "success",
    summary: data.length ? `Found ${data.length} matching students.` : "No matching students found.",
    toolName: "search_students"
  };
}

async function getStudentContext(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = studentContextSchema.parse(args);
  const { getStudentContextTool } = await import("./read-tools.ts");
  const data = await getStudentContextTool(
    { classId, studentEmail: parsed.studentEmail },
    { listTeacherClassConversations: dependencies?.getClassConversations }
  );

  return {
    content: `${data.summary.title}: ${data.summary.body}`,
    data: data as Record<string, unknown>,
    status: "success",
    summary: data.summary.body,
    toolName: "get_student_context"
  };
}

async function searchConversations(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = searchConversationsSchema.parse(args);
  const { searchConversationsTool } = await import("./read-tools.ts");
  const data = await searchConversationsTool(
    {
      classId,
      query: parsed.query,
      retrievalConfidence: parsed.retrievalConfidence,
      status: parsed.status,
      studentEmail: parsed.studentEmail
    },
    { listTeacherClassConversations: dependencies?.getClassConversations }
  );

  return {
    content: data.count ? `Found ${data.count} matching conversations.` : "No matching conversations found.",
    data,
    status: "success",
    summary: data.count ? `Found ${data.count} matching conversations.` : "No matching conversations found.",
    toolName: "search_conversations"
  };
}

async function getClassMaterials(
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const { getClassMaterialsTool } = await import("./read-tools.ts");
  const data = await getClassMaterialsTool({ classId }, dependencies);

  return {
    content: data.count ? `${data.count} class materials are available.` : "No class materials found.",
    data,
    status: "success",
    summary: data.count ? `${data.count} class materials are available.` : "No class materials found.",
    toolName: "get_class_materials"
  };
}

async function searchMaterials(
  args: Record<string, unknown>,
  classId: string,
  dependencies?: AssistantToolDependencies
): Promise<TeacherAssistantToolResult> {
  const parsed = searchMaterialsSchema.parse(args);
  const { searchMaterialsTool } = await import("./read-tools.ts");
  const data = await searchMaterialsTool({ classId, query: parsed.query ?? "" }, dependencies);

  return {
    content: data.count ? `Found ${data.count} matching materials.` : "No matching materials found.",
    data,
    status: "success",
    summary: data.count ? `Found ${data.count} matching materials.` : "No matching materials found.",
    toolName: "search_materials"
  };
}

async function getClassSettings(
  classId: string,
  classData: Record<string, unknown>
): Promise<TeacherAssistantToolResult> {
  const { getClassSettingsSummaryTool } = await import("./read-tools.ts");
  const data = getClassSettingsSummaryTool({ classData, classId });

  return {
    content: `Class settings for ${data.name}.`,
    data,
    status: "success",
    summary: `Class settings for ${data.name}.`,
    toolName: "get_class_settings"
  };
}

async function getTutorSettings(
  classId: string,
  classData: Record<string, unknown>
): Promise<TeacherAssistantToolResult> {
  const { getTutorSettingsSummaryTool } = await import("./read-tools.ts");
  const data = getTutorSettingsSummaryTool({ classData, classId });

  return {
    content: "Tutor settings loaded.",
    data,
    status: "success",
    summary: "Tutor settings loaded.",
    toolName: "get_tutor_settings"
  };
}

async function updateNotificationSettings(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
  dependencies?: AssistantToolDependencies;
  toolName: string;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updateNotificationSettingsSchema.parse(input.args);
  const patch = notificationPatchSchema.parse(parsed.patch);
  const normalizedArgs = {
    classId: input.classId,
    patch
  };
  const change = buildNotificationSettingsChangeForConfirmation({
    currentSettings: input.actor.classData.notificationSettings,
    patch
  });

  if (!input.confirmation) {
    const pendingAction = await createPendingTeacherAssistantAction({
      actorEmail: input.actor.email,
      actorUid: input.actor.uid,
      args: normalizedArgs,
      classId: input.classId,
      summary: change.summary,
      toolName: "update_notification_settings"
    });

    return {
      action: {
        kind: "confirmation",
        pendingActionId: pendingAction.id,
        summary: change.summary,
        toolName: "update_notification_settings"
      },
      status: "confirmation_required",
      summary: change.summary,
      toolName: "update_notification_settings"
    };
  }

  const pendingAction = await readPendingTeacherAssistantAction(input.confirmation.pendingActionId);
  if (!pendingAction) {
    throw new Error("This assistant confirmation was not found. Ask Chandra to prepare the change again.");
  }

  assertPendingTeacherAssistantActionMatches({
    actorUid: input.actor.uid,
    args: normalizedArgs,
    classId: input.classId,
    pendingAction,
    toolName: "update_notification_settings"
  });

  const applyUpdate =
    input.dependencies?.applyNotificationSettingsUpdate ??
    (await import("./write-tools.ts")).applyNotificationSettingsUpdate;
  const result = await applyUpdate({
    actorEmail: input.actor.email,
    actorUid: input.actor.uid,
    classData: input.actor.classData,
    classId: input.classId,
    confirmationId: input.confirmation.pendingActionId,
    patch
  });

  await consumePendingTeacherAssistantAction(input.confirmation.pendingActionId);

  return {
    data: {
      after: result.after,
      before: result.before,
      changed: result.changed
    },
    status: "success",
    summary: result.changed ? "Notification settings updated." : "Notification settings were already unchanged.",
    toolName: "update_notification_settings"
  };
}

async function updateClassGeneralSettings(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updatePatchSchema.parse(input.args);
  const { buildClassGeneralSettingsChange, applyClassGeneralSettingsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applyClassGeneralSettingsUpdate,
    args: { classId: input.classId, patch: buildClassGeneralSettingsChange({ classData: input.actor.classData, patch: parsed.patch }).patch },
    actor: input.actor,
    buildChange: () => buildClassGeneralSettingsChange({ classData: input.actor.classData, patch: parsed.patch }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_class_general_settings"
  });
}

async function updateTutorAccessSettings(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updatePatchSchema.parse(input.args);
  const { buildTutorAccessSettingsChange, applyTutorAccessSettingsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applyTutorAccessSettingsUpdate,
    args: { classId: input.classId, patch: buildTutorAccessSettingsChange({ classData: input.actor.classData, patch: parsed.patch }).patch },
    actor: input.actor,
    buildChange: () => buildTutorAccessSettingsChange({ classData: input.actor.classData, patch: parsed.patch }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_tutor_access_settings"
  });
}

async function updateTutorBehaviorSettings(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updatePatchSchema.parse(input.args);
  const { buildTutorBehaviorSettingsChange, applyTutorBehaviorSettingsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applyTutorBehaviorSettingsUpdate,
    args: { classId: input.classId, patch: buildTutorBehaviorSettingsChange({ classData: input.actor.classData, patch: parsed.patch }).patch },
    actor: input.actor,
    buildChange: () => buildTutorBehaviorSettingsChange({ classData: input.actor.classData, patch: parsed.patch }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_tutor_behavior_settings"
  });
}

async function updateClassInstructions(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updateInstructionsSchema.parse(input.args);
  const { buildClassInstructionsChange, applyClassInstructionsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applyClassInstructionsUpdate,
    args: {
      classId: input.classId,
      instructions: buildClassInstructionsChange({ classData: input.actor.classData, instructions: parsed.instructions }).instructions
    },
    actor: input.actor,
    buildChange: () => buildClassInstructionsChange({ classData: input.actor.classData, instructions: parsed.instructions }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_class_instructions"
  });
}

async function updateSourceDefaults(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updatePatchSchema.parse(input.args);
  const { buildSourceDefaultsChange, applySourceDefaultsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applySourceDefaultsUpdate,
    args: { classId: input.classId, patch: buildSourceDefaultsChange({ classData: input.actor.classData, patch: parsed.patch }).patch },
    actor: input.actor,
    buildChange: () => buildSourceDefaultsChange({ classData: input.actor.classData, patch: parsed.patch }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_source_defaults"
  });
}

async function updateAppearanceSettings(input: {
  actor: AuthorizedAssistantActor;
  args: Record<string, unknown>;
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
}): Promise<TeacherAssistantToolResult> {
  const parsed = updatePatchSchema.parse(input.args);
  const { buildAppearanceSettingsChange, applyAppearanceSettingsUpdate } = await import("./write-tools.ts");
  return confirmOrApplySettingsUpdate({
    applyUpdate: applyAppearanceSettingsUpdate,
    args: { classId: input.classId, patch: buildAppearanceSettingsChange({ classData: input.actor.classData, patch: parsed.patch }).patch },
    actor: input.actor,
    buildChange: () => buildAppearanceSettingsChange({ classData: input.actor.classData, patch: parsed.patch }),
    classId: input.classId,
    confirmation: input.confirmation,
    toolName: "update_appearance_settings"
  });
}

async function confirmOrApplySettingsUpdate(input: {
  actor: AuthorizedAssistantActor;
  applyUpdate: (input: {
    actorEmail?: string;
    actorUid: string;
    classData: Record<string, unknown>;
    classId: string;
    confirmationId: string;
    patch?: unknown;
    instructions?: string;
  }) => Promise<{ after: unknown; before: unknown; changed: boolean }>;
  args: Record<string, unknown>;
  buildChange: () => { after: unknown; before: unknown; summary: string };
  classId: string;
  confirmation?: TeacherAssistantConfirmationRequest;
  toolName: string;
}): Promise<TeacherAssistantToolResult> {
  const change = input.buildChange();

  if (!input.confirmation) {
    const pendingAction = await createPendingTeacherAssistantAction({
      actorEmail: input.actor.email,
      actorUid: input.actor.uid,
      args: input.args,
      classId: input.classId,
      summary: change.summary,
      toolName: input.toolName
    });

    return {
      action: {
        kind: "confirmation",
        pendingActionId: pendingAction.id,
        summary: change.summary,
        toolName: input.toolName
      },
      status: "confirmation_required",
      summary: change.summary,
      toolName: input.toolName
    };
  }

  const pendingAction = await readPendingTeacherAssistantAction(input.confirmation.pendingActionId);
  if (!pendingAction) {
    throw new Error("This assistant confirmation was not found. Ask Chandra to prepare the change again.");
  }

  assertPendingTeacherAssistantActionMatches({
    actorUid: input.actor.uid,
    args: input.args,
    classId: input.classId,
    pendingAction,
    toolName: input.toolName
  });

  const result = await input.applyUpdate({
    actorEmail: input.actor.email,
    actorUid: input.actor.uid,
    classData: input.actor.classData,
    classId: input.classId,
    confirmationId: input.confirmation.pendingActionId,
    instructions: typeof input.args.instructions === "string" ? input.args.instructions : undefined,
    patch: input.args.patch
  });

  await consumePendingTeacherAssistantAction(input.confirmation.pendingActionId);

  return {
    data: {
      after: result.after,
      before: result.before,
      changed: result.changed
    },
    status: "success",
    summary: result.changed ? "Settings updated." : "Settings were already unchanged.",
    toolName: input.toolName
  };
}

function navigationResult(toolName: string, summary: string, href: string, newTab = false): TeacherAssistantToolResult {
  return {
    action: {
      href,
      kind: "navigate",
      label: summary.replace(/\.$/, ""),
      newTab
    },
    status: "success",
    summary,
    toolName
  };
}

async function validateRosterStudent(
  classId: string,
  studentEmail: string,
  dependencies?: AssistantToolDependencies
) {
  const email = normalizeEmail(studentEmail);
  const students = (dependencies?.listStudents
    ? await dependencies.listStudents(classId)
    : await (async () => {
        const { listClassEnrollmentsPostgresFirst } = await import("../data/server.ts");
        return listClassEnrollmentsPostgresFirst(classId);
      })()) as Array<Record<string, unknown>>;
  const match = students.find((student) => normalizeEmail(student.email ?? student.studentEmail) === email);

  if (!match) {
    throw new Error("Student was not found in this class roster.");
  }

  return email;
}

function assertClassIdIsCurrent(currentClassId: string, args: Record<string, unknown>) {
  const requestedClassId = normalizeRouteToken(args.classId);

  if (requestedClassId && requestedClassId !== currentClassId) {
    throw new Error("Assistant tool classId must match the currently authorized class.");
  }
}

function buildNotificationSettingsChangeForConfirmation(input: {
  currentSettings: unknown;
  patch: Record<string, boolean>;
}) {
  const before = normalizeNotificationSettingsForConfirmation(input.currentSettings);
  const after = normalizeNotificationSettingsForConfirmation({
    ...before,
    ...input.patch
  });

  return {
    after,
    before,
    patch: input.patch,
    summary: summarizeNotificationSettingsChangeForConfirmation(before, after)
  };
}

function normalizeNotificationSettingsForConfirmation(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  return {
    followUpReminders: source.followUpReminders !== false,
    newStudentJoinedClass: source.newStudentJoinedClass !== false,
    weeklyDigest: source.weeklyDigest !== false
  };
}

function summarizeNotificationSettingsChangeForConfirmation(
  before: ReturnType<typeof normalizeNotificationSettingsForConfirmation>,
  after: ReturnType<typeof normalizeNotificationSettingsForConfirmation>
) {
  const labels: Record<keyof typeof before, string> = {
    followUpReminders: "follow-up reminders",
    newStudentJoinedClass: "new student notifications",
    weeklyDigest: "weekly digest"
  };
  const changes = (Object.keys(labels) as Array<keyof typeof before>)
    .filter((key) => before[key] !== after[key])
    .map((key) => `${labels[key]} ${after[key] ? "on" : "off"}`);

  return changes.length ? `Update notification settings: ${changes.join(", ")}.` : "Notification settings are already unchanged.";
}
