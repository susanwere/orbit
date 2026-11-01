import type { MuseJobStatus, ProjectTask } from "./intent-api.js";

export type EnrichedProjectTask = ProjectTask & {
  readonly displayState: string;
  readonly blockedBy: readonly string[];
  readonly job: MuseJobStatus | null;
};

export interface TaskActivity {
  readonly headline: string;
  readonly detail?: string;
  readonly isWorking: boolean;
}

function ciRunLinks(task: EnrichedProjectTask): string | undefined {
  const runs = task.job?.github_ci_report?.runs ?? [];
  const failedRun = runs.find((run) => run.conclusion && run.conclusion !== "success");
  return failedRun ? `Failing check: ${failedRun.name}.` : undefined;
}

/** Plain-language summary of what Muse is doing right now for one task. */
export function describeTaskActivity(task: EnrichedProjectTask): TaskActivity {
  const job = task.job;
  const repairs = task.automatic_repairs ?? 0;
  const repairNote =
    repairs > 0
      ? ` (CI repair attempt ${repairs + (job?.status === "TURN_FINISHED" ? 0 : 1)})`
      : "";

  if (task.last_error && task.displayState === "FAILED") {
    return { headline: "Needs your attention", detail: task.last_error, isWorking: false };
  }
  if (task.displayState === "NEEDS_INPUT" && task.last_error) {
    return { headline: "Muse needs your input", detail: task.last_error, isWorking: false };
  }
  if (!job) {
    switch (task.displayState) {
      case "DRAFT":
        return {
          headline: task.blockedBy?.length
            ? `Waiting for ${task.blockedBy.join(", ")} to finish first`
            : "Ready when you are — edit the prompt if you like, then Execute",
          isWorking: false,
        };
      case "DONE":
        return { headline: "Finished and verified", isWorking: false };
      default:
        return { headline: "Getting started…", isWorking: true };
    }
  }

  if (job.local_execution_state === "REQUESTED" && job.status === "QUEUED") {
    return {
      headline: "Waiting for the local Muse worker to pick this up…",
      detail:
        "If this lasts more than a minute, the local consumer for this project is not running.",
      isWorking: true,
    };
  }
  if (job.local_execution_state === "PREPARING") {
    return { headline: "Preparing a clean checkout for Muse…", isWorking: true };
  }
  if (
    job.status === "QUEUED" ||
    job.local_execution_state === "RUNNING" ||
    job.status === "RUNNING"
  ) {
    return {
      headline: `Muse is writing the code${repairNote}…`,
      detail:
        "Working in an isolated checkout with only the approved paths. This can take a few minutes.",
      isWorking: true,
    };
  }
  if (job.local_execution_state === "ERROR") {
    return {
      headline: "The local worker could not run this",
      detail: job.local_execution_error ?? "Check the local consumer terminal for details.",
      isWorking: false,
    };
  }
  if (job.status === "FAILED") {
    return {
      headline: "Muse run failed",
      detail: job.failure_reason ?? "Edit the prompt and Execute again.",
      isWorking: false,
    };
  }
  if (job.status === "TURN_FINISHED") {
    if (job.github_pull_number) {
      if (job.github_ci_state === "FAILED") {
        return {
          headline: `CI failed on PR #${job.github_pull_number} — Muse is repairing it automatically`,
          detail: ciRunLinks(task) ?? job.github_ci_report?.summary,
          isWorking: true,
        };
      }
      if (job.github_ci_state === "PASSED") {
        return {
          headline: `CI is green on PR #${job.github_pull_number}`,
          detail: "Everything passed. The PR is ready — merging it stays with you.",
          isWorking: false,
        };
      }
      return {
        headline: `PR #${job.github_pull_number} is open — watching CI checks…`,
        detail: "Muse will repair any failure automatically until CI is green.",
        isWorking: true,
      };
    }
    if (job.delivery_state === "REQUESTED" || job.delivery_state === "RUNNING") {
      return { headline: "Muse finished — opening the pull request…", isWorking: true };
    }
    if (job.delivery_state === "ERROR") {
      return {
        headline: "Could not open the pull request",
        detail: job.delivery_error ?? undefined,
        isWorking: false,
      };
    }
    if ((job.changed_paths?.length ?? 0) === 0) {
      return {
        headline: "Muse finished but made no code changes",
        detail: "It may need more detail — edit the prompt and Execute again.",
        isWorking: false,
      };
    }
    return { headline: "Muse finished — preparing the pull request…", isWorking: true };
  }
  return { headline: "Working…", isWorking: true };
}
