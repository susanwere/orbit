import { Canvas } from "@react-three/fiber";
import { Html, Line, MapControls } from "@react-three/drei";
import { useMemo } from "react";
import "./workgraph-canvas.css";

interface WorkStep {
  title: string;
  executor: "agent" | "human" | "system";
  requiresApproval: boolean;
}
interface WorkItem {
  key: string;
  title: string;
  dependsOn: string[];
  workflows: { name: string; steps: WorkStep[] }[];
}
type GraphNode = {
  id: string;
  title: string;
  subtitle: string;
  kind: "intent" | "work" | "workflow" | "gate";
  x: number;
  y: number;
  target?: string;
};
type GraphEdge = { from: string; to: string; dependency?: boolean };

export function projectPlanGraph(
  items: readonly WorkItem[],
  statement: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: "intent", title: "Original intent", subtitle: statement, kind: "intent", x: 0, y: 4 },
  ];
  const edges: GraphEdge[] = [];
  const keys = new Set(items.map((item) => item.key));
  const depths = new Map<string, number>();
  // Cycle-safe, deterministic layering. An invalid cycle is never treated as executable.
  function depth(key: string, seen = new Set<string>()): number {
    if (depths.has(key)) return depths.get(key)!;
    if (seen.has(key)) return 0;
    const item = items.find((entry) => entry.key === key);
    if (!item) return 0;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const result = Math.max(
      0,
      ...item.dependsOn.filter((dep) => keys.has(dep)).map((dep) => depth(dep, nextSeen) + 1),
    );
    depths.set(key, result);
    return result;
  }
  for (const item of items) depth(item.key);
  const columns = new Map<number, WorkItem[]>();
  for (const item of items) {
    const level = depths.get(item.key) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), item]);
  }
  const maxColumn = Math.max(0, ...columns.keys());
  for (const [level, group] of columns) {
    for (const [index, item] of group.entries()) {
      const x = (level - maxColumn / 2) * 4.8;
      const y = 1.4 - (index - (group.length - 1) / 2) * 4.2;
      const workId = `work:${item.key}`;
      nodes.push({
        id: workId,
        title: item.title,
        subtitle: item.key,
        kind: "work",
        x,
        y,
        target: item.key,
      });
      if (!item.dependsOn.length) edges.push({ from: "intent", to: workId });
      for (const dependency of item.dependsOn) {
        if (keys.has(dependency)) {
          edges.push({ from: `work:${dependency}`, to: workId, dependency: true });
        }
      }
      item.workflows.forEach((workflow, wi) => {
        const workflowId = `workflow:${item.key}:${wi}`;
        nodes.push({
          id: workflowId,
          title: workflow.name,
          subtitle: `${workflow.steps.length} steps · ${workflow.steps.filter((step) => step.requiresApproval).length} approval gates`,
          kind: "workflow",
          x,
          y: y - 2.05 - wi * 2,
          target: item.key,
        });
        edges.push({ from: wi === 0 ? workId : `workflow:${item.key}:${wi - 1}`, to: workflowId });
        if (workflow.steps.some((step) => step.requiresApproval)) {
          const gateId = `gate:${item.key}:${wi}`;
          nodes.push({
            id: gateId,
            title: "Human approval required",
            subtitle: "Proposed gate · no execution",
            kind: "gate",
            x: x + 2.6,
            y: y - 2.05 - wi * 2,
            target: item.key,
          });
          edges.push({ from: workflowId, to: gateId });
        }
      });
    }
  }
  return { nodes, edges };
}

interface Props {
  readonly items: readonly WorkItem[];
  readonly intent: string;
  readonly approved: boolean;
  readonly selectedItemKey: string | null;
  readonly onSelect: (key: string | null) => void;
}

export function WorkGraphCanvas({ items, intent, approved, selectedItemKey, onSelect }: Props) {
  const graph = useMemo(() => projectPlanGraph(items, intent), [items, intent]);

  const visibleNodes = graph.nodes.filter((node) => node.kind === "intent" || node.kind === "work");
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const columns = new Map<number, GraphNode[]>();
  const depths = new Map<string, number>();
  const byKey = new Map(items.map((item) => [item.key, item]));
  function depth(key: string, seen = new Set<string>()): number {
    if (depths.has(key)) return depths.get(key)!;
    if (seen.has(key)) return 0;
    const item = byKey.get(key);
    if (!item) return 0;
    const ancestors = new Set(seen);
    ancestors.add(key);
    const level = Math.max(1, ...item.dependsOn.filter((parent) => byKey.has(parent)).map((parent) => depth(parent, ancestors) + 1));
    depths.set(key, level);
    return level;
  }
  for (const node of visibleNodes) {
    const column = node.kind === "intent" ? 0 : depth(node.target!);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, nodes] of columns) {
    nodes.forEach((node, index) => positions.set(node.id, {
      x: level * 5,
      y: (nodes.length - 1) * 1.8 - index * 3.6,
    }));
  }
  const visibleEdges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const choose = (node: GraphNode) => {
    onSelect(node.target ?? null);
  };

  return (
    <div className="workgraph-root">
      <div className="workgraph-legend" aria-label="Workflow graph legend">
        <span>● Intent</span>
        <span>● Work item</span>
        <span>● Work items contain workflows and approval gates</span>
        <strong>{approved ? "Approved plan" : "Proposed only · not running"}</strong>
      </div>
      <div className="workgraph-scene" aria-label="Connected plan graph">
        <Canvas
          orthographic
          camera={{ position: [0, 0, 30], zoom: 65 }}
          gl={{ alpha: true, antialias: true }}
        >
          <ambientLight intensity={1.1} />
          {visibleEdges.map((edge, index) => {
            const start = positions.get(edge.from);
            const end = positions.get(edge.to);
            if (!start || !end) return null;
            return (
              <Line
                key={index}
                points={[
                  [start.x, start.y, -1],
                  [end.x, end.y, -1],
                ]}
                color={edge.dependency ? "#8cadff" : "#536c96"}
                lineWidth={edge.dependency ? 2 : 1.5}
              />
            );
          })}
          {visibleNodes.map((node) => (
            <Html
              key={node.id}
              position={[positions.get(node.id)!.x, positions.get(node.id)!.y, 0]}
              center
              transform={false}
              zIndexRange={[15, 5]}
            >
              <button
                type="button"
                className={`workgraph-node workgraph-node--${node.kind} ${(node.target ? selectedItemKey === node.target : selectedItemKey === null) ? "is-selected" : ""}`}
                aria-pressed={
                  node.target ? selectedItemKey === node.target : selectedItemKey === null
                }
                onClick={() => choose(node)}
                title={
                  node.target ? "Show this work item's configuration" : "Original project intent"
                }
              >
                <span>{node.kind === "intent" ? "ORIGINAL INTENT" : "WORK ITEM"}</span>
                <strong>{node.title}</strong>
                <small>{node.kind === "work" ? `${items.find((item) => item.key === node.target)?.workflows.length ?? 0} workflows · Click to configure` : node.subtitle}</small>
              </button>
            </Html>
          ))}
          <MapControls
            enableRotate={false}
            enableDamping
            dampingFactor={0.12}
            minZoom={20}
            maxZoom={120}
            screenSpacePanning
          />
        </Canvas>
      </div>
      <div className="workgraph-footer">
        <span>Drag to pan · scroll to zoom · select a work item to configure its workflows</span>
        <details>
          <summary>Accessible node list</summary>
          <ul>
            {visibleNodes.map((node) => (
              <li key={node.id}>
                <button type="button" onClick={() => choose(node)}>
                  {node.title} · {node.kind}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
