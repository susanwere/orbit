import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { PostgresExecutionImpactService } from "../src/modules/execution/postgres-execution-impact.js";
import type { AgentDefinition } from "@orbit/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { promoteApprovedKnowledge } from "../src/modules/context/promote-approved-knowledge.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("atomic approved knowledge publication", () => {
  let database: PgDatabase;
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const principalId = randomUUID();
  const snapshotId = randomUUID();
  beforeAll(async () => {
    database = new PgDatabase(databaseUrl!);
    await database.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Knowledge publication test')",
      [organizationId],
    );
    await database.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Knowledge test')",
      [projectId, organizationId],
    );
    await database.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Admin','admin')",
      [principalId, organizationId],
    );
    await database.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,'Build viewer',$4)",
      [randomUUID(), organizationId, projectId, principalId],
    );
    await database.query(
      "INSERT INTO project_knowledge_snapshots(id,organization_id,project_id,revision,content,created_by_principal_id) VALUES($1,$2,$3,1,$4::jsonb,$5)",
      [
        snapshotId,
        organizationId,
        projectId,
        JSON.stringify({ summary: { overview: "Viewer" } }),
        principalId,
      ],
    );
  });
  afterAll(async () => {
    await database?.query("DELETE FROM project_knowledge_heads WHERE project_id=$1", [projectId]);
    await database?.query("DELETE FROM project_knowledge_snapshots WHERE project_id=$1", [
      projectId,
    ]);
    await database?.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await database?.close();
  });
  const publish = () =>
    database.transaction((transaction) =>
      promoteApprovedKnowledge(transaction, organizationId, projectId, snapshotId, 1, principalId),
    );
  it("refuses proposals, cross-tenant publication and approval by another principal", async () => {
    await expect(publish()).rejects.toThrow("Knowledge snapshot missing");
    await expect(
      database.transaction((transaction) =>
        promoteApprovedKnowledge(transaction, randomUUID(), projectId, snapshotId, 1, principalId),
      ),
    ).rejects.toThrow();
    expect(
      (await database.query("SELECT id FROM context_versions WHERE project_id=$1", [projectId]))
        .rows,
    ).toHaveLength(0);
  });
  it("rolls back approval, runtime context and outbox together", async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          "UPDATE project_knowledge_snapshots SET review_status='APPROVED',reviewed_by_principal_id=$2 WHERE id=$1",
          [snapshotId, principalId],
        );
        await promoteApprovedKnowledge(
          transaction,
          organizationId,
          projectId,
          snapshotId,
          1,
          principalId,
        );
        throw new Error("simulated transaction failure");
      }),
    ).rejects.toThrow("simulated");
    expect(
      (
        await database.query("SELECT review_status FROM project_knowledge_snapshots WHERE id=$1", [
          snapshotId,
        ])
      ).rows[0]?.review_status,
    ).toBe("PROPOSED");
    expect(
      (await database.query("SELECT id FROM events WHERE project_id=$1", [projectId])).rows,
    ).toHaveLength(0);
    expect(
      (
        await database.query("SELECT event_id FROM domain_effect_jobs WHERE project_id=$1", [
          projectId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it("publishes a replayable event and durable job exactly once", async () => {
    await database.query(
      "UPDATE project_knowledge_snapshots SET review_status='APPROVED',reviewed_by_principal_id=$2 WHERE id=$1",
      [snapshotId, principalId],
    );
    await expect(
      database.transaction((transaction) =>
        promoteApprovedKnowledge(
          transaction,
          organizationId,
          projectId,
          snapshotId,
          1,
          randomUUID(),
        ),
      ),
    ).rejects.toThrow();
    const contextVersionId = await publish();
    expect(await publish()).toBe(contextVersionId);
    const events = await database.query(
      "SELECT event.payload,job.status FROM events event JOIN domain_effect_jobs job ON job.event_id=event.id WHERE event.project_id=$1",
      [projectId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      status: "pending",
      payload: {
        currentContextVersionId: contextVersionId,
        knowledgeSnapshotId: snapshotId,
        knowledgeRevision: 1,
      },
    });
    expect(
      (await database.query("SELECT id FROM context_versions WHERE project_id=$1", [projectId]))
        .rows,
    ).toHaveLength(2);
  });
  it("routes an approved knowledge update into an idempotent human review, preserving snapshots", async () => {
    const agent: AgentDefinition = {
      id: randomUUID(),
      organizationId,
      name: "Context-aware Muse",
      purpose: "Build viewer",
      provider: "meta",
      model: "muse",
      capabilities: ["repo.read"],
      approvedTools: [],
      maxContextClassification: "INTERNAL",
      allowedContextScopes: ["/attributes/approvedProjectKnowledge"],
      allowedRepositories: ["example/viewer"],
      allowedPaths: ["src/**"],
      forbiddenActions: [],
      approvalRequiredActions: [],
      networkPolicy: "none",
      networkAllowlist: [],
      status: "approved",
      version: 1,
      createdByPrincipalId: principalId,
      createdAt: new Date().toISOString(),
    };
    const snapshots = new AgentContextSnapshotService(
      database,
      new ProjectAuthorizationService(database),
    );
    const snapshot = await snapshots.create({
      projectId,
      requestedByPrincipalId: principalId,
      agent,
      mission: "Build viewer",
    });
    const contractId = randomUUID();
    const sessionId = randomUUID();
    await database.query(
      `INSERT INTO execution_contracts(id,organization_id,project_id,context_snapshot_id,
      agent_definition_id,agent_definition_version,network_policy,allowed_paths)
      VALUES($1,$2,$3,$4,$5,1,'none','["src/**"]'::jsonb)`,
      [contractId, organizationId, projectId, snapshot.id, agent.id],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,organization_id,project_id,agent_definition_id,
      agent_definition_version,work_item_id,requested_by_principal_id,human_owner_principal_id,
      mission,context_snapshot_id,execution_contract_id,state)
      VALUES($1,$2,$3,$4,1,'viewer',$5,$5,'Build viewer',$6,$7,'RUNNING')`,
      [sessionId, organizationId, projectId, agent.id, principalId, snapshot.id, contractId],
    );
    const secondSnapshotId = randomUUID();
    await database.query(
      `INSERT INTO project_knowledge_snapshots(id,organization_id,project_id,revision,
      content,created_by_principal_id,review_status,reviewed_by_principal_id)
      VALUES($1,$2,$3,2,$4::jsonb,$5,'APPROVED',$5)`,
      [
        secondSnapshotId,
        organizationId,
        projectId,
        JSON.stringify({ summary: { overview: "Viewer now requires offline support" } }),
        principalId,
      ],
    );
    const nextContextId = await database.transaction((transaction) =>
      promoteApprovedKnowledge(
        transaction,
        organizationId,
        projectId,
        secondSnapshotId,
        2,
        principalId,
      ),
    );
    const events = await database.query<
      { payload: { previousContextVersionId: string; currentContextVersionId: string } } & Record<
        string,
        unknown
      >
    >(
      "SELECT payload FROM events WHERE project_id=$1 AND entity_id=$2 AND type='context.updated'",
      [projectId, nextContextId],
    );
    const impactInput = { organizationId, projectId, ...events.rows[0]!.payload };
    const impact = new PostgresExecutionImpactService(database);
    expect(await impact.evaluate(impactInput)).toEqual({ reviewed: 1, continued: 0 });
    expect(await impact.evaluate(impactInput)).toEqual({ reviewed: 0, continued: 0 });
    expect(
      (
        await database.query("SELECT state,context_snapshot_id FROM agent_sessions WHERE id=$1", [
          sessionId,
        ])
      ).rows[0],
    ).toMatchObject({ state: "WAITING", context_snapshot_id: snapshot.id });
    expect(
      (await database.query("SELECT id FROM human_gates WHERE agent_session_id=$1", [sessionId]))
        .rows,
    ).toHaveLength(1);
    expect(
      (await database.query("SELECT items FROM context_snapshots WHERE id=$1", [snapshot.id]))
        .rows[0]?.items,
    ).toEqual(snapshot.items);
    const newerSnapshot = await snapshots.create({
      projectId,
      requestedByPrincipalId: principalId,
      agent,
      mission: "Build viewer",
    });
    expect(newerSnapshot.sourceContextVersionId).toBe(nextContextId);
    expect(newerSnapshot.items[0]!.excerpt).toContain("offline support");
    expect(snapshot.items[0]!.excerpt).not.toContain("offline support");
  });
});
