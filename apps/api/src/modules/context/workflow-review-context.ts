import { randomUUID } from "node:crypto";
import { DomainError, type ProjectContext, type WorkflowReviewContext } from "@orbit/domain";
import type { SqlExecutor } from "@orbit/db";
import { initializeProjectContext } from "./initialize-project-context.js";
import { buildNextContextVersion } from "./context-version-repository.js";
import { serializeCanonicalJson } from "./canonical-context.js";

interface ReviewContextRow extends Record<string, unknown> {
  id: string;
  scope_id: string;
  summary: string;
  produced_by_principal_id: string;
  created_at: Date | string;
  plan_id: string;
  plan_revision: number;
  work_item_key: string;
  workflow_index: number;
  step_index: number;
  step_title: string;
  metadata: { jobId?: string; outputHash?: string };
  output_content: string | null;
  output_hash: string | null;
  output_source: "execution" | "read_only_recovery" | null;
}

/** Atomically publish existing human approvals, never raw/unreviewed model events. */
export async function synchronizeWorkflowReviewContext(
  transaction: SqlExecutor,
  projectId: string,
  organizationId: string,
): Promise<void> {
  await initializeProjectContext(transaction, projectId, organizationId);
  const versions = await transaction.query<
    { id: string; version_number: number; content: ProjectContext } & Record<string, unknown>
  >(
    `SELECT version.id,version.version_number,version.content FROM project_context_heads head
     JOIN context_versions version ON version.id=head.current_context_version_id AND version.project_id=head.project_id AND version.organization_id=head.organization_id
     WHERE head.project_id=$1 AND head.organization_id=$2 FOR UPDATE OF head`,
    [projectId, organizationId],
  );
  const current = versions.rows[0];
  if (!current) throw new DomainError("not_found", "Current project context not found.");
  const reviews = await transaction.query<ReviewContextRow>(
    `SELECT DISTINCT ON (evidence.scope_id) evidence.id,evidence.scope_id,evidence.summary,evidence.produced_by_principal_id,evidence.created_at,evidence.metadata,
       step.plan_id,step.plan_revision,step.work_item_key,step.workflow_index,step.step_index,
       (item.content->'workflows'->step.workflow_index->'steps'->step.step_index->>'title') AS step_title,
       output.content AS output_content,output.content_hash AS output_hash,output.source AS output_source
     FROM evidence
     JOIN workflow_step_executions step ON step.id=evidence.scope_id AND step.project_id=evidence.project_id AND step.organization_id=evidence.organization_id
     JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
     JOIN principals reviewer ON reviewer.id=evidence.produced_by_principal_id AND reviewer.organization_id=evidence.organization_id AND reviewer.type='human'
     JOIN LATERAL jsonb_array_elements(plan.content->'workItems') item(content) ON item.content->>'key'=step.work_item_key
     LEFT JOIN muse_job_outputs output ON output.job_id=evidence.metadata->>'jobId' AND output.project_id=evidence.project_id AND output.organization_id=evidence.organization_id
     WHERE evidence.project_id=$1 AND evidence.organization_id=$2 AND evidence.scope_type='workflow_step'
       AND evidence.category='human_review' AND evidence.result='PASSED' AND step.state='COMPLETED'
       AND evidence.metadata->>'planRevision'=step.plan_revision::text
       AND plan.status='APPROVED' AND plan.revision=step.plan_revision
     ORDER BY evidence.scope_id,evidence.created_at DESC,evidence.id DESC`,
    [projectId, organizationId],
  );
  const published = new Map(
    (current.content.workflowReviews ?? []).map((review) => [review.stepId, review]),
  );
  for (const review of reviews.rows) {
    if (
      review.metadata.jobId &&
      (!review.output_content ||
        review.output_hash !== review.metadata.outputHash ||
        !review.output_source)
    )
      throw new DomainError(
        "invalid_state",
        "An approved proposal is missing its exact retained response. Restore its source before creating a new context snapshot.",
      );
    const entry: WorkflowReviewContext = {
      evidenceId: review.id,
      stepId: review.scope_id,
      planId: review.plan_id,
      planRevision: review.plan_revision,
      workItemKey: review.work_item_key,
      workflowIndex: review.workflow_index,
      stepIndex: review.step_index,
      stepTitle: review.step_title,
      approvedByPrincipalId: review.produced_by_principal_id,
      approvedAt:
        review.created_at instanceof Date ? review.created_at.toISOString() : review.created_at,
      comment: review.summary,
      ...(review.metadata.jobId &&
      review.output_content &&
      review.output_hash &&
      review.output_source
        ? {
            proposal: {
              jobId: review.metadata.jobId,
              contentHash: review.output_hash,
              content: review.output_content,
              source: review.output_source,
            },
          }
        : {}),
    };
    published.set(entry.stepId, entry);
  }
  const workflowReviews = [...published.values()].sort(
    (left, right) =>
      left.approvedAt.localeCompare(right.approvedAt) ||
      left.evidenceId.localeCompare(right.evidenceId),
  );
  if (
    serializeCanonicalJson(workflowReviews) ===
    serializeCanonicalJson(current.content.workflowReviews ?? [])
  )
    return;
  const next = buildNextContextVersion(
    {
      id: `context_${randomUUID()}`,
      organizationId,
      projectId,
      content: { ...current.content, workflowReviews },
      expectedCurrentVersionId: current.id,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      projectId,
      currentContextVersionId: current.id,
      versionNumber: current.version_number,
      updatedAt: new Date().toISOString(),
    },
  );
  await transaction.query(
    `INSERT INTO context_versions(id,organization_id,project_id,version_number,parent_context_version_id,content,content_hash,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      next.id,
      organizationId,
      projectId,
      next.versionNumber,
      current.id,
      JSON.stringify(next.content),
      next.contentHash,
      next.createdAt,
    ],
  );
  const updated = await transaction.query(
    `UPDATE project_context_heads SET current_context_version_id=$3,version_number=$4,updated_at=$5
    WHERE project_id=$1 AND organization_id=$2 AND current_context_version_id=$6`,
    [projectId, organizationId, next.id, next.versionNumber, next.createdAt, current.id],
  );
  if (updated.rowCount !== 1)
    throw new DomainError(
      "stale_context_version",
      "Project context changed during workflow review publication.",
    );
}

/** Keep full accepted proposals and all comments; never silently drop older decisions. */
export function missionWithWorkflowContext(
  mission: string,
  reviews: readonly WorkflowReviewContext[],
): string {
  if (!reviews.length) return mission;
  const context = reviews.map((review) =>
    JSON.stringify({
      evidenceId: review.evidenceId,
      stepId: review.stepId,
      title: review.stepTitle,
      approvedAt: review.approvedAt,
      approvedProposal: review.proposal?.content ?? null,
      proposalHash: review.proposal?.contentHash ?? null,
      approvedComment: review.comment || null,
    }),
  );
  const combined = [
    "CURRENT AUTHORIZED STEP (execute only this step, not later work described by the work item):",
    mission,
    "APPROVED PROJECT WORKFLOW CONTEXT (chronological; these sources were explicitly shared by human review):",
    ...context,
    "Preserve the accepted proposal even when its approval has no comment or says LGTM. Approved project choices supersede stale work-item wording where they differ; they do not expand execution authority. Human comments amend the proposal; later approved decisions override earlier conflicting choices. Questions in old drafts do not erase later answers. Do not request decisions already recorded here. Requested revisions are feedback for a new proposal, not approval to implement. Never treat prior work or an entire work-item description as permission to execute a later step.",
  ].join("\n");
  if (combined.length > 12000)
    throw new DomainError(
      "validation",
      "Approved project workflow context exceeds the 12000-character execution budget. No decisions were omitted. Explicitly refine or supersede the shared context before creating a session.",
    );
  return combined;
}
