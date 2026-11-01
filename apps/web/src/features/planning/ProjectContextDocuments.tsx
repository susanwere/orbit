import { useEffect, useState } from "react";
import type { ProjectIntentApi } from "../intent/intent-api.js";

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
  const [documents, setDocuments] = useState<readonly DocumentMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api.getProjectDocuments(projectId)
      .then((items) => { if (active) setDocuments(items); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load documents.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, projectId, refreshCount]);

  return (
    <section className="orbit-detail-page orbit-detail-page--canvas" aria-labelledby="project-context-heading">
      <div className="orbit-detail-heading">
        <div>
          <span className="orbit-detail-eyebrow">PROJECT / KNOWLEDGE</span>
          <h2 id="project-context-heading">Project Context</h2>
          <p>Supporting documents saved with your project. Original files and intent references remain immutable.</p>
        </div>
        <button type="button" className="orbit-detail-back" onClick={() => setRefreshCount((count) => count + 1)} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading && <p role="status">Loading project documents…</p>}
      {error && <p className="intent-error" role="alert">{error}</p>}
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
                  {document.media_type} · {Math.ceil(document.size_bytes / 1024)} KB · Version {document.version}
                </p>
                <p className="orbit-detail-muted">
                  Processing: {document.processing_status} · Uploaded {new Date(document.created_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="orbit-detail-muted">
        Document text extraction, secure downloads and automatic Muse planning context are not yet enabled.
      </p>
    </section>
  );
}
