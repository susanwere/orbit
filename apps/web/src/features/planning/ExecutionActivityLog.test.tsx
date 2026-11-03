import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExecutionActivityLog } from "./ExecutionActivityLog.js";
import type { MuseJobStatus } from "../intent/intent-api.js";
const job: MuseJobStatus = {
  id: "job",
  workflow_step_id: "step",
  status: "RUNNING",
  attempts: 1,
  started_at: "2026-11-03T12:00:00Z",
  finished_at: null,
  failure_reason: null,
  github_repository: null,
  github_pull_number: null,
  activity: [
    {
      id: "1",
      stage: "tools",
      status: "started",
      message: "Muse is reading repository files.",
      occurredAt: "2026-11-03T12:00:01Z",
    },
  ],
};
describe("execution activity timeline", () => {
  it("uses the generation timeline design with real timestamps and live worker messages", () => {
    const markup = renderToStaticMarkup(createElement(ExecutionActivityLog, { job }));
    expect(markup).toContain('class="context-generation-steps"');
    expect(markup).toContain("Live · updates every 2s");
    expect(markup).toContain("Muse is reading repository files.");
    expect(markup).toContain('dateTime="2026-11-03T12:00:01Z"');
    expect(markup).not.toContain("Work item completion verified.");
  });
  it("does not fake activity for historical runs", () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionActivityLog, {
        job: { ...job, status: "TURN_FINISHED", activity: [] },
      }),
    );
    expect(markup).toContain("Detailed activity was not recorded for this run.");
    expect(markup).not.toContain("Live · updates every 2s");
  });
  it("shows failures without an animated in-progress indicator", () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionActivityLog, { job: { ...job, status: "FAILED" } }),
    );
    expect(markup).toContain("Needs attention");
    expect(markup).not.toContain('role="progressbar"');
  });
});

it("stops live animation after CI passes and tells the user to review and merge", () => {
  const markup = renderToStaticMarkup(
    createElement(ExecutionActivityLog, {
      job: { ...job, status: "TURN_FINISHED", github_ci_state: "PASSED", github_pull_number: 102 },
      step: {
        id: "step",
        state: "WAITING",
        blocker_reason: "pull_request_review",
        work_item_key: "work",
        workflow_index: 0,
        step_index: 0,
        approval_required: false,
        approved_at: null,
        agent_session_id: "session",
      },
    }),
  );
  expect(markup).toContain("Ready for review");
  expect(markup).toContain("Waiting for you to merge");
  expect(markup).not.toContain('role="progressbar"');
  expect(markup).not.toContain("Live · updates every 2s");
});
