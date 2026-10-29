import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

export type GateAction = "approve" | "reject" | "request_alternative";
interface GateRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  agent_session_id: string;
  assigned_human_principal_id: string;
  status: string;
  trigger_context_version_id: string;
}
export class HumanGateService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly auth: ProjectAuthorizationService,
    private readonly uuid: () => string = randomUUID,
  ) {}
  async list(projectId: string, principalId: string) {
    const actor = await this.auth.authorize(principalId, projectId, "read");
    const result = await this.db.query<GateRow>(
      `SELECT * FROM human_gates
      WHERE project_id=$1 AND organization_id=$2
      AND (assigned_human_principal_id=$3 OR $4='admin')
      ORDER BY created_at DESC LIMIT 100`,
      [projectId, actor.organizationId, principalId, actor.role],
    );
    return result.rows;
  }
  async resolve(input: {
    projectId: string;
    gateId: string;
    principalId: string;
    action: GateAction;
    note?: string;
  }) {
    const actor = await this.auth.authorize(input.principalId, input.projectId, "review");
    if (
      !["approve", "reject", "request_alternative"].includes(input.action) ||
      (input.note !== undefined && input.note.length > 1000)
    )
      throw new DomainError("validation", "Invalid gate resolution.");
    return this.db.transaction(async (tx) => {
      const result = await tx.query<GateRow>(
        `SELECT * FROM human_gates
        WHERE project_id=$1 AND id=$2 AND organization_id=$3 FOR UPDATE`,
        [input.projectId, input.gateId, actor.organizationId],
      );
      const gate = result.rows[0];
      if (!gate) throw new DomainError("not_found", "Human gate not found.");
      if (gate.assigned_human_principal_id !== input.principalId && actor.role !== "admin")
        throw new DomainError(
          "forbidden",
          "Only the designated human or administrator can resolve this gate.",
        );
      if (gate.status !== "OPEN") throw new DomainError("invalid_state", "Gate already resolved.");
      const state =
        input.action === "approve"
          ? "RUNNING"
          : input.action === "reject"
            ? "TERMINATED"
            : "WAITING";
      const session = await tx.query<Record<string, unknown>>(
        `UPDATE agent_sessions
        SET state=$3,ended_at=CASE WHEN $3='TERMINATED' THEN now() ELSE ended_at END
        WHERE project_id=$1 AND id=$2 AND state='WAITING' RETURNING id`,
        [input.projectId, gate.agent_session_id, state],
      );
      if (!session.rows[0])
        throw new DomainError("invalid_state", "Execution is not waiting for review.");
      const next =
        input.action === "approve"
          ? "APPROVED"
          : input.action === "reject"
            ? "REJECTED"
            : "ALTERNATIVE_REQUESTED";
      await tx.query(
        `UPDATE human_gates SET status=$3,resolved_by_principal_id=$4,
        resolved_at=now(),resolution_note=$5 WHERE id=$1 AND project_id=$2`,
        [gate.id, input.projectId, next, input.principalId, input.note ?? null],
      );
      await tx.query(
        `INSERT INTO events(
        id,organization_id,project_id,type,occurred_at,correlation_id,causation_id,
        actor_type,actor_id,entity_type,entity_id,payload)
        VALUES($1,$2,$3,'human_gate.resolved',now(),$4,$5,'human',$6,
          'HumanGate',$7,$8::jsonb)`,
        [
          `event_${this.uuid()}`,
          actor.organizationId,
          input.projectId,
          `gate:${gate.id}`,
          `context-version:${gate.trigger_context_version_id}`,
          input.principalId,
          gate.id,
          JSON.stringify({
            agentSessionId: gate.agent_session_id,
            resolution: next,
            snapshotUnchanged: true,
          }),
        ],
      );
      return {
        gateId: gate.id,
        status: next,
        agentSessionId: gate.agent_session_id,
        sessionState: state,
      };
    });
  }
}
