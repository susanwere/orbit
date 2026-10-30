import { describe, expect, it } from "vitest";
import { projectPlanGraph } from "./WorkGraphCanvas.js";

describe("projectPlanGraph", () => {
  it("creates intent, dependency edges, workflow nodes and real approval gates", () => {
    const graph = projectPlanGraph(
      [
        { key: "setup", title: "Setup", dependsOn: [], workflows: [{ name: "Scaffold", steps: [{ title: "Set up", executor: "human", requiresApproval: true }] }] },
        { key: "ui", title: "UI", dependsOn: ["setup"], workflows: [{ name: "Build", steps: [{ title: "Build UI", executor: "agent", requiresApproval: false }] }] },
      ],
      "Create a user interface",
    );
    expect(graph.nodes.find((node) => node.id === "intent")?.subtitle).toBe("Create a user interface");
    expect(graph.edges).toContainEqual({ from: "work:setup", to: "work:ui", dependency: true });
    expect(graph.nodes.filter((node) => node.kind === "workflow")).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.kind === "gate")).toHaveLength(1);
  });

  it("ignores missing dependency keys and does not invent a provider execution event", () => {
    const graph = projectPlanGraph([{ key: "a", title: "A", dependsOn: ["unknown"], workflows: [] }], "Intent");
    expect(graph.edges.some((edge) => edge.from === "work:unknown")).toBe(false);
    expect(graph.nodes.every((node) => node.kind !== ("running" as string))).toBe(true);
  });
});
