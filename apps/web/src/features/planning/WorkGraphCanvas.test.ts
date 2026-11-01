import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectPlanGraph, WorkGraphCanvas } from "./WorkGraphCanvas.js";

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
