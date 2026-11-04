import "./plan-detail-items.css";
import { SectionTabs } from "./SectionTabs.js";
import { useState } from "react";
import type { StoredIntent } from "../intent/intent-api.js";
import type { WorkGraph } from "./PlanReview.js";

export const planSections = [
  { key: "original-intent", title: "Original Intent" },
  { key: "outcome", title: "Proposed Outcome" },
  { key: "guardrails", title: "Guardrails" },
  { key: "decisionsToReview", title: "Decisions to Review" },
  { key: "assumptions", title: "Assumptions" },
] as const;
export type PlanSectionKey = (typeof planSections)[number]["key"];

interface PlanSectionProps {
  readonly section: PlanSectionKey;
  readonly graph: WorkGraph | null;
  readonly originalIntent: StoredIntent | null;
  readonly approved: boolean;
  readonly canEdit: boolean;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onSectionChange: (section: PlanSectionKey) => void;
  readonly onSummaryChange: (summary: string) => void;
  readonly onListChange: (
    section: "guardrails" | "decisionsToReview" | "assumptions",
    text: string,
  ) => void;
  readonly onCancel: () => void;
  readonly onSave: () => Promise<boolean>;
}

export function PlanSection({
  section,
  graph,
  originalIntent,
  approved,
  canEdit,
  dirty,
  busy,
  onSectionChange,
  onSummaryChange,
  onListChange,
  onCancel,
  onSave,
}: PlanSectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const sectionDefinition = planSections.find((entry) => entry.key === section);
  const title = sectionDefinition?.title ?? "Plan details";
  const listSection =
    section === "guardrails" || section === "decisionsToReview" || section === "assumptions"
      ? section
      : null;
  const editableSection = section === "outcome" || listSection !== null;
  return (
    <div className="canvas-plan-details">
      <SectionTabs
        items={planSections.map((entry) => ({
          ...entry,
          disabled: entry.key !== "original-intent" && !graph,
          icon: <PlanSectionIcon section={entry.key} />,
        }))}
        selectedKey={section}
        onSelect={(nextSection) => {
          setIsEditing(false);
          onSectionChange(nextSection);
        }}
        label="Plan detail sections"
        idPrefix="plan-details"
      />
      <section
        className="canvas-plan-section"
        role="tabpanel"
        id={`plan-details-panel-${section}`}
        aria-labelledby={`plan-details-tab-${section}`}
      >
        <div
          className={`canvas-plan-section-card${isEditing ? "" : " canvas-plan-section-card--items"}`}
        >
          <div className="canvas-plan-card-toolbar">
            <small className="plan-detail-state" data-approved={approved}>
              {section === "original-intent"
                ? originalIntent
                  ? "Saved · immutable"
                  : "No original intent saved"
                : approved
                  ? "Read-only · plan approved"
                  : graph
                    ? "Editable until plan approval"
                    : "No plan generated yet"}
            </small>
            {section !== "original-intent" && graph && editableSection && !isEditing && canEdit && (
              <button type="button" onClick={() => setIsEditing(true)}>
                Edit
              </button>
            )}
          </div>
          {section === "original-intent" ? (
            <PlanDetailItems
              entries={originalIntent ? [originalIntent.statement] : []}
              section={section}
              approved={approved}
              emptyMessage="No original intent is available."
            />
          ) : graph && editableSection ? (
            <>
              {isEditing && !approved ? (
                <textarea
                  autoFocus
                  className="canvas-plan-inline-editor"
                  aria-label={
                    section === "outcome" ? "Proposed outcome" : `${title} (one per line)`
                  }
                  id={section === "outcome" ? "plan-summary" : `plan-${section}`}
                  rows={4}
                  maxLength={section === "outcome" ? 2000 : undefined}
                  value={listSection ? graph[listSection].join("\n") : graph.summary}
                  disabled={!canEdit}
                  onChange={(event) =>
                    listSection
                      ? onListChange(listSection, event.target.value)
                      : onSummaryChange(event.target.value)
                  }
                />
              ) : (
                <PlanDetailItems
                  entries={listSection ? graph[listSection] : [graph.summary]}
                  section={section}
                  approved={approved}
                  emptyMessage="None proposed."
                />
              )}
              <div className="canvas-plan-section-actions">
                {isEditing && !approved && (
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        onCancel();
                        setIsEditing(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="canvas-section-primary"
                      disabled={!canEdit || !dirty}
                      onClick={async () => {
                        if (await onSave()) setIsEditing(false);
                      }}
                    >
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                )}
              </div>
              {dirty && isEditing && (
                <small className="canvas-section-save-note">
                  Saving or canceling applies to all unsaved plan changes.
                </small>
              )}
            </>
          ) : (
            <p>No proposed plan is available yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function PlanDetailItems({
  entries,
  section,
  approved,
  emptyMessage,
}: {
  readonly entries: readonly string[];
  readonly section: PlanSectionKey;
  readonly approved: boolean;
  readonly emptyMessage: string;
}) {
  const labels: Record<PlanSectionKey, string> = {
    "original-intent": "Original request",
    outcome: "Proposed outcome",
    guardrails: "Guardrail",
    decisionsToReview: "Decision to review",
    assumptions: "Assumption",
  };
  if (!entries.length) return <p className="canvas-plan-section-text">{emptyMessage}</p>;
  return (
    <ul
      className="plan-detail-items"
      aria-label={`${planSections.find((entry) => entry.key === section)?.title} items`}
    >
      {entries.map((entry, index) => {
        const titledEntry = entry.match(/^([^:\n]{1,80}):\s+([\s\S]+)$/);
        const itemTitle =
          titledEntry?.[1]?.replace(/^\*\*|\*\*$/g, "") ??
          `${labels[section]}${entries.length > 1 ? ` ${index + 1}` : ""}`;
        const description = titledEntry?.[2] ?? entry;
        return (
          <li className="plan-detail-item" key={index}>
            <span
              className="plan-detail-marker"
              data-approved={approved}
              aria-hidden="true"
              title={approved ? "Approved as part of the plan" : "Proposed item"}
            >
              {approved ? "✓" : index + 1}
            </span>
            <div className="plan-detail-item-card">
              <span className="plan-detail-item-icon">
                <PlanSectionIcon section={section} />
              </span>
              <div className="plan-detail-item-content">
                <h3>{itemTitle}</h3>
                <p>{description}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PlanSectionIcon({ section }: { readonly section: PlanSectionKey }) {
  const paths: Record<PlanSectionKey, string> = {
    "original-intent": "M21 12a9 9 0 1 1-9-9m5 0v4h4m-4-4-5 9m4 0a4 4 0 1 1-4-4",
    outcome:
      "m11 3 2.5 6.5L20 12l-6.5 2.5L11 21l-2.5-6.5L2 12l6.5-2.5L11 3Zm9-2 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z",
    guardrails: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z",
    decisionsToReview: "M8 5h13M8 12h13M8 19h13M3 4h1v2H3zM3 11h1v2H3zM3 18h1v2H3z",
    assumptions: "M9 18h6m-6 3h6M8 15a7 7 0 1 1 8 0l-1 3H9l-1-3Z",
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill={section === "outcome" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[section]} />
    </svg>
  );
}
