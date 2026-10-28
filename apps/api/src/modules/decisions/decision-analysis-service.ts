import { createHash, randomUUID } from "node:crypto";
import type { SqlDatabase } from "@orbit/db";
import type { OrbitEvent, ProjectContext, ContextVersion } from "@orbit/domain";
import type { DecisionDetector } from "./decision-detector.js";
import { generateContextChangeProposal } from "../context/context-change-generator.js";

interface EventRow extends Record<string, unknown> {
  id: string; organization_id: string; project_id: string; type: OrbitEvent["type"];
  occurred_at: Date | string; correlation_id: string; causation_id: string;
  actor_type: OrbitEvent["actor"]["type"]; actor_id: string;
  entity_type: OrbitEvent["entityType"]; entity_id: string;
  payload: Record<string, unknown>;
}
interface VersionRow extends Record<string, unknown> {
  id: string; organization_id: string; project_id: string; version_number: number;
  content: ProjectContext; content_hash: string; created_at: Date | string;
}
const iso = (v: Date | string) => v instanceof Date ? v.toISOString() : v;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

/** Analysis runs outside DB transactions; persistence is idempotent and atomic. */
export class DecisionAnalysisService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly detector: DecisionDetector,
    private readonly systemPrincipalId: string,
    private readonly newId: () => string = randomUUID,
  ) {}

  async analyze(eventId: string): Promise<"proposed" | "ignored"> {
    const eventResult = await this.db.query<EventRow>(
      "SELECT * FROM events WHERE id=$1", [eventId],
    );
    const row = eventResult.rows[0];
    if (!row) throw new Error("Normalized event does not exist");
    const headResult = await this.db.query<VersionRow>(`
      SELECT v.* FROM context_versions v
      JOIN project_context_heads h ON h.project_id=v.project_id
        AND h.current_context_version_id=v.id
      WHERE v.project_id=$1 AND v.organization_id=$2`,
      [row.project_id,row.organization_id],
    );
    const base = headResult.rows[0];
    if (!base) throw new Error("Authoritative project context missing");
    const contextVersion: ContextVersion = {
      id:base.id,organizationId:base.organization_id,projectId:base.project_id,
      versionNumber:base.version_number,content:base.content,
      contentHash:base.content_hash,createdAt:iso(base.created_at),
    };
    const previous = await this.db.query<Record<string, unknown>>(`
      SELECT * FROM decisions WHERE project_id=$1 AND organization_id=$2 AND status='ACTIVE'
      ORDER BY created_at DESC LIMIT 20`,[row.project_id,row.organization_id]);
    const payload = row.payload;
    const artifact = payload.sourceArtifact as OrbitEvent["sourceArtifact"] | undefined;
    if (!artifact || artifact.provider !== "github" || !artifact.externalId) return "ignored";
    const event: OrbitEvent = {
      id:row.id,organizationId:row.organization_id,projectId:row.project_id,
      type:row.type,occurredAt:iso(row.occurred_at),correlationId:row.correlation_id,
      causationId:row.causation_id,
      actor:{type:row.actor_type,id:row.actor_id},
      entityType:row.entity_type,entityId:row.entity_id,
      payload:payload as OrbitEvent["payload"],sourceArtifact:artifact,
    };
    const outcome = await this.detector.detect({
      event,currentContext:base.content,activeDecisions:previous.rows.map((d) => ({
        id:String(d.id),organizationId:String(d.organization_id),projectId:String(d.project_id),
        sourceDecisionProposalId:String(d.source_decision_proposal_id),
        sourceArtifactId:String(d.source_artifact_id),
        title:String(d.title),rationale:String(d.rationale),
        alternatives:d.alternatives as string[],scope:d.scope as string[],
        status:"ACTIVE" as const,approvedByPrincipalId:String(d.approved_by_principal_id),
        createdAt:iso(d.created_at as Date | string),
      })),
    });
    if (outcome.kind === "none") return "ignored";
    const candidate = outcome.candidate;
    const digest = fingerprint(event.id);
    const proposalId = `dp_${this.newId()}`;
    const change = generateContextChangeProposal({
      id:`ccp_${this.newId()}`,organizationId:row.organization_id,
      projectId:row.project_id,decisionProposalId:proposalId,
      baseContextVersion:contextVersion,candidate,createdAt:new Date().toISOString(),
    });
    await this.db.transaction(async tx => {
      const principal = await tx.query<{id:string}>(`
        SELECT id FROM principals WHERE id=$1 AND organization_id=$2 AND type='system'`,
        [this.systemPrincipalId,row.organization_id],
      );
      if (!principal.rows[0]) throw new Error("Configured system principal is unavailable");
      const artifactId = `artifact_${fingerprint(`${row.project_id}:${artifact.type}:${artifact.externalId}`).slice(0,28)}`;
      await tx.query(`INSERT INTO source_artifacts
        (id,organization_id,project_id,provider,type,external_id,url,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT(project_id,provider,type,external_id) DO NOTHING`,
        [artifactId,row.organization_id,row.project_id,artifact.provider,artifact.type,
          artifact.externalId,artifact.url??null,JSON.stringify({sourceEventId:row.id})]);
      const inserted = await tx.query<{id:string}>(`INSERT INTO decision_proposals
        (id,organization_id,project_id,source_artifact_id,source_quote,title,
         rationale,alternatives,scope,confidence,base_context_version_id,
         status,detected_by_principal_id,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,
          'READY_FOR_REVIEW',$12,$13)
        ON CONFLICT(project_id,source_artifact_id,fingerprint) DO NOTHING RETURNING id`,
        [proposalId,row.organization_id,row.project_id,artifactId,candidate.evidenceQuote,
          candidate.title,candidate.rationale,JSON.stringify(candidate.alternatives),
          JSON.stringify(candidate.scope),candidate.confidence,base.id,this.systemPrincipalId,digest]);
      if (!inserted.rows.length) return;
      await tx.query(`INSERT INTO context_change_proposals
        (id,organization_id,project_id,decision_proposal_id,base_context_version_id,
         revision,operations,resulting_context_preview,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
        [change.id,change.organizationId,change.projectId,change.decisionProposalId,
          change.baseContextVersionId,change.revision,JSON.stringify(change.operations),
          JSON.stringify(change.resultingContextPreview),change.status,change.createdAt,change.updatedAt]);
    });
    return "proposed";
  }
}
