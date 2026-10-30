import { describe, expect, it } from "vitest";
import { StepSessionBindingService } from "../src/modules/execution/step-session-binding-service.js";

describe("step session binding", () => {
  const input = {
    projectId: "project",
    principalId: "reviewer",
    stepId: "step",
    sessionId: "session",
  };

  it("binds only a matching authorized session on an approved plan", async () => {
    const statements: string[] = [];
    const service = new StepSessionBindingService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string, params: unknown[]) => {
              statements.push(sql);
              if (sql.includes("pg_advisory_xact_lock")) {
                expect(params).toEqual(["orbit:steps:org:project"]);
                return { rows: [] };
              }
              expect(params).toEqual(["step", "project", "org", "session", "reviewer", "member"]);
              return { rows: [{ id: "step", agent_session_id: "session" }] };
            },
          }),
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
    );
    await expect(service.bind(input)).resolves.toMatchObject({ agent_session_id: "session" });
    expect(statements[1]).toContain("plan.status='APPROVED'");
    expect(statements[1]).toContain("session.state='AUTHORIZED'");
    expect(statements[1]).toContain("session.work_item_id=step.work_item_key");
    expect(statements[1]).toContain("step.agent_session_id IS NULL");
  });

  it("rejects ineligible and duplicate assignments", async () => {
    const service = new StepSessionBindingService(
      {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ query: async () => ({ rows: [] }) }),
      } as never,
      { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
    );
    await expect(service.bind(input)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
