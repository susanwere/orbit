import { describe, expect, it } from "vitest";
import { DecisionAnalysisWorker } from "../src/modules/decisions/decision-analysis-worker.js";

describe("durable decision analysis", () => {
  it("claims, invokes the detector service and records success", async () => {
    const sql: string[] = [];
    let used = false;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: async (query: string) => {
          sql.push(query);
          if (query.includes("SELECT event_id")) {
            if (used) return { rows: [] };
            used = true;
            return { rows: [{ event_id: "evt_1", attempts: 0 }] };
          }
          return { rows: [] };
        },
      }),
      query: async (query: string) => { sql.push(query); return { rows: [] }; },
    };
    const analyzed: string[] = [];
    const analysis = { analyze: async (id: string) => { analyzed.push(id); return "proposed"; } };
    const worker = new DecisionAnalysisWorker(db as never, analysis as never);
    expect(await worker.processBatch()).toBe(1);
    expect(analyzed).toEqual(["evt_1"]);
    expect(sql.some(q => q.includes("completed_at=now()"))).toBe(true);
  });

  it("marks failing inference for bounded retry without storing raw secrets", async () => {
    const calls: { query: string; params: unknown[] }[] = [];
    let used = false;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: async (query: string) => {
          if (query.includes("SELECT event_id")) {
            if (used) return { rows: [] };
            used = true;
            return { rows: [{ event_id: "evt_2", attempts: 0 }] };
          }
          return { rows: [] };
        },
      }),
      query: async (query: string, params: unknown[]) => {
        calls.push({ query, params }); return { rows: [] };
      },
    };
    const analysis = { analyze: async () => { throw new Error("SECRET-AUTHORIZATION-TOKEN"); } };
    await new DecisionAnalysisWorker(db as never, analysis as never).processBatch();
    expect(calls[0]?.query).toContain("status='failed'");
    expect(JSON.stringify(calls)).not.toContain("SECRET-AUTHORIZATION-TOKEN");
  });
});
