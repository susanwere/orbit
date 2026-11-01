import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

/** HTTP only records explicit consent. Credentials and checkout access stay in the worker. */
export class MuseDeliveryRequestService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  async request(input: {
    projectId: string;
    stepId: string;
    principalId: string;
    jobId: string;
    outputHash: string;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (
      !/^musejob_[A-Za-z0-9-]{20,80}$/.test(input.jobId) ||
      !/^[a-f0-9]{64}$/.test(input.outputHash)
    )
      throw new DomainError(
        "validation",
        "The exact finished job and reviewed output hash are required.",
      );
    const requested = await this.database.query<Record<string, unknown>>(
      `UPDATE muse_execution_jobs job SET
         delivery_requested_at=COALESCE(job.delivery_requested_at,now()),
         delivery_requested_by_principal_id=COALESCE(job.delivery_requested_by_principal_id,$4),
         delivery_state=COALESCE(job.delivery_state,'REQUESTED')
       FROM agent_sessions session,workflow_step_executions step,execution_contracts contract,plan_proposals plan,muse_job_outputs output
       WHERE job.id=$1 AND job.project_id=$2 AND job.organization_id=$3 AND job.workflow_step_id=$5
         AND session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
         AND step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id AND step.agent_session_id=session.id
         AND contract.id=session.execution_contract_id AND contract.project_id=job.project_id AND contract.organization_id=job.organization_id
         AND plan.id=step.plan_id AND plan.project_id=job.project_id AND plan.organization_id=job.organization_id
         AND plan.status='APPROVED' AND plan.revision=step.plan_revision
         AND job.status='TURN_FINISHED' AND session.state='RUNNING' AND step.state='RUNNING' AND step.completion_kind='github_ci'
         AND (step.approval_required=false OR step.approved_by_principal_id IS NOT NULL)
         AND (session.requested_by_principal_id=$4 OR session.human_owner_principal_id=$4 OR $7='admin')
         AND contract.allowed_repositories='["susanwere/private-test"]'::jsonb AND contract.allowed_paths <> '[]'::jsonb
         AND EXISTS (SELECT 1 FROM project_repositories repository WHERE repository.project_id=job.project_id AND repository.organization_id=job.organization_id AND repository.full_name='susanwere/private-test')
         AND output.job_id=job.id AND output.project_id=job.project_id AND output.organization_id=job.organization_id
         AND output.content_hash=$6 AND output.source='execution' AND jsonb_array_length(output.changed_paths)>0
         AND (job.delivery_state IS NULL OR job.delivery_state IN ('REQUESTED','RUNNING','FINISHED'))
         AND NOT EXISTS (SELECT 1 FROM human_gates gate WHERE gate.project_id=job.project_id AND gate.organization_id=job.organization_id AND gate.agent_session_id=session.id AND gate.status='OPEN')
         AND NOT EXISTS (
           SELECT 1 FROM workflow_step_prerequisites dependency JOIN workflow_step_executions prior
           ON prior.id=dependency.prerequisite_step_id AND prior.project_id=dependency.project_id AND prior.organization_id=dependency.organization_id
           WHERE dependency.step_id=step.id AND dependency.project_id=step.project_id AND dependency.organization_id=step.organization_id
             AND (prior.state <> 'COMPLETED' OR prior.plan_id <> step.plan_id))
       RETURNING job.id,job.delivery_state,job.github_repository,job.github_pull_number,job.github_head_sha`,
      [
        input.jobId,
        input.projectId,
        actor.organizationId,
        input.principalId,
        input.stepId,
        input.outputHash,
        actor.role,
      ],
    );
    if (!requested.rows[0])
      throw new DomainError(
        "invalid_state",
        "Delivery needs a finished code turn, reviewed output, current approved plan, completed prerequisites and an authorized session. A failed delivery requires inspecting the checkout and GitHub before recovery.",
      );
    return requested.rows[0];
  }
}

/** Consumes consent once. An interrupted push is ambiguous: never replay it automatically. */
export class LocalMuseDeliveryConsumer {
  constructor(
    private readonly database: SqlDatabase,
    private readonly deliver: (jobId: string) => Promise<void>,
  ) {}
  async runNext(projectId: string): Promise<string | null> {
    const candidates = await this.database.query<{ id: string } & Record<string, unknown>>(
      `SELECT id FROM muse_execution_jobs WHERE project_id=$1 AND delivery_state IN ('REQUESTED','RUNNING') ORDER BY delivery_requested_at,id LIMIT 1`,
      [projectId],
    );
    const candidate = candidates.rows[0];
    if (!candidate) return null;
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<{ acquired: boolean } & Record<string, unknown>>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [`orbit:muse-delivery:${candidate.id}`],
      );
      if (!locked.rows[0]?.acquired) return null;
      const claimed = await this.database.query<{ id: string } & Record<string, unknown>>(
        `UPDATE muse_execution_jobs SET delivery_state='RUNNING',delivery_error=NULL WHERE id=$1 AND project_id=$2 AND delivery_state='REQUESTED' AND status='TURN_FINISHED' AND github_repository IS NULL RETURNING id`,
        [candidate.id, projectId],
      );
      if (!claimed.rows[0]) {
        await this.database.query(
          `UPDATE muse_execution_jobs SET delivery_state=CASE WHEN github_pull_number IS NOT NULL THEN 'FINISHED' ELSE 'ERROR' END,delivery_error=CASE WHEN github_pull_number IS NOT NULL THEN NULL ELSE 'Delivery was interrupted. Inspect the disposable checkout and GitHub branch/PR before recovery; it will not be replayed automatically.' END WHERE id=$1 AND project_id=$2 AND delivery_state IN ('REQUESTED','RUNNING')`,
          [candidate.id, projectId],
        );
        return null;
      }
      try {
        await this.deliver(candidate.id);
        const finished = await this.database.query<{ id: string } & Record<string, unknown>>(
          `UPDATE muse_execution_jobs SET delivery_state='FINISHED',delivery_error=NULL WHERE id=$1 AND project_id=$2 AND delivery_state='RUNNING' AND github_pull_number IS NOT NULL AND github_head_sha IS NOT NULL RETURNING id`,
          [candidate.id, projectId],
        );
        if (!finished.rows[0]) throw new Error("No independently recorded PR.");
      } catch {
        await this.database.query(
          `UPDATE muse_execution_jobs SET delivery_state='ERROR',delivery_error='PR delivery could not finish. Inspect the disposable checkout, GitHub permissions and existing branch/PR before recovery. No automatic retry or CI completion occurred.' WHERE id=$1 AND project_id=$2 AND delivery_state='RUNNING'`,
          [candidate.id, projectId],
        );
      }
      return candidate.id;
    });
  }
}
