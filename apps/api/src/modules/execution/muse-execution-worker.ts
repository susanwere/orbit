import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { EngineeringExecutor, EngineeringExecutionResult } from "./muse-code-executor.js";

interface JobRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  agent_session_id: string;
  workflow_step_id: string;
  status: string;
  mission: string;
}

/** A durable queue boundary. Never execute the CLI from an HTTP request. */
export class MuseExecutionJobService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly uuid: () => string = randomUUID,
  ) {}

  async enqueue(input: { projectId: string; principalId: string; sessionId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO muse_execution_jobs
       (id,organization_id,project_id,agent_session_id,workflow_step_id,requested_by_principal_id)
       SELECT $1,s.organization_id,s.project_id,s.id,step.id,$4
       FROM agent_sessions s
       JOIN workflow_step_executions step
         ON step.agent_session_id=s.id AND step.project_id=s.project_id
            AND step.organization_id=s.organization_id
       JOIN execution_contracts c
         ON c.id=s.execution_contract_id AND c.project_id=s.project_id
       WHERE s.project_id=$2 AND s.organization_id=$3 AND s.id=$5
         AND s.state='RUNNING' AND step.state='RUNNING'
         AND (s.requested_by_principal_id=$4 OR s.human_owner_principal_id=$4 OR $6='admin')
         AND c.allowed_repositories <> '[]'::jsonb
         AND c.allowed_paths <> '[]'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM human_gates gate WHERE gate.project_id=s.project_id
             AND gate.organization_id=s.organization_id AND gate.agent_session_id=s.id
             AND gate.status='OPEN'
         )
       ON CONFLICT (project_id,agent_session_id) DO NOTHING
       RETURNING id,project_id,agent_session_id,workflow_step_id,status`,
      [`musejob_${this.uuid()}`, input.projectId, actor.organizationId, input.principalId, input.sessionId, actor.role],
    );
    if (!result.rows[0]) throw new DomainError("invalid_state", "Muse dispatch requires a running, scoped, unblocked session and no existing job.");
    return result.rows[0];
  }
}

/**
 * Executes one queued job in an independently sandboxed worker. Caller must
 * provision a clean checkout and enforce the ExecutionContract's paths/network.
 * No invocation should occur in an API container.
 */
export class MuseExecutionWorker {
  constructor(
    private readonly db: SqlDatabase,
    private readonly executor: EngineeringExecutor,
  ) {}

  async runNext(workspace: string): Promise<{ jobId: string; status: string } | null> {
    // Do not allow this worker to be accidentally activated on the API host.
    if (process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true") {
      throw new Error("Muse worker requires an explicitly isolated execution environment.");
    }
    const job = await this.db.transaction(async (tx) => {
      const claim = await tx.query<JobRow>(
        `SELECT job.id,job.organization_id,job.project_id,job.agent_session_id,
            job.workflow_step_id,job.status,s.mission
         FROM muse_execution_jobs job
         JOIN agent_sessions s ON s.id=job.agent_session_id AND s.project_id=job.project_id
           AND s.organization_id=job.organization_id
         JOIN workflow_step_executions step ON step.id=job.workflow_step_id
           AND step.project_id=job.project_id AND step.agent_session_id=s.id
         JOIN execution_contracts c ON c.id=s.execution_contract_id AND c.project_id=s.project_id
         WHERE job.status='QUEUED' AND s.state='RUNNING' AND step.state='RUNNING'
           AND c.allowed_repositories <> '[]'::jsonb AND c.allowed_paths <> '[]'::jsonb
           AND NOT EXISTS (SELECT 1 FROM human_gates gate
             WHERE gate.agent_session_id=s.id AND gate.project_id=s.project_id
               AND gate.organization_id=s.organization_id AND gate.status='OPEN')
         ORDER BY job.created_at LIMIT 1 FOR UPDATE OF job SKIP LOCKED`,
        [],
      );
      const candidate = claim.rows[0];
      if (!candidate) return null;
      await tx.query(
        `UPDATE muse_execution_jobs SET status='RUNNING',started_at=now(),
         attempts=attempts+1 WHERE id=$1 AND project_id=$2 AND status='QUEUED'`,
        [candidate.id, candidate.project_id],
      );
      return candidate;
    });
    if (!job) return null;

    let result: EngineeringExecutionResult | null = null;
    let failure = "";
    try {
      result = await this.executor.execute({
        mission: job.mission,
        workspace,
        modelSteps: 20,
        timeoutMs: 600000,
      });
      if (result.exitCode !== 0) failure = "Muse Code exited without a completed turn.";
      if (result.outputTruncated) failure = "Muse Code output exceeded capture limits.";
    } catch {
      // Never persist provider stderr or secrets into user-visible error fields.
      failure = "Muse Code process failed or timed out.";
    }
    const state = failure ? "FAILED" : "TURN_FINISHED";
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE muse_execution_jobs
         SET status=$3,exit_code=$4,event_count=$5,failure_reason=$6,finished_at=now()
         WHERE id=$1 AND project_id=$2 AND status='RUNNING'`,
        [job.id,job.project_id,state,result?.exitCode ?? null,result?.events.length ?? 0,failure || null],
      );
      if (failure) {
        await tx.query(
          `UPDATE agent_sessions SET state='FAILED',ended_at=now()
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.agent_session_id,job.project_id],
        );
        await tx.query(
          `UPDATE workflow_step_executions SET state='FAILED'
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.workflow_step_id,job.project_id],
        );
      }
      // Exit 0 leaves session and step RUNNING pending independently verified CI.
    });
    return { jobId: job.id, status: state };
  }
}
