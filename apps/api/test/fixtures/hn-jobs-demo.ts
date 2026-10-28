import type { SqlDatabase } from "@orbit/db";
import {
  hashProjectContext,
} from "../../src/modules/context/canonical-context.js";
import {
  generateContextChangeProposal,
} from "../../src/modules/context/context-change-generator.js";
import {
  normalizeGitHubWebhook,
} from "../../src/modules/integrations/github/event-normalizer.js";
import {
  PostgresDecisionPromotion,
  type PromotionIdKind,
} from "../../src/modules/decisions/postgres-decision-promotion.js";
import {
  AgentContextSnapshotService,
} from "../../src/modules/context/agent-context-snapshot-service.js";
import {
  ProjectAuthorizationService,
} from "../../src/modules/projects/project-authorization.js";
import type { CommittedDomainEvent, DomainEventPublisher } from "../../src/modules/events/domain-event-publisher.js";
import type { AgentDefinition, ContextVersion, ProjectContext } from "@orbit/domain";

const at = "2026-10-28T12:00:00.000Z";
const decisionText = "Fetch 20 jobs initially and use explicit Load More rather than infinite scroll";

const ids = {
  organization: "demo_hn_org",
  project: "demo_hn_jobs",
  human: "demo_human_review",
  intent: "demo_original_intent",
  work: "demo_work_item",
  source: "demo_pr_comment",
  base: "demo_context_v3",
  proposal: "demo_decision_proposal",
  change: "demo_context_change",
  decision: "D-107",
  approval: "demo_approval",
  current: "demo_context_v4",
  snapshot: "demo_snapshot",
  contract: "demo_execution_contract",
  session: "demo_agent_session",
} as const;

class Collector implements DomainEventPublisher {
  events: CommittedDomainEvent[] = [];
  async publish(events: readonly CommittedDomainEvent[]) { this.events.push(...events); }
}

/** Explicitly fake model interpretation, real normalization/governance/persistence. */
export async function replayHnJobsDemo(db: SqlDatabase) {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("The HN demo replay may run only against the test database.");
  }
  // Fixed test identifiers make the replay reproducible; clean only this fixture's tenant.
  await db.query("DELETE FROM organizations WHERE id = $1", [ids.organization]);

  await db.query("INSERT INTO organizations(id, name) VALUES($1,'HN Demo')", [ids.organization]);
  await db.query(
    "INSERT INTO projects(id, organization_id, name) VALUES($1,$2,'HN Jobs')",
    [ids.project, ids.organization],
  );
  await db.query(
    `INSERT INTO principals(id, organization_id, type, display_name, role)
     VALUES ($1,$2,'human','Demo Reviewer','admin')`,
    [ids.human, ids.organization],
  );
  await db.query(
    `INSERT INTO intents(id, organization_id, project_id, statement, created_by_principal_id)
     VALUES ($1,$2,$3,'Build a responsive Hacker News Jobs viewer',$4)`,
    [ids.intent, ids.organization, ids.project, ids.human],
  );

  const baseContent: ProjectContext = {
    projectId: ids.project,
    originalIntentId: ids.intent,
    currentIntent: "Build a responsive Hacker News Jobs viewer",
    constraints: [],
    attributes: { pageSize: 20 },
  };
  const baseVersion: ContextVersion = {
    id: ids.base,
    organizationId: ids.organization,
    projectId: ids.project,
    versionNumber: 3,
    content: baseContent,
    contentHash: hashProjectContext(baseContent),
    createdAt: at,
  };
  await db.query(
    `INSERT INTO context_versions(id,organization_id,project_id,version_number,content,content_hash,created_at)
     VALUES($1,$2,$3,3,$4::jsonb,$5,$6)`,
    [ids.base, ids.organization, ids.project,
      JSON.stringify(baseContent), baseVersion.contentHash, at],
  );
  await db.query(
    `INSERT INTO project_context_heads(
       project_id,organization_id,current_context_version_id,version_number,updated_at
     ) VALUES($1,$2,$3,3,$4)`,
    [ids.project, ids.organization, ids.base, at],
  );

  const webhook = normalizeGitHubWebhook({
    organizationId: ids.organization,
    projectId: ids.project,
    deliveryId: "hn-demo-delivery-1",
    eventName: "issue_comment",
    receivedAt: at,
    payload: {
      action: "created",
      repository: { full_name: "demo/hn-jobs" },
      issue: { number: 42, pull_request: {} },
      comment: {
        id: 107, body: decisionText,
        created_at: at,
        html_url: "https://github.com/demo/hn-jobs/pull/42#issuecomment-107",
      },
      sender: { id: 7, login: "maintainer", type: "User" },
    },
  });
  if (webhook?.type !== "pull_request.comment_created") {
    throw new Error("Demo webhook normalization failed.");
  }

  await db.query(
    `INSERT INTO source_artifacts(
       id,organization_id,project_id,provider,type,external_id,title,url,metadata
     ) VALUES ($1,$2,$3,'linear','work_item','HN-1','HN jobs list',
       'https://linear.app/demo/issue/HN-1','{}'::jsonb)`,
    [ids.work, ids.organization, ids.project],
  );
  await db.query(
    `INSERT INTO source_artifacts(
       id,organization_id,project_id,provider,type,external_id,title,url,metadata
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      ids.source, ids.organization, ids.project,
      webhook.sourceArtifact.provider, webhook.sourceArtifact.type,
      webhook.sourceArtifact.externalId, "PR #42 discussion",
      webhook.sourceArtifact.url,
      JSON.stringify({ workItemArtifactId: ids.work, orbitEventId: webhook.id }),
    ],
  );
  // Frozen, evidence-grounded Muse output. The replay does not call a model API.
  const candidate = {
    title: decisionText,
    rationale: "Reduce initial payload and keep pagination user controlled.",
    alternatives: ["Infinite scroll"],
    scope: ["jobs list"],
    confidence: 0.99,
    evidenceQuote: decisionText,
  };
  await db.query(
    `INSERT INTO decision_proposals(
       id,organization_id,project_id,source_artifact_id,source_quote,title,
       rationale,alternatives,scope,confidence,base_context_version_id,
       status,detected_by_principal_id,fingerprint
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,
       'READY_FOR_REVIEW',$12,'demo-stable-fingerprint')`,
    [
      ids.proposal, ids.organization, ids.project, ids.source,
      candidate.evidenceQuote, candidate.title, candidate.rationale,
      JSON.stringify(candidate.alternatives), JSON.stringify(candidate.scope),
      candidate.confidence, ids.base, ids.human,
    ],
  );
  const change = generateContextChangeProposal({
    id: ids.change,
    organizationId: ids.organization,
    projectId: ids.project,
    decisionProposalId: ids.proposal,
    baseContextVersion: baseVersion,
    candidate,
    createdAt: at,
  });
  await db.query(
    `INSERT INTO context_change_proposals(
      id,organization_id,project_id,decision_proposal_id,base_context_version_id,
      revision,operations,resulting_context_preview,status,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [
      ids.change, ids.organization, ids.project, ids.proposal, ids.base,
      change.revision, JSON.stringify(change.operations),
      JSON.stringify(change.resultingContextPreview), change.status, at, at,
    ],
  );
  const collector = new Collector();
  let eventCounter = 0;
  const idFactory = (kind: PromotionIdKind): string => {
    if (kind === "approval") return ids.approval;
    if (kind === "decision") return ids.decision;
    if (kind === "context") return ids.current;
    return `demo_event_${++eventCounter}`;
  };
  const result = await new PostgresDecisionPromotion(db, collector, idFactory)
    .promote({
      organizationId: ids.organization, projectId: ids.project,
      decisionProposalId: ids.proposal, contextChangeProposalId: ids.change,
      expectedContextVersionId: ids.base, approvedByPrincipalId: ids.human,
      approvedAt: at,
    });
  const agent: AgentDefinition = {
    id: "demo_engineering_agent", organizationId: ids.organization,
    name: "Engineering Agent", purpose: "Implement HN Jobs UI",
    provider: "meta", model: "muse", capabilities: ["repo.read"],
    approvedTools: [], maxContextClassification: "INTERNAL",
    allowedContextScopes: ["project"],
    allowedRepositories: ["demo/hn-jobs"], allowedPaths: ["apps/**"],
    approvalRequiredActions: [], forbiddenActions: [],
    networkPolicy: "none", networkAllowlist: [],
    status: "approved", version: 1, createdByPrincipalId: ids.human, createdAt: at,
  };
  const snapshot = await new AgentContextSnapshotService(
    db, new ProjectAuthorizationService(db),
    () => ids.snapshot, () => at,
  ).create({
    projectId: ids.project,
    requestedByPrincipalId: ids.human,
    agent,
    mission: "Implement jobs list Load More",
  });
  await db.query(
    `INSERT INTO execution_contracts(
       id,organization_id,project_id,context_snapshot_id,
       agent_definition_id,agent_definition_version,network_policy
     ) VALUES($1,$2,$3,$4,$5,1,'none')`,
    [ids.contract, ids.organization, ids.project, ids.snapshot, agent.id],
  );
  await db.query(
    `INSERT INTO agent_sessions(
      id,organization_id,project_id,agent_definition_id,
      agent_definition_version,work_item_id,requested_by_principal_id,
      human_owner_principal_id,mission,context_snapshot_id,
      execution_contract_id,state
    ) VALUES ($1,$2,$3,$4,1,$5,$6,$6,$7,$8,$9,'AUTHORIZED')`,
    [
      ids.session, ids.organization, ids.project, agent.id, ids.work,
      ids.human, "Implement jobs list Load More", ids.snapshot, ids.contract,
    ],
  );
  return {
    normalizedEventId: webhook.id,
    reviewedOperations: change.operations,
    decisionId: result.decisionId,
    decisionStatus: "ACTIVE" as const,
    contextVersion: result.versionNumber,
    previousContextVersionId: ids.base,
    currentContextVersionId: result.contextVersionId,
    eventTypes: collector.events.map((e) => e.type),
    futureSessionId: ids.session,
    futureSessionContextVersionId: snapshot.sourceContextVersionId,
    includedDecisionIds: snapshot.includedDecisionIds,
  };
}
