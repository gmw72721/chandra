import { useState, type CSSProperties } from "react";
import { conversationNeedsTeacherReview as conversationNeedsTeacherReviewNow } from "@/lib/conversation-review-utils";
import type {
  ConversationReviewStatus,
  RetrievalConfidence,
  StudentFeedback,
  TeacherClassOverview,
  TeacherClassOverviewPriorityRow,
  TeacherConversationSourceAuditSummary
} from "@/lib/types";

type SvgIconName =
  | "alert"
  | "book"
  | "calendar"
  | "check"
  | "chevron"
  | "clipboard"
  | "dots"
  | "file"
  | "heart"
  | "home"
  | "key"
  | "message"
  | "monitor"
  | "moon"
  | "pulse"
  | "question"
  | "settings"
  | "spark"
  | "student"
  | "user"
  | "users";

const sidebarItems: SvgIconName[] = ["message", "home", "users", "book", "file", "monitor", "settings"];

type AnalyticsConversationRow = {
  id: string;
  feedbackSummary?: {
    openCount: number;
  };
  feedback?: StudentFeedback[];
  followUpDueAt?: unknown;
  lastMessageAt: unknown;
  lastMessageLabel: string;
  learningSignals?: {
    answerSeekingReviewCount?: number;
    safetyReviewCount?: number;
    studentReplyAfterTeacherNote?: boolean;
  };
  latestRetrievalConfidence?: RetrievalConfidence;
  messageCount: number;
  sourceAudit: TeacherConversationSourceAuditSummary;
  status: ConversationReviewStatus;
  studentEmail: string;
  studentId: string;
  studentName: string;
  title: string;
  topic: string;
};

type TeacherAnalyticsDashboardContentProps = {
  classLabel?: string;
  dateLabel?: string;
  maxDate?: string;
  overview?: TeacherClassOverview | null;
  priorityRows?: TeacherClassOverviewPriorityRow[];
  reviewRows?: AnalyticsConversationRow[];
  selectedDate?: string;
  joinCode?: string;
  isLoadingClassDetails?: boolean;
  isLoadingOverview?: boolean;
  sourceCount?: number;
  studentCount?: number;
  onAddSource?: () => void;
  onCopyJoinCode?: () => void;
  onDateChange?: (date: string) => void;
  onPauseChat?: () => void;
  onOpenPriorityStudent?: (row: TeacherClassOverviewPriorityRow) => void;
  onReviewConversation?: (row: AnalyticsConversationRow) => void;
  onReviewToday?: () => void;
  onUsageDecision?: (row: AnalyticsConversationRow, decision: "approve" | "deny") => void;
};

export function TeacherAnalyticsDashboard() {
  return (
    <div className="analytics-dashboard" aria-label="Teacher analytics dashboard">
      <aside className="analytics-rail" aria-label="Primary navigation">
        <div className="analytics-logo">C</div>
        <nav className="analytics-rail-nav" aria-label="Dashboard sections">
          {sidebarItems.map((item) => (
            <button
              aria-label={item === "home" ? "Home" : item}
              aria-pressed={item === "home"}
              className="analytics-rail-button"
              key={item}
              type="button"
            >
              <DashboardIcon name={item} />
            </button>
          ))}
        </nav>
        <div className="analytics-rail-footer">
          <div className="analytics-user-avatar">GW</div>
          <button aria-label="Theme" className="analytics-moon-button" type="button">
            <DashboardIcon name="moon" />
          </button>
        </div>
      </aside>

      <main className="analytics-main">
        <TeacherAnalyticsDashboardContent />
      </main>
    </div>
  );
}

export function TeacherAnalyticsDashboardContent({
  classLabel = "Class",
  dateLabel,
  maxDate,
  overview,
  priorityRows = [],
  reviewRows = [],
  selectedDate,
  joinCode,
  isLoadingClassDetails = false,
  isLoadingOverview = false,
  sourceCount = 0,
  studentCount = 0,
  onAddSource,
  onCopyJoinCode,
  onDateChange,
  onPauseChat,
  onOpenPriorityStudent,
  onReviewConversation,
  onReviewToday,
  onUsageDecision
}: TeacherAnalyticsDashboardContentProps = {}) {
  const metrics = overview?.metrics;
  const summary = overview?.summary;
  const totalStudents = metrics?.totalStudents || studentCount;
  const selectedDashboardDate = selectedDate ?? overview?.date ?? dateKeyForAnalyticsDate(new Date());
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [visibleCalendarMonth, setVisibleCalendarMonth] = useState(() => overviewDateToLocalDate(selectedDashboardDate));
  const dashboardReferenceDate = overviewDateToLocalDate(selectedDashboardDate);
  const historicalReviewRows = reviewRows.filter((row) => isOnOrBeforeEndOfDate(row.lastMessageAt, dashboardReferenceDate));
  const allReviewRowsToCheck = historicalReviewRows.filter((row) =>
    conversationNeedsTeacherReviewNow({
      feedbackSummary: row.feedbackSummary ?? { openCount: 0 },
      followUpDueAt: row.followUpDueAt,
      learningSignals: row.learningSignals,
      status: row.status
    })
  );
  const reviewQueueByConversationId = new Map((overview?.reviewQueueRows ?? []).map((row) => [row.conversationId, row]));
  const overviewDateLabel =
    dateLabel ??
    formatOverviewButtonDate(
      selectedDashboardDate,
      overview?.date === selectedDashboardDate ? overview?.dateLabel : undefined
    );
  const selectedDateIsToday = selectedDashboardDate === dateKeyForAnalyticsDate(new Date());
  const weeklyStats = buildWeeklyChatStats(historicalReviewRows, dashboardReferenceDate);
  const weeklyReviewRows = historicalReviewRows.filter((row) => weeklyStats.dateKeys.has(dateKeyForAnalyticsValue(row.lastMessageAt)));
  const activeStudentsThisWeek = weeklyStats.activeStudentCount || summary?.activeStudentsToday || metrics?.activeNow || 0;
  const allChatUsers = buildStudentChatRows(weeklyReviewRows, priorityRows);
  const chatUsers = allChatUsers.slice(0, 5);
  const weeklyChats = weeklyStats.total;
  const averageChatCount = calculateAverageChatCount(allChatUsers, totalStudents);
  const followUpRows = allChatUsers.filter((row) => isAboveClassAverage(row.chatsThisWeek, averageChatCount)).slice(0, 4);
  const topUserMax = Math.max(...chatUsers.map((row) => row.chatsThisWeek), 1);
  const calendarWeeks = buildCalendarWeeks(visibleCalendarMonth, selectedDashboardDate, maxDate);
  const attentionRows = buildAttentionRows({
    averageChatCount,
    followUpRows,
    onOpenPriorityStudent,
    onReviewConversation,
    onUsageDecision,
    reviewQueueByConversationId,
    reviewRows: allReviewRowsToCheck
  });
  const visibleAttentionRows = attentionRows.slice(0, 8);
  const showAttentionSkeleton = isLoadingOverview && !visibleAttentionRows.length;
  const updatedLabel = formatUpdatedAt(overview?.generatedAt);

  return (
    <div className="analytics-dashboard-content">
      <header className="analytics-page-header" aria-label="Dashboard overview">
        <div className="analytics-page-header-main">
          <div className="analytics-page-title">
            <div className="analytics-page-title-row">
              <h1>{selectedDateIsToday ? "Today" : "Daily overview"}</h1>
              {isLoadingClassDetails || isLoadingOverview ? (
                <span className="analytics-title-loader" role="status" aria-label="Loading overview">
                  <span className="sr-only">Loading overview</span>
                </span>
              ) : null}
            </div>
            <p>{classLabel}</p>
            <span className="analytics-trust-signal">{updatedLabel}</span>
          </div>
          <div className="analytics-class-control-strip" aria-label="Class controls">
            <ClassControlButton
              actionLabel="Pause"
              icon="message"
              label="Chat"
              status="On"
              onAction={onPauseChat}
            />
            <ClassControlButton
              actionLabel="Copy"
              icon="key"
              label="Join code"
              status={joinCode?.trim() || "Set up"}
              onAction={onCopyJoinCode}
            />
            <ClassControlButton
              actionLabel={sourceCount ? "Add" : "Add source"}
              icon="file"
              label="Sources"
              status={sourceCount ? `${sourceCount} ready` : "None yet"}
              onAction={onAddSource}
            />
          </div>
        </div>
        <div className="analytics-header-actions">
          <div className="analytics-date-menu">
            <button
              aria-expanded={isCalendarOpen}
              aria-haspopup="dialog"
              className="analytics-date-picker"
              type="button"
              onClick={() => {
                setVisibleCalendarMonth(overviewDateToLocalDate(selectedDashboardDate));
                setIsCalendarOpen((isOpen) => !isOpen);
              }}
            >
              <DashboardIcon name="calendar" />
              <span>{overviewDateLabel}</span>
              <DashboardIcon name="chevron" />
            </button>
            {isCalendarOpen ? (
              <div className="analytics-calendar-popover" role="dialog" aria-label="Choose dashboard date">
                <div className="analytics-calendar-header">
                  <button
                    aria-label="Previous month"
                    className="analytics-calendar-nav previous"
                    type="button"
                    onClick={() => setVisibleCalendarMonth((date) => shiftCalendarMonth(date, -1))}
                  >
                    <DashboardIcon name="chevron" />
                  </button>
                  <strong>{formatCalendarMonth(visibleCalendarMonth)}</strong>
                  <button
                    aria-label="Next month"
                    className="analytics-calendar-nav"
                    type="button"
                    onClick={() => setVisibleCalendarMonth((date) => shiftCalendarMonth(date, 1))}
                  >
                    <DashboardIcon name="chevron" />
                  </button>
                </div>
                <div className="analytics-calendar-grid" role="grid" aria-label={formatCalendarMonth(visibleCalendarMonth)}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                    <span className="analytics-calendar-weekday" key={day}>
                      {day}
                    </span>
                  ))}
                  {calendarWeeks.flat().map((day) => (
                    <button
                      aria-label={formatCalendarDayLabel(day.date)}
                      className={[
                        "analytics-calendar-day",
                        day.isCurrentMonth ? "" : "outside",
                        day.isSelected ? "selected" : "",
                        day.isToday ? "today" : ""
                      ].filter(Boolean).join(" ")}
                      disabled={day.isDisabled}
                      key={day.dateKey}
                      role="gridcell"
                      type="button"
                      onClick={() => {
                        onDateChange?.(day.dateKey);
                        setVisibleCalendarMonth(day.date);
                        setIsCalendarOpen(false);
                      }}
                    >
                      {day.date.getDate()}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <button className="analytics-primary-action" type="button" onClick={onReviewToday}>
            Review today
          </button>
        </div>
      </header>

      <section className="analytics-status-strip" aria-label="Class metrics">
        <MetricPill label="Students" value={String(totalStudents)} detail="enrolled" />
        <MetricPill label="Chats" value={String(weeklyChats)} detail="this week" />
        <MetricPill label="Active" value={String(activeStudentsThisWeek)} detail="this week" />
        <MetricPill label="Needs review" value={String(allReviewRowsToCheck.length)} detail="open items" tone="warning" />
      </section>

      <section className="analytics-overview-grid">
        <section className="analytics-card analytics-attention-panel">
          <div className="analytics-card-heading">
            <div>
              <h2>Needs attention</h2>
              <p>Review requests, source warnings, and unusual chat volume across this class.</p>
            </div>
          </div>
          <div className="analytics-compact-table attention-table" role="table" aria-label="Needs attention">
            <div className="analytics-compact-table-header" role="row">
              <span>Student</span>
              <span>Reason</span>
              <span>Evidence</span>
              <span>Last activity</span>
              <span>Action</span>
            </div>
            {visibleAttentionRows.map((row) => (
              <div className="analytics-compact-table-row" role="row" key={row.id}>
                <span className="analytics-student-cell">
                  <span className={`analytics-avatar ${avatarTone(row.studentName)}`}>{initialsForName(row.studentName, row.studentEmail)}</span>
                  <strong>{row.studentName}</strong>
                </span>
                <span>{row.reason}</span>
                <span>{row.evidence}</span>
                <span className="analytics-time-cell">{row.lastActivity}</span>
                {row.decisions ? (
                  <span className="analytics-decision-actions">
                    <button type="button" onClick={row.decisions.deny}>
                      Deny
                    </button>
                    <button type="button" onClick={row.decisions.approve}>
                      Approve
                    </button>
                  </span>
                ) : (
                  <button className="analytics-row-action" type="button" onClick={row.onAction}>
                    {row.actionLabel}
                  </button>
                )}
              </div>
            ))}
            {showAttentionSkeleton ? <AttentionSkeletonRows /> : null}
          </div>
          {!visibleAttentionRows.length && !showAttentionSkeleton ? (
            <div className="analytics-empty-state">
              <strong>No attention items right now.</strong>
              <span>Student review requests, source warnings, and unusually high chat volume will appear here.</span>
            </div>
          ) : null}
        </section>

        <section className="analytics-card analytics-chart-card">
          <div className="analytics-card-heading">
            <div>
              <h2>Chats This Week</h2>
            </div>
          </div>
          <LineChart labels={weeklyStats.labels} values={weeklyStats.values} />
        </section>

        <section className="analytics-card analytics-chart-card">
          <div className="analytics-card-heading">
            <div>
              <h2>Top Chat Users This Week</h2>
            </div>
          </div>
          <div className={`analytics-bar-chart ${chatUsers.length === 1 ? "single" : ""}`} aria-label="Top chat users this week">
            {chatUsers.map((row) => (
              <div className="analytics-bar-item" key={row.id}>
                <strong className="analytics-bar-value">{row.chatsThisWeek}</strong>
                <span className="analytics-bar-column" style={{ "--bar-height": `${Math.max(8, Math.round((row.chatsThisWeek / topUserMax) * 100))}%` } as CSSProperties}>
                  <span />
                </span>
                <small>{splitStudentName(row.studentName)}</small>
              </div>
            ))}
            {!chatUsers.length ? <p className="analytics-empty-state">No chat activity in this window.</p> : null}
          </div>
        </section>
      </section>
    </div>
  );
}

type AttentionRow = {
  actionLabel: string;
  decisions?: {
    approve: () => void;
    deny: () => void;
  };
  evidence: string;
  id: string;
  lastActivity: string;
  onAction?: () => void;
  reason: string;
  studentEmail?: string;
  studentName: string;
};

function ClassControlButton({
  actionLabel,
  icon,
  label,
  status,
  onAction
}: {
  actionLabel: string;
  icon: SvgIconName;
  label: string;
  status: string;
  onAction?: () => void;
}) {
  return (
    <div className="analytics-class-control">
      <span className="analytics-class-control-icon">
        <DashboardIcon name={icon} />
      </span>
      <span>
        <strong>{label}</strong>
        <em>{status}</em>
      </span>
      <button type="button" onClick={onAction}>{actionLabel}</button>
    </div>
  );
}

function MetricPill({
  detail,
  label,
  tone,
  value
}: {
  detail: string;
  label: string;
  tone?: "default" | "warning";
  value: string;
}) {
  return (
    <div className={`analytics-metric-pill ${tone === "warning" ? "warning" : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <em>{detail}</em>
    </div>
  );
}

function AttentionSkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <div className="analytics-compact-table-row analytics-skeleton-row" role="row" key={row}>
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </>
  );
}

function issueForConversation(row: AnalyticsConversationRow, fallbackIssue?: string) {
  if ((row.feedbackSummary?.openCount ?? 0) > 0) {
    return conversationHasOpenUsageRequest(row) ? "Usage request" : "Review requested";
  }

  if ((row.learningSignals?.safetyReviewCount ?? 0) > 0) {
    return "Safety review";
  }

  if ((row.learningSignals?.answerSeekingReviewCount ?? 0) > 0) {
    return "Answer-seeking check";
  }

  if (row.learningSignals?.studentReplyAfterTeacherNote) {
    return "Student replied to teacher";
  }

  if (row.sourceAudit.lowSourceConfidence || row.latestRetrievalConfidence === "low") {
    return "Source accuracy";
  }

  if (row.sourceAudit.noSourceUsedWarning || row.sourceAudit.learningSignals.reviewSourceCount > 0) {
    return "Needs source check";
  }

  if (row.status === "needs_follow_up") {
    return "Needs follow-up";
  }

  if (row.status === "misunderstanding_spotted") {
    return "Misunderstanding spotted";
  }

  if (row.status === "ai_answer_needs_review") {
    return "AI answer review";
  }

  return fallbackIssue === "Usage request needs decision" ? "Usage request" : fallbackIssue || row.topic || "New chat";
}

function conversationHasOpenUsageRequest(row: AnalyticsConversationRow) {
  return row.feedback?.some((feedback) => feedback.status !== "resolved" && feedback.kind === "usage_request") ?? false;
}

function buildAttentionRows({
  averageChatCount,
  followUpRows,
  onOpenPriorityStudent,
  onReviewConversation,
  onUsageDecision,
  reviewQueueByConversationId,
  reviewRows
}: {
  averageChatCount: number;
  followUpRows: StudentChatRow[];
  onOpenPriorityStudent?: (row: TeacherClassOverviewPriorityRow) => void;
  onReviewConversation?: (row: AnalyticsConversationRow) => void;
  onUsageDecision?: (row: AnalyticsConversationRow, decision: "approve" | "deny") => void;
  reviewQueueByConversationId: Map<string, TeacherClassOverview["reviewQueueRows"][number]>;
  reviewRows: AnalyticsConversationRow[];
}): AttentionRow[] {
  const attentionRows: AttentionRow[] = [];

  for (const row of reviewRows) {
    const overviewRow = reviewQueueByConversationId.get(row.id);
    const isUsageRequest = conversationHasOpenUsageRequest(row);

    attentionRows.push({
      actionLabel: isUsageRequest ? "Decide" : "Review",
      decisions: isUsageRequest
        ? {
            approve: () => onUsageDecision?.(row, "approve"),
            deny: () => onUsageDecision?.(row, "deny")
          }
        : undefined,
      evidence: evidenceForConversation(row, overviewRow),
      id: `conversation-${row.id}`,
      lastActivity: row.lastMessageLabel || "Recent",
      onAction: () => onReviewConversation?.(row),
      reason: issueForConversation(row, overviewRow?.issue),
      studentEmail: row.studentEmail,
      studentName: row.studentName
    });
  }

  const reviewStudentKeys = new Set(
    reviewRows.map((row) => row.studentEmail || row.studentId || row.studentName)
  );

  for (const row of followUpRows) {
    const studentKey = row.studentEmail || row.studentId || row.studentName;

    if (reviewStudentKeys.has(studentKey)) {
      continue;
    }

    attentionRows.push({
      actionLabel: "Open student",
      evidence: `${row.chatsThisWeek} chats this week; class average ${averageChatCount}`,
      id: `follow-up-${row.id}`,
      lastActivity: row.lastMessageLabel || "This week",
      onAction: () => onOpenPriorityStudent?.(studentChatRowToPriorityRow(row)),
      reason: "High chat volume",
      studentEmail: row.studentEmail,
      studentName: row.studentName
    });
  }

  return attentionRows;
}

function evidenceForConversation(
  row: AnalyticsConversationRow,
  overviewRow?: TeacherClassOverview["reviewQueueRows"][number]
) {
  if (conversationHasOpenUsageRequest(row)) {
    return "Student is asking for more AI usage";
  }

  if ((row.learningSignals?.safetyReviewCount ?? 0) > 0) {
    return `${row.learningSignals?.safetyReviewCount} safety signal`;
  }

  if ((row.learningSignals?.answerSeekingReviewCount ?? 0) > 0) {
    return `${row.learningSignals?.answerSeekingReviewCount} answer-seeking signal`;
  }

  if (row.sourceAudit.lowSourceConfidence || row.latestRetrievalConfidence === "low") {
    return overviewRow?.meta || "Low source confidence";
  }

  if (row.sourceAudit.noSourceUsedWarning) {
    return "No class source used";
  }

  if (row.sourceAudit.learningSignals.reviewSourceCount > 0) {
    return `${row.sourceAudit.learningSignals.reviewSourceCount} source check`;
  }

  return overviewRow?.meta || row.title || row.topic || "Recent student activity";
}

function formatUpdatedAt(value?: string) {
  if (!value) {
    return "Waiting for current data";
  }

  const updatedAt = new Date(value);

  if (Number.isNaN(updatedAt.getTime())) {
    return "Updated recently";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt.getTime()) / 1000));

  if (elapsedSeconds < 45) {
    return "Updated just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes} min ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `Updated ${elapsedHours} hr ago`;
  }

  return `Updated ${updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function initialsForName(name: string, email?: string) {
  const source = name.trim() || email?.split("@")[0] || "Student";
  const words = source.split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : source.slice(0, 2);

  return initials.toUpperCase();
}

function avatarTone(value: string) {
  const tones = ["purple", "blue", "green", "orange", "cyan"] as const;
  const total = value.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0);

  return tones[total % tones.length];
}

function formatOverviewButtonDate(date?: string, fallback?: string) {
  if (!date) {
    return fallback ?? "Today";
  }

  const parsedDate = new Date(`${date}T12:00:00.000Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    return fallback ?? date;
  }

  return parsedDate.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric"
  });
}

type StudentChatRow = {
  chatsThisWeek: number;
  id: string;
  lastMessageAt?: unknown;
  lastMessageLabel?: string;
  priorityRow?: TeacherClassOverviewPriorityRow;
  studentEmail?: string;
  studentId?: string;
  studentName: string;
};

function buildStudentChatRows(
  reviewRows: AnalyticsConversationRow[],
  priorityRows: TeacherClassOverviewPriorityRow[]
): StudentChatRow[] {
  const rowsByStudent = new Map<string, StudentChatRow>();

  for (const row of reviewRows) {
    const key = row.studentEmail || row.studentId || row.studentName;
    const existing = rowsByStudent.get(key);

    if (existing) {
      existing.chatsThisWeek += Math.max(row.messageCount, 1);
      if (isAfterAnalyticsValue(row.lastMessageAt, existing.lastMessageAt)) {
        existing.lastMessageAt = row.lastMessageAt;
        existing.lastMessageLabel = row.lastMessageLabel;
      }
      continue;
    }

    rowsByStudent.set(key, {
      chatsThisWeek: Math.max(row.messageCount, 1),
      id: key,
      lastMessageAt: row.lastMessageAt,
      lastMessageLabel: row.lastMessageLabel,
      studentEmail: row.studentEmail,
      studentId: row.studentId,
      studentName: row.studentName
    });
  }

  for (const row of priorityRows) {
    const key = row.studentEmail || row.studentId || row.studentName;
    const existing = rowsByStudent.get(key);

    if (existing) {
      existing.priorityRow = row;
    }
  }

  return Array.from(rowsByStudent.values()).sort((first, second) => second.chatsThisWeek - first.chatsThisWeek);
}

function studentChatRowToPriorityRow(row: StudentChatRow): TeacherClassOverviewPriorityRow {
  return row.priorityRow ?? {
    action: "viewChats",
    actionLabel: "View chats",
    id: row.id,
    issue: "High chat volume this week",
    status: "High volume",
    studentEmail: row.studentEmail ?? "",
    studentId: row.studentId ?? "",
    studentName: row.studentName,
    tone: "high"
  };
}

function calculateAverageChatCount(rows: StudentChatRow[], studentCount: number) {
  const divisor = Math.max(studentCount || rows.length, 1);
  const total = rows.reduce((sum, row) => sum + row.chatsThisWeek, 0);

  return Math.max(Math.round(total / divisor), 0);
}

function isAboveClassAverage(chatCount: number, averageChatCount: number) {
  if (!averageChatCount) {
    return chatCount >= 5;
  }

  return chatCount >= Math.max(averageChatCount + 3, Math.ceil(averageChatCount * 1.5));
}

function splitStudentName(name: string) {
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  const last = rest.join(" ");

  return last ? (
    <>
      {first}
      <br />
      {last}
    </>
  ) : (
    first || "Student"
  );
}

function buildWeeklyChatStats(rows: AnalyticsConversationRow[], referenceDate: Date) {
  const dates = rollingSevenDatesFor(referenceDate);
  const labels = dates.map((date) => date.toLocaleDateString("en-US", { weekday: "short" }));
  const dateKeys = new Set(dates.map(dateKeyForAnalyticsDate));
  const countsByDate = new Map(Array.from(dateKeys, (dateKey) => [dateKey, 0]));
  const activeStudents = new Set<string>();

  for (const row of rows) {
    const dateKey = dateKeyForAnalyticsValue(row.lastMessageAt);

    if (!dateKey || !dateKeys.has(dateKey)) {
      continue;
    }

    const chatCount = Math.max(row.messageCount, 1);
    countsByDate.set(dateKey, (countsByDate.get(dateKey) ?? 0) + chatCount);
    activeStudents.add(row.studentEmail || row.studentId || row.studentName);
  }

  const values = dates.map((date) => countsByDate.get(dateKeyForAnalyticsDate(date)) ?? 0);

  return {
    activeStudentCount: activeStudents.size,
    dateKeys,
    labels,
    total: values.reduce((sum, value) => sum + value, 0),
    values
  };
}

function rollingSevenDatesFor(referenceDate: Date) {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  start.setDate(start.getDate() - 6);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function overviewDateToLocalDate(date?: string) {
  if (!date) {
    return new Date();
  }

  const [year, month, day] = date.split("-").map(Number);

  if (!year || !month || !day) {
    return new Date();
  }

  return new Date(year, month - 1, day);
}

type CalendarDay = {
  date: Date;
  dateKey: string;
  isCurrentMonth: boolean;
  isDisabled: boolean;
  isSelected: boolean;
  isToday: boolean;
};

function buildCalendarWeeks(visibleMonth: Date, selectedDate: string, maxDate?: string): CalendarDay[][] {
  const firstOfMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  const todayKey = dateKeyForAnalyticsDate(new Date());
  const days = Array.from({ length: 42 }, (_, index): CalendarDay => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const dateKey = dateKeyForAnalyticsDate(date);

    return {
      date,
      dateKey,
      isCurrentMonth: date.getMonth() === visibleMonth.getMonth(),
      isDisabled: Boolean(maxDate && dateKey > maxDate),
      isSelected: dateKey === selectedDate,
      isToday: dateKey === todayKey
    };
  });

  return Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7));
}

function shiftCalendarMonth(date: Date, monthDelta: number) {
  return new Date(date.getFullYear(), date.getMonth() + monthDelta, 1);
}

function formatCalendarMonth(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatCalendarDayLabel(date: Date) {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

function dateKeyForAnalyticsValue(value: unknown) {
  const date = coerceAnalyticsDate(value);

  return date ? dateKeyForAnalyticsDate(date) : "";
}

function isOnOrBeforeEndOfDate(value: unknown, date: Date) {
  const itemDate = coerceAnalyticsDate(value);

  if (!itemDate) {
    return false;
  }

  const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return itemDate.getTime() <= endOfDay.getTime();
}

function isAfterAnalyticsValue(nextValue: unknown, currentValue: unknown) {
  const nextDate = coerceAnalyticsDate(nextValue);
  const currentDate = coerceAnalyticsDate(currentValue);

  if (!nextDate) {
    return false;
  }

  if (!currentDate) {
    return true;
  }

  return nextDate.getTime() > currentDate.getTime();
}

function dateKeyForAnalyticsDate(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function coerceAnalyticsDate(value: unknown) {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? null : new Date(millis);
  }

  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate() as Date;
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function LineChart({ labels, values }: { labels: string[]; values: number[] }) {
  const maxValue = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = 34 + index * 64;
      const y = 126 - (value / maxValue) * 104;

      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className="analytics-line-chart" viewBox="0 0 440 170" role="img" aria-label="Chats this week line chart">
      {[0, 1, 2, 3, 4].map((line) => (
        <line x1="28" x2="424" y1={22 + line * 26} y2={22 + line * 26} key={line} />
      ))}
      <polyline points={points} />
      {values.map((value, index) => {
        const x = 34 + index * 64;
        const y = 126 - (value / maxValue) * 104;

        return (
          <g key={`${value}-${index}`}>
            <text className="analytics-line-value" x={x} y={Math.max(14, y - 10)}>
              {value}
            </text>
            <circle cx={x} cy={y} r="4" />
          </g>
        );
      })}
      {labels.map((label, index) => (
        <text x={34 + index * 64} y="158" key={`${label}-${index}`}>
          {label}
        </text>
      ))}
    </svg>
  );
}

function DashboardIcon({ name }: { name: SvgIconName }) {
  const common = {
    "aria-hidden": true,
    fill: "none",
    height: 20,
    viewBox: "0 0 24 24",
    width: 20
  };

  switch (name) {
    case "alert":
      return (
        <svg {...common}>
          <path d="M12 3.6 21 20H3L12 3.6Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.9" />
          <path d="M12 9v5M12 17.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
        </svg>
      );
    case "book":
      return (
        <svg {...common}>
          <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v15H8a3 3 0 0 0-3 3V5.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M8 7h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <path d="M7 3.5v3M17 3.5v3M4.5 9h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.9" />
          <path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m8 10 4 4 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <path d="M9 4h6l1 2h2v14H6V6h2l1-2Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9 11h6M9 15h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "dots":
      return (
        <svg {...common}>
          <path d="M12 5.5h.01M12 12h.01M12 18.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M7 3.5h7l4 4V20H7V3.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M14 3.5V8h4M9 12h6M9 16h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "heart":
      return (
        <svg {...common}>
          <path d="M12 20s-7-4.5-8.8-9.4C1.8 6.8 5.9 4 8.8 6.2L12 8.6l3.2-2.4c2.9-2.2 7 0.6 5.6 4.4C19 15.5 12 20 12 20Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "home":
      return (
        <svg {...common}>
          <path d="m4 11 8-7 8 7v8.5A1.5 1.5 0 0 1 18.5 21H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5V11Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "key":
      return (
        <svg {...common}>
          <circle cx="8.5" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 12h8M17 12v3M14.5 12v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "message":
      return (
        <svg {...common}>
          <path d="M4.5 5h15v11h-9L5 20v-4H4.5V5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "monitor":
      return (
        <svg {...common}>
          <rect height="11" rx="1.5" stroke="currentColor" strokeWidth="1.8" width="17" x="3.5" y="5" />
          <path d="M9 20h6M12 16v4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "moon":
      return (
        <svg {...common}>
          <path d="M20 14.7A7.8 7.8 0 0 1 9.3 4 8 8 0 1 0 20 14.7Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "pulse":
      return (
        <svg {...common}>
          <path d="M3.5 12h3l2-5 4.2 10 2.2-5h5.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        </svg>
      );
    case "question":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.9" />
          <path d="M9.7 9a2.4 2.4 0 0 1 4.6 1c0 1.9-2.3 2-2.3 3.7M12 17.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="8" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path d="M12 3.5 13.7 8 18 9.7 13.7 11.3 12 15.5 10.3 11.3 6 9.7 10.3 8 12 3.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
          <path d="M5.5 15.5 6.2 18 8.5 18.8 6.2 19.5 5.5 22 4.8 19.5 2.5 18.8 4.8 18 5.5 15.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
        </svg>
      );
    case "student":
      return (
        <svg {...common}>
          <path d="M18 20a6 6 0 0 0-12 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM18.5 7l2.5 2.5M21 7l-2.5 2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <path d="M19 20a7 7 0 0 0-14 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <path d="M16.5 19.5a4.5 4.5 0 0 0-9 0M12 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M19 18.5a3.2 3.2 0 0 0-2.9-3.1M16.2 6.2a2.7 2.7 0 0 1 0 5.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
  }
}
