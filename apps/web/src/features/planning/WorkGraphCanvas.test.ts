import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GraphNodeCard,
  projectExecutionGraph,
  projectPlanGraph,
  WorkGraphCanvas,
} from "./WorkGraphCanvas.js";

describe("projectPlanGraph", () => {
  it("creates intent, dependency edges, workflow nodes and real approval gates", () => {
    const graph = projectPlanGraph(
      [
        {
          key: "setup",
          title: "Setup",
          dependsOn: [],
          workflows: [
            {
              name: "Scaffold",
              steps: [{ title: "Set up", executor: "human", requiresApproval: true }],
            },
          ],
        },
        {
          key: "ui",
          title: "UI",
          dependsOn: ["setup"],
          workflows: [
            {
              name: "Build",
              steps: [{ title: "Build UI", executor: "agent", requiresApproval: false }],
            },
          ],
        },
      ],
      "Create a user interface",
    );
    expect(graph.nodes.find((node) => node.id === "intent")?.subtitle).toBe(
      "Create a user interface",
    );
    expect(graph.edges).toContainEqual({ from: "work:setup", to: "work:ui", dependency: true });
    expect(graph.nodes.filter((node) => node.kind === "workflow")).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.kind === "gate")).toHaveLength(1);
  });

  it("ignores missing dependency keys and does not invent a provider execution event", () => {
    const graph = projectPlanGraph(
      [{ key: "a", title: "A", dependsOn: ["unknown"], workflows: [] }],
      "Intent",
    );
    expect(graph.edges.some((edge) => edge.from === "work:unknown")).toBe(false);
    expect(graph.nodes.every((node) => node.kind !== ("running" as string))).toBe(true);
  });
});

describe("execution graph evidence", () => {
  it("projects waiting dependencies and readiness onto the main work item nodes", () => {
    const items = [{ key: "ui", title: "Build UI", dependsOn: ["api"], workflows: [] }];
    const task = {
      id: "task-ui",
      task_key: "ui",
      title: "Build UI",
      prompt: "Build UI",
      revision: 1,
      state: "DRAFT" as const,
      has_agent_executor: true,
      blocked_by: ["Build API"],
    };
    const waiting = projectExecutionGraph(items, "Intent", [], {}, [task]);
    expect(waiting.nodes.find((node) => node.id === "work:ui")?.executionStatus).toBe("WAITING");
    const ready = projectExecutionGraph(items, "Intent", [], {}, [{ ...task, blocked_by: [] }]);
    expect(ready.nodes.find((node) => node.id === "work:ui")?.executionStatus).toBe("READY");
  });
  it.each([
    { delivery_state: "REQUESTED" },
    { delivery_state: "RUNNING" },
    { delivery_state: "FINISHED", github_ci_state: "WAITING" },
    { delivery_state: "FINISHED", github_ci_state: "PENDING" },
  ])("keeps active canvas nodes running through delivery and verification (%j)", (phase) => {
    const task = {
      id: "task",
      task_key: "build",
      title: "Build",
      prompt: "Build",
      revision: 1,
      state: "ACTIVE" as const,
      ...phase,
    };
    const graph = projectExecutionGraph(
      [{ key: "build", title: "Build", dependsOn: [], workflows: [] }],
      "Intent",
      [
        {
          id: "step",
          work_item_key: "build",
          workflow_index: 0,
          step_index: 0,
          state: "WAITING",
          blocker_reason: null,
          approval_required: false,
          approved_at: null,
          agent_session_id: "session",
        },
      ],
      {},
      [task],
    );
    expect(graph.nodes.find((node) => node.id === "work:build")?.executionStatus).toBe("RUNNING");
  });
  it("keeps a finished Muse turn separate from the authoritative workflow state", async () => {
    const { projectExecutionGraph } = await import("./WorkGraphCanvas.js");
    const graph = projectExecutionGraph(
      [
        {
          key: "build",
          title: "Build",
          dependsOn: [],
          workflows: [
            {
              name: "Engineering",
              steps: [{ title: "Implement", executor: "agent", requiresApproval: false }],
            },
          ],
        },
      ],
      "Build an app",
      [
        {
          id: "step-1",
          state: "RUNNING",
          blocker_reason: null,
          work_item_key: "build",
          workflow_index: 0,
          step_index: 0,
          approval_required: false,
          approved_at: null,
          agent_session_id: "session-1",
        },
      ],
      {
        "session-1": {
          id: "job-1",
          status: "TURN_FINISHED",
          workflow_step_id: "step-1",
          attempts: 1,
          started_at: null,
          finished_at: null,
          failure_reason: null,
          github_repository: null,
          github_pull_number: null,
        },
      },
    );
    expect(graph.nodes.find((node) => node.id === "step:build:0:0")?.executionStatus).toBe(
      "RUNNING",
    );
    expect(graph.nodes.find((node) => node.id === "agent:session-1")?.executionStatus).toBe(
      "TURN_FINISHED",
    );
    expect(graph.nodes.some((node) => node.executionStatus === "COMPLETED")).toBe(false);
  });
  it("does not invent an ordering dependency between independent workflows", () => {
    const graph = projectPlanGraph(
      [
        {
          key: "work",
          title: "Work",
          dependsOn: [],
          workflows: [
            { name: "Design", steps: [] },
            { name: "Engineering", steps: [] },
          ],
        },
      ],
      "Intent",
    );
    expect(graph.edges).toContainEqual({ from: "work:work", to: "workflow:work:0" });
    expect(graph.edges).toContainEqual({ from: "work:work", to: "workflow:work:1" });
    expect(graph.edges).not.toContainEqual({ from: "workflow:work:0", to: "workflow:work:1" });
  });
});

describe("main workflow canvas", () => {
  it.each([false, true])("shows only intent and main work items when approved=%s", (approved) => {
    const markup = renderToStaticMarkup(
      createElement(WorkGraphCanvas, {
        items: [
          {
            key: "build",
            title: "Build the app",
            dependsOn: [],
            workflows: [
              {
                name: "Private workflow detail",
                steps: [
                  { title: "Private step detail", executor: "agent", requiresApproval: true },
                ],
              },
            ],
          },
        ],
        intent: "Build an app",
        approved,
        selectedItemKey: null,
        onSelect: () => undefined,
      }),
    );
    expect(markup).toContain("Build the app · work");
    expect(markup).toContain("Original intent · intent");
    expect(markup).not.toContain("Private workflow detail");
    expect(markup).not.toContain("Private step detail");
    expect(markup).not.toContain("Human approval required · gate");
  });
});

describe("canvas execution controls", () => {
  it.each([false, true])("requires approval for executable cards (approved=%s)", (approved) => {
    const markup = renderToStaticMarkup(
      createElement(WorkGraphCanvas, {
        items: [
          { key: "ready", title: "Ready work", dependsOn: [], workflows: [] },
          { key: "blocked", title: "Blocked work", dependsOn: ["ready"], workflows: [] },
        ],
        intent: "Intent",
        approved,
        selectedItemKey: null,
        onSelect: () => undefined,
        executableItemKeys: ["ready"],
        onExecute: () => undefined,
      }),
    );
    expect(markup.includes("Execute Ready work")).toBe(approved);
    expect(markup).not.toContain("Execute Blocked work");
    expect(markup).not.toContain("Execute Original intent");
  });
});

describe("active execution node", () => {
  it.each(["RUNNING", "STARTING", "WAITING", "READY_FOR_REVIEW", "COMPLETED", "FAILED"])(
    "animates only active execution and marks finished nodes as settled (%s)",
    (status) => {
      const markup = renderToStaticMarkup(
        createElement(GraphNodeCard, {
          node: {
            id: "work:build",
            title: "Build",
            subtitle: "build",
            kind: "work",
            executionStatus: status,
          },
          selected: false,
          onChoose: () => undefined,
          onMeasure: () => undefined,
          onFocus: () => undefined,
        }),
      );
      expect(markup.includes("is-executing")).toBe(["RUNNING", "STARTING"].includes(status));
      expect(markup.includes("is-settled")).toBe(
        ["COMPLETED", "READY_FOR_REVIEW"].includes(status),
      );
      expect(markup).toContain(`Status: ${status.replaceAll("_", " ")}`);
    },
  );
});

it("gives the original intent a static green border without marking it as executing", () => {
  const markup = renderToStaticMarkup(
    createElement(GraphNodeCard, {
      node: { id: "intent", title: "Original intent", subtitle: "Build it", kind: "intent" },
      selected: false,
      onChoose: () => undefined,
      onMeasure: () => undefined,
      onFocus: () => undefined,
    }),
  );
  expect(markup).toContain("is-settled");
  expect(markup).not.toContain("is-executing");
  expect(markup).toContain('aria-busy="false"');
});

it("does not allow a stale Execute action to overwrite an active node's status", () => {
  const markup = renderToStaticMarkup(
    createElement(GraphNodeCard, {
      node: {
        id: "work:build",
        title: "Build",
        subtitle: "build",
        kind: "work",
        executionStatus: "RUNNING",
      },
      selected: false,
      onChoose: () => undefined,
      onMeasure: () => undefined,
      onFocus: () => undefined,
      onExecute: () => undefined,
    }),
  );
  expect(markup).toContain("Status: RUNNING");
  expect(markup).toContain("is-executing");
  expect(markup).not.toContain('aria-label="Execute Build"');
});
