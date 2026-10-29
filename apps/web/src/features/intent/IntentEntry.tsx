import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PlanReview } from "../planning/PlanReview.js";
import type { CreatedProject, ConnectedRepository } from "../projects/project-api.js";
import type { ProjectIntentApi, ProjectPlan, StoredIntent } from "./intent-api.js";
import "./intent-entry.css";

interface IntentEntryProps {
  readonly project: CreatedProject;
  readonly api: ProjectIntentApi;
  readonly onBack: () => void;
}

type Phase = "loading" | "ready" | "saving" | "planning" | "error";

export function IntentEntry({ project, api, onBack }: IntentEntryProps) {
  const [statement, setStatement] = useState("");
  const [intent, setIntent] = useState<StoredIntent | null>(null);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const busy = phase === "loading" || phase === "saving" || phase === "planning";

  const refresh = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const [savedIntent, savedPlan] = await Promise.all([
        api.getIntent(project.id),
        api.getPlan(project.id),
      ]);
      setIntent(savedIntent);
      setPlan(savedPlan);
      if (savedIntent) setStatement(savedIntent.statement);
      setPhase("ready");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load project intent.");
      setPhase("error");
    }
  }, [api, project.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.getIntent(project.id),
      api.getPlan(project.id),
      api.getRepositories(project.id),
    ]).then((results) => {
      if (cancelled) return;
      const [intentResult, planResult, repositoryResult] = results;
      if (!intentResult || intentResult.status === "rejected") {
        setPhase("error");
        setError("Could not load project intent. Retry to continue.");
        return;
      }
      if (!planResult || planResult.status === "rejected") {
        setPhase("error");
        setError("Could not load the planning state. Retry to continue.");
        return;
      }
      setIntent(intentResult.value);
      if (intentResult.value) setStatement(intentResult.value.statement);
      setPlan(planResult.value);
      if (repositoryResult?.status === "fulfilled") {
        setRepositories(repositoryResult.value);
      } else {
        setRepositoryError(true);
      }
      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [api, project.id]);

  async function generate() {
    setPhase("planning");
    setError(null);
    try {
      const result = await api.generatePlan(project.id);
      setPlan(result);
      setPhase("ready");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Planning failed. Try again.");
      setPhase("error");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || intent) return;
    const text = statement.trim();
    if (!text || text.length > 10_000) {
      setError("Describe what you want to build (up to 10,000 characters).");
      return;
    }
    setPhase("saving");
    setError(null);
    try {
      const saved = await api.submitIntent(project.id, text);
      setIntent(saved);
      setStatement(saved.statement);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save intent. Try again.");
      setPhase("error");
      return;
    }
    await generate();
  }

  const proposed = plan?.status === "READY_FOR_REVIEW" || plan?.status === "APPROVED";
  if (reviewOpen && plan && proposed) {
    return (
      <PlanReview
        project={project}
        originalIntent={intent}
        plan={plan}
        api={api}
        onBack={() => setReviewOpen(false)}
        onUpdated={setPlan}
      />
    );
  }
  return (
    <main className="intent-page">
      <section className="intent-panel" aria-labelledby="intent-heading">
        <div className="intent-topline">
          <span className="eyebrow">ORBIT / {project.name}</span>
          <button type="button" onClick={onBack} className="intent-back">
            Back to Orbit
          </button>
        </div>
        <p className="intent-overline">STEP 01 · PRODUCT INTENT</p>
        <h1 id="intent-heading">What do you want to build?</h1>
        <p className="intent-description">
          Describe the outcome you want. Orbit will propose work items, workflows, dependencies, and
          approval points for you to review before any execution begins.
        </p>

        {phase === "loading" ? (
          <p role="status" className="intent-muted">
            Loading your project…
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            className="intent-composer"
          >
            <label htmlFor="orbit-intent-statement">Your original intent</label>
            <textarea
              id="orbit-intent-statement"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              readOnly={Boolean(intent)}
              disabled={busy || Boolean(intent)}
              rows={7}
              maxLength={10_000}
              required
              placeholder="Build a React application that fetches Hacker News job postings and displays them in a responsive list…"
            />
            <p className="intent-hint">
              {intent
                ? "Original intent saved. It is preserved as the historical source of truth."
                : "Include your users, desired behavior, and important constraints. Voice capture with Muse Voice is coming next."}
            </p>
            {error && (
              <p role="alert" className="intent-error">
                {error}
              </p>
            )}
            {intent && !error && (
              <p role="status" className="intent-confirmed">
                Original intent saved. Your words will not be overwritten by planning.
              </p>
            )}
            <div className="intent-actions">
              {!intent && (
                <button type="submit" className="cta-primary" disabled={busy || !statement.trim()}>
                  {phase === "saving" ? "Saving intent…" : "Save intent & propose plan"}
                </button>
              )}
              {intent && !proposed && plan?.status !== "GENERATING" && (
                <button
                  type="button"
                  className="cta-primary"
                  onClick={() => {
                    void generate();
                  }}
                  disabled={busy}
                >
                  {phase === "planning" ? "Muse Spark is planning…" : "Generate or retry plan"}
                </button>
              )}
              {phase === "error" && !intent && (
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Reload project state
                </button>
              )}
              {plan?.status === "GENERATING" && (
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                  }}
                  disabled={busy}
                >
                  Check planning status
                </button>
              )}
            </div>
          </form>
        )}

        {phase === "planning" && (
          <p role="status" className="intent-muted">
            Muse Spark is generating a proposed work graph. No agents are running.
          </p>
        )}
        {proposed && (
          <div className="intent-next" role="status">
            <strong>{plan.status === "APPROVED" ? "Plan approved" : "Proposed plan ready"}</strong>
            <p>
              {plan.status === "APPROVED"
                ? "Your plan is approved. Execution is not started automatically."
                : "Muse Spark returned a proposal. The Plan Review experience is the next step; no work has started."}
            </p>
            <button type="button" className="cta-primary" onClick={() => setReviewOpen(true)}>
              {plan.status === "APPROVED" ? "View approved plan" : "Review proposed plan"}
            </button>
          </div>
        )}

        <aside className="intent-repository" aria-label="Connected repositories">
          <h2>Repository</h2>
          {repositories.length ? (
            <ul>
              {repositories.map((repository) => (
                <li key={repository.id}>
                  <a href={repository.html_url} target="_blank" rel="noreferrer">
                    {repository.full_name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {repositoryError ? "Repository summary unavailable." : "No repository connected yet."}
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
