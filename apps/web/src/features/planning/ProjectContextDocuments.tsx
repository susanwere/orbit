import type { KnowledgeGenerationActivity } from "@orbit/domain";
import { useEffect, useState } from "react";
import type { ProjectIntentApi, ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import "./project-context.css";
import type { ConnectedRepository } from "../projects/project-api.js";
import { ProjectContextEmptyState } from "./ProjectContextEmptyState.js";
import { ProjectContextReview } from "./ProjectContextReview.js";

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
  projectName,
  onOpenIntent,
}: {
  readonly api: ProjectIntentApi;
  readonly projectId: string;
  readonly projectName: string;
  readonly onOpenIntent: () => void;
}) {
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [hasIntent, setHasIntent] = useState(false);
  const [snapshots, setSnapshots] = useState<readonly ProjectKnowledgeSnapshot[]>([]);
  const [activity, setActivity] = useState<readonly KnowledgeGenerationActivity[]>([]);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setActivity([]);
    setGenerating(true);
    setError(null);
    try {
      const next = await api.refreshProjectKnowledge(projectId, (entry) =>
        setActivity((entries) => [...entries.slice(-99), entry]),
      );
      setSnapshots((items) => [next, ...items]);
      setSelectedId(next.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not summarize project.");
    } finally {
      setGenerating(false);
    }
  }
  const latest = snapshots.find((item) => item.id === selectedId) ?? snapshots[0];
  async function review(decision: "approve" | "request_changes", note: string): Promise<boolean> {
    if (!latest) return false;
    setReviewing(true);
    setError(null);
    try {
      const updated = await api.reviewProjectKnowledge(
        projectId,
        latest.id,
        latest.revision,
        decision,
        note,
      );
      setSnapshots((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review could not be saved.");
      return false;
    } finally {
      setReviewing(false);
    }
  }
  if (latest && !generating) {
    return (
      <ProjectContextReview
        key={latest.id}
        snapshot={latest}
        history={snapshots}
        projectName={projectName}
        hasIntent={hasIntent}
        error={error}
        loading={loading}
        reviewing={reviewing}
        onSelectVersion={setSelectedId}
        onRefresh={() => setRefreshCount((count) => count + 1)}
        onGenerate={() => {
          void generateSummary();
        }}
        onOpenIntent={onOpenIntent}
        onReview={review}
      />
    );
  }
  return (
    <section
      className="orbit-detail-page orbit-detail-page--canvas project-context-page project-context-page--initial"
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
        {error && (
          <button
            type="button"
            className="orbit-detail-back"
            onClick={() => setRefreshCount((count) => count + 1)}
            disabled={loading || generating}
          >
            ⟳ Refresh
          </button>
        )}
      </div>
      {loading && <p role="status">Loading project context…</p>}
      {error && (
        <p className="intent-error" role="alert">
          {error}
        </p>
      )}
      {!loading && (
        <ProjectContextEmptyState
          repositories={repositories}
          documentCount={documents.length}
          hasIntent={hasIntent}
          onOpenIntent={onOpenIntent}
          activity={activity}
          generating={generating}
          disabled={!hasLoaded}
          onGenerate={() => {
            void generateSummary();
          }}
        />
      )}
    </section>
  );
}
