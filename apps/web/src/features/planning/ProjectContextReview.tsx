import { MarkdownContent } from "./MarkdownContent.js";
import { SectionTabs } from "./SectionTabs.js";
import { ProjectArchitectureEvidence } from "./ProjectArchitecture.js";
import { useState } from "react";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import { ContextIcon, type ContextIconKind } from "./ProjectContextEmptyState.js";
import { compareKnowledgeVersions } from "./compare-knowledge.js";
import "./project-context-review.css";

const tabs = [
  { key: "overview", title: "Overview", icon: "documents" },
  { key: "architecture", title: "Architecture", icon: "history" },
  { key: "technologies", title: "Technologies", icon: "layers" },
  { key: "features", title: "Features", icon: "edit" },
  { key: "constraints", title: "Constraints", icon: "intent" },
  { key: "history", title: "Version History", icon: "history" },
] as const;
type ContextTab = (typeof tabs)[number]["key"];

/** Older snapshots retain their prose when no distinct technology section exists. */
export function splitKnowledgeArchitecture(architecture: string) {
  const heading =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:3[.)]\s*)?technologies used(?:\*\*)?\s*:?\s*(?:\n|$)/i.exec(
      architecture,
    );
  return heading
    ? {
        architecture: architecture.slice(0, heading.index).trim(),
        technologies: architecture.slice(heading.index + heading[0].length).trim(),
      }
    : { architecture, technologies: "" };
}
const statusLabel = (snapshot: ProjectKnowledgeSnapshot) =>
  snapshot.review_status === "APPROVED"
    ? "Approved"
    : snapshot.review_status === "CHANGES_REQUESTED"
      ? "Changes requested"
      : "Proposed";

export function ProjectContextReview({
  snapshot,
  history,
  projectName,
  hasIntent,
  error,
  loading,
  reviewing,
  onSelectVersion,
  onRefresh,
  onGenerate,
  onOpenIntent,
  onReview,
}: {
  readonly snapshot: ProjectKnowledgeSnapshot;
  readonly history: readonly ProjectKnowledgeSnapshot[];
  readonly projectName: string;
  readonly hasIntent: boolean;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reviewing: boolean;
  readonly onSelectVersion: (snapshotId: string) => void;
  readonly onRefresh: () => void;
  readonly onGenerate: () => void;
  readonly onOpenIntent: () => void;
  readonly onReview: (decision: "approve" | "request_changes", note: string) => Promise<boolean>;
}) {
  const [activeTab, setActiveTab] = useState<ContextTab>("overview");
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [showDocuments, setShowDocuments] = useState(false);
  const canReview = !snapshot.review_status || snapshot.review_status === "PROPOSED";
  const approved = history.find((entry) => entry.review_status === "APPROVED");
  const baseline =
    approved?.id === snapshot.id
      ? history.find((entry) => entry.id !== snapshot.id && entry.review_status === "APPROVED")
      : approved;
  const changes = compareKnowledgeVersions(snapshot, baseline);
  const architecture = splitKnowledgeArchitecture(snapshot.content.summary.architecture);
  const generatedAt = new Date(snapshot.created_at).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const busy = loading || reviewing;
  return (
    <section
      className="orbit-detail-page orbit-detail-page--canvas project-context-page context-review-page"
      aria-labelledby="context-review-heading"
    >
      <header className="context-review-header">
        <div>
          <span className="orbit-detail-eyebrow">PROJECT / KNOWLEDGE</span>
          <h2 id="context-review-heading">Project Context</h2>
          <p>
            A comprehensive, evidence-based understanding of your project, generated from your
            repository, intent and documents.
          </p>
        </div>
        <div className="context-review-header-actions">
          <details className="context-review-menu">
            <summary aria-label="Context options">⋮</summary>
            <div>
              <button type="button" disabled={busy} onClick={onRefresh}>
                Refresh
              </button>
              <button type="button" disabled={busy} onClick={onGenerate}>
                Generate new version
              </button>
              <label htmlFor="knowledge-version">Version history</label>
              <select
                id="knowledge-version"
                disabled={busy}
                value={snapshot.id}
                onChange={(event) => onSelectVersion(event.target.value)}
              >
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    v{entry.revision} · {statusLabel(entry)}
                  </option>
                ))}
              </select>
            </div>
          </details>
        </div>
      </header>
      {loading && <p role="status">Refreshing project context…</p>}
      {error && (
        <p className="intent-error" role="alert">
          {error}
        </p>
      )}
      <div className="context-version-banner">
        <span className="context-version-icon">
          <ContextIcon kind="layers" />
        </span>
        <div>
          <div className="context-version-title">
            <strong>Knowledge Version</strong>
            <span>v{snapshot.revision}</span>
            <span
              className="context-version-status"
              data-status={snapshot.review_status ?? "PROPOSED"}
            >
              {statusLabel(snapshot)}
            </span>
            {approved?.id === snapshot.id && (
              <span className="context-current-approved">Current approved</span>
            )}
          </div>
          <p>Generated by Muse Spark · {generatedAt}</p>
        </div>
        <div className="context-version-review-actions">
          {canReview && (
            <>
              <button
                type="button"
                className="context-secondary-button"
                disabled={busy}
                onClick={() => setRequestingChanges(!requestingChanges)}
              >
                <ContextIcon kind="edit" />
                Request Changes
              </button>
              <button
                type="button"
                className="context-approve-button"
                disabled={busy}
                onClick={() => {
                  void onReview("approve", "");
                }}
              >
                <span aria-hidden="true">✓</span>
                {reviewing ? "Saving…" : "Approve Context"}
              </button>
            </>
          )}
        </div>
      </div>
      {snapshot.review_note && (
        <p className="context-review-feedback">
          <strong>Review feedback:</strong> {snapshot.review_note}
        </p>
      )}
      {requestingChanges && canReview && (
        <form
          className="context-review-feedback"
          onSubmit={(event) => {
            event.preventDefault();
            void onReview("request_changes", reviewNote).then((saved) => {
              if (saved) {
                setRequestingChanges(false);
                setReviewNote("");
              }
            });
          }}
        >
          <label htmlFor="knowledge-review-note">What should change?</label>
          <textarea
            id="knowledge-review-note"
            rows={3}
            maxLength={2000}
            required
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder="Explain the corrections needed in this context proposal…"
          />
          <div>
            <button
              type="button"
              className="context-secondary-button"
              disabled={reviewing}
              onClick={() => setRequestingChanges(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="context-approve-button"
              disabled={busy || !reviewNote.trim()}
            >
              Submit feedback
            </button>
          </div>
        </form>
      )}
      <div className="context-review-layout">
        <div className="context-review-primary">
          <SectionTabs
            items={tabs.map((tab) => ({ ...tab, icon: <ContextIcon kind={tab.icon} /> }))}
            selectedKey={activeTab}
            onSelect={setActiveTab}
            label="Project context sections"
            idPrefix="context"
          />
          <article
            className="context-content-card"
            role="tabpanel"
            id={`context-panel-${activeTab}`}
            aria-labelledby={`context-tab-${activeTab}`}
            tabIndex={0}
          >
            <h3>
              <span className="context-panel-icon">
                <ContextIcon kind={tabs.find((tab) => tab.key === activeTab)!.icon} />
              </span>
              {activeTab === "overview"
                ? "Project Overview"
                : activeTab === "architecture"
                  ? "Technical Architecture"
                  : activeTab === "technologies"
                    ? "Technologies Used"
                    : activeTab === "features"
                      ? "Implemented Features"
                      : activeTab === "history"
                        ? "Version History"
                        : "Constraints & Open Questions"}
            </h3>
            {activeTab === "overview" && (
              <>
                <MarkdownContent
                  className="context-prose"
                  content={snapshot.content.summary.summary}
                />
                <div className="context-content-divider" />
                <h4>Working with this context</h4>
                <ol className="context-lifecycle">
                  <li>Add intent & evidence</li>
                  <li>Generate project context</li>
                  <li>Review & approve</li>
                  <li>Plan & execute work</li>
                  <li>Track results & evidence</li>
                </ol>
                <div className="context-content-divider" />
                <h4>At a Glance</h4>
                <div className="context-glance-grid">
                  <Glance
                    icon="repository"
                    count={snapshot.content.repositories.length}
                    label="Repositories"
                    description="Recorded evidence sources"
                  />
                  <Glance
                    icon="documents"
                    count={snapshot.content.documents.length}
                    label="Documents"
                    description="Versioned supporting material"
                  />
                  <Glance
                    icon="layers"
                    count={snapshot.content.summary.features.length}
                    label="Features"
                    description="Identified in this proposal"
                  />
                  <Glance
                    icon="intent"
                    count={snapshot.content.summary.unknowns.length}
                    label="Open questions"
                    description="Gaps requiring review"
                  />
                </div>
              </>
            )}
            {activeTab === "architecture" && (
              <MarkdownContent
                className="context-prose"
                content={architecture.architecture || "No architecture description was provided."}
              />
            )}
            {activeTab === "technologies" && (
              <>
                <MarkdownContent
                  className="context-prose"
                  content={
                    architecture.technologies ||
                    "This version does not contain a separate technology inventory. Check Architecture and the source evidence, or generate a new version with the updated architect prompt."
                  }
                />
                <p className="context-review-muted">
                  Configured or declared technologies do not establish production deployment.
                </p>
              </>
            )}
            {activeTab === "features" && (
              <ContextList
                entries={snapshot.content.summary.features}
                empty="No features were identified in this version."
              />
            )}
            {activeTab === "constraints" && (
              <>
                <p className="context-review-muted">
                  AI-identified constraints are not automatically enforced execution policies.
                </p>
                <ContextList
                  entries={snapshot.content.summary.constraints}
                  empty="No constraints were identified."
                />
                <h4>Open questions</h4>
                <ContextList
                  entries={snapshot.content.summary.unknowns}
                  empty="No open questions were recorded."
                />
              </>
            )}
            {activeTab === "history" && (
              <ol className="context-history-list">
                {history.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-current={version.id === snapshot.id ? "true" : undefined}
                      onClick={() => onSelectVersion(version.id)}
                    >
                      <strong>Knowledge v{version.revision}</strong>
                      <span
                        className="context-version-status"
                        data-status={version.review_status ?? "PROPOSED"}
                      >
                        {statusLabel(version)}
                      </span>
                      <time dateTime={version.created_at}>
                        {new Date(version.created_at).toLocaleString()}
                      </time>
                    </button>
                    {version.review_note && <p>{version.review_note}</p>}
                  </li>
                ))}
              </ol>
            )}
            <details className="context-version-changes">
              <summary>
                {baseline
                  ? `Changes since approved v${baseline.revision}`
                  : "Changes in this initial context"}
              </summary>
              <p>
                {changes.summaryChanged ? "Project overview changed. " : ""}
                {changes.architectureChanged ? "Architecture changed." : ""}
              </p>
              {[
                ["Added features", changes.addedFeatures],
                ["Removed features", changes.removedFeatures],
                ["Added constraints", changes.addedConstraints],
                ["Removed constraints", changes.removedConstraints],
                ["New unknowns", changes.addedUnknowns],
                ["Removed unknowns", changes.resolvedUnknowns],
                ["Repository revisions", changes.changedRepositories],
                ["Document revisions", changes.changedDocuments],
              ].map(([title, entries]) =>
                Array.isArray(entries) && entries.length ? (
                  <div key={String(title)}>
                    <h4>{title}</h4>
                    <ContextList entries={entries} empty="" />
                  </div>
                ) : null,
              )}
            </details>
          </article>
        </div>
        <aside className="context-evidence-sidebar" aria-label="Project context evidence">
          {activeTab === "architecture" ? (
            <ProjectArchitectureEvidence snapshot={snapshot} />
          ) : (
            <>
              <section className="context-evidence-card">
                <h3>
                  <ContextIcon kind="layers" />
                  Sources & Evidence
                </h3>
                {snapshot.content.repositories.length ? (
                  snapshot.content.repositories.map((repository) => (
                    <details key={repository.fullName} className="context-evidence-source">
                      <summary>
                        <ContextIcon kind="repository" />
                        <span>
                          <strong>Repository</strong>
                          <small>{repository.fullName}</small>
                        </span>
                        <span aria-hidden="true">›</span>
                      </summary>
                      <a
                        href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open on GitHub ↗
                      </a>
                      <p>
                        {repository.commitSha
                          ? `Source revision: ${repository.commitSha.slice(0, 12)}`
                          : "Source revision unavailable"}
                      </p>
                      <p>
                        {repository.inspected.length} inspected files ·{" "}
                        {repository.truncated ? "Representative sample" : "Recorded source sample"}
                      </p>
                      <ul>
                        {repository.inspected.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                      {repository.summary && (
                        <MarkdownContent content={repository.summary.summary} />
                      )}
                    </details>
                  ))
                ) : (
                  <p className="context-review-muted">No repository evidence in this version.</p>
                )}
                <button
                  type="button"
                  className="context-evidence-source context-evidence-button"
                  aria-expanded={showDocuments}
                  onClick={() => setShowDocuments(!showDocuments)}
                >
                  <ContextIcon kind="documents" />
                  <span>
                    <strong>Documents</strong>
                    <small>{snapshot.content.documents.length} files in this version</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                {showDocuments && (
                  <div className="context-document-evidence">
                    {snapshot.content.documents.length ? (
                      snapshot.content.documents.map((document) => (
                        <details key={document.id}>
                          <summary>
                            {document.filename} · v{document.version}
                          </summary>
                          <MarkdownContent content={document.summary.summary} />
                        </details>
                      ))
                    ) : (
                      <p>No supporting documents in this version.</p>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="context-evidence-source context-evidence-button"
                  onClick={onOpenIntent}
                >
                  <ContextIcon kind="intent" />
                  <span>
                    <strong>Original Intent</strong>
                    <small>{hasIntent ? "Defined" : "Not saved yet"}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </section>
              <section className="context-evidence-card">
                <h3>
                  <ContextIcon kind="intent" />
                  Project Details
                </h3>
                <dl className="context-project-details">
                  <div>
                    <dt>Project</dt>
                    <dd>{projectName}</dd>
                  </div>
                  <div>
                    <dt>Generated</dt>
                    <dd>{generatedAt}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>
                      <span
                        className="context-version-status"
                        data-status={snapshot.review_status ?? "PROPOSED"}
                      >
                        v{snapshot.revision} ({statusLabel(snapshot)})
                      </span>
                    </dd>
                  </div>
                  {snapshot.reviewed_at && (
                    <div>
                      <dt>Reviewed</dt>
                      <dd>{new Date(snapshot.reviewed_at).toLocaleString()}</dd>
                    </div>
                  )}
                </dl>
              </section>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
function ContextList({
  entries,
  empty,
}: {
  readonly entries: readonly string[];
  readonly empty: string;
}) {
  return entries.length ? (
    <ul className="context-detail-list">
      {entries.map((entry, index) => (
        <li key={index}>
          <MarkdownContent content={entry} />
        </li>
      ))}
    </ul>
  ) : (
    <p className="context-review-muted">{empty}</p>
  );
}
function Glance({
  icon,
  count,
  label,
  description,
}: {
  readonly icon: ContextIconKind;
  readonly count: number;
  readonly label: string;
  readonly description: string;
}) {
  return (
    <div>
      <ContextIcon kind={icon} />
      <strong>
        {count} {label}
      </strong>
      <span>{description}</span>
    </div>
  );
}
