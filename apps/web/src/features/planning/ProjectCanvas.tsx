import { useCallback, useEffect, useState } from "react";
import type { CreatedProject } from "../projects/project-api.js";
import type { ProjectIntentApi, ProjectPlan, StoredIntent } from "../intent/intent-api.js";
import { PlanReview } from "./PlanReview.js";

export function ProjectCanvas({
  project,
  api,
  onBack,
}: {
  project: CreatedProject;
  api: ProjectIntentApi;
  onBack: () => void;
}) {
  const [intent, setIntent] = useState<StoredIntent | null>(null);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [savedIntent, currentPlan] = await Promise.all([
        api.getIntent(project.id),
        api.getPlan(project.id),
      ]);
      setIntent(savedIntent);
      setPlan(currentPlan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load project workspace.");
    } finally {
      setLoading(false);
    }
  }, [api, project.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (error)
    return (
      <main className="orbit-detail-page orbit-detail-page--canvas">
        <p role="alert" className="intent-error">{error}</p>
        <button type="button" onClick={() => void refresh()}>Retry</button>
        <button type="button" onClick={onBack}>Back to projects</button>
      </main>
    );
  return (
    <PlanReview
      project={project}
      originalIntent={intent}
      plan={plan}
      isLoading={loading}
      api={api}
      onBack={onBack}
      onUpdated={setPlan}
    />
  );
}
