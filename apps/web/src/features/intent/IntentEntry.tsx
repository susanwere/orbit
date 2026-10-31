import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PlanReview } from "../planning/PlanReview.js";
import type { CreatedProject, ConnectedRepository } from "../projects/project-api.js";
import type {
  ProjectIntentApi,
  ProjectPlan,
  StoredIntent,
  ExecutionStep,
  MuseJobStatus,
} from "./intent-api.js";
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
  const [executionPreparing, setExecutionPreparing] = useState(false);
  const [executionSummary, setExecutionSummary] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionSteps, setExecutionSteps] = useState<readonly ExecutionStep[]>([]);
  const [executionLoaded, setExecutionLoaded] = useState(false);
  const [stepActionPending, setStepActionPending] = useState<string | null>(null);
  const [museJobs, setMuseJobs] = useState<Record<string, MuseJobStatus | null>>({});
  const [githubRunId, setGithubRunId] = useState("");
  const [agentDefinitionId, setAgentDefinitionId] = useState("");
  const [pendingSessionIds, setPendingSessionIds] = useState<Record<string, string>>({});
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
      if (planResult.value?.status === "APPROVED") {
        void api
          .getExecutionSteps(project.id)
          .then((steps) => {
            if (!cancelled) {
              setExecutionSteps(steps);
              setExecutionLoaded(true);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setExecutionError("Could not load execution status. Refresh to retry.");
            }
          });
      }
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

  async function loadExecutionSteps() {
    setExecutionError(null);
    try {
      setExecutionSteps(await api.getExecutionSteps(project.id));
      setExecutionLoaded(true);
    } catch (failure) {
      setExecutionError(
        failure instanceof Error ? failure.message : "Could not load execution status.",
      );
    }
  }

  async function actOnStep(
    step: ExecutionStep,
    action: "approve" | "retry" | "start" | "dispatch" | "job" | "create",
  ) {
    if (stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      if (action === "approve") {
        await api.approveExecutionStep(project.id, step.id);
      } else if (action === "retry") {
        await api.authorizeExecutionRetry(project.id, step.id);
      } else if (action === "create" && plan) {
        if (!agentDefinitionId.trim()) {
          throw new Error("Provide the ID of an approved Muse coding agent definition.");
        }
        let sessionId = pendingSessionIds[step.id];
        if (!sessionId) {
          const graph = plan.content as {
            workItems?: {
              key: string;
              title: string;
              description: string;
              workflows: { steps: { title: string }[] }[];
            }[];
          } | null;
          const workItem = graph?.workItems?.find((item) => item.key === step.work_item_key);
          const stepTitle =
            workItem?.workflows?.[step.workflow_index]?.steps?.[step.step_index]?.title;
          const mission = [
            workItem?.title ?? step.work_item_key,
            workItem?.description ?? "Implement the approved work item.",
            stepTitle ? `Approved step: ${stepTitle}` : "",
            "Follow the approved execution contract and human gates.",
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000);
          sessionId = await api.createAgentSession(
            project.id,
            agentDefinitionId.trim(),
            `work:${plan.id}:${step.work_item_key}`,
            mission,
          );
          setPendingSessionIds((current) => ({ ...current, [step.id]: sessionId! }));
        }
        await api.bindExecutionSession(project.id, step.id, sessionId);
        setPendingSessionIds((current) => {
          const updated = { ...current };
          delete updated[step.id];
          return updated;
        });
      } else if (step.agent_session_id) {
        if (action === "start") await api.startAgentSession(project.id, step.agent_session_id);
        if (action === "dispatch") await api.dispatchMuse(project.id, step.agent_session_id);
        const job = await api.getMuseJob(project.id, step.agent_session_id);
        setMuseJobs((current) => ({ ...current, [step.agent_session_id!]: job }));
      }
      setExecutionSteps(await api.getExecutionSteps(project.id));
    } catch (failure) {
      setExecutionError(failure instanceof Error ? failure.message : "Step action failed.");
    } finally {
      setStepActionPending(null);
    }
  }

  async function verifyCi(step: ExecutionStep) {
    const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
    const runId = Number(githubRunId);
    if (
      !job?.github_repository ||
      !job.github_pull_number ||
      !Number.isSafeInteger(runId) ||
      runId <= 0
    ) {
      setExecutionError("Enter a valid GitHub Actions run ID for the delivered pull request.");
      return;
    }
    if (stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      await api.verifyGithubCi(
        project.id,
        step.id,
        job.github_repository,
        runId,
        job.github_pull_number,
      );
      setExecutionSteps(await api.getExecutionSteps(project.id));
    } catch (failure) {
      setExecutionError(failure instanceof Error ? failure.message : "CI verification failed.");
    } finally {
      setStepActionPending(null);
    }
  }

  async function prepareExecution() {
    if (plan?.status !== "APPROVED" || executionPreparing) return;
    setExecutionPreparing(true);
    setExecutionError(null);
    try {
      await api.prepareExecution(project.id);
      const steps = await api.getExecutionSteps(project.id);
      setExecutionSteps(steps);
      setExecutionLoaded(true);
      const blocked = steps.filter((step) => step.blocker_reason !== null);
      setExecutionSummary(
        `Prepared ${steps.length} execution steps. ${blocked.length} have blockers. No agents have started.`,
      );
    } catch (failure) {
      // An existing execution may already be prepared. Never retry silently.
      setExecutionError(
        failure instanceof Error ? failure.message : "Could not prepare execution.",
      );
    } finally {
      setExecutionPreparing(false);
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
            {plan.status === "APPROVED" && (
              <div className="execution-dashboard" role="region" aria-label="Execution dashboard">
                <strong>Workflow execution</strong>
                <p role="status">
                  {executionSteps.length
                    ? `${executionSteps.filter((step) => step.state === "COMPLETED").length} of ${executionSteps.length} steps completed`
                    : executionLoaded
                      ? "No execution prepared"
                      : "Loading execution status…"}
                </p>
                <p>
                  Prepare, authorize and dispatch work below. No agent runs without explicit
                  approval.
                </p>
                <button
                  type="button"
                  onClick={() => void loadExecutionSteps()}
                  disabled={Boolean(stepActionPending)}
                >
                  Refresh status
                </button>
              </div>
            )}
            {plan.status === "APPROVED" && executionLoaded && executionSteps.length === 0 && (
              <button
                type="button"
                className="cta-primary"
                onClick={() => void prepareExecution()}
                disabled={executionPreparing || Boolean(executionSummary)}
              >
                {executionPreparing ? "Preparing execution…" : "Prepare execution"}
              </button>
            )}
            {plan.status === "APPROVED" && (
              <section id="orbit-execution-steps" aria-label="Execution step review">
                <h3>Execution steps</h3>
                <p>
                  Review real backend statuses and approve only the required human gates. Approval
                  does not start an agent.
                </p>
                <button
                  type="button"
                  onClick={() => void loadExecutionSteps()}
                  disabled={Boolean(stepActionPending)}
                >
                  Refresh execution status
                </button>
                {executionSteps.some((step) => !step.agent_session_id) && (
                  <div>
                    <label htmlFor="orbit-agent-definition">
                      Approved Muse agent definition ID
                    </label>
                    <input
                      id="orbit-agent-definition"
                      value={agentDefinitionId}
                      onChange={(event) => setAgentDefinitionId(event.target.value)}
                      placeholder="Approved coding agent ID"
                    />
                    <p>
                      Sessions are created for your account with the approved agent's existing
                      repository and path permissions.
                    </p>
                  </div>
                )}
                {executionSteps.length > 0 && (
                  <ol>
                    {executionSteps.map((step) => (
                      <li key={step.id}>
                        <strong>
                          {step.work_item_key} · Workflow {step.workflow_index + 1}, Step{" "}
                          {step.step_index + 1}
                        </strong>
                        {" · "}
                        {step.state}
                        {step.blocker_reason && <span> · Blocked: {step.blocker_reason}</span>}
                        {step.approval_required &&
                          !step.approved_at &&
                          step.state === "BLOCKED" && (
                            <button
                              type="button"
                              disabled={Boolean(stepActionPending)}
                              onClick={() => void actOnStep(step, "approve")}
                            >
                              {stepActionPending === step.id ? "Approving…" : "Approve step"}
                            </button>
                          )}
                        {!step.agent_session_id &&
                          step.state === "BLOCKED" &&
                          step.blocker_reason !== "prerequisite_incomplete" &&
                          step.blocker_reason !== "human_approval_required" && (
                            <button
                              type="button"
                              disabled={Boolean(stepActionPending) || !agentDefinitionId.trim()}
                              onClick={() => void actOnStep(step, "create")}
                            >
                              {pendingSessionIds[step.id]
                                ? "Retry binding created session"
                                : "Create & bind agent session"}
                            </button>
                          )}
                        {step.agent_session_id &&
                          step.blocker_reason === null &&
                          (step.state === "READY" || step.state === "BLOCKED") && (
                            <button
                              type="button"
                              disabled={Boolean(stepActionPending)}
                              onClick={() => void actOnStep(step, "start")}
                            >
                              Start authorized session
                            </button>
                          )}
                        {step.agent_session_id && step.state === "RUNNING" && (
                          <button
                            type="button"
                            disabled={Boolean(stepActionPending)}
                            onClick={() => void actOnStep(step, "dispatch")}
                          >
                            Queue Muse Code
                          </button>
                        )}
                        {step.agent_session_id && (
                          <button
                            type="button"
                            disabled={Boolean(stepActionPending)}
                            onClick={() => void actOnStep(step, "job")}
                          >
                            Check Muse job
                          </button>
                        )}
                        {step.agent_session_id && museJobs[step.agent_session_id] && (
                          <p role="status">
                            Muse job: {museJobs[step.agent_session_id]?.status}
                            {museJobs[step.agent_session_id]?.github_pull_number
                              ? ` · PR #${museJobs[step.agent_session_id]?.github_pull_number}`
                              : ""}
                            {museJobs[step.agent_session_id]?.failure_reason
                              ? ` · ${museJobs[step.agent_session_id]?.failure_reason}`
                              : ""}
                          </p>
                        )}
                        {step.agent_session_id &&
                          museJobs[step.agent_session_id]?.github_pull_number &&
                          museJobs[step.agent_session_id]?.github_repository && (
                            <div>
                              <a
                                href={`https://github.com/${museJobs[step.agent_session_id]?.github_repository}/pull/${museJobs[step.agent_session_id]?.github_pull_number}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Review generated pull request
                              </a>
                              <label htmlFor={`github-run-${step.id}`}>GitHub Actions run ID</label>
                              <input
                                id={`github-run-${step.id}`}
                                type="number"
                                min="1"
                                step="1"
                                value={githubRunId}
                                onChange={(event) => setGithubRunId(event.target.value)}
                                placeholder="From the Actions run URL"
                              />
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending) || !githubRunId.trim()}
                                onClick={() => void verifyCi(step)}
                              >
                                Verify GitHub CI
                              </button>
                            </div>
                          )}
                        {step.state === "FAILED" && (
                          <button
                            type="button"
                            disabled={Boolean(stepActionPending)}
                            onClick={() => void actOnStep(step, "retry")}
                          >
                            {stepActionPending === step.id
                              ? "Authorizing…"
                              : "Acknowledge failure & authorize retry"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            {executionSummary && <p role="status">{executionSummary}</p>}
            {executionError && (
              <p role="alert" className="intent-error">
                {executionError}
              </p>
            )}
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
