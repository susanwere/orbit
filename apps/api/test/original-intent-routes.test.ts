import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";

describe("original intent API", () => {
  function fixture(role: "admin" | "viewer" = "admin") {
    const stored: Array<Record<string, unknown>> = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const originalIntent = {
      auth: {
        verify: (value: string | undefined) => {
          if (value !== "Bearer valid") {
            throw new DomainError("unauthenticated", "Auth required");
          }
          return { id: "author", organizationId: "org-a" };
        },
      },
      authorization: {
        authorize: async (_id: string, projectId: string, permission: string) => {
          if (projectId !== "allowed") {
            throw new DomainError("forbidden", "Project access denied.");
          }
          if (role === "viewer" && permission === "review") {
            throw new DomainError("forbidden", "Viewer cannot submit intent.");
          }
          return { organizationId: "org-a", projectId: "allowed" };
        },
      },
      db: {
        query: async (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          if (sql.startsWith("SELECT")) {
            return {
              rows: stored.filter(
                (x) => x.organization_id === params[0] && x.project_id === params[1],
              ),
            };
          }
          if (stored.length) return { rows: [] };
          const row = {
            id: params[0],
            organization_id: params[1],
            project_id: params[2],
            statement: params[3],
            created_by_principal_id: params[4],
            created_at: "2026-10-29T00:00:00Z",
          };
          stored.push(row);
          return { rows: [row] };
        },
      },
    };
    return { originalIntent, queries };
  }

  it("requires authentication and rejects unauthorized projects", async () => {
    const { originalIntent } = fixture();
    const app = await buildApp({ originalIntent: originalIntent as never });
    expect((await app.inject({ method: "GET", url: "/projects/allowed/intent" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/other/intent",
          headers: { authorization: "Bearer valid" },
          payload: { statement: "Build a UI" },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("stores exactly one immutable intent with no planner side effects", async () => {
    const { originalIntent, queries } = fixture();
    const app = await buildApp({ originalIntent: originalIntent as never });
    const headers = { authorization: "Bearer valid" };
    const first = await app.inject({
      method: "POST",
      url: "/projects/allowed/intent",
      headers,
      payload: { statement: "  Build a recorder  " },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().intent.statement).toBe("Build a recorder");
    const again = await app.inject({
      method: "POST",
      url: "/projects/allowed/intent",
      headers,
      payload: { statement: "Overwrite" },
    });
    expect(again.statusCode).toBe(409);
    const read = await app.inject({
      method: "GET",
      url: "/projects/allowed/intent",
      headers,
    });
    expect(read.json().intent.statement).toBe("Build a recorder");
    expect(queries.every((q) => /^(SELECT|INSERT)/.test(q.sql))).toBe(true);
    await app.close();
  });

  it("does not allow viewers to create original intent", async () => {
    const { originalIntent } = fixture("viewer");
    const app = await buildApp({ originalIntent: originalIntent as never });
    const response = await app.inject({
      method: "POST",
      url: "/projects/allowed/intent",
      headers: { authorization: "Bearer valid" },
      payload: { statement: "Build" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
