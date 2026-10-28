import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";
import { generateContextChangeProposal } from "../src/modules/context/context-change-generator.js";
import { PostgresDecisionPromotion } from "../src/modules/decisions/postgres-decision-promotion.js";
import { PostgresWebhookInboxStore } from "../src/modules/integrations/github/webhook-inbox.js";
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
