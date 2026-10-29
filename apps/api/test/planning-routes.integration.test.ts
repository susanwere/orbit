import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgDatabase } from "@orbit/db";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { MuseWorkGraphPlanner } from "../src/modules/planning/muse-work-graph-planner.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const proposed = {
  summary: "Consent-first interview capture",
  workItems: [
    {
      key: "CAP-1",
      title: "Recorder controls",
      description: "Require consent before recording",
      dependsOn: [],
      workflows: [
        {
          name: "Engineering",
          steps: [{ title: "Implement stop control", executor: "agent", requiresApproval: false }],
        },
        {
          name: "Review",
          steps: [{ title: "Review privacy behavior", executor: "human", requiresApproval: true }],
        },
      ],
    },
  ],
  guardrails: ["No recording without consent"],
  decisionsToReview: ["Choose retention period"],
  assumptions: [],
};

describe.skipIf(!databaseUrl)("authenticated planning and human review API (PostgreSQL)", () => {
  let db: PgDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const orgs: string[] = [];
  const principals = new Map<string, string>();
  const complete = vi.fn().mockResolvedValue(proposed);
  const token = (id: string) => ({ authorization: `Bearer ${id}` });
  const id = () => randomUUID();

  async function createOrganization() {
    const org = id();
    orgs.push(org);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Planning test')", [org]);
    return org;
  }
  async function createPrincipal(org: string, role: "admin" | "viewer") {
    const principal = id();
    await db.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Test actor',$3)",
      [principal, org, role],
    );
    principals.set(principal, org);
    return principal;
  }
  async function seedProject(org: string, author: string) {
    const project = id();
    await db.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,$3)", [
      project,
      org,
      project,
    ]);
    await db.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,$4,$5)",
      [id(), org, project, "Build an interview recorder", author],
    );
    return project;
  }

  beforeAll(async () => {
    db = new PgDatabase(databaseUrl!);
    app = await buildApp({
      planning: {
        db,
        authorization: new ProjectAuthorizationService(db),
        planner: new MuseWorkGraphPlanner({ complete }),
        auth: {
          verify: (value) => {
            const principal = value?.startsWith("Bearer ") ? value.slice(7) : "";
            if (!principal || !principals.has(principal)) {
              throw new DomainError("unauthenticated", "Authentication required.");
            }
            return { id: principal, organizationId: principals.get(principal)! };
          },
        },
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    for (const org of orgs) {
      await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    }
    await db?.close();
  });

  it("requires authentication, membership and editor role", async () => {
    const org = await createOrganization();
    const other = await createOrganization();
    const admin = await createPrincipal(org, "admin");
    const viewer = await createPrincipal(org, "viewer");
    const outsider = await createPrincipal(other, "admin");
    const project = await seedProject(org, admin);
    const url = `/projects/${project}/plan`;

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: token(viewer) })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method: "GET", url, headers: token(outsider) })).statusCode).toBe(
      403,
    );
    expect(
      (await app.inject({ method: "GET", url, headers: token(admin) })).json().plan,
    ).toBeNull();
  });

  it("creates a bounded proposal, supports editing and authentic human approval", async () => {
    complete.mockResolvedValue(proposed);
    const org = await createOrganization();
    const admin = await createPrincipal(org, "admin");
    const project = await seedProject(org, admin);
    const url = `/projects/${project}/plan`;

    const created = await app.inject({ method: "POST", url, headers: token(admin) });
    expect(created.statusCode).toBe(201);
    const plan = created.json().plan;
    expect(plan.status).toBe("READY_FOR_REVIEW");
    expect(plan.content.workItems[0].workflows).toHaveLength(2);
    expect((await app.inject({ method: "POST", url, headers: token(admin) })).statusCode).toBe(409);

    const editedContent = structuredClone(proposed);
    editedContent.summary = "Reviewed consent-first interview capture";
    const edit = await app.inject({
      method: "PATCH",
      url,
      headers: token(admin),
      payload: { expectedRevision: plan.revision, content: editedContent },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().plan.revision).toBe(plan.revision + 1);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: token(admin),
          payload: { expectedRevision: plan.revision, content: editedContent },
        })
      ).statusCode,
    ).toBe(409);

    const approved = await app.inject({
      method: "POST",
      url: `${url}/approve`,
      headers: token(admin),
      payload: { expectedRevision: edit.json().plan.revision },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().plan.status).toBe("APPROVED");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: token(admin),
          payload: { expectedRevision: approved.json().plan.revision, content: editedContent },
        })
      ).statusCode,
    ).toBe(409);
    const approval = await db.query<{ decision: string } & Record<string, unknown>>(
      "SELECT decision FROM approvals WHERE project_id=$1 AND subject_type='plan'",
      [project],
    );
    expect(approval.rows.map((row) => row.decision)).toEqual(["APPROVED"]);
    const sessions = await db.query<{ count: string } & Record<string, unknown>>(
      "SELECT COUNT(*)::text AS count FROM agent_sessions WHERE project_id=$1",
      [project],
    );
    expect(sessions.rows[0]?.count).toBe("0");
  });

  it("persists generation failure and permits controlled retry", async () => {
    const org = await createOrganization();
    const admin = await createPrincipal(org, "admin");
    const project = await seedProject(org, admin);
    const url = `/projects/${project}/plan`;
    complete.mockRejectedValueOnce(new Error("Transient Meta API error"));
    const failed = await app.inject({ method: "POST", url, headers: token(admin) });
    expect(failed.statusCode).toBe(503);
    const state = await app.inject({ method: "GET", url, headers: token(admin) });
    expect(state.json().plan.status).toBe("FAILED");
    expect(state.json().plan.content).toBeNull();
    const retried = await app.inject({ method: "POST", url, headers: token(admin) });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().plan.revision).toBe(2);
  });
});
