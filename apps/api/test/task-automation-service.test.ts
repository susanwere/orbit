import { describe, expect, it, vi } from "vitest";
import { TaskAutomationService } from "../src/modules/tasks/task-automation-service.js";

function fixture(ciState: "FAILED" | "PENDING", deliveryFailed = false) {
  const statements: string[] = [];
  const evidence = { verify: vi.fn() };
  const jobs = { enqueue: vi.fn().mockResolvedValue({ id: "repair-job" }) };
  const repair = { prepare: vi.fn().mockResolvedValue({ repairSourceJobId: "job" }) };
  const service = new TaskAutomationService(
    {
      query: async (statement: string) => {
        statements.push(statement);
        return {
          rows: statement.startsWith("SELECT task.id")
            ? [
                {
                  id: "task",
                  organization_id: "org",
                  plan_id: "plan",
                  task_key: "build",
                  prompt: "Implement",
                  step_id: "step",
                  session_id: "session",
                  approved_by_principal_id: "owner",
                  automatic_repairs: 0,
                  job_id: "job",
                  job_status: "TURN_FINISHED",
                  github_pull_number: deliveryFailed ? null : 123,
                  delivery_state: deliveryFailed ? "ERROR" : "FINISHED",
                },
              ]
            : [],
        };
      },
    } as never,
    {} as never,
    { inspect: async () => ({ state: ciState, summary: `CI ${ciState}`, runs: [] }) } as never,
    repair as never,
    { authorizeRetry: vi.fn().mockResolvedValue({}) } as never,
    {
      listApproved: async () => [{ id: "agent", provider: "meta" }],
      create: async () => ({ session: { id: "repair-session" } }),
      start: vi.fn().mockResolvedValue({}),
    } as never,
    { bind: vi.fn().mockResolvedValue({}) } as never,
    jobs as never,
    evidence as never,
  );
  return { service, statements, evidence, jobs, repair };
}
describe("task review lifecycle", () => {
  it("continues observing pending CI without execution, repair, or completion", async () => {
    const test = fixture("PENDING");
    expect(await test.service.advanceNext("project")).toBeNull();
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
    expect(test.repair.prepare).not.toHaveBeenCalled();
    expect(test.evidence.verify).not.toHaveBeenCalled();
  });
  it("stops an interrupted delivery without queuing another model run or CI repair", async () => {
    const test = fixture("PENDING", true);
    expect(await test.service.advanceNext("project")).toBe("delivery-failed:task");
    expect(test.statements.some((statement) => statement.includes("SET state='NEEDS_INPUT'"))).toBe(
      true,
    );
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
    expect(test.repair.prepare).not.toHaveBeenCalled();
    expect(test.evidence.verify).not.toHaveBeenCalled();
  });
  it("returns a reviewed task to active execution only for a verified CI regression", async () => {
    const test = fixture("FAILED");
    expect(await test.service.advanceNext("project")).toBe("ci-repair-started:task");
    expect(
      test.statements.some((statement) => statement.includes("SET state='ACTIVE',session_id=$3")),
    ).toBe(true);
    expect(test.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(test.evidence.verify).not.toHaveBeenCalled();
  });
});
