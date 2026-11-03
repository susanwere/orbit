import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { GithubCiReport } from "./github-ci-monitor.js";

/** Authenticated human authorizes a new attempt; immutable snapshots/output and PR lineage survive. */
export class MuseCiRepairService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}
  async prepare(input: { projectId: string; stepId: string; principalId: string; jobId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const jobs = await transaction.query<
        {
          agent_session_id: string;
          plan_revision: number;
          github_ci_report: GithubCiReport;
          repair_source_job_id: string | null;
          github_pull_number: number | null;
        } & Record<string, unknown>
      >(
        `SELECT job.agent_session_id,COALESCE(job.github_ci_report,source.github_ci_report) AS github_ci_report,job.repair_source_job_id,job.github_pull_number,step.plan_revision FROM muse_execution_jobs job
         JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id AND step.agent_session_id=job.agent_session_id
         JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
         LEFT JOIN muse_execution_jobs source ON source.id=job.repair_source_job_id AND source.project_id=job.project_id AND source.organization_id=job.organization_id AND source.workflow_step_id=job.workflow_step_id AND source.status='FAILED' AND source.github_ci_state='FAILED'
         LEFT JOIN muse_job_outputs output ON output.job_id=job.id AND output.project_id=job.project_id AND output.organization_id=job.organization_id
         JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=job.project_id AND plan.organization_id=job.organization_id
         WHERE job.id=$1 AND job.project_id=$2 AND job.organization_id=$3 AND step.id=$4
           AND job.status='TURN_FINISHED' AND (
             (job.github_ci_state='FAILED' AND job.github_head_sha=job.github_ci_report->>'headSha' AND job.github_repository='susanwere/private-test' AND job.github_pull_number IS NOT NULL)
             OR (job.github_pull_number IS NULL AND output.source='execution' AND output.changed_paths='[]'::jsonb AND source.github_repository='susanwere/private-test' AND source.github_pull_number IS NOT NULL AND source.github_head_sha=source.github_ci_report->>'headSha'))
           AND session.state IN ('RUNNING','WAITING') AND step.state IN ('RUNNING','WAITING') AND step.completion_kind='github_ci'
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND (session.requested_by_principal_id=$5 OR session.human_owner_principal_id=$5 OR $6='admin')
           AND NOT EXISTS (SELECT 1 FROM human_gates gate WHERE gate.project_id=job.project_id AND gate.organization_id=job.organization_id AND gate.agent_session_id=session.id AND gate.status='OPEN')
         FOR UPDATE OF job,step,session`,
        [
          input.jobId,
          input.projectId,
          actor.organizationId,
          input.stepId,
          input.principalId,
          actor.role,
        ],
      );
      const job = jobs.rows[0];
      if (!job || typeof job.github_ci_report?.summary !== "string")
        throw new DomainError(
          "invalid_state",
          "Refresh CI first. Repair requires a verified failure on this step's current delivered head and an authorized owner.",
        );
      const summary = job.github_ci_report.summary.slice(0, 3000);
      const repairSourceJobId = job.github_pull_number
        ? input.jobId
        : (job.repair_source_job_id ?? input.jobId);
      await transaction.query(
        `INSERT INTO evidence(id,organization_id,project_id,scope_type,scope_id,category,result,title,summary,produced_by_principal_id,agent_session_id,metadata) VALUES($1,$2,$3,'workflow_step',$4,'human_review','FAILED','Human-authorized CI repair',$5,$6,$7,$8::jsonb)`,
        [
          `evidence_${randomUUID()}`,
          actor.organizationId,
          input.projectId,
          input.stepId,
          summary,
          input.principalId,
          job.agent_session_id,
          JSON.stringify({
            decision: "rejected",
            planRevision: job.plan_revision,
            repairSourceJobId,
          }),
        ],
      );
      await transaction.query(
        "UPDATE muse_execution_jobs SET status='FAILED',failure_reason='CI failure reviewed by human; fresh authorized repair required.' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [input.jobId, input.projectId, actor.organizationId],
      );
      await transaction.query(
        "UPDATE agent_sessions SET state='FAILED',ended_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [job.agent_session_id, input.projectId, actor.organizationId],
      );
      await transaction.query(
        "UPDATE workflow_step_executions SET state='FAILED' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [input.stepId, input.projectId, actor.organizationId],
      );
      return { stepId: input.stepId, state: "FAILED", repairSourceJobId };
    });
  }
}
