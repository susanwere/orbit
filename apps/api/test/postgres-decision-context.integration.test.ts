import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";
import { generateContextChangeProposal } from "../src/modules/context/context-change-generator.js";
import { PostgresDecisionPromotion } from "../src/modules/decisions/postgres-decision-promotion.js";
import { PostgresWebhookInboxStore } from "../src/modules/integrations/github/webhook-inbox.js";
import { DecisionReviewRepository } from "../src/modules/decisions/decision-review-repository.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { ContextVersionRepository } from "../src/modules/context/context-version-repository.js";
import { PostgresExecutionImpactService } from "../src/modules/execution/postgres-execution-impact.js";
import type { AgentDefinition } from "@orbit/domain";
import type { ContextVersion, ProjectContext } from "@orbit/domain";
import type { CommittedDomainEvent, DomainEventPublisher } from "../src/modules/events/domain-event-publisher.js";

const at = "2026-10-28T10:00:00.000Z";
const connection = process.env.TEST_DATABASE_URL;

interface Fixture {
  organizationId: string;
  projectId: string;
  principalId: string;
  version: ContextVersion;
}

class RecordingPublisher implements DomainEventPublisher {
  events: CommittedDomainEvent[] = [];
  async publish(events: readonly CommittedDomainEvent[]) {
    this.events.push(...events);
  }
}

describe.skipIf(!connection)("PostgreSQL decision/context integration", () => {
  let db: PgDatabase;
  const organizations: string[] = [];
  beforeAll(() => { db = new PgDatabase(connection!); });
  afterAll(async () => {
    for (const organizationId of organizations) {
      await db.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
    }
    await db.close();
  });

  async function createFixture(): Promise<Fixture> {
    const key = randomUUID();
    const organizationId = `org_${key}`;
    const projectId = `project_${key}`;
    const principalId = `reviewer_${key}`;
    const intentId = `intent_${key}`;
    const context: ProjectContext = {
      projectId, originalIntentId: intentId, currentIntent: "Build jobs",
      constraints: [], attributes: {},
    };
    const version: ContextVersion = {
      id: `context_${key}`, organizationId, projectId,
      versionNumber: 3, content: context,
      contentHash: hashProjectContext(context), createdAt: at,
    };
    organizations.push(organizationId);
    await db.query("INSERT INTO organizations(id, name) VALUES($1, 'Test org')", [organizationId]);
    await db.query(
      "INSERT INTO projects(id, organization_id, name) VALUES($1, $2, $3)",
      [projectId, organizationId, `Project ${key}`],
    );
    await db.query(
      "INSERT INTO principals(id, organization_id, type, display_name, role) VALUES($1,$2,'human','Reviewer','admin')",
      [principalId, organizationId],
    );
    await db.query(
      "INSERT INTO intents(id, organization_id, project_id, statement, created_by_principal_id) VALUES($1,$2,$3,'Build jobs',$4)",
      [intentId, organizationId, projectId, principalId],
    );
    await db.query(
      `INSERT INTO context_versions(
        id, organization_id, project_id, version_number, content, content_hash, created_at
      ) VALUES($1,$2,$3,3,$4::jsonb,$5,$6)`,
      [version.id, organizationId, projectId, JSON.stringify(context), version.contentHash, at],
    );
    await db.query(
      `INSERT INTO project_context_heads(
         project_id, organization_id, current_context_version_id, version_number, updated_at
       ) VALUES($1,$2,$3,3,$4)`,
      [projectId, organizationId, version.id, at],
    );
    return { organizationId, projectId, principalId, version };
  }

  async function createProposal(fixture: Fixture, label = "one") {
    const artifactId = `art_${randomUUID()}`;
    const proposalId = `dp_${randomUUID()}`;
    const changeId = `ccp_${randomUUID()}`;
    await db.query(
      `INSERT INTO source_artifacts(
        id, organization_id, project_id, provider, type, external_id, title, metadata
      ) VALUES($1,$2,$3,'github','pull_request_comment',$4,'Load More','{}'::jsonb)`,
      [artifactId, fixture.organizationId, fixture.projectId, `${label}-${artifactId}`],
    );
    await db.query(
      `INSERT INTO decision_proposals(
        id, organization_id, project_id, source_artifact_id, title, rationale,
        alternatives, scope, confidence, base_context_version_id, status,
        detected_by_principal_id, fingerprint
      ) VALUES ($1,$2,$3,$4,'Use explicit Load More','Manual pagination',
        '[]'::jsonb,'["jobs"]'::jsonb,0.95,$5,'READY_FOR_REVIEW',$6,$7)`,
      [
        proposalId, fixture.organizationId, fixture.projectId, artifactId,
        fixture.version.id, fixture.principalId, `fingerprint_${proposalId}`,
      ],
    );
    const proposal = generateContextChangeProposal({
      id: changeId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      decisionProposalId: proposalId,
      baseContextVersion: fixture.version,
      candidate: {
        title: "Use explicit Load More", rationale: "Manual pagination",
        confidence: 0.95, alternatives: [], scope: ["jobs"],
        evidenceQuote: "Use explicit Load More",
      },
      createdAt: at,
    });
    await db.query(
      `INSERT INTO context_change_proposals(
        id, organization_id, project_id, decision_proposal_id,
        base_context_version_id, revision, operations,
        resulting_context_preview, status, created_at, updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [
        changeId, fixture.organizationId, fixture.projectId, proposalId,
        fixture.version.id, proposal.revision,
        JSON.stringify(proposal.operations), JSON.stringify(proposal.resultingContextPreview),
        proposal.status, at, at,
      ],
    );
    return { proposalId, changeId };
  }

  const promoter = (db: PgDatabase, publisher: RecordingPublisher) =>
    new PostgresDecisionPromotion(db, publisher);
  const approvalInput = (f: Fixture, ids: { proposalId: string; changeId: string }) => ({
    organizationId: f.organizationId,
    projectId: f.projectId,
    decisionProposalId: ids.proposalId,
    contextChangeProposalId: ids.changeId,
    expectedContextVersionId: f.version.id,
    approvedByPrincipalId: f.principalId,
    approvedAt: at,
  });

  it("persists an atomic approval, immutable v4 and committed events", async () => {
    const fixture = await createFixture();
    const ids = await createProposal(fixture);
    const publisher = new RecordingPublisher();
    const result = await promoter(db, publisher).promote(approvalInput(fixture, ids));
    expect(result.versionNumber).toBe(4);
    const head = await db.query<{ current_context_version_id: string }>(
      "SELECT current_context_version_id FROM project_context_heads WHERE project_id = $1",
      [fixture.projectId],
    );
    expect(head.rows[0]?.current_context_version_id).toBe(result.contextVersionId);
    const content = await db.query<{ content: ProjectContext }>(
      "SELECT content FROM context_versions WHERE id = $1", [result.contextVersionId],
    );
    expect(content.rows[0]?.content.constraints[0]?.sourceDecisionId).toBe(result.decisionId);
    const approvals = await db.query<{ id: string }>(
      "SELECT id FROM approvals WHERE project_id = $1", [fixture.projectId],
    );
    expect(approvals.rowCount).toBe(1);
    expect(publisher.events.map((e) => e.type)).toEqual([
      "decision.accepted", "context.version_created", "context.updated",
    ]);
    const events = await db.query<{ id: string }>(
      "SELECT id FROM events WHERE project_id = $1", [fixture.projectId],
    );
    expect(events.rowCount).toBe(3);
  });

  it("blocks concurrent stale approvals with no second authoritative decision", async () => {
    const fixture = await createFixture();
    const first = await createProposal(fixture, "first");
    const second = await createProposal(fixture, "second");
    const publisher = new RecordingPublisher();
    await promoter(db, publisher).promote(approvalInput(fixture, first));
    await expect(promoter(db, publisher).promote(approvalInput(fixture, second)))
      .rejects.toMatchObject({ code: "stale_context_version" });
    const decisions = await db.query<{ id: string }>(
      "SELECT id FROM decisions WHERE project_id = $1", [fixture.projectId],
    );
    expect(decisions.rowCount).toBe(1);
    expect(publisher.events).toHaveLength(3);
  });

  it("rolls back invalid preview without partial Approval, Decision or context", async () => {
    const fixture = await createFixture();
    const ids = await createProposal(fixture);
    await db.query(
      "UPDATE context_change_proposals SET resulting_context_preview = $2::jsonb WHERE id = $1",
      [ids.changeId, JSON.stringify({ ...fixture.version.content, currentIntent: "tampered" })],
    );
    const publisher = new RecordingPublisher();
    await expect(promoter(db, publisher).promote(approvalInput(fixture, ids)))
      .rejects.toMatchObject({ code: "invalid_context_preview" });
    for (const table of ["decisions", "approvals", "events"]) {
      const count = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE project_id = $1`,
        [fixture.projectId],
      );
      expect(count.rows[0]?.count).toBe("0");
    }
    const head = await db.query<{ current_context_version_id: string }>(
      "SELECT current_context_version_id FROM project_context_heads WHERE project_id = $1",
      [fixture.projectId],
    );
    expect(head.rows[0]?.current_context_version_id).toBe(fixture.version.id);
    expect(publisher.events).toHaveLength(0);
  });

  it("rejects proposals without changing the authoritative context", async () => {
    const fixture = await createFixture();
    const ids = await createProposal(fixture);
    const repository = new DecisionReviewRepository(db);
    await repository.reject(fixture.projectId, ids.proposalId, ids.changeId, at);
    const head = await db.query<{ current_context_version_id: string }>(
      "SELECT current_context_version_id FROM project_context_heads WHERE project_id = $1",
      [fixture.projectId],
    );
    expect(head.rows[0]?.current_context_version_id).toBe(fixture.version.id);
    const decisions = await db.query<{ status: string }>(
      "SELECT status FROM decision_proposals WHERE id = $1", [ids.proposalId],
    );
    expect(decisions.rows[0]?.status).toBe("REJECTED");
    const authoritative = await db.query<{ id: string }>(
      "SELECT id FROM decisions WHERE project_id = $1", [fixture.projectId],
    );
    expect(authoritative.rowCount).toBe(0);
  });

  it("enforces authorization across projects and rejects viewer approvals", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const authorization = new ProjectAuthorizationService(db);
    await expect(authorization.authorize(other.principalId, fixture.projectId, "review"))
      .rejects.toMatchObject({ code: "forbidden" });
    await db.query("UPDATE principals SET role = 'viewer' WHERE id = $1", [fixture.principalId]);
    await expect(authorization.authorize(fixture.principalId, fixture.projectId, "review"))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("future snapshots inherit approved v4; running snapshots remain frozen across updates", async () => {
    const fixture = await createFixture();
    const ids = await createProposal(fixture);
    const publisher = new RecordingPublisher();
    const result = await promoter(db, publisher).promote(approvalInput(fixture, ids));
    const agent: AgentDefinition = {
      id: `agent_${randomUUID()}`, organizationId: fixture.organizationId,
      name: "Engineering", purpose: "Build jobs",
      provider: "meta", model: "muse",
      capabilities: ["repo.read"], approvedTools: [],
      maxContextClassification: "INTERNAL",
      allowedContextScopes: ["project"],
      allowedRepositories: ["susanwere/orbit"], allowedPaths: ["apps/jobs/**"],
      forbiddenActions: [], approvalRequiredActions: [],
      networkPolicy: "none", networkAllowlist: [],
      status: "approved", version: 1,
      createdByPrincipalId: fixture.principalId, createdAt: at,
    };
    const snapshots = new AgentContextSnapshotService(
      db, new ProjectAuthorizationService(db),
    );
    const snapshot = await snapshots.create({
      projectId: fixture.projectId,
      requestedByPrincipalId: fixture.principalId,
      agent,
      mission: "Implement jobs Load More",
    });
    expect(snapshot.sourceContextVersionId).toBe(result.contextVersionId);
    expect(snapshot.includedDecisionIds).toContain(result.decisionId);
    await expect(db.query(
      "UPDATE context_snapshots SET mission = 'tampered' WHERE id = $1",
      [snapshot.id],
    )).rejects.toThrow();

    const contractId = `contract_${randomUUID()}`;
    const sessionId = `session_${randomUUID()}`;
    await db.query(
      `INSERT INTO execution_contracts(
        id, organization_id, project_id, context_snapshot_id,
        agent_definition_id, agent_definition_version, network_policy, allowed_paths
      ) VALUES ($1,$2,$3,$4,$5,1,'none','["apps/jobs/**"]'::jsonb)`,
      [contractId, fixture.organizationId, fixture.projectId, snapshot.id, agent.id],
    );
    await db.query(
      `INSERT INTO agent_sessions(
        id, organization_id, project_id, agent_definition_id,
        agent_definition_version, work_item_id,
        requested_by_principal_id, human_owner_principal_id,
        mission, context_snapshot_id, execution_contract_id, state
      ) VALUES ($1,$2,$3,$4,1,'jobs-list',$5,$5,$6,$7,$8,'RUNNING')`,
      [
        sessionId, fixture.organizationId, fixture.projectId, agent.id,
        fixture.principalId, "Implement jobs Load More", snapshot.id, contractId,
      ],
    );
    const contexts = new ContextVersionRepository(db);
    const version4 = await contexts.getById(fixture.projectId, result.contextVersionId);
    expect(version4).not.toBeNull();
    const version5 = await contexts.append({
      id: `context_${randomUUID()}`,
      organizationId: fixture.organizationId, projectId: fixture.projectId,
      content: { ...version4!.content, attributes: { theme: "dark" } },
      expectedCurrentVersionId: result.contextVersionId, createdAt: at,
    });
    const impact = new PostgresExecutionImpactService(db);
    expect(await impact.evaluate({
      organizationId: fixture.organizationId, projectId: fixture.projectId,
      previousContextVersionId: result.contextVersionId,
      currentContextVersionId: version5.id,
    })).toEqual({ reviewed: 0, continued: 1 });
    const version6 = await contexts.append({
      id: `context_${randomUUID()}`,
      organizationId: fixture.organizationId, projectId: fixture.projectId,
      content: {
        ...version5.content,
        constraints: [...version5.content.constraints, {
          id: `constraint_${randomUUID()}`, key: "jobs.pagination",
          statement: "Use cursor pagination for jobs Load More",
          sourceDecisionId: result.decisionId, createdAt: at,
        }],
      },
      expectedCurrentVersionId: version5.id, createdAt: at,
    });
    expect(await impact.evaluate({
      organizationId: fixture.organizationId, projectId: fixture.projectId,
      previousContextVersionId: version5.id,
      currentContextVersionId: version6.id,
    })).toEqual({ reviewed: 1, continued: 0 });
    const persisted = await db.query<{ state: string; context_snapshot_id: string }>(
      "SELECT state, context_snapshot_id FROM agent_sessions WHERE id = $1", [sessionId],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: "WAITING", context_snapshot_id: snapshot.id,
    });
  });

  it("deduplicates webhook deliveries using the real database constraint", async () => {
    const fixture = await createFixture();
    const inbox = new PostgresWebhookInboxStore(db);
    const payload = {
      organizationId: fixture.organizationId, projectId: fixture.projectId,
      provider: "github" as const, deliveryId: `delivery_${randomUUID()}`,
      eventName: "pull_request", headers: {}, payload: { action: "opened" },
      receivedAt: at,
    };
    expect((await inbox.persist(payload)).inserted).toBe(true);
    expect((await inbox.persist(payload)).inserted).toBe(false);
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM webhook_inbox WHERE project_id = $1", [fixture.projectId],
    );
    expect(rows.rowCount).toBe(1);
  });
});
