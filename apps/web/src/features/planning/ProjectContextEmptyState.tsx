import type { KnowledgeGenerationActivity } from "@orbit/domain";
import { ContextGenerationProgress } from "./ContextGenerationProgress.js";
import type { ConnectedRepository } from "../projects/project-api.js";
import type { ReactNode } from "react";

export type ContextIconKind =
  | "repository"
  | "documents"
  | "intent"
  | "spark"
  | "layers"
  | "history"
  | "edit";
export function ContextIcon({ kind }: { readonly kind: ContextIconKind }) {
  const paths: Record<ContextIconKind, string> = {
    repository:
      "M9 19c-4 1-4-2-6-2m12 5v-4a3 3 0 0 0-1-2c3 0 6-2 6-6a5 5 0 0 0-1-3 5 5 0 0 0 0-4s-1-1-4 1a14 14 0 0 0-6 0C6 2 5 3 5 3a5 5 0 0 0 0 4 5 5 0 0 0-1 3c0 4 3 6 6 6a3 3 0 0 0-1 2v4",
    documents: "M14 2H5v20h14V7Zm0 0v6h5M8 13h8M8 17h5",
    intent: "M20 11a8 8 0 1 1-7-7m-1 4a4 4 0 1 0 4 4m-4 0L22 2m-5 0h5v5",
    spark: "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Zm8-2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z",
    layers: "m2 7 10-5 10 5-10 5-10-5Zm0 5 10 5 10-5M2 17l10 5 10-5",
    history: "M6 5v14m12-14v14M6 8h12M6 16h12M3 2h6v5H3Zm12 15h6v5h-6Z",
    edit: "M13 4H4v16h16v-9M10 14l1-5L20 1l3 3-9 9-4 1Z",
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

export function ContextSourceCard({
  icon,
  title,
  description,
  available = false,
  expanded,
  onClick,
}: {
  readonly icon: ContextIconKind;
  readonly title: string;
  readonly description: string;
  readonly available?: boolean;
  readonly expanded?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="context-source-card"
      data-available={available}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className="context-source-icon">
        <ContextIcon kind={icon} />
      </span>
      <span className="context-source-copy">
        <strong>
          {title}
          {available && (
            <span className="context-source-check" aria-label="Available">
              ✓
            </span>
          )}
        </strong>
        <span>{description}</span>
      </span>
      <span className="context-source-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function ContextBenefit({
  icon,
  title,
  children,
}: {
  readonly icon: ContextIconKind;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <span className="context-benefit-icon">
        <ContextIcon kind={icon} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </li>
  );
}

export function ProjectContextEmptyState({
  activity = [],
  generating,
  disabled,
  repositories = [],
  documentCount = 0,
  hasIntent = false,
  onOpenIntent,
  onGenerate,
}: {
  readonly activity?: readonly KnowledgeGenerationActivity[];
  readonly hasIntent?: boolean;
  readonly documentCount?: number;
  readonly onOpenIntent?: () => void;
  readonly repositories?: readonly Pick<ConnectedRepository, "id" | "full_name" | "html_url">[];
  readonly generating: boolean;
  readonly disabled: boolean;
  readonly onGenerate: () => void;
}) {
  return (
    <div
      className={`context-initial-state${generating ? " context-initial-state--generating" : ""}`}
    >
      <div className="context-understanding-art" aria-hidden="true">
        <span className="context-art-orbit">
          <i />
          <i />
        </span>
        <span className="context-art-layer context-art-layer-bottom" />
        <span className="context-art-layer context-art-layer-middle" />
        <span className="context-art-layer context-art-layer-top" />
        <svg
          className="context-art-brain"
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M29 16c-6-7-17-2-15 6-7 1-9 12-3 16-4 9 6 16 12 12 2 4 6 3 6-1V16Zm6 0c6-7 17-2 15 6 7 1 9 12 3 16 4 9-6 16-12 12-2 4-6 3-6-1V16ZM15 25c5-2 9 1 9 5m-12 8c6-4 11-1 11 3m20-16c-5-2-7 1-7 5m15 8c-6-4-11-1-11 3" />
          <path d="m53 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2" />
        </svg>
      </div>
      <h3>
        {generating ? "Muse is understanding your project" : "Let Muse understand your project"}
      </h3>
      <p>
        {generating
          ? "Orbit is reading the available repository evidence, original intent, and supporting documents to generate a reviewable Project Context summary."
          : "Generate a project context summary from your intent, connected repository and any supporting documents. This becomes a versioned understanding that you can review and refine over time."}
      </p>
      {generating ? (
        <ContextGenerationProgress
          activity={activity}
          repositoryCount={repositories.length}
          documentCount={documentCount}
          hasIntent={hasIntent}
        />
      ) : (
        <button
          type="button"
          className="context-generate-button"
          disabled={disabled}
          onClick={onGenerate}
        >
          <ContextIcon kind="spark" />
          Generate context summary
        </button>
      )}
      <ul className="context-initial-benefits" aria-label="Project context sources">
        <ContextBenefit
          icon="repository"
          title={repositories.length ? "Repository (connected)" : "Repository (optional)"}
        >
          {repositories.length
            ? repositories.map((repository) => (
                <a
                  className="context-repository-link"
                  key={repository.id}
                  href={repository.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {repository.full_name} <span aria-hidden="true">↗</span>
                </a>
              ))
            : "No repository connected"}
        </ContextBenefit>
        <ContextBenefit icon="documents" title={`Documents (${documentCount})`}>
          {documentCount === 1 ? "1 supporting document" : `${documentCount} supporting documents`}
        </ContextBenefit>
        <ContextBenefit icon="intent" title="Original Intent">
          <button type="button" className="context-intent-link" onClick={onOpenIntent}>
            View your project goal and scope <span aria-hidden="true">›</span>
          </button>
        </ContextBenefit>
      </ul>
    </div>
  );
}
