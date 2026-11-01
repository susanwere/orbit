import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";

describe("original intent document associations", () => {
  function setup(ownedDocuments: string[]) {
    const statements: string[] = [];
    const attachments: string[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        statements.push(sql);
        if (sql.includes("SELECT id,version FROM project_documents")) {
          return {
            rows: ownedDocuments
              .filter((id) => (params[2] as string[]).includes(id))
              .map((id) => ({ id, version: 1 })),
          };
        }
        if (sql.includes("INSERT INTO intents")) {
          return {
            rows: [
              {
                id: params[0],
                organization_id: params[1],
                project_id: params[2],
                statement: params[3],
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO intent_document_attachments")) {
          attachments.push(...(params[3] as string[]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      transaction: async <T>(run: (transaction: { query: typeof db.query }) => Promise<T>) =>
        run(db),
    };
    const originalIntent = {
      db,
      auth: {
        verify: (header: string | undefined) => {
          if (header !== "Bearer valid") throw new DomainError("unauthenticated", "Unauthorized");
          return { id: "author", organizationId: "org-one" };
        },
      },
      authorization: {
        authorize: async (_actor: string, projectId: string) => {
          if (projectId !== "project-one")
            throw new DomainError("forbidden", "Project access denied");
          return { organizationId: "org-one", projectId };
        },
      },
    };
    return { originalIntent, statements, attachments };
  }

  const ownedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const foreignId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const post = (documentIds: string[]) => ({
    method: "POST" as const,
    url: "/projects/project-one/intent",
    headers: { authorization: "Bearer valid" },
    payload: { statement: "Create a jobs page", documentIds },
  });

  it("atomically records only authorized document versions", async () => {
    const fixture = setup([ownedId]);
    const app = await buildApp({ originalIntent: fixture.originalIntent as never });
    const response = await app.inject(post([ownedId]));
    expect(response.statusCode).toBe(201);
    expect(fixture.attachments).toEqual([ownedId]);
    expect(fixture.statements.some((sql) => sql.includes("INSERT INTO intent_document_attachments"))).toBe(true);
    await app.close();
  });

  it("rejects foreign project documents before creating an intent", async () => {
    const fixture = setup([ownedId]);
    const app = await buildApp({ originalIntent: fixture.originalIntent as never });
    const response = await app.inject(post([ownedId, foreignId]));
    expect(response.statusCode).toBe(400);
    expect(fixture.statements.some((sql) => sql.includes("INSERT INTO intents"))).toBe(false);
    expect(fixture.attachments).toEqual([]);
    await app.close();
  });

  it("rejects duplicate attachment IDs", async () => {
    const fixture = setup([ownedId]);
    const app = await buildApp({ originalIntent: fixture.originalIntent as never });
    const response = await app.inject(post([ownedId, ownedId]));
    expect(response.statusCode).toBe(400);
    expect(fixture.attachments).toEqual([]);
    await app.close();
  });
});
