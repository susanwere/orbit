import { describe, expect, it } from "vitest";
import { MuseLeaseRecoveryService } from "../src/modules/execution/muse-lease-recovery.js";

describe("Muse crashed worker lease recovery", () => {
  const job = {
    id: "job",
    project_id: "project",
    agent_session_id: "session",
    workflow_step_id: "step",
  };
  const fixture = (claimed = true, updated = true) => {
    const statements: string[] = [];
    const service = new MuseLeaseRecoveryService({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ query: async (sql: string, args: unknown[]) => {
          statements.push(sql);
          if (sql.includes("FROM muse_execution_jobs WHERE status='RUNNING'")) {
            expect(args).toEqual([50]);
            return { rows: claimed ? [job] : [] };
          }
          if (sql.includes("UPDATE muse_execution_jobs"))
            return { rows: updated ? [{ id: "job" }] : [] };
          return { rows: [] };
        } }),
    } as never);
    return { service, statements };
  };

  it("fails an expired job, session and step atomically", async () => {
    const h = fixture();
    await expect(h.service.recoverExpired()).resolves.toBe(1);
    expect(h.statements[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(h.statements[0]).toContain("lease_expires_at < now()");
    expect(h.statements.some((q) => q.includes("UPDATE agent_sessions SET state='FAILED'"))).toBe(true);
    expect(h.statements.some((q) => q.includes("UPDATE workflow_step_executions SET state='FAILED'"))).toBe(true);
    expect(h.statements.some((q) => q.includes("SET status='QUEUED'"))).toBe(false);
  });

  it("does nothing if no lease is expired", async () => {
    const h = fixture(false);
    await expect(h.service.recoverExpired()).resolves.toBe(0);
    expect(h.statements).toHaveLength(1);
  });

  it("does not modify a session when job was already finalized", async () => {
    const h = fixture(true, false);
    await expect(h.service.recoverExpired()).resolves.toBe(1);
    expect(h.statements.some((q) => q.includes("UPDATE agent_sessions"))).toBe(false);
  });

  it("rejects unbounded recovery scans", async () => {
    const h = fixture();
    await expect(h.service.recoverExpired(1000)).rejects.toThrow();
    expect(h.statements).toHaveLength(0);
  });
});
