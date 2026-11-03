import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MuseAttemptDetails } from "./MuseAttemptDetails.js";
import type { ExecutionStep, MuseJobStatus } from "./intent-api.js";

const step: ExecutionStep = {
  id: "step",
  title: "Propose language selector design",
  state: "RUNNING",
  agent_session_id: "fresh-session",
  ci_repair_source_job_id: "original-job",
  blocker_reason: "running",
  work_item_key: "greeting",
  workflow_index: 1,
  step_index: 0,
  approval_required: false,
  approved_at: null,
};
const job: MuseJobStatus = {
  id: "fresh-repair-job",
  workflow_step_id: "step",
  status: "RUNNING",
  repair_source_job_id: "original-job",
  context_snapshot_id: "fresh-snapshot",
  repair_repository: "susanwere/private-test",
  repair_pull_number: 10,
  repair_base_sha: "a".repeat(40),
  attempts: 1,
  started_at: null,
  finished_at: null,
  failure_reason: null,
  github_repository: null,
  github_pull_number: null,
};
describe("CI repair identity", () => {
  it("distinguishes the current repair job/session/snapshot from its original source and step title", () => {
    const markup = renderToStaticMarkup(<MuseAttemptDetails step={step} job={job} />);
    expect(markup).toContain("CI repair attempt");
    expect(markup).toContain("Approved work: Propose language selector design");
    expect(markup).toContain("Current repair job: <code>fresh-repair-job</code>");
    expect(markup).toContain("Repair source job: <code>original-job</code>");
    expect(markup).toContain("fresh-session");
    expect(markup).toContain("fresh-snapshot");
    expect(markup).toContain("https://github.com/susanwere/private-test/pull/10");
  });
  it("shows authorization with no current job while a fresh session still needs to be created", () => {
    const markup = renderToStaticMarkup(
      <MuseAttemptDetails step={{ ...step, state: "BLOCKED", agent_session_id: null }} />,
    );
    expect(markup).toContain("CI repair authorized");
    expect(markup).toContain("explicitly start and execute");
    expect(markup).not.toContain("Current repair job:");
  });
  it("does not label an ordinary execution as a repair", () => {
    expect(
      renderToStaticMarkup(
        <MuseAttemptDetails
          step={{ ...step, ci_repair_source_job_id: null }}
          job={{ ...job, repair_source_job_id: null }}
        />,
      ),
    ).toBe("");
  });
});
