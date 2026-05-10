"use client";

import { useState } from "react";
import { formatConversationDate } from "@/lib/display-format";
import type {
  StudentLearningProfileContent,
  StudentLearningProfileDocument,
  StudentLearningTriedStrategy
} from "@/lib/types";

export function StudentLearningProfileCard({
  canForceUpdate,
  isSavingAction,
  onApprove,
  onClearDraft,
  onDisable,
  onForceSevenDays,
  onUpdateNow,
  profile,
  statusMessage
}: {
  canForceUpdate: boolean;
  isSavingAction: string;
  onApprove: () => void;
  onClearDraft: () => void;
  onDisable: () => void;
  onForceSevenDays: () => void;
  onUpdateNow: () => void;
  profile: StudentLearningProfileDocument | null;
  statusMessage: string;
}) {
  const activeProfile = profile?.activeProfile ?? null;
  const draftProfile = profile?.draftProfile ?? null;
  const [selectedProfileView, setSelectedProfileView] = useState<"active" | "draft" | null>("draft");
  const displayProfile =
    selectedProfileView === "active" && activeProfile
      ? activeProfile
      : selectedProfileView === "draft" && draftProfile
        ? draftProfile
        : null;
  const testingStrategies = displayProfile?.triedStrategies.filter(isTestingStrategy).slice(0, 4) ?? [];
  const profileChanges = activeProfile && draftProfile ? buildLearningProfileChanges(activeProfile, draftProfile) : [];

  return (
    <section className="student-detail-card learning-profile-card">
      <div className="student-detail-card-heading">
        <div>
          <h4>Learning profile</h4>
          <span className="learning-profile-status">
            {formatLearningProfileStatus(profile)}
            {profile?.lastSuccessfulUpdateAt ? ` / updated ${formatConversationDate(profile.lastSuccessfulUpdateAt)}` : ""}
          </span>
        </div>
        <div className="learning-profile-heading-actions">
          <button disabled={Boolean(isSavingAction)} type="button" onClick={onUpdateNow}>
            {isSavingAction === "update" ? "Updating" : "Update"}
          </button>
          {canForceUpdate ? (
            <button disabled={Boolean(isSavingAction)} type="button" onClick={onForceSevenDays}>
              Force 7d
            </button>
          ) : null}
        </div>
      </div>

      <div className="learning-profile-counts">
        <span>{profile?.pendingConversationCount ?? 0} pending conversations</span>
        <span>{profile?.pendingStudentMessageCount ?? 0} pending student messages</span>
      </div>
      {statusMessage ? <p className="learning-profile-status-note">{statusMessage}</p> : null}

      {profileChanges.length ? (
        <div className="learning-profile-content">
          <LearningProfileList title="Model change notes" items={draftProfile?.profileChangeNotes ?? []} />
          <LearningProfileList title="Changes in new draft" items={profileChanges} />
        </div>
      ) : null}

      {activeProfile || draftProfile ? (
        <div className="learning-profile-view-tabs" aria-label="Learning profile versions">
          <button
            aria-pressed={selectedProfileView === "active"}
            disabled={!activeProfile}
            type="button"
            onClick={() => setSelectedProfileView(selectedProfileView === "active" ? null : "active")}
          >
            Reviewed profile
          </button>
          <button
            aria-pressed={selectedProfileView === "draft"}
            disabled={!draftProfile}
            type="button"
            onClick={() => setSelectedProfileView(selectedProfileView === "draft" ? null : "draft")}
          >
            New draft
          </button>
        </div>
      ) : null}

      {displayProfile ? (
        <div className="learning-profile-content">
          {displayProfile.summary ? <p className="learning-profile-summary">{displayProfile.summary}</p> : null}
          <LearningProfileList title="Effective supports" items={displayProfile.effectiveSupports} />
          <LearningProfileList title="Less effective supports" items={displayProfile.lessEffectiveSupports} />
          <LearningProfileStrategyList strategies={testingStrategies} />
          <LearningProfileList title="Try next" items={displayProfile.strategiesToTryNext} />
          <LearningProfileList title="Notable improvements" items={displayProfile.notableImprovements} />
          <LearningProfileList title="Evidence notes" items={displayProfile.evidence.map((evidence) => evidence.note)} />
        </div>
      ) : (
        <p className="learning-profile-empty">
          {activeProfile || draftProfile ? "Select a profile version to view it." : "No reviewed learning profile yet."}
        </p>
      )}

      <div className="learning-profile-actions">
        <button disabled={!draftProfile || Boolean(isSavingAction)} type="button" onClick={onApprove}>
          {isSavingAction === "approve" ? "Approving" : "Approve"}
        </button>
        <button disabled={!activeProfile || Boolean(isSavingAction)} type="button" onClick={profile?.active ? onDisable : onApprove}>
          {profile?.active
            ? isSavingAction === "disable"
              ? "Disabling"
              : "Disable"
            : isSavingAction === "approve"
              ? "Enabling"
              : "Enable"}
        </button>
        <button disabled={!draftProfile || Boolean(isSavingAction)} type="button" onClick={onClearDraft}>
          {isSavingAction === "clearDraft" ? "Clearing" : "Clear draft"}
        </button>
      </div>
    </section>
  );
}

export function formatLearningProfileUpdateResult(result: { reason?: string } | undefined, forced: boolean) {
  if (result?.reason === "updated") {
    return forced ? "Created a new draft from the past 7 days." : "Created a new draft for teacher review.";
  }

  if (result?.reason === "below_threshold") {
    return "Not enough new data yet. Use Force 7d to draft from the past 7 days.";
  }

  if (result?.reason === "no_recent_data") {
    return "No conversations or student messages found in the past 7 days.";
  }

  if (result?.reason === "model_unavailable") {
    return "The model update was unavailable. Check OPENROUTER_API_KEY.";
  }

  return "";
}

function LearningProfileList({ items, title }: { items: string[]; title: string }) {
  const visibleItems = items.filter(Boolean).slice(0, 4);

  if (!visibleItems.length) {
    return null;
  }

  return (
    <div className="learning-profile-list">
      <strong>{title}</strong>
      <ul>
        {visibleItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function LearningProfileStrategyList({ strategies }: { strategies: StudentLearningTriedStrategy[] }) {
  if (!strategies.length) {
    return null;
  }

  return (
    <div className="learning-profile-list">
      <strong>Strategies being tested</strong>
      <ul>
        {strategies.map((strategy) => (
          <li key={strategy.id}>
            {strategy.strategy}
            {strategy.nextAction ? ` / ${strategy.nextAction}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function isTestingStrategy(strategy: StudentLearningTriedStrategy) {
  return strategy.status === "currently_testing" || strategy.status === "try_next";
}

function formatLearningProfileStatus(profile: StudentLearningProfileDocument | null) {
  if (!profile) {
    return "No profile";
  }

  if (!profile.active) {
    return profile.draftProfile ? "Draft awaiting review" : "Disabled";
  }

  if (!profile.teacherReviewed) {
    return "Draft awaiting review";
  }

  return `Active / ${profile.confidence} confidence`;
}

function buildLearningProfileChanges(
  activeProfile: StudentLearningProfileContent,
  draftProfile: StudentLearningProfileContent
) {
  return [
    ...summaryChange(activeProfile.summary, draftProfile.summary),
    ...arrayProfileChanges("effective support", activeProfile.effectiveSupports, draftProfile.effectiveSupports),
    ...arrayProfileChanges("less effective support", activeProfile.lessEffectiveSupports, draftProfile.lessEffectiveSupports),
    ...arrayProfileChanges("strategy to try", activeProfile.strategiesToTryNext, draftProfile.strategiesToTryNext),
    ...arrayProfileChanges("avoid note", activeProfile.avoid, draftProfile.avoid),
    ...arrayProfileChanges("open question", activeProfile.openQuestions, draftProfile.openQuestions),
    ...arrayProfileChanges("notable improvement", activeProfile.notableImprovements, draftProfile.notableImprovements),
    ...strategyProfileChanges(activeProfile.triedStrategies, draftProfile.triedStrategies)
  ].slice(0, 8);
}

function summaryChange(activeSummary: string, draftSummary: string) {
  if (normalizeProfileComparisonText(activeSummary) === normalizeProfileComparisonText(draftSummary)) {
    return [];
  }

  if (!activeSummary.trim() && draftSummary.trim()) {
    return ["Added summary."];
  }

  if (activeSummary.trim() && !draftSummary.trim()) {
    return ["Removed summary."];
  }

  return ["Updated summary wording."];
}

function arrayProfileChanges(label: string, activeItems: string[], draftItems: string[]) {
  const activeSet = new Set(activeItems.map(normalizeProfileComparisonText));
  const draftSet = new Set(draftItems.map(normalizeProfileComparisonText));
  const added = draftItems
    .filter((item) => item.trim() && !activeSet.has(normalizeProfileComparisonText(item)))
    .map((item) => `Added ${label}: ${item}`);
  const removed = activeItems
    .filter((item) => item.trim() && !draftSet.has(normalizeProfileComparisonText(item)))
    .map((item) => `Removed ${label}: ${item}`);

  return [...added, ...removed];
}

function strategyProfileChanges(
  activeStrategies: StudentLearningTriedStrategy[],
  draftStrategies: StudentLearningTriedStrategy[]
) {
  const activeByKey = new Map(activeStrategies.map((strategy) => [strategyComparisonKey(strategy), strategy]));
  const changes: string[] = [];

  draftStrategies.forEach((strategy) => {
    const activeStrategy = activeByKey.get(strategyComparisonKey(strategy));

    if (!activeStrategy) {
      changes.push(`Added strategy: ${strategy.strategy}`);
      return;
    }

    if (activeStrategy.status !== strategy.status) {
      changes.push(`Changed strategy status: ${strategy.strategy} (${activeStrategy.status} to ${strategy.status})`);
    }
  });

  return changes;
}

function strategyComparisonKey(strategy: StudentLearningTriedStrategy) {
  return normalizeProfileComparisonText(strategy.id || strategy.strategy);
}

function normalizeProfileComparisonText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
