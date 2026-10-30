import { describe, expect, it } from "vitest";
import { ApprovedStepMaterializer } from "../src/modules/execution/approved-step-materializer.js";

const graph = {
  summary: "Create a React app",
  guardrails: [],
  decisionsToReview: [],
  assumptions: [],
  workItems: [
    {
      key: "setup",
      title: "Setup",
      description: "Prepare app",
      dependsOn: [],
      workflows: [
        {
          name: "Architecture",
          steps: [
            { title: "Propose structure", executor: "agent", requiresApproval: false },
            { title: "Review", executor: "human", requiresApproval: true },
          ],
        },
        {
          name: "Design",
          steps: [{ title: "Sketch UI", executor: "human", requiresApproval: false }],
        },
      ],
    },
    {
      key: "build",
      title: "Build",
      description: "Implement",
      dependsOn: ["setup"],
      workflows: [
        {
          name: "Code",
          steps: [{ title: "Implement", executor: "agent", requiresApproval: false }],
        },
      ],
    },
  ],
};

function harness(approved = true, existing = false) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("FROM plan_proposals"))
      return { rows: approved ? [{ id: "plan", revision: 3, content: graph }] : [] };
    if (sql.includes("FROM workflow_step_executions"))
      return { rows: existing ? [{ id: "step" }] : [] };
    return { rows: [] };
  };
  const service = new ApprovedStepMaterializer(
    {
      transaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    } as never,
    { authorize: async () => ({ organizationId: "org", role: "member" }) } as never,
  );
  return { service, statements };
}

describe("approved plan step materialization", () => {
  it("creates every step and connects only actual step/work-item dependencies", async () => {
    const h = harness();
    await expect(h.service.materialize("project", "owner")).resolves.toEqual({
      planId: "plan",
      revision: 3,
      stepCount: 4,
    });
    const edges = h.statements.filter((entry) =>
      entry.sql.includes("INSERT INTO workflow_step_prerequisites"),
    );
    expect(edges.map((edge) => edge.params.slice(2))).toEqual([
      ["step:plan:setup:0:1", "step:plan:setup:0:0"],
      ["step:plan:build:0:0", "step:plan:setup:0:1"],
      ["step:plan:build:0:0", "step:plan:setup:1:0"],
    ]);
    const inserted = h.statements.filter((entry) =>
      entry.sql.includes("INSERT INTO workflow_step_executions"),
    );
    expect(inserted).toHaveLength(4);
    const workItems = h.statements.filter((entry) => entry.sql.includes("INSERT INTO orbit_work_items"));
    expect(workItems.map((entry) => entry.params[0])).toEqual(["work:plan:setup", "work:plan:build"]);
    expect(inserted[1]?.params.at(-1)).toBe(true);
    expect(inserted[0]?.params[4]).toBe(3);
  });

  it("refuses to materialize unapproved plans", async () => {
    const h = harness(false);
    await expect(h.service.materialize("project", "owner")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(h.statements.filter((entry) => entry.sql.includes("INSERT INTO"))).toHaveLength(0);
  });

  it("refuses to duplicate step records after the first materialization", async () => {
    const h = harness(true, true);
    await expect(h.service.materialize("project", "owner")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(h.statements.filter((entry) => entry.sql.includes("INSERT INTO"))).toHaveLength(0);
  });
});
