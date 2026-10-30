import { afterEach, describe, expect, it } from "vitest";
import {
  MuseExecutionJobService,
  MuseExecutionWorker,
} from "../src/modules/execution/muse-execution-worker.js";

afterEach(() => {
  delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
});

describe("Muse execution queue", () => {
  it("enqueues only a running contract-scoped unblocked session", async () => {
    let statement = "";
    const service = new MuseExecutionJobService(
      {
        query: async (sql: string, args: unknown[]) => {
          statement = sql;
          expect(args.slice(1)).toEqual(["project", "org", "human", "session", "member"]);
          return { rows: [{ id: "job", status: "QUEUED" }] };
        },
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
      () => "fixed",
    );
    await expect(
      service.enqueue({ projectId: "project", principalId: "human", sessionId: "session" }),
    ).resolves.toMatchObject({ status: "QUEUED" });
    expect(statement).toContain("step.state='RUNNING'");
    expect(statement).toContain("s.state='RUNNING'");
    expect(statement).toContain("c.allowed_paths <> '[]'::jsonb");
    expect(statement).toContain("gate.status='OPEN'");
    expect(statement).toContain("ON CONFLICT");
  });

  it("fails closed on duplicates or unauthorized dispatch", async () => {
    const service = new MuseExecutionJobService(
      { query: async () => ({ rows: [] }) } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
    );
    await expect(
      service.enqueue({ projectId: "project", principalId: "human", sessionId: "session" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("isolated Muse execution worker", () => {
  const job = {
    id: "job",
    organization_id: "org",
    project_id: "project",
    agent_session_id: "session",
    workflow_step_id: "step",
    status: "QUEUED",
    mission: "Implement a React component",
    allowed_repositories: ["org/repo"],
    allowed_paths: ["src/**"],
    network_policy: "none",
    network_allowlist: [],
  };
  const harness = (exitCode: number, overrides: Record<string, unknown> = {}, leaseWon = true) => {
    const statements: string[] = [];
    let invoked = 0;
    const worker = new MuseExecutionWorker(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string) => {
              statements.push(sql);
              if (sql.includes("FROM muse_execution_jobs job"))
                return { rows: [{ ...job, ...overrides }] };
              if (sql.includes("SET status=$3")) return { rows: leaseWon ? [{ id: "job" }] : [] };
              return { rows: [] };
            },
          }),
      } as never,
      {
        execute: async () => {
          invoked++;
          return {
            provider: "meta-muse-code",
            exitCode,
            events: [{ type: "finished" }],
            outputTruncated: false,
          };
        },
      },
    );
    return {
      worker,
      statements,
      get invoked() {
        return invoked;
      },
    };
  };
  it("rejects missing grants and network-enabled contracts without invoking Muse", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    for (const overrides of [
      { allowed_paths: [] },
      { allowed_repositories: [] },
      { network_policy: "allowlist" },
      { network_allowlist: ["example.com"] },
    ]) {
      const h = harness(0, overrides);
      await expect(h.worker.runNext("/tmp/checkout")).resolves.toMatchObject({
        status: "FAILED",
      });
      expect(h.invoked).toBe(0);
    }
  });

  it("refuses to execute outside an isolated worker", async () => {
    const h = harness(0);
    await expect(h.worker.runNext("/tmp/checkout")).rejects.toThrow("isolated");
    expect(h.invoked).toBe(0);
  });

  it("leaves a successful CLI turn awaiting independent CI evidence", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const h = harness(0);
    await expect(h.worker.runNext("/tmp/checkout")).resolves.toEqual({
      jobId: "job",
      status: "TURN_FINISHED",
    });
    expect(h.invoked).toBe(1);
    expect(
      h.statements.some((sql) => sql.includes("UPDATE agent_sessions SET state='FAILED'")),
    ).toBe(false);
    expect(h.statements.some((sql) => sql.includes("SET status=$3"))).toBe(true);
  });

  it("does not alter session or step after lease ownership expires", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const h = harness(1, {}, false);
    await h.worker.runNext("/tmp/checkout");
    expect(h.statements.some((sql) => sql.includes("lease_expires_at > now()"))).toBe(true);
    expect(h.statements.some((sql) => sql.includes("UPDATE agent_sessions SET state='FAILED'"))).toBe(false);
    expect(h.statements.some((sql) => sql.includes("UPDATE workflow_step_executions SET state='FAILED'"))).toBe(false);
  });

  it("marks failed session and step when Muse exits unsuccessfully", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const h = harness(1);
    await expect(h.worker.runNext("/tmp/checkout")).resolves.toEqual({
      jobId: "job",
      status: "FAILED",
    });
    expect(
      h.statements.some((sql) => sql.includes("UPDATE agent_sessions SET state='FAILED'")),
    ).toBe(true);
    expect(
      h.statements.some((sql) =>
        sql.includes("UPDATE workflow_step_executions SET state='FAILED'"),
      ),
    ).toBe(true);
  });
});
