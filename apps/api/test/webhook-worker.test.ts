import { describe, expect, it } from "vitest";
import { GithubWebhookWorker } from "../src/modules/integrations/github/webhook-worker.js";

describe("GitHub webhook worker", () => {
  it("does not process a row without a verified project", async () => {
    const calls: string[] = [];
    let claimed = false;
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            calls.push(sql);
            if (sql.includes("SELECT * FROM webhook_inbox")) {
              if (claimed) return { rows: [] };
              claimed = true;
              return {
                rows: [
                  {
                    id: "in1",
                    organization_id: "org",
                    project_id: null,
                    delivery_id: "d1",
                    event_name: "issue_comment",
                    payload: {},
                    received_at: "2026-10-28T10:00:00Z",
                    attempts: 0,
                  },
                ],
              };
            }
            return { rows: [], rowCount: 1 };
          },
        }),
    };
    expect(await new GithubWebhookWorker(db as never).processBatch()).toBe(1);
    expect(calls.some((s) => s.includes("status='failed'"))).toBe(true);
    expect(calls.some((s) => s.includes("INSERT INTO events"))).toBe(false);
  });

  it("normalizes and writes a valid event idempotently", async () => {
    const queries: string[] = [];
    let once = false;
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes("SELECT * FROM webhook_inbox")) {
              if (once) return { rows: [] };
              once = true;
              return {
                rows: [
                  {
                    id: "in2",
                    organization_id: "org",
                    project_id: "project",
                    delivery_id: "delivery",
                    event_name: "pull_request",
                    received_at: "2026-10-28T10:00:00Z",
                    payload: {
                      action: "opened",
                      repository: { full_name: "org/repo" },
                      pull_request: { number: 3, created_at: "2026-10-28T10:00:00Z" },
                    },
                    attempts: 0,
                  },
                ],
              };
            }
            return { rows: [], rowCount: 1 };
          },
        }),
    };
    expect(await new GithubWebhookWorker(db as never).processBatch()).toBe(1);
    expect(queries.some((s) => s.includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
    expect(queries.some((s) => s.includes("processed_at=now()"))).toBe(true);
  });
});
