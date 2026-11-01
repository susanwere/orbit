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
    <section className="canvas-plan-section" aria-label={title}>
      <div className="canvas-plan-section-heading">
        <span className="canvas-empty-spark" aria-hidden="true">
          <PlanSectionIcon section={section} />
        </span>
        <h2>{title}</h2>
        <p>
          {section === "outcome"
            ? "The intended result of your project, as proposed by Muse Spark."
            : section === "original-intent"
              ? "The original request that started this project. Saved and immutable."
              : "Review the context guiding the proposed plan."}
        </p>
      </div>
      <div className="canvas-plan-section-status">
        <span>
          {approved ? "● Approved plan" : graph ? "● Draft plan" : "● Original intent saved"}
        </span>
      </div>
      <div className="canvas-plan-section-card">
        {section === "original-intent" ? (
          <>
            <h3>Original Intent</h3>
            <p className="canvas-plan-section-text">
              {originalIntent?.statement ?? "No original intent is available."}
            </p>
            {originalIntent && <small>Saved · immutable</small>}
          </>
        ) : graph && editableSection ? (
          <>
            <div className="canvas-plan-card-heading">
              <h3>{section === "outcome" ? "Proposed outcome" : title}</h3>
              {!isEditing && canEdit && (
                <button type="button" onClick={() => setIsEditing(true)}>
                  Edit
                </button>
              )}
            </div>
            {isEditing && !approved ? (
              <textarea
                autoFocus
                className="canvas-plan-inline-editor"
                aria-label={section === "outcome" ? "Proposed outcome" : `${title} (one per line)`}
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
            ) : listSection ? (
              graph[listSection].length ? (
                <ul className="canvas-plan-section-text">
                  {graph[listSection].map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              ) : (
                <p className="canvas-plan-section-text">None proposed.</p>
              )
            ) : (
              <p className="canvas-plan-section-text">{graph.summary}</p>
            )}
            <div className="canvas-plan-section-actions">
              <p>{approved ? "Read-only · plan approved" : "Editable until plan approval"}</p>
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
      <div className="canvas-plan-related">
        <h3>Related sections</h3>
        <div>
          {planSections
            .filter((entry) => entry.key !== section)
            .map((entry) => (
              <button
                type="button"
                key={entry.key}
                disabled={!graph && entry.key !== "original-intent"}
                onClick={() => onSectionChange(entry.key)}
              >
                <span aria-hidden="true">
                  <PlanSectionIcon section={entry.key} />
                </span>
                <span>
                  <strong>{entry.title}</strong>
                  <small>
                    {entry.key === "original-intent"
                      ? "View the original request"
                      : entry.key === "outcome"
                        ? "View the proposed result"
                        : `${graph?.[entry.key].length ?? 0} ${entry.key === "guardrails" ? "rules" : entry.key === "decisionsToReview" ? "decisions" : "assumptions"}`}
                  </small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
        </div>
      </div>
    </section>
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
