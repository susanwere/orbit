import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Project and GitHub repository API (PostgreSQL)", () => {
  let db: PgDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const orgs: string[] = [];
  const token = (actor: string) => ({ authorization: `Bearer ${actor}` });
  const id = () => randomUUID();
  async function actor(role: "admin" | "member" | "viewer", organizationId: string) {
    const user = id();
    await db.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Test user',$3)",
      [user, organizationId, role],
    );
    return user;
  }
  async function organization() {
    const org = id();
    orgs.push(org);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Project API test')", [org]);
    return org;
  }
  const principalMap = new Map<string, string>();
  beforeAll(async () => {
    db = new PgDatabase(databaseUrl!);
    app = await buildApp({
      projectManagement: {
        db,
        authorization: new ProjectAuthorizationService(db),
        auth: {
          verify: (header) => {
            if (!header?.startsWith("Bearer ") || !principalMap.has(header.slice(7)))
              throw new DomainError("unauthenticated", "Auth required");
            return { id: header.slice(7), organizationId: principalMap.get(header.slice(7))! };
          },
        },
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    for (const org of orgs) await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db?.close();
  });
  it("enforces authentication, role authorization, tenant scoping and duplicates", async () => {
    const org = await organization(),
      other = await organization();
    const admin = await actor("admin", org),
      viewer = await actor("viewer", org),
      outsider = await actor("admin", other);
    principalMap.set(admin, org);
    principalMap.set(viewer, org);
    principalMap.set(outsider, other);
    expect(
      (await app.inject({ method: "POST", url: "/projects", payload: { name: "Example" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects",
          headers: token(viewer),
          payload: { name: "Example" },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      headers: token(admin),
      payload: { name: "Example" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects",
          headers: token(admin),
          payload: { name: "Example" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/projects/${projectId}`, headers: token(outsider) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/projects", headers: token(outsider) })).json()
        .projects,
    ).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: "/projects?limit=101", headers: token(admin) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/projects", headers: token(admin) }))
        .json()
        .projects.some((p: { id: string }) => p.id === projectId),
    ).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: `/projects/${projectId}`, headers: token(admin) }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/repositories`,
          headers: token(viewer),
          payload: { repository: "susanwere/orbit" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/repositories`,
          headers: token(admin),
          payload: { repository: "https://evil.com/susanwere/orbit" },
        })
      ).statusCode,
    ).toBe(400);
    const connected = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/repositories`,
      headers: token(admin),
      payload: { repository: "https://github.com/susanwere/orbit" },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.json().full_name).toBe("susanwere/orbit");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/repositories`,
          headers: token(admin),
          payload: { repository: "susanwere/orbit" },
        })
      ).statusCode,
    ).toBe(201);
    const repeatedRegistrations = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: "POST",
          url: `/projects/${projectId}/repositories`,
          headers: token(admin),
          payload: { repository: "susanwere/orbit" },
        }),
      ),
    );
    for (const registration of repeatedRegistrations) {
      expect(registration.statusCode).toBe(201);
      expect(registration.json().id).toBe(connected.json().id);
      expect(registration.json().created_at).toBe(connected.json().created_at);
    }
    const list = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/repositories`,
      headers: token(viewer),
    });
    expect(list.json().repositories).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/projects/${projectId}/repositories`,
          headers: token(outsider),
        })
      ).statusCode,
    ).toBe(403);
  });
});
