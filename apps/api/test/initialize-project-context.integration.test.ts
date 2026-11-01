import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { initializeProjectContext } from "../src/modules/context/initialize-project-context.js";
import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("initial project context (PostgreSQL)", () => {
  let database: PgDatabase;
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const principalId = randomUUID();
  const intentId = randomUUID();
  beforeAll(async () => {
    database = new PgDatabase(databaseUrl!);
    await database.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Context initialization test')",
      [organizationId],
    );
    await database.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Existing project')",
      [projectId, organizationId],
    );
    await database.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Admin','admin')",
      [principalId, organizationId],
    );
  });
  afterAll(async () => {
    await database?.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await database?.close();
  });
  it("requires a saved intent and fails closed for a different tenant", async () => {
    await expect(
      database.transaction((transaction) =>
        initializeProjectContext(transaction, projectId, organizationId),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      database.transaction((transaction) =>
        initializeProjectContext(transaction, projectId, randomUUID()),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(
      (await database.query("SELECT id FROM context_versions WHERE project_id=$1", [projectId]))
        .rows,
    ).toHaveLength(0);
  });
  it("initializes once under concurrent session requests and preserves the saved intent", async () => {
    await database.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,$4,$5)",
      [intentId, organizationId, projectId, "Display Hello World", principalId],
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        database.transaction((transaction) =>
          initializeProjectContext(transaction, projectId, organizationId),
        ),
      ),
    );
    const versions = await database.query<
      {
        id: string;
        content: import("@orbit/domain").ProjectContext;
        content_hash: string;
      } & Record<string, unknown>
    >("SELECT id,content,content_hash FROM context_versions WHERE project_id=$1", [projectId]);
    expect(versions.rows).toHaveLength(1);
    const version = versions.rows[0]!;
    expect(version.content).toEqual({
      projectId,
      originalIntentId: intentId,
      currentIntent: "Display Hello World",
      constraints: [],
      attributes: {},
    });
    expect(version.content_hash).toBe(hashProjectContext(version.content));
    const head = await database.query(
      "SELECT current_context_version_id,version_number FROM project_context_heads WHERE project_id=$1",
      [projectId],
    );
    expect(head.rows[0]).toMatchObject({
      current_context_version_id: version.id,
      version_number: 1,
    });
    await database.transaction((transaction) =>
      initializeProjectContext(transaction, projectId, organizationId),
    );
    expect(
      (await database.query("SELECT id FROM context_versions WHERE project_id=$1", [projectId]))
        .rows,
    ).toEqual([{ id: version.id }]);
  });
  it("creates a real snapshot for an existing project without context", async () => {
    const snapshotProjectId = randomUUID();
    const snapshotIntentId = randomUUID();
    await database.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Snapshot project')",
      [snapshotProjectId, organizationId],
    );
    await database.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,$4,$5)",
      [snapshotIntentId, organizationId, snapshotProjectId, "Display a greeting", principalId],
    );
    const snapshots = new AgentContextSnapshotService(
      database,
      new ProjectAuthorizationService(database),
    );
    const snapshot = await snapshots.create({
      projectId: snapshotProjectId,
      requestedByPrincipalId: principalId,
      mission: "Implement greeting",
      agent: {
        id: "test-agent",
        organizationId,
        name: "Muse",
        purpose: "Greeting",
        provider: "meta",
        model: "muse-code",
        capabilities: ["read", "write"],
        approvedTools: ["code"],
        maxContextClassification: "PUBLIC",
        allowedContextScopes: [],
        allowedRepositories: ["susanwere/private-test"],
        allowedPaths: ["src/**"],
        approvalRequiredActions: ["github-push"],
        forbiddenActions: ["access-secrets"],
        networkPolicy: "none",
        networkAllowlist: [],
        status: "approved",
        version: 1,
        createdByPrincipalId: principalId,
        createdAt: new Date().toISOString(),
      },
    });
    expect(snapshot.sourceContextVersionId).toMatch(/^context_/);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.allowedRepositories).toEqual(["susanwere/private-test"]);
    const stored = await database.query(
      "SELECT source_context_version_id FROM context_snapshots WHERE id=$1",
      [snapshot.id],
    );
    expect(stored.rows[0]?.source_context_version_id).toBe(snapshot.sourceContextVersionId);
  });
  it("refuses to replace existing history when the head is missing", async () => {
    await database.query("DELETE FROM project_context_heads WHERE project_id=$1", [projectId]);
    await expect(
      database.transaction((transaction) =>
        initializeProjectContext(transaction, projectId, organizationId),
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(
      (await database.query("SELECT id FROM context_versions WHERE project_id=$1", [projectId]))
        .rows,
    ).toHaveLength(1);
  });
});
