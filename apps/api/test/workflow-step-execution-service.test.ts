import { describe, expect, it } from "vitest";
import { WorkflowStepExecutionService } from "../src/modules/execution/workflow-step-execution-service.js";

function harness({
  state = "BLOCKED",
  approved = true,
  prerequisites = 0,
  openGates = 0,
  boundSession: boundSession = null,
  sessionAuthorized = true,
}: {
  state?: string;
  approved?: boolean;
  prerequisites?: number;
  openGates?: number;
  boundSession?: string | null;
  sessionAuthorized?: boolean;
} = {}) {
  const statements: string[] = [];
  let updates = 0;
  const db = {
    transaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
  async function query(sql: string, parameters: unknown[]) {
    statements.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) {
      expect(parameters[0]).toBe("orbit:steps:org:project");
      return { rows: [{}] };
    }
    if (sql.includes("JOIN plan_proposals")) {
      return {
        rows: [
          {
            id: "step",
            state,
            approval_required: true,
            approved_by_principal_id: approved ? "reviewer" : null,
            agent_session_id: boundSession,
          },
        ],
      };
    }
    if (sql.includes("FROM workflow_step_prerequisites")) {
      return { rows: Array.from({ length: prerequisites }, (_, index) => ({ id: String(index) })) };
    }
    if (sql.includes("JOIN agent_sessions s ON s.id=step.agent_session_id")) {
      return { rows: sessionAuthorized ? [{ id: "session" }] : [] };
    }
    if (sql.includes("FROM human_gates gate")) {
      return { rows: Array.from({ length: openGates }, (_, index) => ({ id: String(index) })) };
    }
    if (sql.includes("UPDATE workflow_step_executions")) {
      updates++;
      return { rows: [{ id: "step", state: "RUNNING" }] };
    }
    throw new Error("Unexpected SQL");
  }
  const service = new WorkflowStepExecutionService(
    db as never,
    { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
  );
  return {
    service,
    statements,
    get updates() {
      return updates;
    },
  };
}

describe("authoritative step execution", () => {
  const input = { projectId: "project", principalId: "reviewer", stepId: "step" };

  it("starts only an eligible approved step with completed prerequisites", async () => {
    const h = harness();
    await expect(h.service.start(input)).resolves.toMatchObject({ state: "RUNNING" });
    expect(h.updates).toBe(1);
    expect(h.statements.some((sql) => sql.includes("p.status='APPROVED'"))).toBe(true);
    expect(h.statements.some((sql) => sql.includes("prerequisite.state <> 'COMPLETED'"))).toBe(
      true,
    );
  });

  it("blocks pending approval without changing state", async () => {
    const h = harness({ approved: false });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
  });

  it("blocks incomplete prerequisites without changing state", async () => {
    const h = harness({ prerequisites: 1 });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
  });

  it("rejects a bound session that lost authorization before start", async () => {
    const h = harness({ boundSession: "session", sessionAuthorized: false });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
  });

  it("blocks an unresolved session human gate even after step approval", async () => {
    const h = harness({ openGates: 1 });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
    expect(h.statements.some((sql) => sql.includes("gate.status='OPEN'"))).toBe(true);
  });

  it("rejects duplicate execution attempts", async () => {
    const h = harness({ state: "RUNNING" });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
  });

  it("denies unauthorized principals before querying step records", async () => {
    let queried = false;
    const service = new WorkflowStepExecutionService(
      {
        transaction: async () => {
          queried = true;
        },
      } as never,
      {
        authorize: async () => {
          throw new Error("Not authorized");
        },
      } as never,
    );
    await expect(service.start(input)).rejects.toThrow("Not authorized");
    expect(queried).toBe(false);
  });
});

describe("human approval authority", () => {
  it("persists reviewer identity only on an approved plan and pending step", async () => {
    const statements: string[] = [];
    const service = new WorkflowStepExecutionService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string, args: unknown[]) => {
              statements.push(sql);
              if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
              expect(args).toEqual(["step", "project", "org", "reviewer"]);
              return { rows: [{ id: "step", approved_by_principal_id: "reviewer" }] };
            },
          }),
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
    );
    await expect(
      service.approve({ projectId: "project", principalId: "reviewer", stepId: "step" }),
    ).resolves.toMatchObject({ approved_by_principal_id: "reviewer" });
    expect(statements[1]).toContain("p.status='APPROVED'");
    expect(statements[1]).toContain("s.approved_by_principal_id IS NULL");
    expect(statements[1]).toContain("s.state IN ('BLOCKED','READY')");
  });

  it("rejects duplicate and ineligible approval updates", async () => {
    const service = new WorkflowStepExecutionService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ query: async () => ({ rows: [] }) }),
      } as never,
      { authorize: async () => ({ organizationId: "org" }) } as never,
    );
    await expect(
      service.approve({ projectId: "project", principalId: "reviewer", stepId: "step" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("evidence-backed step completion", () => {
  it("only marks a step complete with a linked completed session and passing evidence", async () => {
    const statements: string[] = [];
    const service = new WorkflowStepExecutionService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string, args: unknown[]) => {
              statements.push(sql);
              if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
              expect(args).toEqual(["step", "project", "org"]);
              return { rows: [{ id: "step", state: "COMPLETED" }] };
            },
          }),
      } as never,
      { authorize: async () => ({ organizationId: "org" }) } as never,
    );
    await expect(
      service.complete({ projectId: "project", principalId: "reviewer", stepId: "step" }),
    ).resolves.toMatchObject({ state: "COMPLETED" });
    expect(statements[1]).toContain("session.state='COMPLETED'");
    expect(statements[1]).toContain("e.result='PASSED'");
    expect(statements[1]).toContain("e.scope_type='workflow_step'");
    expect(statements[1]).toContain("s.agent_session_id IS NOT NULL");
  });

  it("fails closed without proven completion", async () => {
    const service = new WorkflowStepExecutionService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ query: async () => ({ rows: [] }) }),
      } as never,
      { authorize: async () => ({ organizationId: "org" }) } as never,
    );
    await expect(
      service.complete({ projectId: "project", principalId: "reviewer", stepId: "step" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
