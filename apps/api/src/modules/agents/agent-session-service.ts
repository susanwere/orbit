import { randomUUID } from "node:crypto";
import { DomainError, type AgentDefinition } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { AgentContextSnapshotService } from "../context/agent-context-snapshot-service.js";

interface DefinitionRow extends Record<string,unknown> { definition:AgentDefinition }
interface OwnerRow extends Record<string,unknown> { id:string }
export class AgentSessionService {
  constructor(
    private readonly db:SqlDatabase,
    private readonly auth:ProjectAuthorizationService,
    private readonly snapshots:AgentContextSnapshotService,
    private readonly uuid:()=>string=randomUUID,
  ){}
  async create(input:{
    projectId:string;requestedBy:string;humanOwner:string;agentDefinitionId:string;
    workItemId:string;mission:string;
  }){
    const actor=await this.auth.authorize(input.requestedBy,input.projectId,"review");
    if(!input.mission.trim()||input.mission.length>2000)
      throw new DomainError("validation","A bounded agent mission is required.");
    return this.db.transaction(async tx=>{
      const workItem=await tx.query<Record<string,unknown>>(`SELECT id FROM orbit_work_items
        WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
        [input.workItemId,input.projectId,actor.organizationId]);
      if(!workItem.rows[0])throw new DomainError("not_found","Work item not found.");
      const owner=await tx.query<OwnerRow>(`SELECT id FROM principals
        WHERE id=$1 AND organization_id=$2 AND type='human' AND role IN ('admin','member')`,
        [input.humanOwner,actor.organizationId]);
      if(!owner.rows[0])throw new DomainError("forbidden","Human owner is not authorized.");
      const definitions=await tx.query<DefinitionRow>(`SELECT definition
        FROM orbit_agent_definition_versions
        WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1`,
        [actor.organizationId,input.agentDefinitionId]);
      const agent=definitions.rows[0]?.definition;
      if(!agent||agent.status!=="approved"||agent.organizationId!==actor.organizationId||
         agent.id!==input.agentDefinitionId||!Number.isSafeInteger(agent.version))
        throw new DomainError("forbidden","Only approved current agent definitions may run.");
      const snapshot=await this.snapshots.createWithinTransaction(tx,{
        projectId:input.projectId,requestedByPrincipalId:input.requestedBy,
        agent,mission:input.mission,
      });
      const contractId=`contract_${this.uuid()}`;
      await tx.query(`INSERT INTO execution_contracts(
        id,organization_id,project_id,context_snapshot_id,agent_definition_id,
        agent_definition_version,allowed_actions,approval_required_actions,
        forbidden_actions,allowed_repositories,allowed_paths,network_policy,
        network_allowlist,completion_criteria)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
          $11::jsonb,$12,$13::jsonb,$14::jsonb)`,
        [contractId,actor.organizationId,input.projectId,snapshot.id,agent.id,agent.version,
          JSON.stringify(agent.capabilities),JSON.stringify(agent.approvalRequiredActions),
          JSON.stringify(agent.forbiddenActions),JSON.stringify(agent.allowedRepositories),
          JSON.stringify(agent.allowedPaths),agent.networkPolicy,
          JSON.stringify(agent.networkAllowlist),JSON.stringify([])]);
      const sessionId=`session_${this.uuid()}`;
      const created=await tx.query<Record<string,unknown>>(`INSERT INTO agent_sessions(
        id,organization_id,project_id,agent_definition_id,agent_definition_version,
        work_item_id,requested_by_principal_id,human_owner_principal_id,mission,
        context_snapshot_id,execution_contract_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'AUTHORIZED') RETURNING *`,
        [sessionId,actor.organizationId,input.projectId,agent.id,agent.version,
          input.workItemId,input.requestedBy,input.humanOwner,input.mission,
          snapshot.id,contractId]);
      return {session:created.rows[0],snapshot,executionContractId:contractId};
    });
  }
  async get(projectId:string,principalId:string,sessionId:string){
    await this.auth.authorize(principalId,projectId,"read");
    const result=await this.db.query<Record<string,unknown>>(`SELECT s.*,cs.source_context_version_id
      FROM agent_sessions s JOIN context_snapshots cs ON cs.id=s.context_snapshot_id
      WHERE s.project_id=$1 AND s.id=$2`,[projectId,sessionId]);
    if(!result.rows[0])throw new DomainError("not_found","Session not found.");
    return result.rows[0];
  }
  async start(projectId:string,principalId:string,sessionId:string){
    const actor=await this.auth.authorize(principalId,projectId,"review");
    const result=await this.db.query<Record<string,unknown>>(`UPDATE agent_sessions
      SET state='RUNNING',started_at=now()
      WHERE project_id=$1 AND id=$2 AND state='AUTHORIZED'
        AND (human_owner_principal_id=$3 OR requested_by_principal_id=$3 OR $4='admin')
      RETURNING *`,[projectId,sessionId,principalId,actor.role]);
    if(!result.rows[0])throw new DomainError("invalid_state","Session is not authorized to start.");
    return result.rows[0];
  }
}
