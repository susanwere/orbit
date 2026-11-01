import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase, SqlExecutor } from "@orbit/db";
import type {
  ProjectAuthorizationService,
  AuthorizedProjectActor,
} from "../projects/project-authorization.js";
import {
  validateProposedWorkGraph,
  type PlannedStep,
} from "../planning/muse-work-graph-planner.js";

import { synchronizeWorkflowReviewContext } from "../context/workflow-review-context.js";

interface ReviewStep extends Record<string, unknown> {
  id: string;
  plan_id: string;
  plan_revision: number;
  state: string;
  agent_session_id: string | null;
  completion_kind: string;
  content: unknown;
  work_item_key: string;
  workflow_index: number;
  step_index: number;
}
interface StepReference {
  projectId: string;
  stepId: string;
  principalId: string;
}

/** Human review is separate evidence; it never represents passing code/CI. */
export class WorkflowReviewService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  private async loadStep(
    transaction: SqlExecutor,
    actor: AuthorizedProjectActor,
    stepId: string,
  ): Promise<{ step: ReviewStep; plannedStep: PlannedStep }> {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `orbit:steps:${actor.organizationId}:${actor.projectId}`,
    ]);
    const records = await transaction.query<ReviewStep>(
      `SELECT step.*,plan.content FROM workflow_step_executions step
       JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
       WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3
         AND plan.status='APPROVED' AND plan.revision=step.plan_revision FOR UPDATE OF step`,
      [stepId, actor.projectId, actor.organizationId],
    );
    const step = records.rows[0];
    if (!step) throw new DomainError("not_found", "Approved workflow step not found.");
    const graph = validateProposedWorkGraph(step.content);
    const plannedStep = graph.workItems.find((item) => item.key === step.work_item_key)?.workflows[
      step.workflow_index
    ]?.steps[step.step_index];
    if (!plannedStep) throw new DomainError("invalid_state", "Step is not in the approved plan.");
    return { step, plannedStep };
  }

  private async assertUnblocked(
    transaction: SqlExecutor,
    actor: AuthorizedProjectActor,
    step: ReviewStep,
  ) {
    const blockers = await transaction.query<Record<string, unknown>>(
      `SELECT 1 FROM workflow_step_prerequisites dependency
       JOIN workflow_step_executions prerequisite ON prerequisite.id=dependency.prerequisite_step_id AND prerequisite.project_id=dependency.project_id AND prerequisite.organization_id=dependency.organization_id
       WHERE dependency.step_id=$1 AND dependency.project_id=$2 AND dependency.organization_id=$3
         AND (prerequisite.state<>'COMPLETED' OR prerequisite.plan_id<>$4)
       UNION ALL SELECT 1 FROM human_gates WHERE project_id=$2 AND organization_id=$3 AND agent_session_id=$5 AND status='OPEN'`,
      [step.id, actor.projectId, actor.organizationId, step.plan_id, step.agent_session_id],
    );
    if (blockers.rows.length)
      throw new DomainError("invalid_state", "Resolve prerequisites and open human gates first.");
  }

  private async event(
    transaction: SqlExecutor,
    actor: AuthorizedProjectActor,
    stepId: string,
    type: string,
    metadata: Record<string, unknown>,
  ) {
    await transaction.query(
      `INSERT INTO events(id,organization_id,project_id,type,occurred_at,actor_type,actor_id,entity_type,entity_id,payload)
      VALUES($1,$2,$3,$4,now(),'human',$5,'workflow_step',$6,$7::jsonb)`,
      [
        randomUUID(),
        actor.organizationId,
        actor.projectId,
        type,
        actor.principalId,
        stepId,
        JSON.stringify(metadata),
      ],
    );
  }

  async authorizeProposal(input: StepReference & { acknowledgeNonCodeStep: boolean }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (actor.role !== "admin" || input.acknowledgeNonCodeStep !== true)
      throw new DomainError(
        "forbidden",
        "An administrator must explicitly designate a proposal-only step.",
      );
    return this.database.transaction(async (transaction) => {
      const { step, plannedStep } = await this.loadStep(transaction, actor, input.stepId);
      if (plannedStep.executor !== "agent" || !["BLOCKED", "READY", "RUNNING"].includes(step.state))
        throw new DomainError(
          "invalid_state",
          "Only an active agent proposal can use output review.",
        );
      const unsafe = await transaction.query<Record<string, unknown>>(
        `SELECT 1 FROM muse_execution_jobs job LEFT JOIN muse_job_outputs output ON output.job_id=job.id
         WHERE job.workflow_step_id=$1 AND job.project_id=$2 AND job.organization_id=$3
           AND (job.github_repository IS NOT NULL OR jsonb_array_length(output.changed_paths)>0)`,
        [step.id, actor.projectId, actor.organizationId],
      );
      if (unsafe.rows.length)
        throw new DomainError(
          "invalid_state",
          "Code-producing work requires GitHub CI verification.",
        );
      await transaction.query(
        "UPDATE workflow_step_executions SET completion_kind='human_review' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [step.id, actor.projectId, actor.organizationId],
      );
      await this.event(transaction, actor, step.id, "workflow.proposal_review_authorized", {
        planId: step.plan_id,
        planRevision: step.plan_revision,
      });
      return { stepId: step.id, completionKind: "human_review" };
    });
  }

  async reviewOutput(
    input: StepReference & { outputHash: string; note?: string; decision?: "approve" | "reject" },
  ) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (
      (input.decision !== undefined && !["approve", "reject"].includes(input.decision)) ||
      (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000)) ||
      (input.decision === "reject" && !input.note?.trim()) ||
      typeof input.outputHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.outputHash)
    )
      throw new DomainError(
        "validation",
        "Review the exact output. Approval comments are optional (up to 2000 characters); requesting a revision requires feedback.",
      );
    return this.database.transaction(async (transaction) => {
      const { step, plannedStep } = await this.loadStep(transaction, actor, input.stepId);
      if (
        plannedStep.executor !== "agent" ||
        step.completion_kind !== "human_review" ||
        step.state !== "RUNNING"
      )
        throw new DomainError(
          "invalid_state",
          "Step is not an authorized proposal awaiting review.",
        );
      await this.assertUnblocked(transaction, actor, step);
      const outputs = await transaction.query<{ job_id: string } & Record<string, unknown>>(
        `SELECT output.job_id FROM muse_job_outputs output
         JOIN muse_execution_jobs job ON job.id=output.job_id AND job.project_id=output.project_id AND job.organization_id=output.organization_id
         JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
         WHERE job.workflow_step_id=$1 AND job.project_id=$2 AND job.organization_id=$3
           AND session.id=$4 AND session.state='RUNNING' AND job.status='TURN_FINISHED'
           AND job.github_repository IS NULL AND output.content_hash=$5 AND output.changed_paths='[]'::jsonb
           AND (session.human_owner_principal_id=$6 OR session.requested_by_principal_id=$6 OR $7='admin') FOR UPDATE OF job,session`,
        [
          step.id,
          actor.projectId,
          actor.organizationId,
          step.agent_session_id,
          input.outputHash,
          input.principalId,
          actor.role,
        ],
      );
      const output = outputs.rows[0];
      if (!output)
        throw new DomainError(
          "invalid_state",
          "Output changed, code changes exist, or you cannot review this session.",
        );
      if (input.decision === "reject") {
        await this.recordEvidence(
          transaction,
          actor,
          step,
          (input.note ?? "").trim(),
          step.agent_session_id,
          { jobId: output.job_id, outputHash: input.outputHash, decision: "rejected" },
          "FAILED",
        );
        await transaction.query(
          "UPDATE muse_execution_jobs SET status='FAILED',failure_reason='Proposal rejected by human review; a new authorized attempt is required.' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
          [output.job_id, actor.projectId, actor.organizationId],
        );
        await transaction.query(
          "UPDATE agent_sessions SET state='FAILED',ended_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3",
          [step.agent_session_id, actor.projectId, actor.organizationId],
        );
        await transaction.query(
          "UPDATE workflow_step_executions SET state='FAILED' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
          [step.id, actor.projectId, actor.organizationId],
        );
        return { stepId: step.id, state: "FAILED", evidenceKind: "human_review" };
      }
      await this.recordEvidence(
        transaction,
        actor,
        step,
        (input.note ?? "").trim(),
        step.agent_session_id,
        { jobId: output.job_id, outputHash: input.outputHash },
      );
      await transaction.query(
        "UPDATE agent_sessions SET state='COMPLETED',ended_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='RUNNING'",
        [step.agent_session_id, actor.projectId, actor.organizationId],
      );
      await transaction.query(
        "UPDATE workflow_step_executions SET state='COMPLETED',completed_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='RUNNING'",
        [step.id, actor.projectId, actor.organizationId],
      );
      await synchronizeWorkflowReviewContext(transaction, actor.projectId, actor.organizationId);
      return { stepId: step.id, state: "COMPLETED", evidenceKind: "human_review" };
    });
  }

  async completeHumanStep(input: StepReference & { note?: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000))
      throw new DomainError(
        "validation",
        "Optional approval comments must be at most 2000 characters.",
      );
    return this.database.transaction(async (transaction) => {
      const { step, plannedStep } = await this.loadStep(transaction, actor, input.stepId);
      if (
        plannedStep.executor !== "human" ||
        step.agent_session_id ||
        !["BLOCKED", "READY"].includes(step.state)
      )
        throw new DomainError(
          "invalid_state",
          "Only a declared human step can be completed by this review.",
        );
      await this.assertUnblocked(transaction, actor, step);
      await this.recordEvidence(transaction, actor, step, (input.note ?? "").trim(), null, {});
      await transaction.query(
        `UPDATE workflow_step_executions SET state='COMPLETED',completed_at=now(),approved_by_principal_id=$4,approved_at=now()
        WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
        [step.id, actor.projectId, actor.organizationId, input.principalId],
      );
      await synchronizeWorkflowReviewContext(transaction, actor.projectId, actor.organizationId);
      return { stepId: step.id, state: "COMPLETED", evidenceKind: "human_review" };
    });
  }

  private async recordEvidence(
    transaction: SqlExecutor,
    actor: AuthorizedProjectActor,
    step: ReviewStep,
    note: string,
    sessionId: string | null,
    metadata: Record<string, unknown>,
    reviewResult: "PASSED" | "FAILED" = "PASSED",
  ) {
    await transaction.query(
      `INSERT INTO evidence(id,organization_id,project_id,scope_type,scope_id,category,result,title,summary,produced_by_principal_id,agent_session_id,metadata)
      VALUES($1,$2,$3,'workflow_step',$4,'human_review',$9,'Authenticated human review',$5,$6,$7,$8::jsonb)`,
      [
        randomUUID(),
        actor.organizationId,
        actor.projectId,
        step.id,
        note,
        actor.principalId,
        sessionId,
        JSON.stringify({ ...metadata, planId: step.plan_id, planRevision: step.plan_revision }),
        reviewResult,
      ],
    );
    await this.event(transaction, actor, step.id, "workflow.output_reviewed", {
      ...metadata,
      note,
      planId: step.plan_id,
    });
  }
}
