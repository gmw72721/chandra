export type ConversationRetentionWindow = "forever" | "30-days" | "90-days" | "1-year";

const retentionWindows: Record<Exclude<ConversationRetentionWindow, "forever">, number> = {
  "30-days": 30,
  "90-days": 90,
  "1-year": 365
};

export function conversationRetentionCutoffDate(
  retention: unknown,
  now = new Date()
): Date | null {
  if (retention === "forever") {
    return null;
  }

  const days = retentionWindows[retention as Exclude<ConversationRetentionWindow, "forever">];

  if (!days) {
    return null;
  }

  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function isConversationExpiredForRetention({
  lastActivity,
  retention,
  now = new Date()
}: {
  lastActivity: unknown;
  retention: unknown;
  now?: Date;
}) {
  const cutoff = conversationRetentionCutoffDate(retention, now);

  if (!cutoff) {
    return false;
  }

  const activityMillis = timestampMillis(lastActivity);

  return activityMillis > 0 && activityMillis < cutoff.getTime();
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return 0;
}
