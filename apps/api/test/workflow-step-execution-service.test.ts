import { describe, expect, it } from "vitest";
import { WorkflowStepExecutionService } from "../src/modules/execution/workflow-step-execution-service.js";

function harness({
  state = "BLOCKED",
  approved = true,
  prerequisites = 0,
}: {
  state?: string;
  approved?: boolean;
  prerequisites?: number;
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
      return { rows: [{ id: "step", state, approval_required: true, approved_by_principal_id: approved ? "reviewer" : null }] };
    }
    if (sql.includes("FROM workflow_step_prerequisites")) {
      return { rows: Array.from({ length: prerequisites }, (_, index) => ({ id: String(index) })) };
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
  return { service, statements, get updates() { return updates; } };
}

describe("authoritative step execution", () => {
  const input = { projectId: "project", principalId: "reviewer", stepId: "step" };

  it("starts only an eligible approved step with completed prerequisites", async () => {
    const h = harness();
    await expect(h.service.start(input)).resolves.toMatchObject({ state: "RUNNING" });
    expect(h.updates).toBe(1);
    expect(h.statements.some((sql) => sql.includes("p.status='APPROVED'"))).toBe(true);
    expect(h.statements.some((sql) => sql.includes("prerequisite.state <> 'COMPLETED'"))).toBe(true);
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

  it("rejects duplicate execution attempts", async () => {
    const h = harness({ state: "RUNNING" });
    await expect(h.service.start(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.updates).toBe(0);
  });

  it("denies unauthorized principals before querying step records", async () => {
    let queried = false;
    const service = new WorkflowStepExecutionService(
      { transaction: async () => { queried = true; } } as never,
      { authorize: async () => { throw new Error("Not authorized"); } } as never,
    );
    await expect(service.start(input)).rejects.toThrow("Not authorized");
    expect(queried).toBe(false);
  });
});
