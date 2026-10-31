import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { AgentSessionService } from "../src/modules/agents/agent-session-service.js";
const agent = {
  id: "agent",
  organizationId: "org",
  status: "approved",
  version: 1,
  capabilities: ["read"],
  approvalRequiredActions: ["change-auth"],
  forbiddenActions: ["secrets"],
  allowedRepositories: ["org/repo"],
  allowedPaths: ["src/**"],
  networkPolicy: "none",
  networkAllowlist: [],
};
describe("scoped agent session creation", () => {
  it("creates snapshot, contract, and authorized session in one transaction", async () => {
    const statements: string[] = [];
    const tx = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM orbit_work_items")) return { rows: [{ id: "work" }] };
        if (sql.includes("FROM principals")) return { rows: [{ id: "owner" }] };
        if (sql.includes("FROM orbit_agent_definition_versions"))
          return { rows: [{ definition: agent, status: "approved", version: 1 }] };
        if (sql.includes("INSERT INTO agent_sessions"))
          return { rows: [{ id: "session_3", state: "AUTHORIZED" }] };
        return { rows: [] };
      },
    };
    const db = { transaction: async (fn: (x: typeof tx) => Promise<unknown>) => fn(tx) };
    const auth = { authorize: async () => ({ organizationId: "org", role: "member" }) };
    const snapshots = {
      createWithinTransaction: async () => ({ id: "snapshot", sourceContextVersionId: "v4" }),
    };
    const svc = new AgentSessionService(
      db as never,
      auth as never,
      snapshots as never,
      (() => {
        let i = 0;
        return () => String(++i);
      })(),
    );
    const result = await svc.create({
      projectId: "project",
      requestedBy: "requester",
      humanOwner: "owner",
      agentDefinitionId: "agent",
      workItemId: "work",
      mission: "Implement job pagination",
    });
    expect(result.executionContractId).toBe("contract_1");
    expect(statements.some((s) => s.includes("INSERT INTO execution_contracts"))).toBe(true);
    expect(statements.some((s) => s.includes("INSERT INTO agent_sessions"))).toBe(true);
  });
  it("denies unapproved agent definitions", async () => {
    const tx = {
      query: async (sql: string) => {
        if (sql.includes("FROM orbit_work_items")) return { rows: [{ id: "work" }] };
        if (sql.includes("FROM principals")) return { rows: [{ id: "owner" }] };
        if (sql.includes("FROM orbit_agent_definition_versions"))
          return {
            rows: [
              { definition: { ...agent, status: "suspended" }, status: "suspended", version: 1 },
            ],
          };
        return { rows: [] };
      },
    };
    const svc = new AgentSessionService(
      { transaction: async (fn: (x: typeof tx) => Promise<unknown>) => fn(tx) } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
      { createWithinTransaction: async () => ({ id: "snapshot" }) } as never,
    );
    await expect(
      svc.create({
        projectId: "project",
        requestedBy: "requester",
        humanOwner: "owner",
        agentDefinitionId: "agent",
        workItemId: "work",
        mission: "Build UI",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("atomic session and step start", () => {
  const make = (stepEligible = true, stepUpdate = true) => {
    const statements: string[] = [];
    const queries: unknown[][] = [];
    const tx = {
      query: async (sql: string, args: unknown[]) => {
        statements.push(sql);
        queries.push(args);
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("FROM workflow_step_executions step"))
          return { rows: stepEligible ? [{ step_id: "step" }] : [] };
        if (sql.includes("UPDATE agent_sessions"))
          return { rows: [{ id: "session", state: "RUNNING" }] };
        if (sql.includes("UPDATE workflow_step_executions"))
          return { rows: stepUpdate ? [{ id: "step" }] : [] };
        throw new Error("Unexpected SQL");
      },
    };
    const service = new AgentSessionService(
      {
        transaction: async (fn: (connection: { query: typeof tx.query }) => Promise<unknown>) =>
          fn(tx),
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
      {} as never,
    );
    return { service, statements, queries };
  };

  it("starts exactly one eligible linked step and session in a transaction", async () => {
    const h = make();
    await expect(h.service.start("project", "owner", "session")).resolves.toMatchObject({
      state: "RUNNING",
      workflowStepId: "step",
    });
    expect(h.statements[1]).toContain("plan.status='APPROVED'");
    expect(h.statements[1]).toContain("prerequisite.state <> 'COMPLETED'");
    expect(h.statements[1]).toContain("step.approved_by_principal_id IS NOT NULL");
    expect(h.statements[1]).toContain("gate.status='OPEN'");
    expect(h.queries[1]).toEqual(["session", "project", "org", "owner", "member"]);
    expect(h.statements.some((q) => q.includes("UPDATE workflow_step_executions"))).toBe(true);
  });

  it("rejects a blocked or unassigned step before any state update", async () => {
    const h = make(false);
    await expect(h.service.start("project", "owner", "session")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(h.statements.some((q) => q.trimStart().startsWith("UPDATE"))).toBe(false);
  });

  it("rolls back if the step transition fails", async () => {
    const h = make(true, false);
    await expect(h.service.start("project", "owner", "session")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("denies unauthorized principals before a transaction", async () => {
    let transacted = false;
    const service = new AgentSessionService(
      {
        transaction: async () => {
          transacted = true;
        },
      } as never,
      {
        authorize: async () => {
          throw new DomainError("forbidden", "Denied");
        },
      } as never,
      {} as never,
    );
    await expect(service.start("project", "outsider", "session")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(transacted).toBe(false);
  });
});

describe("approved project agent catalog", () => {
  it("uses project authorization and returns only public approved definition metadata", async () => {
    let sql = "";
    let argumentsSeen: unknown[] = [];
    const service = new AgentSessionService(
      {
        query: async (statement: string, args: unknown[]) => {
          sql = statement;
          argumentsSeen = args;
          return {
            rows: [{ id: "muse", name: "Muse Code", provider: "meta", version: 1 }],
          };
        },
      } as never,
      {
        authorize: async () => ({ organizationId: "org", role: "member" }),
      } as never,
      {} as never,
    );
    const agents = await service.listApproved("project", "human");
    expect(argumentsSeen).toEqual(["org", "project"]);
    expect(sql).toContain("d.status='approved'");
    expect(sql).toContain("MAX(latest.version)");
    expect(sql).toContain("project_repositories");
    expect(sql).toContain("allowedRepositories");
    expect(agents).toEqual([{ id: "muse", name: "Muse Code", provider: "meta", version: 1 }]);
    expect(JSON.stringify(agents)).not.toContain("META_API_KEY");
  });
});
