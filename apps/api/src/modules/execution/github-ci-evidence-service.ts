import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

interface GithubRun {
  status?: string;
  conclusion?: string | null;
  event?: string;
  name?: string;
  head_sha?: string;
  repository?: { full_name?: string };
}
interface GithubPull {
  number?: number;
  head?: { sha?: string };
  base?: { repo?: { full_name?: string } };
  merged_at?: string | null;
}

/**
 * Independently verify GitHub CI and merged PR evidence before completing an
 * engineering step. Never accept user-reported CI status or agent exit code.
 */
export class GithubCiEvidenceService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly githubToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly uuid: () => string = randomUUID,
  ) {}

  async verify(input: {
    projectId: string;
    principalId: string;
    stepId: string;
    repository: string;
    runId: number;
    pullNumber: number;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !Number.isSafeInteger(input.runId) ||
      input.runId < 1 ||
      !Number.isSafeInteger(input.pullNumber) ||
      input.pullNumber < 1 ||
      !this.githubToken
    ) {
      throw new DomainError("validation", "A valid GitHub repository, run, and PR are required.");
    }
    const [owner, repository] = input.repository.split("/");
    const base = `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}`;
    const load = async <T>(suffix: string): Promise<T> => {
      const response = await this.fetchImpl(base + suffix, {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new DomainError("invalid_state", "GitHub evidence could not be independently verified.");
      }
      return (await response.json()) as T;
    };
    const run = await load<GithubRun>(`/actions/runs/${input.runId}`);
    const pull = await load<GithubPull>(`/pulls/${input.pullNumber}`);
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.event !== "pull_request" ||
      run.name !== "CI" ||
      run.repository?.full_name !== input.repository ||
      pull.number !== input.pullNumber ||
      pull.base?.repo?.full_name !== input.repository ||
      !pull.merged_at ||
      !run.head_sha ||
      run.head_sha !== pull.head?.sha
    ) {
      throw new DomainError("invalid_state", "GitHub PR and successful CI evidence do not match.");
    }

    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const eligible = await tx.query<
        { agent_session_id: string; job_id: string } & Record<string, unknown>
      >(
        `SELECT step.agent_session_id,job.id AS job_id
         FROM workflow_step_executions step
         JOIN plan_proposals plan ON plan.id=step.plan_id
           AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
         JOIN agent_sessions session ON session.id=step.agent_session_id
           AND session.project_id=step.project_id AND session.organization_id=step.organization_id
         JOIN execution_contracts contract ON contract.id=session.execution_contract_id
           AND contract.project_id=session.project_id
           AND contract.organization_id=session.organization_id
         JOIN muse_execution_jobs job ON job.agent_session_id=session.id
           AND job.project_id=step.project_id AND job.organization_id=step.organization_id
           AND job.workflow_step_id=step.id
         WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3
           AND step.state='RUNNING' AND session.state='RUNNING'
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND job.status='TURN_FINISHED'
           AND contract.allowed_repositories @> $4::jsonb
           AND NOT EXISTS (
             SELECT 1 FROM human_gates gate WHERE gate.project_id=step.project_id
               AND gate.organization_id=step.organization_id
               AND gate.agent_session_id=session.id AND gate.status='OPEN'
           )
         FOR UPDATE OF step,session,job`,
        [input.stepId, input.projectId, actor.organizationId, JSON.stringify([input.repository])],
      );
      const ready = eligible.rows[0];
      if (!ready) {
        throw new DomainError("invalid_state", "Execution is not eligible for CI-backed completion.");
      }
      await tx.query(
        `INSERT INTO evidence
         (id,organization_id,project_id,scope_type,scope_id,category,result,title,
          summary,artifact_ref,produced_by_principal_id,agent_session_id,metadata)
         VALUES($1,$2,$3,'workflow_step',$4,'ci','PASSED','Verified GitHub CI',
                'Merged pull request with independently verified passing CI',$5,$6,$7,$8::jsonb)`,
        [
          `evidence_${this.uuid()}`,
          actor.organizationId,
          input.projectId,
          input.stepId,
          `https://github.com/${input.repository}/actions/runs/${input.runId}`,
          input.principalId,
          ready.agent_session_id,
          JSON.stringify({
            provider: "github",
            repository: input.repository,
            runId: input.runId,
            pullNumber: input.pullNumber,
            headSha: run.head_sha,
          }),
        ],
      );
      await tx.query(
        `UPDATE agent_sessions SET state='COMPLETED',ended_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='RUNNING'`,
        [ready.agent_session_id, input.projectId, actor.organizationId],
      );
      const completed = await tx.query<Record<string, unknown>>(
        `UPDATE workflow_step_executions SET state='COMPLETED',completed_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='RUNNING'
         RETURNING id,state`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (!completed.rows[0]) {
        throw new DomainError("invalid_state", "Workflow step completion conflicted.");
      }
      return completed.rows[0];
    });
  }
}
