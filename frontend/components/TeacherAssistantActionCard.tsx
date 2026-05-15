"use client";

import type { TeacherAssistantAction } from "@/lib/teacher-assistant/types";

export function TeacherAssistantActionCard({
  action,
  disabled,
  onConfirm,
  onNavigate
}: {
  action: TeacherAssistantAction;
  disabled?: boolean;
  onConfirm: (pendingActionId: string, decision: "approved" | "rejected") => void;
  onNavigate: (href: string) => void;
}) {
  if (action.kind === "navigate") {
    return (
      <div className="teacher-assistant-action-card">
        <span>{action.label}</span>
        {action.newTab ? (
          <a href={action.href} rel="noreferrer" target="_blank">
            Open
          </a>
        ) : (
          <button type="button" onClick={() => onNavigate(action.href)}>
            Open
          </button>
        )}
      </div>
    );
  }

  if (action.kind === "confirmation") {
    return (
      <div className="teacher-assistant-action-card confirmation">
        <strong>Confirm change</strong>
        <span>{action.summary}</span>
        <div>
          <button disabled={disabled} type="button" onClick={() => onConfirm(action.pendingActionId, "approved")}>
            Approve
          </button>
          <button disabled={disabled} type="button" onClick={() => onConfirm(action.pendingActionId, "rejected")}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="teacher-assistant-action-card">
      <strong>{action.toolName}</strong>
      <span>{action.summary}</span>
    </div>
  );
}
