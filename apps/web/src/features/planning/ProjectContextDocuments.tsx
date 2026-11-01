import { useEffect, useState } from "react";
import type { ProjectIntentApi, ProjectKnowledgeSnapshot } from "../intent/intent-api.js";

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
}: {
  readonly api: ProjectIntentApi;
  readonly projectId: string;
}) {
  const [snapshots, setSnapshots] = useState<readonly ProjectKnowledgeSnapshot[]>([]);
  const [generating, setGenerating] = useState(false);
  const [documents, setDocuments] = useState<readonly DocumentMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([api.getProjectDocuments(projectId), api.getProjectKnowledge(projectId)])
      .then(([items, history]) => {
        if (active) {
          setDocuments(items);
          setSnapshots(history);
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not summarize project.");
    } finally {
      setGenerating(false);
    }
  }
  const latest = snapshots[0];
  return (
    <section
      className="orbit-detail-page orbit-detail-page--canvas"
      aria-labelledby="project-context-heading"
    >
      <div className="orbit-detail-heading">
        <div>
          <span className="orbit-detail-eyebrow">PROJECT / KNOWLEDGE</span>
          <h2 id="project-context-heading">Project Context</h2>
          <p>
            Versioned understanding of your project, grounded in documents and repository evidence.
          </p>
        </div>
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
        <button
          type="button"
          className="orbit-detail-back"
          onClick={() => setRefreshCount((count) => count + 1)}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      {loading && <p role="status">Loading project documents…</p>}
      {error && (
        <p className="intent-error" role="alert">
          {error}
        </p>
      )}
      {latest && (
        <div className="orbit-detail-card">
          <span className="orbit-detail-eyebrow">KNOWLEDGE VERSION {latest.revision}</span>
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
      {!latest && !loading && (
        <p>Generate the first snapshot to see what Muse understands about your project.</p>
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
      {!loading && !error && documents.length === 0 && (
        <div className="orbit-detail-card">
          <h3>No supporting documents yet</h3>
          <p>Add documents when submitting your original Intent. They will appear here.</p>
        </div>
      )}
      {!loading && !error && documents.length > 0 && (
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
      <p className="orbit-detail-muted">
        Document excerpts are used for Muse planning. Knowledge snapshots are generated on demand;
        repository analysis samples accessible manifests and README files, not the entire source
        tree.
      </p>
    </section>
  );
}
