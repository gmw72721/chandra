import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import {
  normalizeAnswerPolicySettings,
  normalizeNotificationSettings,
  normalizeResponseFormatSettings,
  normalizeSourceDefaultsSettings,
  normalizeTutorAccessSettings
} from "../class-settings.ts";
import {
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  normalizeTeacherClassThemeMood
} from "../class-theme.ts";

const notificationPatchSchema = z
  .object({
    followUpReminders: z.boolean().optional(),
    newStudentJoinedClass: z.boolean().optional(),
    weeklyDigest: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one notification setting to update.");

export type NotificationSettingsPatch = z.infer<typeof notificationPatchSchema>;

const classGeneralPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    section: z.string().max(120).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one class setting to update.");

const tutorAccessPatchSchema = z
  .object({
    enabled: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one tutor access setting to update.");

const tutorBehaviorPatchSchema = z
  .object({
    answerPolicy: z
      .object({
        allowWorkedExamples: z.boolean().optional(),
        askGuidingQuestionBeforeExplaining: z.boolean().optional(),
        doNotGiveFinalAnswers: z.boolean().optional(),
        refuseAnswerOnlyRequests: z.boolean().optional(),
        requireStudentAttemptFirst: z.boolean().optional()
      })
      .strict()
      .optional(),
    behaviorInstructions: z.string().max(4000).optional(),
    responseFormat: z
      .object({
        endWithCheckQuestion: z.boolean().optional(),
        exampleFrequency: z.enum(["rarely", "whenHelpful", "often"]).optional(),
        mathNotation: z.enum(["plain", "balanced", "symbolic"]).optional(),
        oneStepAtATime: z.boolean().optional(),
        simpleWording: z.boolean().optional(),
        tutorVoice: z.enum(["calmClear", "friendlyUpbeat", "directConcise", "formalAcademic", "gentlePatient"]).optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one tutor behavior setting to update.");

const sourceDefaultsPatchSchema = z
  .object({
    activeForStudents: z.boolean().optional(),
    answerKeysTeacherReviewOnly: z.boolean().optional(),
    citationsRequired: z.boolean().optional(),
    priority: z.enum(["primary", "normal", "low"]).optional(),
    teacherOnly: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one source default to update.");

const appearancePatchSchema = z
  .object({
    appearance: z.enum(["light", "dark"]).optional(),
    themeColor: z.enum(["purple", "indigo", "blue", "teal", "cyan", "emerald", "amber", "coral", "rose"]).optional(),
    themeMood: z.enum(["calm", "focused", "warm", "highContrast"]).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one appearance setting to update.");

export function parseNotificationSettingsPatch(value: unknown): NotificationSettingsPatch {
  return notificationPatchSchema.parse(value);
}

export function buildNotificationSettingsChange(input: {
  currentSettings: unknown;
  patch: unknown;
}) {
  const patch = parseNotificationSettingsPatch(input.patch);
  const before = normalizeNotificationSettings(input.currentSettings);
  const after = normalizeNotificationSettings({
    ...before,
    ...patch
  });

  return {
    after,
    before,
    patch,
    summary: summarizeNotificationSettingsChange(before, after)
  };
}

export async function applyNotificationSettingsUpdate(input: {
  actorEmail?: string;
  actorUid: string;
  classData: Record<string, unknown>;
  classId: string;
  confirmationId: string;
  patch: unknown;
}) {
  const change = buildNotificationSettingsChange({
    currentSettings: input.classData.notificationSettings,
    patch: input.patch
  });

  if (JSON.stringify(change.before) === JSON.stringify(change.after)) {
    return {
      ...change,
      changed: false
    };
  }

  const { updateClassSettings } = await import("../data/classes.ts");
  const { tryPostgresData } = await import("../data/server.ts");
  const { adminDb } = await import("../firebase-admin.ts");
  const { writeAuditLog } = await import("../audit-log.ts");

  await tryPostgresData("assistant.notification_settings.write", () =>
    updateClassSettings({
      classId: input.classId,
      notificationSettings: change.after
    })
  );

  if (!adminDb) {
    throw new Error("Firebase Admin is not configured. Notification settings were not saved.");
  }

  await adminDb.collection("classes").doc(input.classId).set(
    {
      notificationSettings: change.after,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await writeAuditLog({
    actor: {
      email: input.actorEmail,
      uid: input.actorUid
    },
    eventType: "teacher_assistant.notification_settings.update",
    metadata: {
      after: change.after,
      before: change.before,
      confirmationId: input.confirmationId,
      toolName: "update_notification_settings"
    },
    route: "/api/teacher-assistant",
    target: {
      id: input.classId,
      type: "class"
    }
  });

  return {
    ...change,
    changed: true
  };
}

export function buildClassGeneralSettingsChange(input: { classData: Record<string, unknown>; patch: unknown }) {
  const patch = classGeneralPatchSchema.parse(input.patch);
  const before = {
    name: stringWithDefault(input.classData.name, "Class"),
    section: stringWithDefault(input.classData.section, "")
  };
  const after = {
    ...before,
    ...patch
  };

  return { after, before, patch, summary: summarizeChangedKeys("Update class details", before, after) };
}

export async function applyClassGeneralSettingsUpdate(input: SettingsUpdateInput) {
  const change = buildClassGeneralSettingsChange({ classData: input.classData, patch: input.patch });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.class_general_settings.update",
    firestorePatch: change.after,
    postgresPatch: change.after,
    toolName: "update_class_general_settings",
    ...change
  });
}

export function buildTutorAccessSettingsChange(input: { classData: Record<string, unknown>; patch: unknown }) {
  const patch = tutorAccessPatchSchema.parse(input.patch);
  const before = normalizeTutorAccessSettings(input.classData.tutorAccess ?? {
    enabled: input.classData.studentChatEnabled
  });
  const after = normalizeTutorAccessSettings({ ...before, ...patch });

  return { after, before, patch, summary: summarizeChangedKeys("Update tutor access", before, after) };
}

export async function applyTutorAccessSettingsUpdate(input: SettingsUpdateInput) {
  const change = buildTutorAccessSettingsChange({ classData: input.classData, patch: input.patch });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.tutor_access_settings.update",
    firestorePatch: {
      studentChatEnabled: change.after.enabled,
      tutorAccess: change.after
    },
    postgresPatch: {
      studentChatEnabled: change.after.enabled,
      tutorAccess: change.after
    },
    toolName: "update_tutor_access_settings",
    ...change
  });
}

export function buildTutorBehaviorSettingsChange(input: { classData: Record<string, unknown>; patch: unknown }) {
  const patch = tutorBehaviorPatchSchema.parse(input.patch);
  const before = {
    answerPolicy: normalizeAnswerPolicySettings(input.classData.answerPolicy),
    behaviorInstructions: stringWithDefault(input.classData.behaviorInstructions, ""),
    responseFormat: normalizeResponseFormatSettings(input.classData.responseFormat)
  };
  const after = {
    answerPolicy: normalizeAnswerPolicySettings({
      ...before.answerPolicy,
      ...(patch.answerPolicy ?? {})
    }),
    behaviorInstructions: patch.behaviorInstructions ?? before.behaviorInstructions,
    responseFormat: normalizeResponseFormatSettings({
      ...before.responseFormat,
      ...(patch.responseFormat ?? {})
    })
  };

  return { after, before, patch, summary: summarizeChangedKeys("Update tutor behavior", before, after) };
}

export async function applyTutorBehaviorSettingsUpdate(input: SettingsUpdateInput) {
  const change = buildTutorBehaviorSettingsChange({ classData: input.classData, patch: input.patch });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.tutor_behavior_settings.update",
    firestorePatch: change.after,
    postgresPatch: change.after,
    toolName: "update_tutor_behavior_settings",
    ...change
  });
}

export function buildClassInstructionsChange(input: {
  classData: Record<string, unknown>;
  instructions: string;
}) {
  const instructions = input.instructions.trim().slice(0, 4000);
  const before = {
    studentFacingInstructions: stringWithDefault(input.classData.studentFacingInstructions, "")
  };
  const after = { studentFacingInstructions: instructions };

  return {
    after,
    before,
    instructions,
    summary: summarizeChangedKeys("Update class instructions", before, after)
  };
}

export async function applyClassInstructionsUpdate(input: SettingsUpdateInput) {
  const change = buildClassInstructionsChange({
    classData: input.classData,
    instructions: input.instructions ?? ""
  });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.class_instructions.update",
    firestorePatch: change.after,
    postgresPatch: change.after,
    toolName: "update_class_instructions",
    ...change
  });
}

export function buildSourceDefaultsChange(input: { classData: Record<string, unknown>; patch: unknown }) {
  const patch = sourceDefaultsPatchSchema.parse(input.patch);
  const before = normalizeSourceDefaultsSettings(input.classData.sourceDefaults);
  const after = normalizeSourceDefaultsSettings({ ...before, ...patch });

  return { after, before, patch, summary: summarizeChangedKeys("Update source defaults", before, after) };
}

export async function applySourceDefaultsUpdate(input: SettingsUpdateInput) {
  const change = buildSourceDefaultsChange({ classData: input.classData, patch: input.patch });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.source_defaults.update",
    firestorePatch: { sourceDefaults: change.after },
    postgresPatch: { sourceDefaults: change.after },
    toolName: "update_source_defaults",
    ...change
  });
}

export function buildAppearanceSettingsChange(input: { classData: Record<string, unknown>; patch: unknown }) {
  const patch = appearancePatchSchema.parse(input.patch);
  const before = {
    appearance: normalizeTeacherClassAppearance(input.classData.appearance),
    themeColor: normalizeTeacherClassThemeColor(input.classData.themeColor),
    themeMood: normalizeTeacherClassThemeMood(input.classData.themeMood)
  };
  const after = {
    appearance: patch.appearance ? normalizeTeacherClassAppearance(patch.appearance) : before.appearance,
    themeColor: patch.themeColor ? normalizeTeacherClassThemeColor(patch.themeColor) : before.themeColor,
    themeMood: patch.themeMood ? normalizeTeacherClassThemeMood(patch.themeMood) : before.themeMood
  };

  return { after, before, patch, summary: summarizeChangedKeys("Update appearance", before, after) };
}

export async function applyAppearanceSettingsUpdate(input: SettingsUpdateInput) {
  const change = buildAppearanceSettingsChange({ classData: input.classData, patch: input.patch });
  return applyClassSettingsChange({
    ...input,
    auditEventType: "teacher_assistant.appearance_settings.update",
    firestorePatch: change.after,
    postgresPatch: change.after,
    toolName: "update_appearance_settings",
    ...change
  });
}

export function summarizeNotificationSettingsChange(
  before: ReturnType<typeof normalizeNotificationSettings>,
  after: ReturnType<typeof normalizeNotificationSettings>
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

type SettingsUpdateInput = {
  actorEmail?: string;
  actorUid: string;
  classData: Record<string, unknown>;
  classId: string;
  confirmationId: string;
  instructions?: string;
  patch?: unknown;
};

async function applyClassSettingsChange(input: SettingsUpdateInput & {
  after: unknown;
  auditEventType: string;
  before: unknown;
  firestorePatch: Record<string, unknown>;
  postgresPatch: Record<string, unknown>;
  toolName: string;
}) {
  if (stableStringify(input.before) === stableStringify(input.after)) {
    return {
      after: input.after,
      before: input.before,
      changed: false
    };
  }

  const { updateClassSettings } = await import("../data/classes.ts");
  const { tryPostgresData } = await import("../data/server.ts");
  const { adminDb } = await import("../firebase-admin.ts");
  const { writeAuditLog } = await import("../audit-log.ts");

  await tryPostgresData(input.auditEventType, () =>
    updateClassSettings({
      classId: input.classId,
      ...input.postgresPatch
    })
  );

  if (!adminDb) {
    throw new Error("Firebase Admin is not configured. Settings were not saved.");
  }

  await adminDb.collection("classes").doc(input.classId).set(
    {
      ...input.firestorePatch,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await writeAuditLog({
    actor: {
      email: input.actorEmail,
      uid: input.actorUid
    },
    eventType: input.auditEventType,
    metadata: {
      after: input.after,
      before: input.before,
      confirmationId: input.confirmationId,
      toolName: input.toolName
    },
    route: "/api/teacher-assistant",
    target: {
      id: input.classId,
      type: "class"
    }
  });

  return {
    after: input.after,
    before: input.before,
    changed: true
  };
}

function summarizeChangedKeys(label: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed = Object.keys(after).filter((key) => stableStringify(before[key]) !== stableStringify(after[key]));
  return changed.length ? `${label}: ${changed.join(", ")}.` : `${label}: already unchanged.`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
    .join(",")}}`;
}

function stringWithDefault(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() : fallback;
}
