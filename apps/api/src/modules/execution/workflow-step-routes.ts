import { GithubCiMonitor } from "./github-ci-monitor.js";
import { MuseCiRepairService } from "./muse-ci-repair-service.js";
import { DomainError } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { StepSessionBindingService } from "./step-session-binding-service.js";
import type { WorkflowStepExecutionService } from "./workflow-step-execution-service.js";
import type { ApprovedStepMaterializer } from "./approved-step-materializer.js";
import { MuseDeliveryRequestService } from "./muse-delivery-request-service.js";
import { WorkflowReviewService } from "./workflow-review-service.js";
import type { GithubCiEvidenceService } from "./github-ci-evidence-service.js";

export interface WorkflowStepRouteOptions {
  readonly auth: AuthVerifier;
  readonly db: SqlDatabase;
  readonly authorization: ProjectAuthorizationService;
  readonly materializer: ApprovedStepMaterializer;
  readonly execution: WorkflowStepExecutionService;
  readonly binding: StepSessionBindingService;
  readonly evidence?: GithubCiEvidenceService;
  readonly ciMonitor?: GithubCiMonitor;
}

/** Exposes human-controlled plan preparation and authoritative step reads.
 * Agent execution and GitHub delivery run in separate workers.
 */
export async function registerWorkflowStepRoutes(
  app: FastifyInstance,
  options: WorkflowStepRouteOptions,
) {
  const ciRepairs = new MuseCiRepairService(options.db, options.authorization);
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { jobId?: unknown; acknowledgeRepair?: unknown };
  }>("/projects/:projectId/execution/steps/:stepId/prepare-ci-repair", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (request.body?.acknowledgeRepair !== true || typeof request.body.jobId !== "string")
      throw new DomainError(
        "validation",
        "Confirm sharing the verified failure with a fresh authorized Muse attempt.",
      );
    return ciRepairs.prepare({
      ...request.params,
      principalId: principal.id,
      jobId: request.body.jobId,
    });
  });
  app.post<{ Params: { projectId: string; stepId: string }; Body: { jobId?: unknown } }>(
    "/projects/:projectId/execution/steps/:stepId/inspect-github-ci",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      const actor = await options.authorization.authorize(
        principal.id,
        request.params.projectId,
        "review",
      );
      if (typeof request.body?.jobId !== "string")
        throw new DomainError("validation", "The delivered job ID is required.");
      const linked = await options.db.query(
        "SELECT id FROM muse_execution_jobs WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND workflow_step_id=$4",
        [request.body.jobId, request.params.projectId, actor.organizationId, request.params.stepId],
      );
      if (!linked.rows.length)
        throw new DomainError("not_found", "Delivered job not found for this step.");
      if (!options.ciMonitor)
        throw new DomainError(
          "invalid_state",
          "Configure the API read-only ORBIT_GITHUB_EVIDENCE_TOKEN and restart it to inspect CI.",
        );
      return options.ciMonitor.inspect({
        jobId: request.body.jobId,
        projectId: request.params.projectId,
        organizationId: actor.organizationId,
      });
    },
  );
  const reviews = new WorkflowReviewService(options.db, options.authorization);
  const deliveries = new MuseDeliveryRequestService(options.db, options.authorization);
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { jobId?: unknown; outputHash?: unknown; acknowledgePush?: unknown };
  }>("/projects/:projectId/execution/steps/:stepId/request-delivery", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (
      request.body?.acknowledgePush !== true ||
      typeof request.body.jobId !== "string" ||
      typeof request.body.outputHash !== "string"
    )
      throw new DomainError(
        "validation",
        "Confirm pushing the reviewed generated changes and opening a pull request.",
      );
    return deliveries.request({
      ...request.params,
      principalId: principal.id,
      jobId: request.body.jobId,
      outputHash: request.body.outputHash,
    });
  });

  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { acknowledgeNonCodeStep?: boolean };
  }>("/projects/:projectId/execution/steps/:stepId/authorize-proposal-review", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    return reviews.authorizeProposal({
      ...request.params,
      principalId: principal.id,
      acknowledgeNonCodeStep: request.body?.acknowledgeNonCodeStep === true,
    });
  });
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { outputHash?: unknown; note?: unknown; decision?: unknown };
  }>("/projects/:projectId/execution/steps/:stepId/review-output", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (
      typeof request.body?.outputHash !== "string" ||
      (request.body.note !== undefined && typeof request.body.note !== "string")
    )
      throw new DomainError(
        "validation",
        "Output hash is required; approval comments are optional.",
      );
    if (
      request.body.decision !== undefined &&
      request.body.decision !== "approve" &&
      request.body.decision !== "reject"
    )
      throw new DomainError("validation", "Invalid review decision.");
    return reviews.reviewOutput({
      ...request.params,
      principalId: principal.id,
      outputHash: request.body.outputHash,
      note: request.body.note,
      decision: request.body.decision,
    });
  });
  app.post<{ Params: { projectId: string; stepId: string }; Body: { note?: unknown } }>(
    "/projects/:projectId/execution/steps/:stepId/complete-human-review",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      if (request.body?.note !== undefined && typeof request.body.note !== "string")
        throw new DomainError("validation", "Approval comments must be text.");
      return reviews.completeHumanStep({
        ...request.params,
        principalId: principal.id,
        note: request.body?.note,
      });
    },
  );
  app.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/execution/prepare",
    async (request, reply) => {
      const principal = options.auth.verify(request.headers.authorization);
      const prepared = await options.materializer.materialize(
        request.params.projectId,
        principal.id,
      );
      return reply.status(201).send(prepared);
    },
  );
  app.post<{ Params: { projectId: string; stepId: string }; Body: { sessionId?: string } }>(
    "/projects/:projectId/execution/steps/:stepId/bind-session",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      const sessionId = request.body?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
        throw new DomainError("validation", "A valid sessionId is required.");
      }
      return {
        step: await options.binding.bind({
          projectId: request.params.projectId,
          stepId: request.params.stepId,
          sessionId,
          principalId: principal.id,
        }),
      };
    },
  );
  app.post<{ Params: { projectId: string; stepId: string } }>(
    "/projects/:projectId/execution/steps/:stepId/approve",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      return {
        step: await options.execution.approve({
          projectId: request.params.projectId,
          stepId: request.params.stepId,
          principalId: principal.id,
        }),
      };
    },
  );
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { acknowledgeFailedAttempt?: boolean };
  }>("/projects/:projectId/execution/steps/:stepId/authorize-retry", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (request.body?.acknowledgeFailedAttempt !== true) {
      throw new DomainError("validation", "Explicit failed-attempt acknowledgment is required.");
    }
    return {
      step: await options.execution.authorizeRetry({
        projectId: request.params.projectId,
        stepId: request.params.stepId,
        principalId: principal.id,
      }),
    };
  });
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { jobId?: unknown; acknowledgeReplacement?: boolean };
  }>("/projects/:projectId/execution/steps/:stepId/retire-unstarted-job", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (
      request.body?.acknowledgeReplacement !== true ||
      typeof request.body?.jobId !== "string" ||
      !/^musejob_[A-Za-z0-9-]{20,80}$/.test(request.body.jobId)
    )
      throw new DomainError(
        "validation",
        "Confirm replacement and provide the exact unstarted job ID.",
      );
    return options.execution.retireUnstartedJob({
      ...request.params,
      principalId: principal.id,
      jobId: request.body.jobId,
    });
  });
  app.post<{
    Params: { projectId: string; stepId: string };
    Body: { repository?: string; runId?: number; pullNumber?: number };
  }>("/projects/:projectId/execution/steps/:stepId/verify-github-ci", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    const body = request.body;
    if (
      typeof body?.repository !== "string" ||
      typeof body.runId !== "number" ||
      typeof body.pullNumber !== "number"
    ) {
      throw new DomainError("validation", "Repository, CI run ID and PR number are required.");
    }
    if (!options.evidence) {
      await options.authorization.authorize(principal.id, request.params.projectId, "review");
      throw new DomainError(
        "invalid_state",
        "GitHub CI verification is not configured. Configure the API read-only ORBIT_GITHUB_EVIDENCE_TOKEN and restart the API before verifying this step.",
      );
    }
    return {
      step: await options.evidence.verify({
        projectId: request.params.projectId,
        stepId: request.params.stepId,
        principalId: principal.id,
        repository: body.repository,
        runId: body.runId,
        pullNumber: body.pullNumber,
      }),
    };
  });
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/execution/steps",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      const actor = await options.authorization.authorize(
        principal.id,
        request.params.projectId,
        "read",
      );
      const result = await options.db.query<Record<string, unknown>>(
        `SELECT s.id,s.plan_id,s.plan_revision,s.work_item_key,s.workflow_index,
           s.step_index,s.state,s.approval_required,s.approved_at,s.completion_kind,planned.executor,planned.title,
           s.agent_session_id,s.started_at,s.completed_at,repair.id AS ci_repair_source_job_id,
           CASE
             WHEN s.state='COMPLETED' THEN 'completed'
             WHEN s.state='FAILED' THEN 'failed'
             WHEN s.state='CANCELED' THEN 'canceled'
             WHEN s.state='RUNNING' THEN 'running'
             WHEN s.state='WAITING' AND EXISTS (SELECT 1 FROM muse_execution_jobs review_job WHERE review_job.workflow_step_id=s.id AND review_job.project_id=s.project_id AND review_job.organization_id=s.organization_id AND review_job.agent_session_id=s.agent_session_id AND review_job.status='TURN_FINISHED' AND review_job.github_ci_state='PASSED' AND review_job.github_pull_number IS NOT NULL) THEN 'pull_request_review'
             WHEN s.state='WAITING' THEN 'waiting'
             WHEN p.status IS DISTINCT FROM 'APPROVED'
                  OR p.revision IS DISTINCT FROM s.plan_revision THEN 'plan_not_approved'
             WHEN EXISTS (
               SELECT 1 FROM workflow_step_prerequisites edge
               JOIN workflow_step_executions prerequisite
                 ON prerequisite.id=edge.prerequisite_step_id
                AND prerequisite.project_id=edge.project_id
               WHERE edge.project_id=s.project_id AND edge.step_id=s.id
                 AND (prerequisite.state <> 'COMPLETED'
                      OR prerequisite.plan_id <> s.plan_id)
             ) THEN 'prerequisite_incomplete'
             WHEN s.approval_required AND s.approved_by_principal_id IS NULL
               THEN 'human_approval_required'
             WHEN planned.executor='human' THEN NULL
             WHEN s.agent_session_id IS NULL THEN 'agent_session_required'
             WHEN EXISTS (
               SELECT 1 FROM human_gates gate
               WHERE gate.project_id=s.project_id
                 AND gate.organization_id=s.organization_id
                 AND gate.agent_session_id=s.agent_session_id AND gate.status='OPEN'
             ) THEN 'human_gate_open'
             WHEN session.state IS DISTINCT FROM 'AUTHORIZED' THEN 'session_not_authorized'
             ELSE NULL
           END AS blocker_reason
         FROM workflow_step_executions s
         JOIN plan_proposals p ON p.id=s.plan_id AND p.project_id=s.project_id
           AND p.organization_id=s.organization_id
         LEFT JOIN LATERAL (
           SELECT (item.content->'workflows'->s.workflow_index->'steps'->s.step_index->>'executor') AS executor,
             (item.content->'workflows'->s.workflow_index->'steps'->s.step_index->>'title') AS title
           FROM jsonb_array_elements(p.content->'workItems') AS item(content)
           WHERE item.content->>'key'=s.work_item_key LIMIT 1
         ) planned ON true
         LEFT JOIN agent_sessions session ON session.id=s.agent_session_id
           AND session.project_id=s.project_id AND session.organization_id=s.organization_id
         LEFT JOIN LATERAL (SELECT job.id FROM muse_execution_jobs job
           WHERE job.project_id=s.project_id AND job.organization_id=s.organization_id AND job.workflow_step_id=s.id
             AND job.status='FAILED' AND job.github_ci_state='FAILED' AND job.github_pull_number IS NOT NULL
           ORDER BY job.created_at DESC,job.id DESC LIMIT 1) repair ON true
         WHERE s.project_id=$1 AND s.organization_id=$2
         ORDER BY s.work_item_key,s.workflow_index,s.step_index LIMIT 1000`,
        [actor.projectId, actor.organizationId],
      );
      return { steps: result.rows };
    },
  );
}
