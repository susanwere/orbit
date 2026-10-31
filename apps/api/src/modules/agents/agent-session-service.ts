import { randomUUID } from "node:crypto";
import { DomainError, type AgentDefinition } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { AgentContextSnapshotService } from "../context/agent-context-snapshot-service.js";

interface DefinitionRow extends Record<string, unknown> {
  definition: AgentDefinition;
  status: string;
  version: number;
}
interface OwnerRow extends Record<string, unknown> {
  id: string;
}
export class AgentSessionService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly auth: ProjectAuthorizationService,
    private readonly snapshots: AgentContextSnapshotService,
    private readonly uuid: () => string = randomUUID,
  ) {}
  async listApproved(projectId: string, principalId: string) {
    const actor = await this.auth.authorize(principalId, projectId, "read");
    const result = await this.db.query<{
      id: string;
      name: string;
      provider: string;
      version: number;
    } & Record<string, unknown>>(
      `SELECT d.id, d.definition->>'name' AS name,
              d.definition->>'provider' AS provider, d.version
       FROM orbit_agent_definition_versions d
       WHERE d.organization_id=$1 AND d.status='approved'
         AND d.version=(
           SELECT MAX(latest.version)
           FROM orbit_agent_definition_versions latest
           WHERE latest.organization_id=d.organization_id AND latest.id=d.id
         )
         AND EXISTS (
           SELECT 1 FROM project_repositories repo
           WHERE repo.project_id=$2 AND repo.organization_id=$1
             AND (d.definition->'allowedRepositories') ? repo.full_name
         )
       ORDER BY name, d.id`,
      [actor.organizationId, projectId],
    );
    return result.rows.map(({ id, name, provider, version }) => ({
      id,
      name,
      provider,
      version,
    }));
  }

  async create(input: {
    projectId: string;
    requestedBy: string;
    humanOwner: string;
    agentDefinitionId: string;
    workItemId: string;
    mission: string;
  }) {
    const actor = await this.auth.authorize(input.requestedBy, input.projectId, "review");
    if (!input.mission.trim() || input.mission.length > 2000)
      throw new DomainError("validation", "A bounded agent mission is required.");
    return this.db.transaction(async (tx) => {
      const workItem = await tx.query<Record<string, unknown>>(
        `SELECT id FROM orbit_work_items
        WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
        [input.workItemId, input.projectId, actor.organizationId],
      );
      if (!workItem.rows[0]) throw new DomainError("not_found", "Work item not found.");
      const owner = await tx.query<OwnerRow>(
        `SELECT id FROM principals
        WHERE id=$1 AND organization_id=$2 AND type='human' AND role IN ('admin','member')`,
        [input.humanOwner, actor.organizationId],
      );
      if (!owner.rows[0]) throw new DomainError("forbidden", "Human owner is not authorized.");
      const definitions = await tx.query<DefinitionRow>(
        `SELECT definition,status,version
        FROM orbit_agent_definition_versions
        WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1`,
        [actor.organizationId, input.agentDefinitionId],
      );
      const latest = definitions.rows[0];
      const agent = latest?.definition;
      if (
        !agent ||
        latest.status !== "approved" ||
        latest.version !== agent.version ||
        agent.status !== "approved" ||
        agent.organizationId !== actor.organizationId ||
        agent.id !== input.agentDefinitionId ||
        !Number.isSafeInteger(agent.version)
      )
        throw new DomainError("forbidden", "Only approved current agent definitions may run.");
      const snapshot = await this.snapshots.createWithinTransaction(tx, {
        projectId: input.projectId,
        requestedByPrincipalId: input.requestedBy,
        agent,
        mission: input.mission,
      });
      const contractId = `contract_${this.uuid()}`;
      await tx.query(
        `INSERT INTO execution_contracts(
        id,organization_id,project_id,context_snapshot_id,agent_definition_id,
        agent_definition_version,allowed_actions,approval_required_actions,
        forbidden_actions,allowed_repositories,allowed_paths,network_policy,
        network_allowlist,completion_criteria)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
          $11::jsonb,$12,$13::jsonb,$14::jsonb)`,
        [
          contractId,
          actor.organizationId,
          input.projectId,
          snapshot.id,
          agent.id,
          agent.version,
          JSON.stringify(agent.capabilities),
          JSON.stringify(agent.approvalRequiredActions),
          JSON.stringify(agent.forbiddenActions),
          JSON.stringify(agent.allowedRepositories),
          JSON.stringify(agent.allowedPaths),
          agent.networkPolicy,
          JSON.stringify(agent.networkAllowlist),
          JSON.stringify([]),
        ],
      );
      const sessionId = `session_${this.uuid()}`;
      const created = await tx.query<Record<string, unknown>>(
        `INSERT INTO agent_sessions(
        id,organization_id,project_id,agent_definition_id,agent_definition_version,
        work_item_id,requested_by_principal_id,human_owner_principal_id,mission,
        context_snapshot_id,execution_contract_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'AUTHORIZED') RETURNING *`,
        [
          sessionId,
          actor.organizationId,
          input.projectId,
          agent.id,
          agent.version,
          input.workItemId,
          input.requestedBy,
          input.humanOwner,
          input.mission,
          snapshot.id,
          contractId,
        ],
      );
      return { session: created.rows[0], snapshot, executionContractId: contractId };
    });
  }
  async get(projectId: string, principalId: string, sessionId: string) {
    await this.auth.authorize(principalId, projectId, "read");
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT s.*,cs.source_context_version_id
      FROM agent_sessions s JOIN context_snapshots cs ON cs.id=s.context_snapshot_id
      WHERE s.project_id=$1 AND s.id=$2`,
      [projectId, sessionId],
    );
    if (!result.rows[0]) throw new DomainError("not_found", "Session not found.");
    return result.rows[0];
  }
  async start(projectId: string, principalId: string, sessionId: string) {
    const actor = await this.auth.authorize(principalId, projectId, "review");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${projectId}`,
      ]);
      const eligible = await tx.query<Record<string, unknown>>(
        `SELECT step.id AS step_id
         FROM workflow_step_executions step
         JOIN agent_sessions session ON session.id=step.agent_session_id
           AND session.project_id=step.project_id AND session.organization_id=step.organization_id
         JOIN plan_proposals plan ON plan.id=step.plan_id
           AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
         WHERE session.id=$1 AND step.project_id=$2 AND step.organization_id=$3
           AND session.state='AUTHORIZED' AND step.state IN ('READY','BLOCKED')
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND (session.human_owner_principal_id=$4 OR session.requested_by_principal_id=$4
                OR $5='admin')
           AND (step.approval_required=false OR step.approved_by_principal_id IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM workflow_step_prerequisites dep
             JOIN workflow_step_executions prerequisite ON prerequisite.id=dep.prerequisite_step_id
               AND prerequisite.project_id=dep.project_id
             WHERE dep.project_id=step.project_id AND dep.step_id=step.id
               AND (prerequisite.state <> 'COMPLETED' OR prerequisite.plan_id<>step.plan_id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM human_gates gate
             WHERE gate.agent_session_id=session.id AND gate.project_id=session.project_id
               AND gate.organization_id=session.organization_id AND gate.status='OPEN'
           )
         FOR UPDATE OF step,session`,
        [sessionId, projectId, actor.organizationId, principalId, actor.role],
      );
      const stepId = eligible.rows[0]?.step_id;
      if (typeof stepId !== "string") {
        throw new DomainError("invalid_state", "Session step is blocked, unapproved, or missing.");
      }
      const started = await tx.query<Record<string, unknown>>(
        `UPDATE agent_sessions
         SET state='RUNNING',started_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='AUTHORIZED'
         RETURNING *`,
        [sessionId, projectId, actor.organizationId],
      );
      if (!started.rows[0]) throw new DomainError("invalid_state", "Session start conflict.");
      const updated = await tx.query<Record<string, unknown>>(
        `UPDATE workflow_step_executions SET state='RUNNING',started_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3
           AND agent_session_id=$4 AND state IN ('READY','BLOCKED') RETURNING id`,
        [stepId, projectId, actor.organizationId, sessionId],
      );
      if (!updated.rows[0]) throw new DomainError("invalid_state", "Step start conflict.");
      return { ...started.rows[0], workflowStepId: stepId };
    });
  }
}
