import type { ConnectedRepository } from "../projects/project-api.js";
import "./project-context-empty.css";

interface ProjectContextEmptyStateProps {
  readonly repositories: readonly ConnectedRepository[] | null;
  readonly documentCount: number;
  readonly generating: boolean;
  readonly onGenerate: () => void;
}

/** First-run context surface. Source availability is descriptive, not a prerequisite. */
export function ProjectContextEmptyState({
  repositories,
  documentCount,
  generating,
  onGenerate,
}: ProjectContextEmptyStateProps) {
  const repositoryCount = repositories?.length ?? 0;
  return (
    <div className="project-context-empty">
      <div className="project-context-empty__hero">
        <div className="project-context-empty__symbol" aria-hidden="true">
          <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
            <circle cx="19" cy="19" r="7" stroke="currentColor" strokeWidth="1.8" />
            <ellipse cx="19" cy="19" rx="18" ry="9" transform="rotate(-36 19 19)" stroke="currentColor" strokeWidth="1.5" opacity=".8" />
            <circle cx="32.2" cy="8.1" r="2.8" fill="currentColor" />
          </svg>
        </div>
        <span className="project-context-empty__eyebrow">YOUR PROJECT KNOWLEDGE</span>
        <h3>Give Muse a deeper understanding of your project</h3>
        <p>
          Turn your original idea, connected repositories, and optional documents into a
          clear picture of your project&apos;s architecture, features, and constraints.
        </p>
        <button
          className="project-context-empty__primary"
          type="button"
          onClick={onGenerate}
          disabled={generating}
          aria-busy={generating}
        >
          <span aria-hidden="true">✦</span>
          {generating ? "Muse is analyzing your sources…" : "Generate Project Context"}
          {!generating && <span aria-hidden="true">→</span>}
        </button>
        <p className="project-context-empty__helper" role={generating ? "status" : undefined}>
          {generating
            ? "Reading available evidence and preparing your first reviewable version. This may take a moment."
            : "A reviewable version will be saved. Nothing is approved automatically."}
        </p>
      </div>

      <div className="project-context-empty__sources" aria-label="Available context sources">
        <div className="project-context-empty__source">
          <span className="project-context-empty__source-icon" aria-hidden="true">⌘</span>
          <div>
            <strong>GitHub repositories</strong>
            <p>
              {repositories === null
                ? "Connection status unavailable"
                : repositoryCount > 0
                  ? `${repositoryCount} connected · Muse will sample relevant source files`
                  : "None connected · Add a repository when you’re ready"}
            </p>
          </div>
          <span className={repositoryCount > 0 ? "project-context-empty__status is-ready" : "project-context-empty__status"}>
            {repositories === null ? "Unknown" : repositoryCount > 0 ? "Available" : "Optional"}
          </span>
        </div>
        <div className="project-context-empty__source">
          <span className="project-context-empty__source-icon" aria-hidden="true">▤</span>
          <div>
            <strong>Supporting documents</strong>
            <p>
              {documentCount > 0
                ? `${documentCount} uploaded · Included in project analysis`
                : "No documents uploaded · You can add them when submitting an Intent"}
            </p>
          </div>
          <span className={documentCount > 0 ? "project-context-empty__status is-ready" : "project-context-empty__status"}>
            {documentCount > 0 ? "Available" : "Optional"}
          </span>
        </div>
      </div>
      <p className="project-context-empty__fineprint">
        Source inspection is representative, not a complete code audit. Project Context can be
        generated without supporting documents.
      </p>
    </div>
  );
}
