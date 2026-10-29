import { describe, it, expect } from "vitest";
import { DomainEffectsWorker } from "../src/modules/execution/domain-effects-worker.js";
describe("committed context effect recovery", () => {
  it("claims an event and marks complete after a successful impact evaluation", async () => {
    const operations: string[] = [];
    let taken = false;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: async (q: string) => {
            operations.push(q);
            if (q.includes("SELECT event_id")) {
              if (taken) return { rows: [] };
              taken = true;
              return { rows: [{ event_id: "evt1", attempts: 0 }] };
            }
            return { rows: [] };
          },
        }),
      query: async (q: string) => {
        operations.push(q);
        if (q.includes("FROM events"))
          return {
            rows: [
              {
                organization_id: "org",
                project_id: "project",
                payload: { previousContextVersionId: "v3", currentContextVersionId: "v4" },
              },
            ],
          };
        return { rows: [] };
      },
    };
    const impacts: unknown[] = [];
    const impact = {
      evaluate: async (input: unknown) => {
        impacts.push(input);
      },
    };
    const worker = new DomainEffectsWorker(db as never, impact as never);
    expect(await worker.processBatch()).toBe(1);
    expect(impacts).toEqual([
      {
        organizationId: "org",
        projectId: "project",
        previousContextVersionId: "v3",
        currentContextVersionId: "v4",
      },
    ]);
    expect(operations.some((s) => s.includes("status='completed'"))).toBe(true);
    expect(await worker.processBatch()).toBe(0);
  });
  it("retries without recording provider text in the failure", async () => {
    let claimed = false;
    const queries: { sql: string; args: unknown[] }[] = [];
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: async (q: string) => {
            if (q.includes("SELECT event_id")) {
              if (claimed) return { rows: [] };
              claimed = true;
              return { rows: [{ event_id: "evt", attempts: 0 }] };
            }
            return { rows: [] };
          },
        }),
      query: async (sql: string, args: unknown[] = []) => {
        queries.push({ sql, args });
        if (sql.includes("FROM events"))
          return {
            rows: [
              {
                organization_id: "org",
                project_id: "p",
                payload: { previousContextVersionId: "v1", currentContextVersionId: "v2" },
              },
            ],
          };
        return { rows: [] };
      },
    };
    const impact = {
      evaluate: async () => {
        throw new Error("SECRET-CONTEXT");
      },
    };
    await new DomainEffectsWorker(db as never, impact as never).processBatch();
    expect(queries.some((c) => c.sql.includes("status='failed'"))).toBe(true);
    expect(JSON.stringify(queries)).not.toContain("SECRET-CONTEXT");
  });
});
