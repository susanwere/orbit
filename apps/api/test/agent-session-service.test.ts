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

describe("agent session start authorization", () => {
  it("requires an approved tenant-scoped plan and a matching authorized session", async () => {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const svc = new AgentSessionService(
      {
        query: async (sql: string, values: unknown[]) => {
          statements.push(sql);
          parameters.push(values);
          return { rows: [{ id: "session", state: "RUNNING" }] };
        },
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
      {} as never,
    );
    const result = await svc.start("project", "owner", "session");
    expect(result).toMatchObject({ state: "RUNNING" });
    expect(statements[0]).toContain("p.status='APPROVED'");
    expect(statements[0]).toContain("p.organization_id=agent_sessions.organization_id");
    expect(statements[0]).toContain("organization_id=$5");
    expect(parameters[0]).toEqual(["project", "session", "owner", "member", "org"]);
  });

  it("does not start a session if the guarded database update matches no rows", async () => {
    const svc = new AgentSessionService(
      { query: async () => ({ rows: [] }) } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
      {} as never,
    );
    await expect(svc.start("project", "owner", "session")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("does not touch the database if project authorization fails", async () => {
    let queried = false;
    const svc = new AgentSessionService(
      {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      } as never,
      {
        authorize: async () => {
          throw new DomainError("forbidden", "Denied");
        },
      } as never,
      {} as never,
    );
    await expect(svc.start("project", "outsider", "session")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(queried).toBe(false);
  });
});
