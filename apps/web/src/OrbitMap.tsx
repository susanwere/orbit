import { useMemo, useState } from "react";
import type { ExecutionRecord, WorkItem } from "./api.js";

const LANES = ["PRODUCT", "DESIGN", "ENGINEERING", "QA", "RELEASE"] as const;
type Lane = (typeof LANES)[number];

const LANE_Y: Record<Lane, number> = { PRODUCT: 44, DESIGN: 138, ENGINEERING: 232, QA: 326, RELEASE: 420 };
const NODE_W = 196;
const NODE_H = 46;
const COL_GAP = 228;

type NodeState = "proposed" | "pending" | "running" | "waiting" | "completed" | "failed" | "blocked" | "open-gate";
type EdgeKind = "dependency" | "executing" | "completed" | "waiting" | "failed" | "proposed";

interface MapNode {
  id: string;
  stepId: string;
  label: string;
  sub: string;
  kind: string;
  lane: Lane;
  x: number;
  y: number;
  state: NodeState;
  isGate: boolean;
}

interface MapEdge {
  id: string;
  d: string;
  endX: number;
  endY: number;
  from: string;
  kind: EdgeKind;
}

export interface OrbitMapProps {
  workItem: WorkItem;
  executions: Map<string, ExecutionRecord>;
  agentName: (id?: string) => string;
  openGatePolicyCode: string;
  selectedStepId: string;
  onSelectStep: (stepId: string) => void;
}

function orderIndex(s: { lane: string; title: string }): number {
  const key = `${s.lane}:${s.title}`;
  const order: Record<string, number> = {
    "PRODUCT:Requirements": 0,
    "DESIGN:Design": 1,
    "ENGINEERING:Architecture": 2,
    "ENGINEERING:Implementation": 3,
    "QA:QA": 4,
    "ENGINEERING:Release": 5,
    "RELEASE:Release": 5,
  };
  return order[key] ?? (LANES.indexOf(s.lane as Lane) + 1) * 10;
}

export function OrbitMap({ workItem, executions, agentName, openGatePolicyCode, selectedStepId, onSelectStep }: OrbitMapProps) {
  const [hover, setHover] = useState<string>("");

  const graph = useMemo(() => {
    const flat = workItem.workflows.flatMap((wf) =>
      wf.steps.map((step) => ({ step, wf })),
    );
    const execOf = (stepId: string) => executions.get(stepId);

    // Earliest lane-order column per step, then push right of its deepest dependency.
    const colOf = new Map<string, number>();
    const depth = (stepId: string, seen: Set<string>): number => {
      if (colOf.has(stepId)) return colOf.get(stepId)!;
      if (seen.has(stepId)) return 0;
      seen.add(stepId);
      const entry = flat.find((f) => f.step.id === stepId);
      const base = entry ? Math.max(0, LANES.indexOf(entry.wf.lane as Lane)) : 0;
      const depDepth = Math.max(0, ...(entry?.step.dependsOnStepIds ?? []).map((d) => depth(d, seen) + 1));
      const value = Math.max(base, depDepth);
      colOf.set(stepId, value);
      return value;
    };
    flat.forEach((f) => depth(f.step.id, new Set()));

    // Keep same-column nodes in a lane from overlapping.
    const perLaneCol = new Map<string, number>();
    const nodes: MapNode[] = flat
      .slice()
      .sort((a, b) => orderIndex(a.wf) - orderIndex(b.wf))
      .map(({ step, wf }) => {
        const exec = execOf(step.id);
        const col = colOf.get(step.id) ?? 0;
        const key = `${wf.lane}:${col}`;
        const stack = perLaneCol.get(key) ?? 0;
        perLaneCol.set(key, stack + 1);
        const state: NodeState = exec?.gate?.state === "open"
          ? "open-gate"
          : exec
            ? (exec.session.state as NodeState)
            : (step.state as NodeState);
        return {
          id: step.id,
          stepId: step.id,
          label: exec ? agentName(exec.session.agentDefinitionId) : step.kind === "ai" ? agentName(step.assignedAgentDefinitionId) : step.kind === "human" ? "Human" : step.kind === "gate" ? "Human Gate" : "System",
          sub: step.title,
          kind: step.kind,
          lane: wf.lane as Lane,
          x: 24 + col * COL_GAP,
          y: LANE_Y[wf.lane as Lane] + stack * (NODE_H + 10),
          state,
          isGate: Boolean(exec?.gate?.state === "open") || step.kind === "gate",
        };
      });

    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    // Everything downstream of the open gate gets dimmed (except the gate itself).
    const dimmed = new Set<string>();
    const gateNode = nodes.find((n) => n.state === "open-gate");
    if (gateNode) {
      const downstreamOf = new Map<string, string[]>();
      flat.forEach(({ step }) => step.dependsOnStepIds.forEach((d) => {
        downstreamOf.set(d, [...(downstreamOf.get(d) ?? []), step.id]);
      }));
      const queue = [...(downstreamOf.get(gateNode.id) ?? [])];
      while (queue.length) {
        const next = queue.shift()!;
        if (dimmed.has(next)) continue;
        dimmed.add(next);
        queue.push(...(downstreamOf.get(next) ?? []));
      }
    }

    const edges: MapEdge[] = [];
    flat.forEach(({ step }) => {
      const to = nodeById.get(step.id);
      if (!to) return;
      step.dependsOnStepIds.forEach((depId) => {
        const from = nodeById.get(depId);
        if (!from) return;
        const toExec = execOf(to.stepId);
        const fromExec = execOf(from.stepId);
        let kind: EdgeKind = "dependency";
        if (from.state === "failed" || to.state === "failed" || from.state === "blocked" || to.state === "blocked") kind = "failed";
        else if (from.state === "open-gate" || to.state === "waiting") kind = "waiting";
        else if (from.state === "completed") kind = "completed";
        else if (fromExec?.session.state === "running" || toExec?.session.state === "running") kind = "executing";
        else if (!fromExec && from.state === "pending") kind = "proposed";

        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const d = `M ${x1} ${y1} C ${x1 + 44} ${y1}, ${x2 - 44} ${y2}, ${x2} ${y2}`;
        edges.push({ id: `${depId}->${step.id}`, d, endX: x2, endY: y2, from: depId, kind });
      });
    });

    const width = Math.max(980, 24 + ((Math.max(0, ...nodes.map((n) => n.x)) - 24) / COL_GAP + 1) * COL_GAP + NODE_W);
    return { nodes, edges, width, dimmed };
  }, [workItem, executions, agentName]);

  return (
    <div className="constellation-wrap">
      <svg className="constellation" viewBox={`0 0 ${graph.width} 486`} role="img" aria-label="Orbit Map execution graph">
        <defs>
          <marker id="arr-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arr-dep" /></marker>
          <marker id="arr-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arr-flow" /></marker>
          <marker id="arr-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arr-done" /></marker>
          <marker id="arr-wait" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arr-wait" /></marker>
        </defs>

        {LANES.map((lane) => (
          <g key={lane}>
            <line x1="16" x2={graph.width - 16} y1={LANE_Y[lane] - 14} y2={LANE_Y[lane] - 14} className="lane-line" />
            <rect x="14" y={LANE_Y[lane] - 34} width={lane.length * 8 + 14} height="14" className="lane-chip" />
            <text x="20" y={LANE_Y[lane] - 23} className="lane-text">{lane}</text>
          </g>
        ))}

        {graph.edges.map((e) => (
          <g key={e.id} className={`edge-g e-${e.kind} ${graph.dimmed.has(e.id.split("->")[1] ?? "") ? "dim" : ""}`}>
            <path d={e.d} className="edge-base" markerEnd={e.kind === "executing" ? "url(#arr-flow)" : e.kind === "completed" ? "url(#arr-done)" : e.kind === "waiting" ? "url(#arr-wait)" : "url(#arr-dep)"} />
            {(e.kind === "executing" || e.kind === "waiting") && <path d={e.d} className="edge-flow" />}
            {e.kind === "waiting" && <path d={e.d} className="edge-pulse" />}
          </g>
        ))}

        {graph.nodes.map((n) => {
          const isDim = graph.dimmed.has(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              className={`cnode st-${n.state} ${n.kind === "human" ? "is-human" : ""} ${n.isGate && n.state === "open-gate" ? "is-gate" : ""} ${selectedStepId === n.id ? "selected" : ""} ${isDim ? "dim" : ""} ${hover === n.id ? "hover" : ""}`}
              onClick={() => onSelectStep(n.id)}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover("")}
            >
              <rect x="30" y="2" width="158" height="42" rx="8" className="node-plate" />
              {n.kind === "human" ? (
                <circle cx="14" cy={NODE_H / 2} r="13" className="node-shape-bg" />
              ) : n.isGate && n.state === "open-gate" ? (
                <rect x="2" y={NODE_H / 2 - 12} width="24" height="24" rx="6" transform={`rotate(45 14 ${NODE_H / 2})`} className="node-shape-bg gate-diamond" />
              ) : (
                <rect x="1" y={NODE_H / 2 - 12} width="26" height="24" rx="6" className="node-shape-bg" />
              )}
              <text x="36" y="19" className="node-label">{truncate(n.label, 15)}</text>
              <text x="36" y="33" className="node-sub">{truncate(n.sub, 19)}</text>
              <circle cx="36" cy={NODE_H - 2} r="3" className="node-dot" />
              {n.state === "open-gate" && (
                <g className="gate-callout">
                  <rect x="34" y={-38} width="132" height="24" rx="12" />
                  <text x="100" y={-22} textAnchor="middle">◆ SUSAN NEEDED · {openGatePolicyCode}</text>
                  <text x="36" y="62" className="gate-wait-text">Policy {openGatePolicyCode} — waiting for human</text>
                </g>
              )}
              {n.state === "completed" && <text x="34" y="52" className="node-check">✓ completed</text>}
            </g>
          );
        })}
        <text x={graph.width - 14} y="478" textAnchor="end" className="map-caption">Lines are the execution — movement tells the story.</text>
      </svg>
      <div className="legend">
        <span><i className="lg lg-dep" /> dependency</span>
        <span><i className="lg lg-flow" /> executing</span>
        <span><i className="lg lg-done" /> completed</span>
        <span><i className="lg lg-wait" /> waiting for human</span>
        <span><i className="lg lg-fail" /> blocked / failed</span>
        <span><i className="lg lg-prop" /> proposed</span>
        <span className="meta">⚙ agent · ● human · ◆ gate · nodes are objects</span>
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
