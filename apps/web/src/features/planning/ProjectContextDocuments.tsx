import { useEffect, useState } from "react";
import type { ProjectIntentApi, ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import "./project-context.css";
import type { ConnectedRepository } from "../projects/project-api.js";
import { ContextSourceCard, ProjectContextEmptyState } from "./ProjectContextEmptyState.js";
import { compareKnowledgeVersions } from "./compare-knowledge.js";

interface DocumentMetadata {
  id: string;
  original_filename: string;
  media_type: string;
  size_bytes: number;
  version: number;
  processing_status: string;
  created_at: string;
}

export function ProjectContextDocuments({
  api,
  projectId,
  onOpenIntent,
}: {
  readonly api: ProjectIntentApi;
  readonly projectId: string;
  readonly onOpenIntent: () => void;
}) {
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [hasIntent, setHasIntent] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"repositories" | "documents" | null>(null);
  const [snapshots, setSnapshots] = useState<readonly ProjectKnowledgeSnapshot[]>([]);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [documents, setDocuments] = useState<readonly DocumentMetadata[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      api.getProjectDocuments(projectId),
      api.getProjectKnowledge(projectId),
      api.getRepositories(projectId),
      api.getIntent(projectId),
    ])
      .then(([items, history, connectedRepositories, intent]) => {
        if (active) {
          setDocuments(items);
          setSnapshots(history);
          setRepositories(connectedRepositories);
          setHasIntent(Boolean(intent));
          setHasLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load documents.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, projectId, refreshCount]);

  async function generateSummary() {
    setGenerating(true);
    setError(null);
    try {
      const next = await api.refreshProjectKnowledge(projectId);
      setSnapshots((items) => [next, ...items]);
      setSelectedId(next.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not summarize project.");
    } finally {
      setGenerating(false);
    }
  }
  const latest = snapshots.find((item) => item.id === selectedId) ?? snapshots[0];
  const approved = snapshots.find((item) => item.review_status === "APPROVED");
  const comparisonBase =
    approved?.id === latest?.id
      ? snapshots.find((item) => item.id !== latest?.id && item.review_status === "APPROVED")
      : approved;
  const changes = latest ? compareKnowledgeVersions(latest, comparisonBase) : null;
  async function review(decision: "approve" | "request_changes") {
    if (!latest) return;
    setReviewing(true);
    setError(null);
    try {
      const updated = await api.reviewProjectKnowledge(
        projectId,
        latest.id,
        latest.revision,
        decision,
        reviewNote,
      );
      setSnapshots((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setReviewNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review could not be saved.");
    } finally {
      setReviewing(false);
    }
  }
  return (
    <section
      className={`orbit-detail-page orbit-detail-page--canvas project-context-page${!latest ? " project-context-page--initial" : ""}`}
      aria-labelledby="project-context-heading"
    >
      <div className="orbit-detail-heading">
        <div>
          <span className="orbit-detail-eyebrow">PROJECT / KNOWLEDGE</span>
          <h2 id="project-context-heading" className="context-accessible-heading">
            Project Context
          </h2>
          <p>
            Orbit’s evolving understanding of your project, grounded in your intent, documents and
            repository evidence.
          </p>
        </div>
        {latest && (
          <button
            type="button"
            className="orbit-detail-back"
            onClick={() => {
              void generateSummary();
            }}
            disabled={loading || generating}
          >
            {generating ? "Summarizing…" : "✦ Generate context summary"}
          </button>
        )}
        {(latest || error) && (
          <button
            type="button"
            className="orbit-detail-back"
            onClick={() => setRefreshCount((count) => count + 1)}
            disabled={loading || generating}
          >
            <span aria-hidden="true">⟳</span> Refresh
          </button>
        )}
      </div>
      {loading && <p role="status">Loading project documents…</p>}
      {error && (
        <p className="intent-error" role="alert">
          {error}
        </p>
      )}
      {latest && !loading && hasLoaded && (
        <div className="context-source-grid">
          <ContextSourceCard
            icon="repository"
            title={repositories.length ? "Repository (connected)" : "Repository"}
            description={
              repositories.length
                ? repositories.map((repository) => repository.full_name).join(", ")
                : "No repository connected"
            }
            available={repositories.length > 0}
            expanded={selectedSource === "repositories"}
            onClick={() =>
              setSelectedSource(selectedSource === "repositories" ? null : "repositories")
            }
          />
          <ContextSourceCard
            icon="documents"
            title="Documents"
            description={`${documents.length} ${documents.length === 1 ? "file" : "files"}`}
            expanded={selectedSource === "documents"}
            onClick={() => setSelectedSource(selectedSource === "documents" ? null : "documents")}
          />
          <ContextSourceCard
            icon="intent"
            title="Original Intent"
            description={hasIntent ? "Defined" : "Not saved yet"}
            available={hasIntent}
            onClick={onOpenIntent}
          />
        </div>
      )}
      {!loading && selectedSource === "repositories" && (
        <div className="orbit-detail-card context-source-details">
          <h3>Connected repositories</h3>
          {repositories.length ? (
            repositories.map((repository) => (
              <p key={repository.id}>
                <a href={repository.html_url} target="_blank" rel="noreferrer">
                  {repository.full_name} ↗
                </a>
              </p>
            ))
          ) : (
            <p>
              No repository is connected. You can generate a proposal from the available intent and
              documents.
            </p>
          )}
        </div>
      )}
      {!latest && !loading && (
        <ProjectContextEmptyState
          repositories={repositories}
          documentCount={documents.length}
          onOpenIntent={onOpenIntent}
          generating={generating}
          disabled={!hasLoaded}
          onGenerate={() => {
            void generateSummary();
          }}
        />
      )}
      {snapshots.length > 0 && (
        <div className="orbit-detail-card">
          <h3>Context version history</h3>
          <p className="orbit-detail-muted">
            {approved ? `Approved: v${approved.revision}` : "No approved context yet"}
          </p>
          <label htmlFor="knowledge-version">Select knowledge version</label>
          <select
            id="knowledge-version"
            value={latest?.id ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {snapshots.map((item) => (
              <option key={item.id} value={item.id}>
                v{item.revision} · {item.review_status ?? "PROPOSED"}
              </option>
            ))}
          </select>
        </div>
      )}
      {latest && (
        <div className="orbit-detail-card">
          <span className="orbit-detail-eyebrow">KNOWLEDGE VERSION {latest.revision}</span>
          <p className="orbit-detail-muted">
            Review: {latest.review_status ?? "PROPOSED"}
            {latest.review_note ? ` · Feedback: ${latest.review_note}` : ""}
          </p>
          {(!latest.review_status || latest.review_status === "PROPOSED") && (
            <div className="orbit-detail-card">
              <h3>Review this context proposal</h3>
              <label htmlFor="knowledge-review-note">Review feedback</label>
              <textarea
                id="knowledge-review-note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder="Optional approval note, or required feedback for changes"
                rows={3}
              />
              <button type="button" disabled={reviewing} onClick={() => void review("approve")}>
                Approve version {latest.revision}
              </button>
              <button
                type="button"
                disabled={reviewing || !reviewNote.trim()}
                onClick={() => void review("request_changes")}
              >
                Request changes
              </button>
            </div>
          )}
          <h3>AI Project Summary</h3>
          <p>{latest.content.summary.summary}</p>
          <h4>Architecture</h4>
          <p>{latest.content.summary.architecture}</p>
          <h4>Key features</h4>
          <ul>
            {latest.content.summary.features.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <h4>Constraints</h4>
          <ul>
            {latest.content.summary.constraints.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <h4>Unknowns</h4>
          <ul>
            {latest.content.summary.unknowns.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          {changes && (
            <div className="orbit-detail-card">
              <h3>
                Changes{" "}
                {comparisonBase
                  ? `since approved v${comparisonBase.revision}`
                  : "in initial context"}
              </h3>
              <p className="orbit-detail-muted">
                {changes.summaryChanged ? "Project summary changed. " : ""}
                {changes.architectureChanged ? "Architecture description changed." : ""}
              </p>
              {(
                [
                  ["Added features", changes.addedFeatures],
                  ["Removed features", changes.removedFeatures],
                  ["Added constraints", changes.addedConstraints],
                  ["Removed constraints", changes.removedConstraints],
                  ["New unknowns", changes.addedUnknowns],
                  ["Resolved unknowns", changes.resolvedUnknowns],
                  ["Repository revisions", changes.changedRepositories],
                  ["Document revisions", changes.changedDocuments],
                ] as const
              ).map(([heading, entries]) =>
                entries.length ? (
                  <div key={heading}>
                    <h4>{heading}</h4>
                    <ul>
                      {entries.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              {!changes.summaryChanged &&
                !changes.architectureChanged &&
                !changes.addedFeatures.length &&
                !changes.removedFeatures.length &&
                !changes.addedConstraints.length &&
                !changes.removedConstraints.length &&
                !changes.addedUnknowns.length &&
                !changes.resolvedUnknowns.length &&
                !changes.changedRepositories.length &&
                !changes.changedDocuments.length && (
                  <p>No material differences detected in the recorded knowledge fields.</p>
                )}
            </div>
          )}
          <h3>Repository evidence</h3>
          {latest.content.repositories.map((repository) => (
            <div className="orbit-detail-card" key={repository.fullName}>
              <strong>{repository.fullName}</strong>
              {repository.summary ? (
                <p>{repository.summary.summary}</p>
              ) : (
                <p>No accessible repository evidence was found.</p>
              )}
              {repository.commitSha && (
                <p className="orbit-detail-muted">
                  Source revision: {repository.commitSha.slice(0, 12)} ·{" "}
                  {repository.truncated ? "Representative sample" : "Available source tree"}
                </p>
              )}
              {repository.inspected.length > 0 && (
                <div>
                  <h4>Inspected files ({repository.inspected.length})</h4>
                  <ul>
                    {repository.inspected.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
          <h3>Document summaries</h3>
          {latest.content.documents.map((document) => (
            <div className="orbit-detail-card" key={document.id}>
              <strong>
                {document.filename} (v{document.version})
              </strong>
              <p>{document.summary.summary}</p>
            </div>
          ))}
        </div>
      )}
      {snapshots.length > 1 && (
        <p>
          Earlier context versions:{" "}
          {snapshots
            .slice(1)
            .map((item) => `v${item.revision}`)
            .join(", ")}
        </p>
      )}
      {!loading &&
        !error &&
        (Boolean(latest) || selectedSource === "documents") &&
        documents.length === 0 && (
          <div className="orbit-detail-card">
            <h3>No supporting documents yet</h3>
            <p>Add documents when submitting your original Intent. They will appear here.</p>
          </div>
        )}
      {!loading &&
        !error &&
        (Boolean(latest) || selectedSource === "documents") &&
        documents.length > 0 && (
          <div className="orbit-detail-card">
            <h3>Supporting documents ({documents.length})</h3>
            <div className="orbit-nested-stage">
              {documents.map((document) => (
                <div className="orbit-detail-card" key={document.id}>
                  <strong>{document.original_filename}</strong>
                  <p className="orbit-detail-muted">
                    {document.media_type} · {Math.ceil(document.size_bytes / 1024)} KB · Version{" "}
                    {document.version}
                  </p>
                  <p className="orbit-detail-muted">
                    Processing: {document.processing_status} · Uploaded{" "}
                    {new Date(document.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      {latest && (
        <p className="orbit-detail-muted">
          Document excerpts are used for Muse planning. Knowledge snapshots are generated on demand;
          repository analysis samples accessible manifests and README files, not the entire source
          tree.
        </p>
      )}
    </section>
  );
}
