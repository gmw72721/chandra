import type { CSSProperties } from "react";
import type {
  ConversationReviewStatus,
  RetrievalConfidence,
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
  | "message"
  | "monitor"
  | "moon"
  | "question"
  | "settings"
  | "spark"
  | "student"
  | "user"
  | "users";

const sidebarItems: SvgIconName[] = ["message", "home", "users", "book", "file", "monitor", "settings"];

type AnalyticsConversationRow = {
  id: string;
  lastMessageLabel: string;
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
  overview?: TeacherClassOverview | null;
  priorityRows?: TeacherClassOverviewPriorityRow[];
  reviewRows?: AnalyticsConversationRow[];
  studentCount?: number;
  onOpenPriorityStudent?: (row: TeacherClassOverviewPriorityRow) => void;
  onReviewConversation?: (row: AnalyticsConversationRow) => void;
  onReviewProfiles?: () => void;
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
  overview,
  priorityRows = [],
  reviewRows = [],
  studentCount = 0,
  onOpenPriorityStudent,
  onReviewConversation,
  onReviewProfiles
}: TeacherAnalyticsDashboardContentProps = {}) {
  const metrics = overview?.metrics;
  const summary = overview?.summary;
  const totalStudents = metrics?.totalStudents || studentCount;
  const activeStudentsToday = summary?.activeStudentsToday ?? 0;
  const activeStudentPercent = totalStudents ? Math.round((activeStudentsToday / totalStudents) * 100) : 0;
  const visibleReviewRows = reviewRows.filter((row) => conversationNeedsTeacherReview(row.status)).slice(0, 7);
  const reviewQueueByConversationId = new Map((overview?.reviewQueueRows ?? []).map((row) => [row.conversationId, row]));
  const reviewSummaryStats = buildReviewSummaryStats(reviewRows);
  const profileTotal =
    (metrics?.draftLearningProfiles ?? 0) +
    (metrics?.missingLearningProfiles ?? 0) +
    (metrics?.reviewedLearningProfiles ?? 0);
  const topics = summary?.topTopics ?? [];
  const overviewDateLabel = dateLabel ?? formatOverviewButtonDate(overview?.date, overview?.dateLabel);

  return (
    <div className="analytics-dashboard-content">
      <header className="analytics-page-header" aria-label="Dashboard overview">
        <div className="analytics-page-title">
          <h1>Today&apos;s Teacher Dashboard</h1>
          <p>
            {classLabel} · {totalStudents} {totalStudents === 1 ? "student" : "students"}
          </p>
        </div>
        <div className="analytics-header-actions">
          <button className="analytics-selector" type="button">
            <DashboardIcon name="calendar" />
            {overviewDateLabel}
            <DashboardIcon name="chevron" />
          </button>
          <button className="analytics-primary-action" type="button">
            Review today
          </button>
        </div>
      </header>

      <section className="analytics-glance-card analytics-card">
          <div className="analytics-glance-copy">
            <h1>Today at a glance</h1>
            <p>{summary?.body ?? "Overview data is loading for this class."}</p>
            {topics.length ? (
              <div className="analytics-topic-row">
                {topics.map((topic, index) => (
                  <span className={`analytics-topic-pill ${index % 2 ? "purple" : "green"}`} key={topic}>
                    {topic}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="analytics-metric-strip">
            <Metric
              icon="question"
              label="Questions today"
              value={String(summary?.questionsToday ?? metrics?.questionsToday ?? 0)}
              detail="vs yesterday"
              delta={formatDelta((summary?.questionsToday ?? metrics?.questionsToday ?? 0) - (metrics?.questionsPreviousDay ?? 0))}
            />
            <Metric
              icon="message"
              label="Conversations today"
              value={String(summary?.conversationCountToday ?? 0)}
              detail="vs yesterday"
              delta={formatDelta((summary?.conversationCountToday ?? 0) - (metrics?.conversationCountPreviousDay ?? 0))}
            />
            <Metric
              icon="users"
              label="Active students"
              value={String(activeStudentsToday)}
              detail={totalStudents ? `${activeStudentPercent}% of class` : "No roster"}
              detailTone={activeStudentsToday ? "green" : undefined}
            />
            <Metric
              icon="student"
              label="Students inactive"
              value={String(metrics?.noActivity ?? 0)}
              detail={(metrics?.noActivity ?? 0) ? "No activity today" : "All active today"}
              detailTone={(metrics?.noActivity ?? 0) ? "orange" : undefined}
            />
            <Metric
              icon="check"
              label="Active now"
              value={String(metrics?.activeNow ?? 0)}
              detail="Live"
              detailTone={(metrics?.activeNow ?? 0) ? "green" : undefined}
            />
          </div>
      </section>

      <section className="analytics-content-grid">
          <div className="analytics-left-column">
            <section className="analytics-card review-queue-card">
              <div className="analytics-card-heading">
                <div className="analytics-title-with-badge">
                  <span className="analytics-count-badge">{reviewRows.filter((row) => conversationNeedsTeacherReview(row.status)).length}</span>
                  <div>
                    <h2>Teacher Review Queue</h2>
                    <p>Conversations that need your attention</p>
                  </div>
                </div>
              </div>

              <div className="analytics-table" role="table" aria-label="Teacher review queue">
                <div className="analytics-table-header" role="row">
                  <span>Student</span>
                  <span>Issue</span>
                  <span>Confidence</span>
                  <span>Last active</span>
                  <span>Action</span>
                  <span aria-hidden="true" />
                </div>
                {visibleReviewRows.map((row) => {
                  const overviewRow = reviewQueueByConversationId.get(row.id);
                  const confidence = confidenceForConversation(row);

                  return (
                  <div className="analytics-table-row" role="row" key={row.id}>
                    <div className="analytics-student-cell">
                      <span className={`analytics-avatar ${avatarTone(row.studentName)}`}>{initialsForName(row.studentName, row.studentEmail)}</span>
                      <strong>{row.studentName}</strong>
                    </div>
                    <div className="analytics-issue-cell">
                      <strong>{overviewRow?.issue ?? issueForConversation(row)}</strong>
                      <span>{overviewRow?.suggestedAction ?? row.title}</span>
                    </div>
                    <span className={`analytics-confidence ${confidence.tone}`}>
                      <i />
                      {confidence.label}
                    </span>
                    <span className="analytics-last-active">{row.lastMessageLabel}</span>
                    <button className="analytics-row-action" type="button" onClick={() => onReviewConversation?.(row)}>
                      Review chat
                    </button>
                    <button className="analytics-dots-button" aria-label={`More actions for ${row.studentName}`} type="button">
                      <DashboardIcon name="dots" />
                    </button>
                  </div>
                  );
                })}
              </div>
              {!visibleReviewRows.length ? (
                <p className="analytics-empty-state">No conversations currently need review.</p>
              ) : null}
            </section>

            <section className="analytics-card priority-card">
              <div className="analytics-card-heading">
                <div>
                  <h2>Priority Students</h2>
                  <p>Students who may benefit from extra support or follow-up</p>
                </div>
              </div>
              <div className="analytics-priority-list">
                {priorityRows.map((row) => (
                  <div className="analytics-priority-row" key={row.id}>
                    <span className={`analytics-avatar ${avatarTone(row.studentName)}`}>{initialsForName(row.studentName, row.studentEmail)}</span>
                    <strong>{row.studentName}</strong>
                    <span className={`analytics-priority-tag ${priorityToneClass(row.tone)}`}>{row.status}</span>
                    <span className="analytics-priority-note">{row.issue}</span>
                    <button className="analytics-open-button" type="button" onClick={() => onOpenPriorityStudent?.(row)}>
                      Open
                    </button>
                  </div>
                ))}
              </div>
              {!priorityRows.length ? (
                <p className="analytics-empty-state">No priority students right now.</p>
              ) : null}
            </section>
          </div>

          <aside className="analytics-right-column">
            <section className="analytics-card summary-card">
              <div className="analytics-card-heading compact">
                <div className="analytics-title-with-icon">
                  <span className="analytics-card-icon pale">
                    <DashboardIcon name="spark" />
                  </span>
                  <h2>AI Tutor Review Summary</h2>
                </div>
              </div>
              <div className="analytics-summary-grid">
                {reviewSummaryStats.map(([icon, value, label, tone]) => (
                  <div className="analytics-summary-stat" key={label}>
                    <DashboardIcon name={icon as SvgIconName} />
                    <strong className={tone}>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="analytics-card profile-health-card">
              <div className="analytics-card-heading compact">
                <div className="analytics-title-with-icon">
                  <DashboardIcon name="heart" />
                  <h2>Learning Profile Health</h2>
                </div>
              </div>
              <div className="analytics-health-grid">
                <HealthStat
                  icon="clipboard"
                  tone="green"
                  label="Draft profiles"
                  value={String(metrics?.draftLearningProfiles ?? 0)}
                  percent={formatPercent(metrics?.draftLearningProfiles ?? 0, profileTotal)}
                />
                <HealthStat
                  icon="alert"
                  tone="orange"
                  label="Missing profiles"
                  value={String(metrics?.missingLearningProfiles ?? 0)}
                  percent={formatPercent(metrics?.missingLearningProfiles ?? 0, profileTotal)}
                />
                <HealthStat
                  icon="check"
                  tone="green"
                  label="Reviewed profiles"
                  value={String(metrics?.reviewedLearningProfiles ?? 0)}
                  percent={formatPercent(metrics?.reviewedLearningProfiles ?? 0, profileTotal)}
                />
              </div>
              <button className="analytics-profile-action" type="button" onClick={onReviewProfiles}>
                Review profiles
              </button>
            </section>
          </aside>
      </section>
    </div>
  );
}

function Metric({
  detail,
  detailTone,
  delta,
  icon,
  label,
  value
}: {
  detail: string;
  detailTone?: "green" | "orange";
  delta?: string;
  icon: SvgIconName;
  label: string;
  value: string;
}) {
  return (
    <div className="analytics-metric">
      <DashboardIcon name={icon} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={detailTone}>
        {detail}
        {delta ? <b>{delta}</b> : null}
      </small>
    </div>
  );
}

function HealthStat({
  icon,
  label,
  percent,
  tone,
  value
}: {
  icon: SvgIconName;
  label: string;
  percent: string;
  tone: "green" | "orange";
  value: string;
}) {
  return (
    <div className="analytics-health-stat">
      <span className={`analytics-health-icon ${tone}`}>
        <DashboardIcon name={icon} />
      </span>
      <div className="analytics-health-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{percent}</small>
        <i style={{ "--health-percent": percent } as CSSProperties} />
      </div>
    </div>
  );
}

function buildReviewSummaryStats(rows: AnalyticsConversationRow[]) {
  const totals = rows.reduce(
    (currentTotals, row) => {
      const signals = row.sourceAudit.learningSignals;

      currentTotals.lowConfidence +=
        signals.lowConfidenceMessageCount || Number(row.sourceAudit.lowSourceConfidence || row.latestRetrievalConfidence === "low");
      currentTotals.offTopic += Number(row.topic.toLowerCase().includes("off-topic") || signals.latestMode === "off_topic_redirect");
      currentTotals.sourceCheck +=
        signals.reviewSourceCount + signals.noSourceAssistantMessageCount + Number(row.sourceAudit.noSourceUsedWarning);
      currentTotals.incomplete += signals.askTeacherCount + signals.stuckOutcomeCount;

      return currentTotals;
    },
    { incomplete: 0, lowConfidence: 0, offTopic: 0, sourceCheck: 0 }
  );

  return [
    ["alert", String(totals.lowConfidence), "Low-confidence responses", "red"],
    ["message", String(totals.offTopic), "Off-topic tutor replies", "orange"],
    ["clipboard", String(totals.sourceCheck), "Need source check", "blue"],
    ["spark", String(totals.incomplete), "Incomplete scaffolding", "purple"]
  ] as const;
}

function conversationNeedsTeacherReview(status: ConversationReviewStatus) {
  return status === "new" || status === "needs_follow_up" || status === "misunderstanding_spotted" || status === "ai_answer_needs_review";
}

function confidenceForConversation(row: AnalyticsConversationRow) {
  const confidence = row.latestRetrievalConfidence ?? (row.sourceAudit.lowSourceConfidence ? "low" : row.sourceAudit.sourceCount ? "high" : "medium");

  return {
    label: `${confidence[0]?.toUpperCase()}${confidence.slice(1)}`,
    tone: confidence
  };
}

function issueForConversation(row: AnalyticsConversationRow) {
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

  return row.topic || "New conversation";
}

function priorityToneClass(tone: TeacherClassOverviewPriorityRow["tone"]) {
  if (tone === "high" || tone === "failed") {
    return "danger";
  }

  if (tone === "follow-up" || tone === "inactive") {
    return "warning";
  }

  if (tone === "ai-review" || tone === "draft") {
    return "purple";
  }

  if (tone === "note") {
    return "blue";
  }

  return "neutral";
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

function formatDelta(value: number) {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatPercent(value: number, total: number) {
  if (!total) {
    return "0%";
  }

  return `${Math.round((value / total) * 100)}%`;
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
