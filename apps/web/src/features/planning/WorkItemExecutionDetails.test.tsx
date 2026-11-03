import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkItemExecutionDetails } from "./WorkItemExecutionDetails.js";
import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";

const executionStep: ExecutionStep = {
  id: "step-1",
  state: "RUNNING",
  blocker_reason: null,
  work_item_key: "pagination",
  workflow_index: 0,
  step_index: 0,
  approval_required: false,
  approved_at: null,
  agent_session_id: "session-1",
};
const job: MuseJobStatus = {
  id: "job-1",
  status: "TURN_FINISHED",
  workflow_step_id: "step-1",
  attempts: 1,
  started_at: "2026-11-03T12:00:00Z",
  finished_at: "2026-11-03T12:05:00Z",
  failure_reason: null,
  github_repository: "example/project",
  github_pull_number: 102,
  github_ci_state: "PASSED",
  changed_paths: ["apps/web/pagination.ts"],
  review_output: "Updated pagination defaults.",
};
function renderDetails(
  step?: ExecutionStep,
  executionJob?: MuseJobStatus,
  overrides: Partial<ComponentProps<typeof WorkItemExecutionDetails>> = {},
) {
  return renderToStaticMarkup(
    createElement(WorkItemExecutionDetails, {
      workItemTitle: "Pagination",
      executor: "agent",
      executionStep: step,
      job: executionJob,
      approved: true,
      onOpenExecution: () => undefined,
      ...overrides,
    }),
  );
}
describe("work item execution dashboard", () => {
  it("shows recorded evidence and review readiness without treating green CI as completed", () => {
    const markup = renderDetails(executionStep, job);
    expect(markup).toContain("Pull request ready for review");
    expect(markup).toContain("Execution has stopped.");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("Work item completed successfully");
    expect(markup).toContain("https://github.com/example/project/pull/102");
    expect(markup).toContain("apps/web/pagination.ts");
    expect(markup).toContain("Updated pagination defaults.");
    expect(markup).not.toContain("Next step");
    expect(markup).not.toContain("Step 1");
    expect(markup).not.toContain("<dt>Workflow</dt>");
    expect(markup).toContain("Work item details");
  });
  it("shows completed only from authoritative step completion", () => {
    expect(renderDetails({ ...executionStep, state: "COMPLETED" }, job)).toContain(
      "Work item completed successfully",
    );
  });
  it("handles an unstarted step without inventing timestamps or activity", () => {
    const markup = renderDetails();
    expect(markup).toContain("Not recorded");
    expect(markup).toContain("No execution activity recorded yet.");
    expect(markup).toContain("No pull request recorded.");
    expect(markup).not.toContain("Work item completed successfully");
  });
  it("rejects unsafe CI links and raw HTML while retaining ordinary summary text", () => {
    const markup = renderDetails(executionStep, {
      ...job,
      github_ci_url: "javascript:alert(1)",
      review_output: "Visible execution summary.\n\n<script>alert(1)</script>",
    });
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("Visible execution summary.");
    expect(markup).not.toContain("alert(1)");
  });
});

describe("work item execution button", () => {
  const readyTask = {
    id: "task-1",
    task_key: "pagination",
    title: "Pagination",
    prompt: "Update pagination",
    revision: 1,
    state: "DRAFT" as const,
    has_agent_executor: true,
    blocked_by: [],
  };
  const executeProps = { task: readyTask, onExecute: () => undefined };
  it("offers Execute for the eligible ready step and disables it while starting", () => {
    expect(renderDetails({ ...executionStep, state: "READY" }, undefined, executeProps)).toContain(
      "step-execution-start",
    );
    const startingMarkup = renderDetails({ ...executionStep, state: "READY" }, undefined, {
      ...executeProps,
      isExecuting: true,
    });
    expect(startingMarkup).toContain("Starting…");
    expect(startingMarkup).toContain('disabled=""');
  });
  it.each(["RUNNING", "COMPLETED", "WAITING", "CANCELED"])(
    "does not offer Execute for a %s step",
    (state) => {
      expect(renderDetails({ ...executionStep, state }, undefined, executeProps)).not.toContain(
        "step-execution-start",
      );
    },
  );
  it("requires plan approval, task readiness and the selected primary step action", () => {
    expect(renderDetails(undefined, undefined, { ...executeProps, approved: false })).not.toContain(
      "step-execution-start",
    );
    expect(
      renderDetails(undefined, undefined, {
        ...executeProps,
        task: { ...readyTask, blocked_by: ["Dependency"] },
      }),
    ).not.toContain("step-execution-start");
    expect(
      renderDetails(undefined, undefined, { ...executeProps, onExecute: undefined }),
    ).not.toContain("step-execution-start");
  });
});

describe("project repository metadata", () => {
  const connectedRepository = {
    id: "repository-1",
    project_id: "current-project",
    owner: "current-owner",
    repo: "current-project",
    full_name: "current-owner/current-project",
    html_url: "https://github.com/current-owner/current-project",
    created_at: "2026-11-03T12:00:00Z",
  };
  it("shows the current project's repository while retaining the real historical PR target", () => {
    const markup = renderDetails(executionStep, job, {
      projectRepositories: [connectedRepository],
    });
    const metadata = markup.split('class="step-execution-meta"')[1]?.split("</dl>")[0];
    expect(metadata).toContain("current-owner/current-project");
    expect(metadata).not.toContain("example/project");
    expect(markup).toContain("https://github.com/example/project/pull/102");
  });
  it("shows all connected repositories instead of assuming the first one is the execution target", () => {
    const markup = renderDetails(undefined, undefined, {
      projectRepositories: [
        connectedRepository,
        { ...connectedRepository, id: "repository-2", full_name: "current-owner/second-project" },
      ],
    });
    expect(markup).toContain("Project repositories");
    expect(markup).toContain("current-owner/second-project");
  });
  it("does not fall back to a historical job's repository when project sources are unavailable", () => {
    expect(renderDetails(executionStep, job, { repositoriesLoading: true })).toContain(
      "Loading repositories…",
    );
    expect(renderDetails(executionStep, job, { repositoriesFailed: true })).toContain(
      "Could not load project repositories",
    );
    expect(renderDetails(executionStep, job)).toContain("No connected repository");
  });
});

it("shows verification as passed for a CI-verified completed work item without inventing missing evidence", () => {
  const markup = renderDetails({ ...executionStep, state: "COMPLETED" }, job);
  const progress = markup.split('aria-label="Execution progress"')[1]?.split("</section>")[0];
  expect(progress?.match(/data-complete="true"/g)).toHaveLength(4);
  expect(progress).toContain("PASSED");
  expect(progress).not.toContain("WAITING");
  const noEvidence = renderDetails({ ...executionStep, state: "COMPLETED" });
  expect(noEvidence).toContain("No CI evidence");
});
