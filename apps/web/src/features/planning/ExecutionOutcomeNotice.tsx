import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";
import { isReadyForReview } from "./work-item-status.js";

export function ExecutionOutcomeNotice({
  step,
  job,
}: {
  readonly step?: ExecutionStep;
  readonly job?: MuseJobStatus | null;
}) {
  const readyForReview = isReadyForReview(step, job);
  const completed = step?.state === "COMPLETED";
  if (!readyForReview && !completed) return null;
  const pullRequestUrl =
    job?.github_repository && job.github_pull_number
      ? `https://github.com/${job.github_repository}/pull/${job.github_pull_number}`
      : null;
  return (
    <aside className="step-review-notice" role="status">
      <strong>
        {completed
          ? pullRequestUrl
            ? "Pull request merged and verified. Work item completed."
            : "Work item completed."
          : "CI passed. Your pull request is ready for review."}
      </strong>
      {readyForReview && (
        <p>Execution has stopped. Review and merge the pull request when you are ready.</p>
      )}
      {pullRequestUrl && (
        <a href={pullRequestUrl} target="_blank" rel="noreferrer">
          {completed ? "View merged pull request" : "Review pull request"} #
          {job?.github_pull_number} ↗
        </a>
      )}
    </aside>
  );
}
