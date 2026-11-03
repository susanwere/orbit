import { isReadyForReview } from "./work-item-status.js";
import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";
import "./project-context.css";
import "./execution-activity-log.css";

export function ExecutionActivityLog({
  job,
  step,
}: {
  readonly job?: MuseJobStatus | null;
  readonly step?: ExecutionStep;
}) {
  const activity = job?.activity ?? [];
  const failed =
    job?.status === "FAILED" || job?.local_execution_state === "ERROR" || step?.state === "FAILED";
  const museFinished = job?.status === "TURN_FINISHED";
  const readyForReview = isReadyForReview(step, job);
  const live =
    !readyForReview &&
    !failed &&
    step?.state !== "COMPLETED" &&
    step?.state !== "CANCELED" &&
    Boolean(
      job && (job.status === "QUEUED" || job.status === "RUNNING" || step?.state === "RUNNING"),
    );
  const stages = [
    {
      title: "Preparing execution",
      state: job?.started_at ? "ready" : failed ? "failed" : job ? "active" : "pending",
      detail: job?.started_at
        ? "Worker started the authorized job."
        : "Waiting for the execution worker.",
    },
    {
      title: "Running Muse Code",
      state: failed
        ? "failed"
        : museFinished
          ? "ready"
          : job?.status === "RUNNING"
            ? "active"
            : "pending",
      detail: failed
        ? "Execution needs attention."
        : museFinished
          ? "Muse finished its turn."
          : (activity.at(-1)?.message ?? "Waiting for Muse activity."),
    },
    {
      title: "Delivery & verification",
      state:
        step?.state === "COMPLETED" || readyForReview
          ? "ready"
          : job?.github_ci_state === "FAILED"
            ? "failed"
            : museFinished
              ? "active"
              : "pending",
      detail:
        step?.state === "COMPLETED"
          ? "Work item completion verified."
          : job?.github_ci_state
            ? `GitHub CI: ${job.github_ci_state}.`
            : "Awaiting independent verification.",
    },
    {
      title: "Review & merge",
      state: step?.state === "COMPLETED" ? "ready" : "pending",
      detail:
        step?.state === "COMPLETED"
          ? "Pull request merged and evidence verified."
          : readyForReview
            ? "Ready for your review. Waiting for you to merge the pull request."
            : "Available after CI passes.",
    },
  ];
  return (
    <div className="execution-activity-card">
      <div className="execution-activity-heading">
        <h4>Execution activity</h4>
        <span className="context-generation-badge">
          {live
            ? "Live · updates every 2s"
            : readyForReview
              ? "Ready for review"
              : failed
                ? "Needs attention"
                : step?.state === "COMPLETED"
                  ? "Completed"
                  : "Recorded activity"}
        </span>
      </div>
      <ol className="context-generation-steps" aria-label="Execution progress stages">
        {stages.map((stage) => (
          <li key={stage.title} data-state={stage.state}>
            <span className="context-generation-marker" aria-hidden="true">
              {stage.state === "ready" ? (
                "✓"
              ) : stage.state === "failed" ? (
                "!"
              ) : stage.state === "active" ? (
                <i />
              ) : null}
            </span>
            <div>
              <strong>{stage.title}</strong>
              <p>{stage.detail}</p>
            </div>
            <span className="context-generation-badge">
              {stage.state === "ready"
                ? "Completed"
                : stage.state === "failed"
                  ? "Needs attention"
                  : stage.state === "active"
                    ? "In progress"
                    : "Pending"}
            </span>
          </li>
        ))}
      </ol>
      {live && (
        <div
          className="context-generation-progress"
          role="progressbar"
          aria-label="Execution in progress"
          aria-valuetext="In progress"
        >
          <span />
        </div>
      )}
      <details className="context-activity-log" open>
        <summary>Activity log{activity.length ? ` · ${activity.length} events` : ""}</summary>
        {activity.length ? (
          <ol aria-label="Muse execution activity">
            {activity.map((entry) => (
              <li key={entry.id} data-status={entry.status}>
                <time dateTime={entry.occurredAt}>
                  {new Date(entry.occurredAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            {live
              ? "Waiting for activity from the execution worker…"
              : job
                ? "Detailed activity was not recorded for this run."
                : "No execution activity recorded yet."}
          </p>
        )}
        {activity.length === 200 && <p>Showing the latest 200 events.</p>}
      </details>
      <p className="context-generation-live" role="status">
        {activity.at(-1)?.message ?? (live ? "Waiting for execution activity." : "")}
      </p>
    </div>
  );
}
