import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

export type ProvenanceStage =
  | "intent"
  | "work_item"
  | "pull_request"
  | "decision"
  | "context_version"
  | "agent_session"
  | "ci_evidence"
  | "release";
export interface ProvenanceNode {
  id: string;
  stage: ProvenanceStage;
  title: string;
  url?: string;
  status?: string;
}
export interface ProvenanceLink {
  from: string;
  to: string;
  relation: string;
}
export interface ProvenanceTrace {
  projectId: string;
  decisionId: string;
  nodes: ProvenanceNode[];
  links: ProvenanceLink[];
  missingStages: ProvenanceStage[];
}

interface IntentRow extends Record<string, unknown> {
  id: string;
  statement: string;
}
interface DecisionRow extends Record<string, unknown> {
  id: string;
  source_artifact_id: string;
  title: string;
  status: string;
  supersedes_decision_id: string | null;
  superseded_by_decision_id: string | null;
}
interface ArtifactRow extends Record<string, unknown> {
  id: string;
  type: string;
  title: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
}
interface VersionRow extends Record<string, unknown> {
  id: string;
  version_number: number;
}
interface SessionRow extends Record<string, unknown> {
  id: string;
  mission: string;
  state: string;
  source_context_version_id: string;
}
interface EvidenceRow extends Record<string, unknown> {
  id: string;
  title: string;
  result: string;
  artifact_ref: string | null;
  agent_session_id: string | null;
  scope_type: string;
  scope_id: string;
}
const reference = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/**
 * A provenance graph is based only on explicit persisted links.
 * Missing work-item/release correlations remain gaps, never fabricated edges.
 */
export class WhyProvenanceQuery {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  async get(principalId: string, projectId: string, decisionId: string): Promise<ProvenanceTrace> {
    const actor = await this.authorization.authorize(principalId, projectId, "read");
    const decisionRows = await this.db.query<DecisionRow>(
      `SELECT id, source_artifact_id, title, status,
         supersedes_decision_id, superseded_by_decision_id
       FROM decisions WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [actor.organizationId, projectId, decisionId],
    );
    const decision = decisionRows.rows[0];
    if (!decision) throw new DomainError("not_found", "Decision not found.");

    const [intents, artifacts, versions, superseded] = await Promise.all([
      this.db.query<IntentRow>(
        "SELECT id, statement FROM intents WHERE organization_id = $1 AND project_id = $2",
        [actor.organizationId, projectId],
      ),
      this.db.query<ArtifactRow>(
        `SELECT id, type, title, url, metadata FROM source_artifacts
         WHERE organization_id = $1 AND project_id = $2
           AND (id = $3 OR id IN (
             SELECT source_artifact_id FROM decisions
             WHERE organization_id = $1 AND project_id = $2 AND id IN ($4,$5)
           ))`,
        [
          actor.organizationId,
          projectId,
          decision.source_artifact_id,
          decision.supersedes_decision_id ?? "",
          decision.superseded_by_decision_id ?? "",
        ],
      ),
      this.db.query<VersionRow>(
        `SELECT id, version_number FROM context_versions
         WHERE organization_id = $1 AND project_id = $2 AND created_from_decision_id = $3
         ORDER BY version_number ASC`,
        [actor.organizationId, projectId, decisionId],
      ),
      this.db.query<DecisionRow>(
        `SELECT id, source_artifact_id, title, status,
          supersedes_decision_id, superseded_by_decision_id
         FROM decisions WHERE organization_id = $1 AND project_id = $2
           AND id IN ($3, $4)`,
        [
          actor.organizationId,
          projectId,
          decision.supersedes_decision_id ?? "",
          decision.superseded_by_decision_id ?? "",
        ],
      ),
    ]);

    const nodes: ProvenanceNode[] = [];
    const links: ProvenanceLink[] = [];
    const insert = (node: ProvenanceNode) => {
      if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
      return node.id;
    };
    const connect = (from: string, to: string, relation: string) => {
      if (nodes.some((node) => node.id === from) && nodes.some((node) => node.id === to)) {
        links.push({ from, to, relation });
      }
    };
    const decisionNodeId = insert({
      id: `decision:${decision.id}`,
      stage: "decision",
      title: decision.title,
      status: decision.status,
    });
    for (const row of intents.rows) {
      insert({ id: `intent:${row.id}`, stage: "intent", title: row.statement });
      connect(`intent:${row.id}`, decisionNodeId, "project original intent");
    }

    const source = artifacts.rows.find((a) => a.id === decision.source_artifact_id);
    if (source) {
      const sourceIsPr = [
        "pull_request",
        "pull_request_comment",
        "pull_request_review",
        "issue_comment",
      ].includes(source.type);
      if (sourceIsPr) {
        const sourceId = insert({
          id: `artifact:${source.id}`,
          stage: "pull_request",
          title: source.title ?? "GitHub discussion",
          url: source.url ?? undefined,
        });
        connect(sourceId, decisionNodeId, "source decision evidence");
        const workItemId = reference(source.metadata?.workItemArtifactId);
        if (workItemId) {
          const linkedWork = await this.db.query<ArtifactRow>(
            `SELECT id, type, title, url, metadata FROM source_artifacts
             WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND type = 'work_item'`,
            [actor.organizationId, projectId, workItemId],
          );
          const item = linkedWork.rows[0];
          if (item) {
            const workNode = insert({
              id: `artifact:${item.id}`,
              stage: "work_item",
              title: item.title ?? "Work item",
              url: item.url ?? undefined,
            });
            connect(workNode, sourceId, "explicit work-item reference");
          }
        }
      }
    }
    for (const relative of superseded.rows) {
      const id = insert({
        id: `decision:${relative.id}`,
        stage: "decision",
        title: relative.title,
        status: relative.status,
      });
      if (relative.id === decision.supersedes_decision_id) {
        connect(id, decisionNodeId, "superseded by");
      } else if (relative.id === decision.superseded_by_decision_id) {
        connect(decisionNodeId, id, "superseded by");
      }
    }
    const versionIds = versions.rows.map((version) => version.id);
    for (const version of versions.rows) {
      const id = insert({
        id: `context:${version.id}`,
        stage: "context_version",
        title: `Context v${version.version_number}`,
      });
      connect(decisionNodeId, id, "created authoritative context");
    }
    const sessions = versionIds.length
      ? await this.db.query<SessionRow>(
          `SELECT s.id, s.mission, s.state, cs.source_context_version_id
         FROM agent_sessions s
         JOIN context_snapshots cs ON cs.id = s.context_snapshot_id AND cs.project_id = s.project_id
         WHERE s.organization_id = $1 AND s.project_id = $2
           AND cs.source_context_version_id = ANY($3::text[])
         ORDER BY s.created_at DESC LIMIT 200`,
          [actor.organizationId, projectId, versionIds],
        )
      : { rows: [] as SessionRow[] };
    for (const session of sessions.rows) {
      const id = insert({
        id: `session:${session.id}`,
        stage: "agent_session",
        title: session.mission,
        status: session.state,
      });
      connect(`context:${session.source_context_version_id}`, id, "agent snapshot from context");
    }
    const sessionIds = sessions.rows.map((s) => s.id);
    const evidence = await this.db.query<EvidenceRow>(
      `SELECT id, title, result, artifact_ref, agent_session_id, scope_type, scope_id
       FROM evidence WHERE organization_id = $1 AND project_id = $2
         AND (agent_session_id = ANY($3::text[])
           OR (scope_type = 'decision' AND scope_id = $4))
       ORDER BY created_at DESC LIMIT 200`,
      [actor.organizationId, projectId, sessionIds, decisionId],
    );
    for (const record of evidence.rows) {
      const id = insert({
        id: `evidence:${record.id}`,
        stage: "ci_evidence",
        title: record.title,
        status: record.result,
        url: record.artifact_ref ?? undefined,
      });
      if (record.agent_session_id) {
        connect(`session:${record.agent_session_id}`, id, "produced evidence");
      } else if (record.scope_type === "decision") {
        connect(decisionNodeId, id, "decision evidence");
      }
    }
    const releases = await this.db.query<ArtifactRow>(
      `SELECT id, type, title, url, metadata FROM source_artifacts
       WHERE organization_id = $1 AND project_id = $2 AND type = 'release'
         AND (metadata->>'decisionId' = $3
           OR metadata->>'contextVersionId' = ANY($4::text[])
           OR metadata->>'agentSessionId' = ANY($5::text[]))`,
      [actor.organizationId, projectId, decisionId, versionIds, sessionIds],
    );
    for (const release of releases.rows) {
      const id = insert({
        id: `artifact:${release.id}`,
        stage: "release",
        title: release.title ?? "Release",
        url: release.url ?? undefined,
      });
      const sessionId = reference(release.metadata?.agentSessionId);
      const versionId = reference(release.metadata?.contextVersionId);
      if (sessionId) connect(`session:${sessionId}`, id, "released session work");
      else if (versionId) connect(`context:${versionId}`, id, "released context version");
      else connect(decisionNodeId, id, "released decision");
    }
    const stages: ProvenanceStage[] = [
      "intent",
      "work_item",
      "pull_request",
      "decision",
      "context_version",
      "agent_session",
      "ci_evidence",
      "release",
    ];
    return {
      projectId,
      decisionId,
      nodes,
      links,
      missingStages: stages.filter((stage) => !nodes.some((node) => node.stage === stage)),
    };
  }
}
