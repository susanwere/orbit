import { describe, expect, it } from "vitest";
import { layoutGraph, routeEdge, type GraphLayout, type LayoutNode } from "./graph-layout.js";
import { projectExecutionGraph } from "./WorkGraphCanvas.js";

function assertNoOverlaps(layout: GraphLayout) {
  const nodes = [...layout.nodes.values()];
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      const separatedX = Math.abs(left.x - right.x) >= (left.width + right.width) / 2;
      const separatedY = Math.abs(left.y - right.y) >= (left.height + right.height) / 2;
      expect(separatedX || separatedY, `${left.id} overlaps ${right.id}`).toBe(true);
    }
  }
}
const workItem = (key: string, dependsOn: string[] = []) => ({
  key,
  title: `Work ${key}`,
  dependsOn,
  workflows: Array.from({ length: 3 }, (_, index) => ({
    name: `Workflow ${index}`,
    steps: Array.from({ length: 4 }, (_, step) => ({
      title: `Step ${step}`,
      executor: "human" as const,
      requiresApproval: true,
    })),
  })),
});
function projectLayout(items: ReturnType<typeof workItem>[]) {
  const graph = projectExecutionGraph(items, "Original intent", [], {});
  const nodes = graph.nodes.map((node, index) => ({
    id: node.id,
    width: index % 2 ? 210 : 290,
    height: 100 + (index % 5) * 70,
  }));
  return { graph, nodes, layout: layoutGraph(nodes, graph.edges) };
}

describe("dimension-aware graph layout", () => {
  it("separates one work item with several workflows, steps and gates", () => {
    const { layout } = projectLayout([workItem("build")]);
    assertNoOverlaps(layout);
    expect(layout.nodes.size).toBe(20);
  });
  it("separates multiple work items and branching/converging dependencies", () => {
    const { graph, nodes, layout } = projectLayout([
      workItem("a"),
      workItem("b", ["a"]),
      workItem("c", ["a"]),
      workItem("d", ["b", "c"]),
    ]);
    assertNoOverlaps(layout);
    expect(graph.edges).toContainEqual({ from: "work:b", to: "work:d", dependency: true });
    expect(graph.edges).toContainEqual({ from: "work:c", to: "work:d", dependency: true });
    for (const edge of graph.edges)
      expect(layout.nodes.get(edge.to)!.x).toBeGreaterThan(layout.nodes.get(edge.from)!.x);
    expect([...layoutGraph(nodes, graph.edges).nodes]).toEqual([...layout.nodes]);
  });
  it("reflows measured title heights and widths without overlap", () => {
    const { graph, nodes } = projectLayout([workItem("a"), workItem("b")]);
    const expandedNodes = nodes.map((node, index) => ({
      ...node,
      width: index % 2 ? 420 : 175,
      height: index % 3 ? 160 : 650,
    }));
    assertNoOverlaps(layoutGraph(expandedNodes, graph.edges));
    expect(nodes[0]!.width).toBe(290);
  });
  it("keeps geometry independent of authoritative status changes", () => {
    const { graph, nodes } = projectLayout([workItem("a")]);
    const refreshed = nodes.map((node) => ({ ...node, state: "CANCELED" }));
    expect([...layoutGraph(refreshed, graph.edges).nodes]).toEqual(
      [...layoutGraph(nodes, graph.edges).nodes].map(([id, node]) => [
        id,
        { ...node, state: "CANCELED" },
      ]),
    );
  });
  it("handles cycles, disconnected nodes and an empty graph without modifying edges", () => {
    const nodes: LayoutNode[] = ["a", "b", "c"].map((id) => ({ id, width: 210, height: 140 }));
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const snapshot = structuredClone(edges);
    assertNoOverlaps(layoutGraph(nodes, edges));
    expect(edges).toEqual(snapshot);
    expect(layoutGraph([], []).bounds).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
  it("attaches edges to borders and routes skipped columns above card content", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ id, width: 210, height: 160 }));
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ];
    const layout = layoutGraph(nodes, edges);
    const route = routeEdge(layout, edges[2]!);
    expect(route[0]!.x).toBe(layout.nodes.get("a")!.x + 105);
    expect(route.at(-1)!.x).toBe(layout.nodes.get("c")!.x - 105);
    expect(Math.min(...route.map((point) => point.y))).toBeLessThan(layout.bounds.top);
    for (let index = 1; index < route.length - 1; index++) {
      const previous = route[index - 1]!;
      const point = route[index]!;
      const next = route[index + 1]!;
      const incoming = { x: point.x - previous.x, y: point.y - previous.y };
      const outgoing = { x: next.x - point.x, y: next.y - point.y };
      const cosine =
        (incoming.x * outgoing.x + incoming.y * outgoing.y) /
        (Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y));
      expect(cosine).toBeGreaterThan(0.5);
    }
  });
});
