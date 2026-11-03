import { ExecutionSummary } from "./ExecutionSummary.js";
import { ExecutionOutcomeNotice } from "./ExecutionOutcomeNotice.js";
import { workItemExecutionStatus } from "./work-item-execution.js";
import { isReadyForReview } from "./work-item-status.js";
import type { ConnectedRepository } from "../projects/project-api.js";
import { ExecutionActivityLog } from "./ExecutionActivityLog.js";
import { useState } from "react";
import type { ExecutionStep, MuseJobStatus, ProjectTask } from "../intent/intent-api.js";
import { canExecuteCanvasTask } from "./canvas-task-execution.js";
import { MuseAttemptDetails } from "../intent/MuseAttemptDetails.js";
import "./step-execution-details.css";
import "./execution-actions.css";

function formatExecutionTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "Not recorded";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}
function evidenceUrl(address: string | null | undefined): string | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function WorkItemExecutionDetails({
  projectRepositories = [],
  repositoriesLoading = false,
  repositoriesFailed = false,
  workItemTitle,
  dependencyTitles = [],
  executor,
  executionStep,
  job,
  task,
  approved,
  onExecute,
  isExecuting = false,
  onOpenExecution,
}: {
  readonly projectRepositories?: readonly ConnectedRepository[];
  readonly repositoriesLoading?: boolean;
  readonly repositoriesFailed?: boolean;
  readonly workItemTitle: string;
  readonly dependencyTitles?: readonly string[];
  readonly executor: string;
  readonly executionStep?: ExecutionStep;
  readonly job?: MuseJobStatus | null;
  readonly task?: ProjectTask;
  readonly approved: boolean;
  readonly onExecute?: () => void;
  readonly isExecuting?: boolean;
  readonly onOpenExecution: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"log" | "prompt">("log");
  const canExecute = Boolean(
    approved &&
      task &&
      canExecuteCanvasTask(task) &&
      onExecute &&
      executor === "agent" &&
      (!executionStep || ["READY", "BLOCKED", "FAILED"].includes(executionStep.state)),
  );
  const readyForReview = isReadyForReview(executionStep, job);
  const status = workItemExecutionStatus(approved, task, executionStep, job);
  const completed = executionStep?.state === "COMPLETED";
  const failed =
    executionStep?.state === "FAILED" ||
    job?.status === "FAILED" ||
    job?.local_execution_state === "ERROR";
  const repositoryUrl = job?.github_repository
    ? `https://github.com/${job.github_repository}`
    : undefined;
  const pullRequestUrl =
    repositoryUrl && job?.github_pull_number
      ? `${repositoryUrl}/pull/${job.github_pull_number}`
      : undefined;
  const ciUrl = evidenceUrl(job?.github_ci_url);
  const progress = [
    { title: "Plan", detail: approved ? "Approved" : "Awaiting approval", complete: approved },
    {
      title: "Execute",
      detail: job?.status ?? "Not started",
      complete: job?.status === "TURN_FINISHED" || completed,
    },
    {
      title: "Verify",
      detail: job?.github_ci_state ?? "No CI evidence",
      complete: job?.github_ci_state === "PASSED",
    },
    {
      title: "Complete",
      detail: completed
        ? "Work item finished"
        : readyForReview
          ? "Awaiting your review & merge"
          : "Awaiting completion",
      complete: completed,
    },
  ];
  return (
    <div className="step-execution-page">
      <div className="step-execution-breadcrumb">
        <span>Work item execution</span>
        <span className="step-execution-badge" data-state={status}>
          {status.replaceAll("_", " ")}
        </span>
        {canExecute && (
          <button
            type="button"
            className="workflow-execute step-execution-start"
            disabled={isExecuting}
            onClick={onExecute}
          >
            <span aria-hidden="true">▶</span> {isExecuting ? "Starting…" : "Execute"}
          </button>
        )}
      </div>
      <ExecutionOutcomeNotice step={executionStep} job={job} />
      <dl className="step-execution-meta">
        <div>
          <dt>Work item</dt>
          <dd>{workItemTitle}</dd>
        </div>
        <div>
          <dt>Executor</dt>
          <dd>{executor === "agent" ? "Muse Code" : executor}</dd>
        </div>
        <div>
          <dt>{projectRepositories.length > 1 ? "Project repositories" : "Project repository"}</dt>
          <dd>
            {repositoriesLoading
              ? "Loading repositories…"
              : repositoriesFailed
                ? "Could not load project repositories"
                : projectRepositories.length
                  ? projectRepositories.map((repository) => (
                      <a
                        className="step-project-repository"
                        key={repository.id}
                        href={`https://github.com/${repository.full_name}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {repository.full_name} ↗
                      </a>
                    ))
                  : "No connected repository"}
          </dd>
        </div>
      </dl>
      <div className="step-execution-columns">
        <div className="step-execution-column">
          <section className="step-execution-panel" aria-label="Execution progress">
            <h3>Execution progress</h3>
            <ol className="step-execution-progress">
              {progress.map((stage) => (
                <li key={stage.title} data-complete={stage.complete}>
                  <span aria-hidden="true">{stage.complete ? "✓" : "○"}</span>
                  <strong>{stage.title}</strong>
                  <small>{stage.detail.replaceAll("_", " ")}</small>
                </li>
              ))}
            </ol>
          </section>
          <section className="step-execution-panel" aria-label="Execution summary">
            <h3>Execution summary</h3>
            <h4>
              {completed
                ? "Work item completed successfully"
                : readyForReview
                  ? "Pull request ready for review"
                  : failed
                    ? "Execution needs attention"
                    : executionStep?.state === "RUNNING"
                      ? "Execution in progress"
                      : "Waiting to execute"}
            </h4>
            {job?.review_output ? (
              <ExecutionSummary
                content={job.review_output}
                repository={job.github_repository}
                headSha={job.github_head_sha}
              />
            ) : (
              <p>
                {completed
                  ? "The execution service has recorded this work item as completed."
                  : "Execution output will appear when it is available."}
              </p>
            )}
            {(job?.failure_reason || job?.local_execution_error || job?.delivery_error) && (
              <p role="alert">
                {job.failure_reason ?? job.local_execution_error ?? job.delivery_error}
              </p>
            )}
            <div className="step-execution-cues">
              <span>
                {job?.changed_paths
                  ? `${job.changed_paths.length} changed files`
                  : "Changed files not available"}
              </span>
              <span>CI: {job?.github_ci_state ?? "Not available"}</span>
            </div>
            {executionStep && <MuseAttemptDetails step={executionStep} job={job} />}
          </section>
          <section className="step-execution-panel" aria-label="Execution activity">
            <div className="step-execution-tabs" role="tablist" aria-label="Execution information">
              <button
                type="button"
                role="tab"
                id="work-item-log-tab"
                aria-selected={activeTab === "log"}
                aria-controls="step-execution-information"
                onClick={() => setActiveTab("log")}
              >
                Execution log
              </button>
              <button
                type="button"
                role="tab"
                id="work-item-prompt-tab"
                aria-selected={activeTab === "prompt"}
                aria-controls="step-execution-information"
                onClick={() => setActiveTab("prompt")}
              >
                Prompt & context
              </button>
            </div>
            <div
              role="tabpanel"
              id="step-execution-information"
              aria-labelledby={activeTab === "log" ? "work-item-log-tab" : "work-item-prompt-tab"}
            >
              {activeTab === "log" ? (
                <ExecutionActivityLog job={job} step={executionStep} />
              ) : (
                <>
                  <h4>Work item prompt</h4>
                  <p className="step-execution-prose">
                    {task?.prompt ?? "No task prompt is available."}
                  </p>
                  {job?.context_snapshot_id && (
                    <p>
                      Context snapshot: <code>{job.context_snapshot_id}</code>
                    </p>
                  )}
                  <p className="step-execution-muted">
                    Execution uses the saved project context and approved work item.
                  </p>
                </>
              )}
            </div>
          </section>
        </div>
        <div className="step-execution-column">
          <section className="step-execution-panel">
            <h3>Work item details</h3>
            <dl className="step-execution-details">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="step-execution-badge" data-state={status}>
                    {status.replaceAll("_", " ")}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatExecutionTime(job?.started_at)}</dd>
              </div>
              <div>
                <dt>Muse run finished</dt>
                <dd>{formatExecutionTime(job?.finished_at)}</dd>
              </div>
              <div>
                <dt>Dependencies</dt>
                <dd>
                  {task?.blocked_by?.length
                    ? task.blocked_by.join(", ")
                    : dependencyTitles.length
                      ? dependencyTitles.join(", ")
                      : task?.dependency_keys?.length
                        ? task.dependency_keys.join(", ")
                        : "No recorded dependencies"}
                </dd>
              </div>
              <div>
                <dt>Plan approval</dt>
                <dd>{approved ? "Approved" : "Awaiting approval"}</dd>
              </div>
            </dl>
            {executionStep?.blocker_reason && (
              <p>{executionStep.blocker_reason.replaceAll("_", " ")}</p>
            )}
          </section>
          <section className="step-execution-panel">
            <h3>Artifacts & evidence</h3>
            <div className="step-execution-artifacts">
              {pullRequestUrl ? (
                <a href={pullRequestUrl} target="_blank" rel="noreferrer">
                  {job?.github_repository} · Pull request #{job?.github_pull_number} ↗
                </a>
              ) : (
                <p>No pull request recorded.</p>
              )}
              {ciUrl ? (
                <a href={ciUrl} target="_blank" rel="noreferrer">
                  GitHub CI · {job?.github_ci_state ?? "View checks"} ↗
                </a>
              ) : (
                <p>CI: {job?.github_ci_state ?? "No CI evidence recorded"}</p>
              )}
              {job?.github_ci_report?.summary && <p>{job.github_ci_report.summary}</p>}
              <details>
                <summary>Changed files ({job?.changed_paths?.length ?? 0})</summary>
                {job?.changed_paths?.length ? (
                  <ul>
                    {job.changed_paths.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No changed files reported.</p>
                )}
              </details>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
