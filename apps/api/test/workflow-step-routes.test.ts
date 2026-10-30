import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

function fixture(authorized = true) {
  let materialized = 0;
  let queried = 0;
  const app = buildApp({
    workflowSteps: {
      auth: {
        verify: (header: string | undefined) => {
          if (!header) throw new Error("Missing token");
          return { id: "human" };
        },
      } as never,
      authorization: {
        authorize: async () => {
          if (!authorized) throw new Error("Forbidden");
          return { projectId: "project", organizationId: "org", role: "member" };
        },
      } as never,
      db: {
        query: async (_sql: string, params: unknown[]) => {
          queried++;
          expect(params).toEqual(["project", "org"]);
          return { rows: [{ id: "step", state: "BLOCKED" }] };
        },
      } as never,
      materializer: {
        materialize: async (projectId: string, principalId: string) => {
          materialized++;
          expect(projectId).toBe("project");
          expect(principalId).toBe("human");
          return { planId: "plan", stepCount: 3 };
        },
      } as never,
    },
  });
  return { app, get queried() { return queried; }, get materialized() { return materialized; } };
}

describe("workflow step routes", () => {
  it("prepares approved plan records only through authenticated service", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "POST",
      url: "/projects/project/execution/prepare",
      headers: { authorization: "Bearer token" },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ planId: "plan", stepCount: 3 });
    expect(f.materialized).toBe(1);
    await app.close();
  });

  it("returns server-derived step states without allowing state mutation", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "GET",
      url: "/projects/project/execution/steps",
      headers: { authorization: "Bearer token" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ steps: [{ id: "step", state: "BLOCKED" }] });
    expect(f.queried).toBe(1);
    await app.close();
  });

  it("does not prepare or read without authentication", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "POST",
      url: "/projects/project/execution/prepare",
    });
    expect(result.statusCode).toBe(500);
    expect(f.materialized).toBe(0);
    await app.close();
  });
});
