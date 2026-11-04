import { createExecutionActivityRecorder, summarizeMuseEvent } from "./muse-execution-activity.js";
import { randomUUID } from "node:crypto";
import { DomainError, type ContextSnapshotItem } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { EngineeringExecutor, EngineeringExecutionResult } from "./muse-code-executor.js";

import { missingRevisionFeedbackSql } from "./revision-feedback.js";
import { hashMuseReviewOutput } from "./muse-review-output.js";

interface JobRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  agent_session_id: string;
  workflow_step_id: string;
  status: string;
  attempts: number;
  mission: string;
  context_items?: ContextSnapshotItem[];
  is_code_task?: boolean;
  allowed_repositories: unknown;
  allowed_paths: unknown;
  network_policy: string;
  network_allowlist: unknown;
}

/** A durable queue boundary. Never execute the CLI from an HTTP request. */
export class MuseExecutionJobService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly uuid: () => string = randomUUID,
  ) {}

  async getStatus(input: { projectId: string; principalId: string; sessionId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "read");
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT job.id,job.status,job.workflow_step_id,job.attempts,job.started_at,session.context_snapshot_id,
         COALESCE(activity.entries,'[]'::jsonb) AS activity,
         job.finished_at,job.failure_reason,job.local_execution_state,job.local_execution_error,
         CASE WHEN step.state='COMPLETED' AND ci.artifact_ref IS NOT NULL THEN 'PASSED' ELSE job.github_ci_state END AS github_ci_state,
         CASE WHEN step.state='COMPLETED' AND ci.artifact_ref IS NOT NULL THEN jsonb_build_object(
           'summary',ci.summary,'runs',jsonb_build_array(jsonb_build_object('id',ci.metadata->'runId','name','CI','conclusion','success','url',ci.artifact_ref,'failures','[]'::jsonb))) ELSE job.github_ci_report END AS github_ci_report,
         job.github_review_state,job.github_review_error,job.delivery_state,job.delivery_error,job.github_head_sha,job.github_repository,job.github_pull_number,output.content AS review_output,
         output.content_hash AS output_hash,output.source AS output_source,output.changed_paths,
         source.github_repository AS repair_repository,source.github_pull_number AS repair_pull_number,source.github_head_sha AS repair_base_sha,job.repair_source_job_id,(job.status='TURN_FINISHED' AND job.github_pull_number IS NULL AND output.changed_paths='[]'::jsonb AND source.github_ci_state='FAILED') AS needs_ci_repair_retry,source.github_ci_report AS repair_ci_report,
         ci.artifact_ref AS github_ci_url,ci.metadata->>'runId' AS github_ci_run_id,
         (job.status='QUEUED' AND job.attempts=0 AND job.started_at IS NULL AND ${missingRevisionFeedbackSql("session")}) AS needs_revision_replacement
       FROM muse_execution_jobs job
       JOIN agent_sessions session ON session.id=job.agent_session_id
         AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id
       LEFT JOIN muse_job_outputs output ON output.job_id=job.id AND output.project_id=job.project_id AND output.organization_id=job.organization_id
       LEFT JOIN muse_execution_jobs source ON source.id=job.repair_source_job_id AND source.project_id=job.project_id AND source.organization_id=job.organization_id AND source.workflow_step_id=job.workflow_step_id AND source.status='FAILED'
       LEFT JOIN LATERAL (
         SELECT evidence.artifact_ref,evidence.metadata,evidence.summary FROM evidence
         WHERE evidence.project_id=job.project_id AND evidence.organization_id=job.organization_id
           AND evidence.scope_type='workflow_step' AND evidence.scope_id=step.id AND evidence.category='ci' AND evidence.result='PASSED'
           AND evidence.metadata->>'provider'='github' AND evidence.metadata->>'repository'=job.github_repository
           AND evidence.metadata->>'pullNumber'=job.github_pull_number::text AND evidence.metadata->>'headSha'=job.github_head_sha
         ORDER BY evidence.created_at DESC,evidence.id DESC LIMIT 1
       ) ci ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('id',entry.id::text,'stage',entry.stage,'status',entry.status,'message',entry.message,'occurredAt',entry.occurred_at) ORDER BY entry.id) AS entries
         FROM (SELECT id,stage,status,message,occurred_at FROM muse_execution_activity
           WHERE job_id=job.id AND project_id=job.project_id AND organization_id=job.organization_id
           ORDER BY id DESC LIMIT 200) entry
       ) activity ON true
       WHERE job.project_id=$1 AND job.organization_id=$2
         AND job.agent_session_id=$3
       ORDER BY job.created_at DESC LIMIT 1`,
      [actor.projectId, actor.organizationId, input.sessionId],
    );
    return result.rows[0] ?? null;
  }

  async enqueue(input: {
    projectId: string;
    principalId: string;
    sessionId: string;
    executeLocally?: boolean;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO muse_execution_jobs
       (id,organization_id,project_id,agent_session_id,workflow_step_id,requested_by_principal_id,local_execution_requested_at,local_execution_state,repair_source_job_id)
       SELECT $1,s.organization_id,s.project_id,s.id,step.id,$4,CASE WHEN $7 THEN now() ELSE NULL END,CASE WHEN $7 THEN 'REQUESTED' ELSE NULL END,s.repair_source_job_id
       FROM agent_sessions s
       JOIN workflow_step_executions step
         ON step.agent_session_id=s.id AND step.project_id=s.project_id
            AND step.organization_id=s.organization_id
       JOIN execution_contracts c
         ON c.id=s.execution_contract_id AND c.project_id=s.project_id
            AND c.organization_id=s.organization_id
       JOIN plan_proposals plan
         ON plan.id=step.plan_id AND plan.project_id=step.project_id
           AND plan.organization_id=step.organization_id
       WHERE plan.status='APPROVED' AND plan.revision=step.plan_revision
         AND s.project_id=$2 AND s.organization_id=$3 AND s.id=$5
         AND s.state='RUNNING' AND step.state='RUNNING'
         AND (step.approval_required=false OR step.approved_by_principal_id IS NOT NULL)
         AND (s.requested_by_principal_id=$4 OR s.human_owner_principal_id=$4 OR $6='admin')
         AND c.allowed_repositories <> '[]'::jsonb
         AND c.allowed_paths <> '[]'::jsonb
         AND (NOT $7 OR c.allowed_repositories=$8::jsonb)
         AND NOT ${missingRevisionFeedbackSql("s")}
         AND NOT EXISTS (
           SELECT 1 FROM workflow_step_prerequisites dep
           JOIN workflow_step_executions prereq ON prereq.id=dep.prerequisite_step_id
             AND prereq.project_id=dep.project_id
             AND prereq.organization_id=dep.organization_id
           WHERE dep.project_id=step.project_id AND dep.organization_id=step.organization_id
             AND dep.step_id=step.id
             AND (prereq.state <> 'COMPLETED' OR prereq.plan_id <> step.plan_id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM human_gates gate WHERE gate.project_id=s.project_id
             AND gate.organization_id=s.organization_id AND gate.agent_session_id=s.id
             AND gate.status='OPEN'
         )
       ON CONFLICT (project_id,agent_session_id) DO UPDATE
       SET local_execution_requested_at=COALESCE(muse_execution_jobs.local_execution_requested_at,now()),
           local_execution_state=CASE WHEN muse_execution_jobs.local_execution_state IS NULL OR muse_execution_jobs.local_execution_state='ERROR' THEN 'REQUESTED' ELSE muse_execution_jobs.local_execution_state END,
           local_execution_error=CASE WHEN muse_execution_jobs.local_execution_state IS NULL OR muse_execution_jobs.local_execution_state='ERROR' THEN NULL ELSE muse_execution_jobs.local_execution_error END
       WHERE $7 AND muse_execution_jobs.status='QUEUED' AND muse_execution_jobs.attempts=0
       RETURNING id,project_id,agent_session_id,workflow_step_id,status,local_execution_state`,
      [
        `musejob_${this.uuid()}`,
        input.projectId,
        actor.organizationId,
        input.principalId,
        input.sessionId,
        actor.role,
        input.executeLocally === true,
        JSON.stringify(["susanwere/private-test"]),
      ],
    );
    if (!result.rows[0])
      throw new DomainError(
        "invalid_state",
        "Muse dispatch requires a running, scoped, unblocked session and no existing job.",
      );
    return result.rows[0];
  }
}

export interface MuseJobSelection {
  readonly jobId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly allowedPaths: readonly string[];
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

  async runNext(
    workspace: string,
    selection?: MuseJobSelection,
  ): Promise<{ jobId: string; status: string } | null> {
    // Do not allow this worker to be accidentally activated on the API host.
    if (process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true") {
      throw new Error("Muse worker requires an explicitly isolated execution environment.");
    }
    const job = await this.db.transaction(async (tx) => {
      const claim = await tx.query<JobRow>(
        `SELECT job.id,job.organization_id,job.project_id,job.agent_session_id,job.attempts,
            job.workflow_step_id,job.status,s.mission,snapshot.items AS context_items,c.allowed_repositories,
            c.allowed_paths,c.network_policy,c.network_allowlist,
            EXISTS(SELECT 1 FROM project_tasks task WHERE task.project_id=job.project_id
              AND task.organization_id=job.organization_id AND task.session_id=job.agent_session_id
              AND task.step_id=job.workflow_step_id) AS is_code_task
         FROM muse_execution_jobs job
         JOIN agent_sessions s ON s.id=job.agent_session_id AND s.project_id=job.project_id
           AND s.organization_id=job.organization_id
         JOIN context_snapshots snapshot ON snapshot.id=s.context_snapshot_id
           AND snapshot.organization_id=s.organization_id AND snapshot.project_id=s.project_id
         JOIN workflow_step_executions step ON step.id=job.workflow_step_id
           AND step.project_id=job.project_id AND step.agent_session_id=s.id
         JOIN execution_contracts c ON c.id=s.execution_contract_id AND c.project_id=s.project_id
           AND c.organization_id=s.organization_id
         JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=step.project_id
           AND plan.organization_id=step.organization_id
         WHERE job.status='QUEUED' AND s.state='RUNNING' AND step.state='RUNNING'
           AND ($1::text IS NULL OR (job.id=$1 AND job.project_id=$2
             AND c.allowed_repositories=$3::jsonb AND c.allowed_paths=$4::jsonb))
           AND (step.approval_required=false OR step.approved_by_principal_id IS NOT NULL)
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND step.organization_id=job.organization_id
           AND NOT EXISTS (
             SELECT 1 FROM workflow_step_prerequisites dependency
             JOIN workflow_step_executions prior ON prior.id=dependency.prerequisite_step_id
               AND prior.project_id=dependency.project_id
               AND prior.organization_id=dependency.organization_id
             WHERE dependency.step_id=step.id AND dependency.project_id=step.project_id
               AND dependency.organization_id=step.organization_id
               AND (prior.state <> 'COMPLETED' OR prior.plan_id <> step.plan_id)
           )
           AND NOT ${missingRevisionFeedbackSql("s")}
           AND c.allowed_repositories <> '[]'::jsonb AND c.allowed_paths <> '[]'::jsonb
           AND NOT EXISTS (SELECT 1 FROM human_gates gate
             WHERE gate.agent_session_id=s.id AND gate.project_id=s.project_id
               AND gate.organization_id=s.organization_id AND gate.status='OPEN')
         ORDER BY job.created_at LIMIT 1 FOR UPDATE OF job SKIP LOCKED`,
        [
          selection?.jobId ?? null,
          selection?.projectId ?? null,
          JSON.stringify(selection ? [selection.repository] : []),
          JSON.stringify(selection?.allowedPaths ?? []),
        ],
      );
      const candidate = claim.rows[0];
      if (!candidate) return null;
      await tx.query(
        `UPDATE muse_execution_jobs SET status='RUNNING',started_at=now(),
         attempts=attempts+1,lease_expires_at=now()+interval '20 minutes' WHERE id=$1 AND project_id=$2 AND status='QUEUED'`,
        [candidate.id, candidate.project_id],
      );
      return candidate;
    });
    if (!job) return null;

    const recordActivity = createExecutionActivityRecorder(this.db, {
      jobId: job.id,
      projectId: job.project_id,
      organizationId: job.organization_id,
      attempt: job.attempts + 1,
    });
    let result: EngineeringExecutionResult | null = null;
    let failure = "";
    // This is a fail-closed policy check, NOT an OS sandbox. A production
    // provisioner must independently enforce these grants on its mounted checkout.
    const repositories = job.allowed_repositories;
    const paths = job.allowed_paths;
    const validStrings = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.length > 0);
    if (
      !validStrings(repositories) ||
      !validStrings(paths) ||
      job.network_policy !== "none" ||
      !Array.isArray(job.network_allowlist) ||
      job.network_allowlist.length > 0
    ) {
      failure = "Execution contract requires explicit, offline repository and path grants.";
    }
    try {
      if (failure) throw new Error(failure);
      await recordActivity({
        stage: "preparing",
        status: "completed",
        message: "Worker claimed the job and checked its execution contract.",
      });
      result = await this.executor.execute({
        onEvent: async (event) => {
          const activity = summarizeMuseEvent(event);
          if (activity) await recordActivity(activity);
        },
        mission: job.mission,
        contextItems: job.context_items,
        workspace,
        modelSteps: 40,
        timeoutMs: 600000,
      });
      if (result.exitCode !== 0) failure = "Muse Code exited without a completed turn.";
      if (result.outputTruncated) failure = "Muse Code output exceeded capture limits.";
      if (!failure && (!result.reviewOutput?.trim() || !result.changedPaths))
        failure =
          "Muse finished without a retainable execution summary or file-change inventory. No PR was requested. Review the preserved checkout before retrying.";
      if (!failure && job.is_code_task && result.changedPaths?.length === 0)
        failure =
          "Muse made no file changes for this coding task. No PR was created. Review its retained summary and resolve the blocker before retrying.";
    } catch (error) {
      // Only our fixed timeout label is exposed; provider diagnostics remain private.
      failure ||=
        error instanceof Error && error.message === "Muse Code timed out."
          ? "Muse reached the 10-minute execution limit. Partial edits are preserved in its checkout; no PR was requested."
          : "Muse Code process failed before output could be retained. Partial edits are preserved; no PR was requested.";
    }
    await recordActivity({
      stage: "execution",
      status: failure ? "failed" : "completed",
      message: failure
        ? "Execution failed. Review the job status for details."
        : "Muse process finished. Delivery and independent verification remain separate.",
    });
    const state = failure ? "FAILED" : "TURN_FINISHED";
    const leaseFinalized = await this.db.transaction(async (tx) => {
      const finalized = await tx.query<{ id: string } & Record<string, unknown>>(
        `UPDATE muse_execution_jobs
         SET status=$3,exit_code=$4,event_count=$5,failure_reason=$6,finished_at=now(),lease_expires_at=NULL
         WHERE id=$1 AND project_id=$2 AND status='RUNNING'
           AND lease_expires_at > now()
         RETURNING id`,
        [
          job.id,
          job.project_id,
          state,
          result?.exitCode ?? null,
          result?.events.length ?? 0,
          failure || null,
        ],
      );
      // Recovery or another owner may have won the lease. A stale worker has
      // no authority to finalize a session or step after its lease expired.
      if (!finalized.rows[0]) return false;
      if (result?.reviewOutput && result.changedPaths) {
        await tx.query(
          `INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,'execution') ON CONFLICT (job_id) DO NOTHING`,
          [
            job.id,
            job.organization_id,
            job.project_id,
            result.reviewOutput,
            hashMuseReviewOutput(result.reviewOutput),
            JSON.stringify(result.changedPaths),
          ],
        );
      }
      if (failure) {
        await tx.query(
          `UPDATE project_tasks SET state='FAILED',last_error=$4,updated_at=now()
           WHERE project_id=$1 AND organization_id=$2 AND session_id=$3
             AND state IN ('STARTING','ACTIVE')`,
          [job.project_id, job.organization_id, job.agent_session_id, failure],
        );
        await tx.query(
          `UPDATE agent_sessions SET state='FAILED',ended_at=now()
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.agent_session_id, job.project_id],
        );
        await tx.query(
          `UPDATE workflow_step_executions SET state='FAILED'
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.workflow_step_id, job.project_id],
        );
      }
      // Exit 0 leaves session and step RUNNING pending independently verified CI.
      return true;
    });
    return { jobId: job.id, status: leaseFinalized ? state : "LEASE_LOST" };
  }
  /** A new read-only turn, not a replay or fabricated recovery of historical output. */
  async recoverOutput(workspace: string, selection: MuseJobSelection) {
    if (process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true")
      throw new Error("Isolated output recovery required.");
    return this.db.transaction(async (transaction) => {
      const jobs = await transaction.query<JobRow>(
        `SELECT job.*,session.mission FROM muse_execution_jobs job
         JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
         JOIN execution_contracts contract ON contract.id=session.execution_contract_id AND contract.project_id=job.project_id AND contract.organization_id=job.organization_id
         JOIN context_snapshots snapshot ON snapshot.id=s.context_snapshot_id
           AND snapshot.organization_id=s.organization_id AND snapshot.project_id=s.project_id
         JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id
         JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
         WHERE job.id=$1 AND job.project_id=$2 AND job.status='TURN_FINISHED' AND job.github_repository IS NULL
           AND step.state='RUNNING' AND step.agent_session_id=session.id AND session.state='RUNNING' AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND contract.allowed_repositories=$3::jsonb AND contract.allowed_paths=$4::jsonb
           AND contract.network_policy='none' AND contract.network_allowlist='[]'::jsonb
           AND NOT EXISTS(SELECT 1 FROM muse_job_outputs output WHERE output.job_id=job.id)
           AND NOT EXISTS(SELECT 1 FROM human_gates gate WHERE gate.project_id=job.project_id AND gate.organization_id=job.organization_id AND gate.agent_session_id=session.id AND gate.status='OPEN')
         FOR UPDATE OF job SKIP LOCKED`,
        [
          selection.jobId,
          selection.projectId,
          JSON.stringify([selection.repository]),
          JSON.stringify(selection.allowedPaths),
        ],
      );
      const job = jobs.rows[0];
      if (!job) throw new Error("Job has no recoverable missing output.");
      const result = await this.executor.execute({
        workspace,
        modelSteps: 20,
        timeoutMs: 600000,
        mission: `${job.mission}\nThis is a NEW read-only regeneration because the prior answer was not retained. Return the complete draft options and wording in your final response. Do not claim human approval, change files, run commands or implement anything.`,
      });
      if (
        result.exitCode !== 0 ||
        result.outputTruncated ||
        !result.reviewOutput ||
        !result.changedPaths ||
        result.changedPaths.length
      )
        throw new Error("No bounded read-only review output was produced.");
      await transaction.query(
        `INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source)
        VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'read_only_recovery')`,
        [
          job.id,
          job.organization_id,
          job.project_id,
          result.reviewOutput,
          hashMuseReviewOutput(result.reviewOutput),
        ],
      );
      return { jobId: job.id, status: "OUTPUT_REGENERATED" };
    });
  }
}
