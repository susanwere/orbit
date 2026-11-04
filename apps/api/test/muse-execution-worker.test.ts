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
          expect(args.slice(1)).toEqual([
            "project",
            "org",
            "human",
            "session",
            "member",
            false,
            '["susanwere/private-test"]',
          ]);
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
    expect(statement).toContain("plan.status='APPROVED'");
    expect(statement).toContain("plan.revision=step.plan_revision");
    expect(statement).toContain("prereq.state <> 'COMPLETED'");
    expect(statement).toContain("s.state='RUNNING'");
    expect(statement).toContain("c.allowed_paths <> '[]'::jsonb");
    expect(statement).toContain("gate.status='OPEN'");
    expect(statement).toContain("ON CONFLICT");
  });

  it("scopes Muse job reads to the authenticated project and organization", async () => {
    const recorded: { sql?: string; args?: unknown[] } = {};
    const service = new MuseExecutionJobService(
      {
        query: async (sql: string, args: unknown[]) => {
          recorded.sql = sql;
          recorded.args = args;
          return { rows: [{ id: "job", status: "TURN_FINISHED" }] };
        },
      } as never,
      {
        authorize: async (_principal: string, _project: string, permission: string) => {
          expect(permission).toBe("read");
          return { projectId: "project", organizationId: "org" };
        },
      } as never,
    );
    await expect(
      service.getStatus({ projectId: "project", principalId: "human", sessionId: "session" }),
    ).resolves.toMatchObject({ status: "TURN_FINISHED" });
    expect(recorded.args).toEqual(["project", "org", "session"]);
    expect(recorded.sql).toContain("job.organization_id=$2");
    expect(recorded.sql).toContain("session.organization_id=job.organization_id");
    expect(recorded.sql).toContain(
      "job_id=job.id AND project_id=job.project_id AND organization_id=job.organization_id",
    );
    expect(recorded.sql).toContain("ORDER BY id DESC LIMIT 200");
    expect(recorded.sql).toContain(
      "CASE WHEN step.state='COMPLETED' AND ci.artifact_ref IS NOT NULL THEN 'PASSED'",
    );
    expect(recorded.sql).toContain("evidence.metadata->>'headSha'=job.github_head_sha");
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
    attempts: 0,
    mission: "Implement a React component",
    allowed_repositories: ["org/repo"],
    allowed_paths: ["src/**"],
    network_policy: "none",
    network_allowlist: [],
  };
  const harness = (
    exitCode: number,
    overrides: Record<string, unknown> = {},
    leaseWon = true,
    retainOutput = true,
  ) => {
    const statements: string[] = [];
    let invoked = 0;
    const worker = new MuseExecutionWorker(
      {
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [], rowCount: 0 };
        },
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
            ...(retainOutput
              ? { reviewOutput: "Implemented the component.", changedPaths: ["src/Component.tsx"] }
              : {}),
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
    expect(h.statements.some((sql) => sql.includes("plan.status='APPROVED'"))).toBe(true);
    expect(h.statements.some((sql) => sql.includes("prior.state <> 'COMPLETED'"))).toBe(true);
    expect(
      h.statements.some((sql) => sql.includes("UPDATE agent_sessions SET state='FAILED'")),
    ).toBe(false);
    expect(h.statements.some((sql) => sql.includes("SET status=$3"))).toBe(true);
  });

  it("fails explicitly and makes the task retryable when a turn returns no retained output", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const test = harness(0, {}, true, false);
    expect(await test.worker.runNext("/tmp/checkout")).toEqual({ jobId: "job", status: "FAILED" });
    expect(
      test.statements.some((statement) =>
        statement.includes("UPDATE project_tasks SET state='FAILED'"),
      ),
    ).toBe(true);
    expect(
      test.statements.some((statement) => statement.includes("INSERT INTO muse_job_outputs")),
    ).toBe(false);
  });
  it("does not alter session or step after lease ownership expires", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const h = harness(1, {}, false);
    await expect(h.worker.runNext("/tmp/checkout")).resolves.toEqual({
      jobId: "job",
      status: "LEASE_LOST",
    });
    expect(h.statements.some((sql) => sql.includes("lease_expires_at > now()"))).toBe(true);
    expect(
      h.statements.some((sql) => sql.includes("UPDATE agent_sessions SET state='FAILED'")),
    ).toBe(false);
    expect(
      h.statements.some((sql) =>
        sql.includes("UPDATE workflow_step_executions SET state='FAILED'"),
      ),
    ).toBe(false);
  });

  it("pins local claims to the selected job, project, repository and mount contract", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const selection = {
      jobId: "selected-job",
      projectId: "project",
      repository: "org/repo",
      allowedPaths: ["src/**"],
    };
    let invoked = false;
    const worker = new MuseExecutionWorker(
      {
        transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            query: async (statement: string, parameters: unknown[]) => {
              expect(statement).toContain("job.id=$1 AND job.project_id=$2");
              expect(statement).toContain(
                "c.allowed_repositories=$3::jsonb AND c.allowed_paths=$4::jsonb",
              );
              expect(statement).toContain(
                "step.approval_required=false OR step.approved_by_principal_id IS NOT NULL",
              );
              expect(parameters).toEqual(["selected-job", "project", '["org/repo"]', '["src/**"]']);
              return { rows: [] };
            },
          }),
      } as never,
      {
        execute: async () => {
          invoked = true;
          throw new Error("Unexpected execution");
        },
      },
    );
    expect(await worker.runNext("/workspace", selection)).toBeNull();
    expect(invoked).toBe(false);
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
