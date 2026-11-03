import type { ExecutionStep, MuseJobStatus } from "./intent-api.js";

/** Workflow identity stays stable across attempts; job, session and snapshot identity do not. */
export function MuseAttemptDetails({
  step,
  job,
}: {
  readonly step: ExecutionStep;
  readonly job?: MuseJobStatus | null;
}) {
  const repairSourceJobId = job?.repair_source_job_id ?? step.ci_repair_source_job_id;
  if (!repairSourceJobId) return null;
  return (
    <section aria-label="CI repair attempt identity">
      <h4>CI repair attempt</h4>
      {step.title && <p>Approved work: {step.title}</p>}
      <p>
        Repair source job: <code>{repairSourceJobId}</code>
      </p>
      {job ? (
        <>
          <p>
            Current repair job: <code>{job.id}</code> · Attempt count: {job.attempts}
          </p>
          <p>
            Repair session: <code>{step.agent_session_id}</code>
          </p>
          {job.context_snapshot_id && (
            <p>
              Repair snapshot: <code>{job.context_snapshot_id}</code>
            </p>
          )}
          {job.repair_repository && job.repair_pull_number && (
            <p>
              Repairing{" "}
              <a
                href={`https://github.com/${job.repair_repository}/pull/${job.repair_pull_number}`}
                target="_blank"
                rel="noreferrer"
              >
                {job.repair_repository} PR #{job.repair_pull_number}
              </a>
              {job.repair_base_sha && (
                <>
                  {" "}
                  from commit <code>{job.repair_base_sha}</code>
                </>
              )}
            </p>
          )}
        </>
      ) : step.agent_session_id ? (
        <p>
          New repair session: <code>{step.agent_session_id}</code>. Start this session and
          explicitly execute the repair to create a new job.
        </p>
      ) : (
        <p>
          CI repair authorized. Create and bind a new session, then explicitly start and execute the
          repair.
        </p>
      )}
      <p>
        Each repair has its own session and immutable snapshot. The original work and PR are
        retained.
      </p>
    </section>
  );
}
