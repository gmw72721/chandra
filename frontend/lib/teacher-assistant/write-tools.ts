import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { normalizeNotificationSettings } from "../class-settings.ts";
import { updateClassSettings } from "../data/classes.ts";
import { tryPostgresData } from "../data/server.ts";
import { adminDb } from "../firebase-admin.ts";
import { writeAuditLog } from "../audit-log.ts";

const notificationPatchSchema = z
  .object({
    followUpReminders: z.boolean().optional(),
    newStudentJoinedClass: z.boolean().optional(),
    weeklyDigest: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one notification setting to update.");

export type NotificationSettingsPatch = z.infer<typeof notificationPatchSchema>;

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
