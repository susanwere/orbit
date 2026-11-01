import { Canvas } from "@react-three/fiber";
import { Html, Line, MapControls } from "@react-three/drei";
import { useMemo, useRef, useState, type ComponentRef } from "react";
import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";
import { OrthographicCamera } from "three";
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
  kind: "intent" | "work" | "workflow" | "gate" | "step" | "agent";
  workflowIndex?: number;
  stepIndex?: number;
  executionStep?: ExecutionStep;
  executionStatus?: string;
  job?: MuseJobStatus | null;
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
          workflowIndex: wi,
          x,
          y: y - 2.05 - wi * 2,
          target: item.key,
        });
        edges.push({ from: workId, to: workflowId });
        if (workflow.steps.some((step) => step.requiresApproval)) {
          const gateId = `gate:${item.key}:${wi}`;
          nodes.push({
            id: gateId,
            title: "Human approval required",
            subtitle: "Proposed gate · no execution",
            kind: "gate",
            workflowIndex: wi,
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

/** Add approved structure and backend status without turning a finished agent turn into completion. */
export function projectExecutionGraph(
  items: readonly WorkItem[],
  statement: string,
  executionSteps: readonly ExecutionStep[],
  jobs: Readonly<Record<string, MuseJobStatus | null>>,
) {
  const projection = projectPlanGraph(items, statement);
  for (const node of projection.nodes) {
    const matchingSteps = executionSteps.filter(
      (step) =>
        step.work_item_key === node.target &&
        (node.workflowIndex === undefined || step.workflow_index === node.workflowIndex),
    );
    const states = [...new Set(matchingSteps.map((step) => step.state))];
    if (states.length === 1) node.executionStatus = states[0];
    if (states.length > 1) node.executionStatus = states.join(" · ");
    if (node.kind === "gate") {
      const approvalSteps = matchingSteps.filter((step) => step.approval_required);
      node.subtitle = approvalSteps.length
        ? approvalSteps.every((step) => step.approved_at || step.state === "COMPLETED")
          ? "Approval recorded"
          : "Approval pending"
        : "Planned human approval";
    }
  }
  for (const item of items)
    item.workflows.forEach((workflow, workflowIndex) => {
      workflow.steps.forEach((step, stepIndex) => {
        const executionStep = executionSteps.find(
          (record) =>
            record.work_item_key === item.key &&
            record.workflow_index === workflowIndex &&
            record.step_index === stepIndex,
        );
        const stepNodeId = `step:${item.key}:${workflowIndex}:${stepIndex}`;
        projection.nodes.push({
          id: stepNodeId,
          title: step.title,
          subtitle: executionStep?.blocker_reason
            ? executionStep.blocker_reason.replaceAll("_", " ")
            : `${step.executor} · approved step`,
          kind: "step",
          target: item.key,
          workflowIndex,
          stepIndex,
          executionStep,
          executionStatus: executionStep?.state,
          x: 0,
          y: 0,
        });
        projection.edges.push({
          from:
            stepIndex === 0
              ? `workflow:${item.key}:${workflowIndex}`
              : `step:${item.key}:${workflowIndex}:${stepIndex - 1}`,
          to: stepNodeId,
        });
        if (executionStep?.agent_session_id) {
          const job = jobs[executionStep.agent_session_id];
          const agentNodeId = `agent:${executionStep.agent_session_id}`;
          projection.nodes.push({
            id: agentNodeId,
            title: "Agent session",
            subtitle: executionStep.agent_session_id,
            kind: "agent",
            target: item.key,
            workflowIndex,
            stepIndex,
            executionStep,
            job,
            executionStatus: job?.status,
            x: 0,
            y: 0,
          });
          projection.edges.push({ from: stepNodeId, to: agentNodeId });
        }
      });
    });
  return projection;
}

interface Props {
  readonly items: readonly WorkItem[];
  readonly intent: string;
  readonly approved: boolean;
  readonly executionSteps?: readonly ExecutionStep[];
  readonly museJobs?: Readonly<Record<string, MuseJobStatus | null>>;
  readonly planLabel?: string;
  readonly onSelectDetail?: (
    workItemKey: string,
    workflowIndex: number,
    stepIndex?: number,
  ) => void;
  readonly selectedItemKey: string | null;
  readonly onSelect: (key: string | null) => void;
}

export function WorkGraphCanvas({
  items,
  intent,
  approved,
  selectedItemKey,
  onSelect,
  executionSteps = [],
  museJobs = {},
  planLabel,
  onSelectDetail,
}: Props) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<OrthographicCamera | null>(null);
  const controlsRef = useRef<ComponentRef<typeof MapControls>>(null);
  const [cameraZoom, setCameraZoom] = useState(65);
  const [isPanningEnabled, setIsPanningEnabled] = useState(true);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const graph = useMemo(
    () =>
      approved
        ? projectExecutionGraph(items, intent, executionSteps, museJobs)
        : projectPlanGraph(items, intent),
    [items, intent, approved, executionSteps, museJobs],
  );

  const visibleNodes = graph.nodes.filter(
    (node) => approved || node.kind === "intent" || node.kind === "work",
  );
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
    const level = Math.max(
      1,
      ...item.dependsOn
        .filter((parent) => byKey.has(parent))
        .map((parent) => depth(parent, ancestors) + 1),
    );
    depths.set(key, level);
    return level;
  }
  for (const node of visibleNodes) {
    const workDepth = depth(node.target ?? "");
    const workColumn = approved ? workDepth * 4 - 3 : workDepth;
    const column =
      node.kind === "intent"
        ? 0
        : node.kind === "work"
          ? workColumn
          : node.kind === "workflow"
            ? workColumn + 1
            : node.kind === "step"
              ? workColumn + 2
              : workColumn + 3;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const maxDepth = Math.max(0, ...columns.keys());
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, nodes] of columns) {
    nodes.forEach((node, index) =>
      positions.set(node.id, {
        x: (level - maxDepth / 2) * 4.6,
        y: (nodes.length - 1) * 1.8 - index * 3.6,
      }),
    );
  }
  const visibleEdges = graph.edges.filter(
    (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const choose = (node: GraphNode) => {
    if (node.target && node.workflowIndex !== undefined && onSelectDetail)
      onSelectDetail(node.target, node.workflowIndex, node.stepIndex);
    else onSelect(node.target ?? null);
  };

  function changeZoom(multiplier: number) {
    const camera = cameraRef.current;
    if (!camera) return;
    camera.zoom = Math.min(120, Math.max(20, camera.zoom * multiplier));
    camera.updateProjectionMatrix();
    controlsRef.current?.update();
    setCameraZoom(camera.zoom);
  }

  function fitGraph() {
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!camera || !scene) return;
    const nodePositions = [...positions.values()];
    const minimumX = Math.min(0, ...nodePositions.map((position) => position.x));
    const maximumX = Math.max(0, ...nodePositions.map((position) => position.x));
    const minimumY = Math.min(0, ...nodePositions.map((position) => position.y));
    const maximumY = Math.max(0, ...nodePositions.map((position) => position.y));
    const centerX = (minimumX + maximumX) / 2;
    const centerY = (minimumY + maximumY) / 2;
    camera.position.set(centerX, centerY, 30);
    controlsRef.current?.target.set(centerX, centerY, 0);
    camera.zoom = Math.min(
      120,
      Math.max(
        20,
        Math.min(
          scene.clientWidth / (maximumX - minimumX + 5.5),
          scene.clientHeight / (maximumY - minimumY + 4),
        ),
      ),
    );
    camera.updateProjectionMatrix();
    controlsRef.current?.update();
    setCameraZoom(camera.zoom);
  }

  async function toggleFullscreen() {
    try {
      setCanvasError(null);
      if (document.fullscreenElement === sceneRef.current) await document.exitFullscreen();
      else await sceneRef.current?.requestFullscreen();
    } catch {
      setCanvasError("Full screen is unavailable. You can still pan and zoom the canvas.");
    }
  }

  return (
    <div className="workgraph-root">
      <div className="workgraph-legend" aria-label="Workflow graph legend">
        <span>● Intent</span>
        <span>● Work item</span>
        <span>
          {approved
            ? "● Workflows · steps · agents · approval gates"
            : "● Work items contain workflows and approval gates"}
        </span>
        <strong>{planLabel ?? (approved ? "Approved plan" : "Proposed only · not running")}</strong>
      </div>
      <div ref={sceneRef} className="workgraph-scene" aria-label="Connected plan graph">
        <div className="canvas-view-controls" role="toolbar" aria-label="Canvas view controls">
          <div>
            <button
              type="button"
              aria-label="Pan canvas"
              aria-pressed={isPanningEnabled}
              onClick={() => setIsPanningEnabled((enabled) => !enabled)}
            >
              <span aria-hidden="true">✥</span>
            </button>
            <button type="button" aria-label="Fit graph to view" onClick={fitGraph}>
              <span aria-hidden="true">⌗</span>
            </button>
            {typeof document !== "undefined" && document.fullscreenEnabled && (
              <button
                type="button"
                aria-label="Toggle full screen"
                onClick={() => {
                  void toggleFullscreen();
                }}
              >
                <span aria-hidden="true">⛶</span>
              </button>
            )}
          </div>
          <div>
            <button
              type="button"
              aria-label="Zoom out"
              disabled={cameraZoom <= 20}
              onClick={() => changeZoom(1 / 1.2)}
            >
              −
            </button>
            <output aria-label="Canvas zoom">{Math.round((cameraZoom / 65) * 100)}%</output>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={cameraZoom >= 120}
              onClick={() => changeZoom(1.2)}
            >
              ＋
            </button>
          </div>
        </div>
        {canvasError && (
          <p className="canvas-view-error" role="alert">
            {canvasError}
          </p>
        )}
        <Canvas
          orthographic
          onCreated={({ camera }) => {
            if (camera instanceof OrthographicCamera) cameraRef.current = camera;
          }}
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
                color={edge.dependency ? "#b28adc" : "#6e5489"}
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
                data-execution-state={node.executionStatus}
                aria-pressed={
                  node.target ? selectedItemKey === node.target : selectedItemKey === null
                }
                onClick={() => choose(node)}
                title={
                  node.target ? "Show this work item's configuration" : "Original project intent"
                }
              >
                <span>
                  {node.kind === "intent"
                    ? "ORIGINAL INTENT"
                    : node.kind === "work"
                      ? "WORK ITEM"
                      : node.kind.toUpperCase()}
                </span>
                <strong>{node.title}</strong>
                {node.executionStatus && (
                  <span className="workgraph-status">{node.executionStatus}</span>
                )}
                <small>
                  {node.kind === "work"
                    ? `${items.find((item) => item.key === node.target)?.workflows.length ?? 0} workflows · Click to configure`
                    : node.subtitle}
                </small>
              </button>
            </Html>
          ))}
          <MapControls
            ref={controlsRef}
            enableRotate={false}
            enablePan={isPanningEnabled}
            onChange={() => {
              const camera = cameraRef.current;
              if (camera) setCameraZoom(camera.zoom);
            }}
            enableDamping={false}
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
