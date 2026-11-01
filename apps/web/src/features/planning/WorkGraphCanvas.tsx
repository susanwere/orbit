import { Canvas } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";
import { GraphViewport, type GraphViewportControls } from "./GraphViewport.js";
import { layoutGraph, routeEdge, type NodeSize } from "./graph-layout.js";
import { BASE_ZOOM, MIN_SCALE, MAX_SCALE } from "./graph-viewport.js";
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
  target?: string;
};
type GraphEdge = { from: string; to: string; dependency?: boolean };

export function projectPlanGraph(
  items: readonly WorkItem[],
  statement: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: "intent", title: "Original intent", subtitle: statement, kind: "intent" },
  ];
  const edges: GraphEdge[] = [];
  const keys = new Set(items.map((item) => item.key));
  for (const item of items) {
    const workId = `work:${item.key}`;
    nodes.push({
      id: workId,
      title: item.title,
      subtitle: item.key,
      kind: "work",
      target: item.key,
    });
    if (!item.dependsOn.length) edges.push({ from: "intent", to: workId });
    for (const dependency of item.dependsOn) {
      if (keys.has(dependency))
        edges.push({ from: `work:${dependency}`, to: workId, dependency: true });
    }
    item.workflows.forEach((workflow, workflowIndex) => {
      const workflowId = `workflow:${item.key}:${workflowIndex}`;
      nodes.push({
        id: workflowId,
        title: workflow.name,
        subtitle: `${workflow.steps.length} steps · ${workflow.steps.filter((step) => step.requiresApproval).length} approval gates`,
        kind: "workflow",
        workflowIndex,
        target: item.key,
      });
      edges.push({ from: workId, to: workflowId });
      if (workflow.steps.some((step) => step.requiresApproval)) {
        const gateId = `gate:${item.key}:${workflowIndex}`;
        nodes.push({
          id: gateId,
          title: "Human approval required",
          subtitle: "Proposed gate · no execution",
          kind: "gate",
          workflowIndex,
          target: item.key,
        });
        edges.push({ from: workflowId, to: gateId });
      }
    });
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
          });
          projection.edges.push({ from: stepNodeId, to: agentNodeId });
        }
      });
    });
  return projection;
}

interface Props {
  readonly planActions?: ReactNode;
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
  planActions,
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
  const controlsRef = useRef<GraphViewportControls>(null);
  const [cameraScale, setCameraScale] = useState(1);
  const [nodeSizes, setNodeSizes] = useState<ReadonlyMap<string, NodeSize>>(new Map());
  const measureNode = useCallback((id: string, size: NodeSize) => {
    setNodeSizes((previous) => {
      const oldSize = previous.get(id);
      if (
        oldSize &&
        Math.abs(oldSize.width - size.width) < 0.5 &&
        Math.abs(oldSize.height - size.height) < 0.5
      )
        return previous;
      return new Map(previous).set(id, size);
    });
  }, []);
  const [isPanningEnabled, setIsPanningEnabled] = useState(true);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const graph = useMemo(
    () =>
      approved
        ? projectExecutionGraph(items, intent, executionSteps, museJobs)
        : projectPlanGraph(items, intent),
    [items, intent, approved, executionSteps, museJobs],
  );

  const visibleNodes = useMemo(
    () => graph.nodes.filter((node) => node.kind === "intent" || node.kind === "work"),
    [graph],
  );
  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    return graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  }, [graph, visibleNodes]);
  const layout = useMemo(
    () =>
      layoutGraph(
        visibleNodes.map((node) => ({
          id: node.id,
          ...(nodeSizes.get(node.id) ?? { width: node.kind === "gate" ? 175 : 210, height: 160 }),
        })),
        visibleEdges,
      ),
    [visibleNodes, visibleEdges, nodeSizes],
  );
  const routes = useMemo(
    () => visibleEdges.map((edge) => routeEdge(layout, edge)),
    [layout, visibleEdges],
  );
  const viewportBounds = useMemo(
    () => ({
      ...layout.bounds,
      top: Math.min(layout.bounds.top, ...routes.flatMap((route) => route.map((point) => point.y))),
      bottom: Math.max(
        layout.bounds.bottom,
        ...routes.flatMap((route) => route.map((point) => point.y)),
      ),
    }),
    [layout, routes],
  );
  const allNodesMeasured = visibleNodes.every((node) => nodeSizes.has(node.id));
  const choose = (node: GraphNode) => {
    if (node.target && node.workflowIndex !== undefined && onSelectDetail)
      onSelectDetail(node.target, node.workflowIndex, node.stepIndex);
    else onSelect(node.target ?? null);
  };

  function changeZoom(multiplier: number) {
    controlsRef.current?.zoomBy(multiplier);
  }
  function fitGraph() {
    controlsRef.current?.fit();
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
        <span>Open a work item to explore its workflows, steps and approval gates</span>
        {planActions}
        <strong className={approved ? "workgraph-plan-approved" : undefined}>
          {approved && <span aria-hidden="true">✓ </span>}
          {planLabel ?? (approved ? "Approved plan" : "Proposed only · not running")}
        </strong>
      </div>
      <p id="graph-navigation-help" className="canvas-heading-accessible">
        Drag or scroll to pan. Shift + wheel pans horizontally. Pinch or +/− zooms. Arrow keys pan,
        0 fits the graph, and Home resets the view.
      </p>
      <div
        ref={sceneRef}
        className="workgraph-scene"
        aria-label="Connected plan graph"
        role="region"
        tabIndex={0}
        aria-describedby="graph-navigation-help"
      >
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
            <button
              type="button"
              aria-label="Reset canvas view"
              onClick={() => controlsRef.current?.reset()}
            >
              <span aria-hidden="true">↺</span>
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
              disabled={cameraScale <= MIN_SCALE}
              onClick={() => changeZoom(1 / 1.2)}
            >
              −
            </button>
            <output aria-label="Canvas zoom">{Math.round(cameraScale * 100)}%</output>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={cameraScale >= MAX_SCALE}
              onClick={() => changeZoom(1.2)}
            >
              ＋
            </button>
          </div>
          <details className="canvas-node-list">
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
        {canvasError && (
          <p className="canvas-view-error" role="alert">
            {canvasError}
          </p>
        )}
        <Canvas
          orthographic
          camera={{ position: [0, 0, 30], zoom: 65 }}
          gl={{ alpha: true, antialias: true }}
        >
          <ambientLight intensity={1.1} />
          <GraphViewport
            bounds={viewportBounds}
            sceneRef={sceneRef}
            controlsRef={controlsRef}
            isPanningEnabled={isPanningEnabled}
            onScaleChange={setCameraScale}
          />
          {allNodesMeasured &&
            visibleEdges.map((edge, index) => {
              const route = routes[index]!;
              if (route.length < 2) return null;
              const end = route[route.length - 1]!;
              const points = route.map(
                (point) =>
                  [point.x / BASE_ZOOM, -point.y / BASE_ZOOM, -1] as [number, number, number],
              );
              const color = edge.dependency ? "#b28adc" : "#8d6bb0";
              return (
                <group key={`${edge.from}:${edge.to}`}>
                  <Line points={points} color={color} lineWidth={edge.dependency ? 2 : 1.5} />
                  <Line
                    points={[
                      [(end.x - 8) / BASE_ZOOM, (-end.y + 5) / BASE_ZOOM, -1],
                      [end.x / BASE_ZOOM, -end.y / BASE_ZOOM, -1],
                      [(end.x - 8) / BASE_ZOOM, (-end.y - 5) / BASE_ZOOM, -1],
                    ]}
                    color={color}
                    lineWidth={1.5}
                  />
                </group>
              );
            })}
          {visibleNodes.map((node) => {
            const position = layout.nodes.get(node.id)!;
            return (
              <Html
                key={node.id}
                position={[position.x / BASE_ZOOM, -position.y / BASE_ZOOM, 0]}
                center
                style={{ pointerEvents: "none" }}
                transform={false}
                zIndexRange={[15, 5]}
              >
                <div
                  style={{
                    transform: `scale(${cameraScale})`,
                    visibility: allNodesMeasured ? "visible" : "hidden",
                  }}
                >
                  <GraphNodeCard
                    node={node}
                    selected={
                      node.target ? selectedItemKey === node.target : selectedItemKey === null
                    }
                    onChoose={() => choose(node)}
                    onMeasure={measureNode}
                    onFocus={() =>
                      controlsRef.current?.reveal(
                        position.x,
                        position.y,
                        position.width,
                        position.height,
                      )
                    }
                  />
                </div>
              </Html>
            );
          })}
        </Canvas>
      </div>
    </div>
  );
}

function GraphNodeCard({
  node,
  selected,
  onChoose,
  onMeasure,
  onFocus,
}: {
  readonly node: GraphNode;
  readonly selected: boolean;
  readonly onChoose: () => void;
  readonly onMeasure: (id: string, size: NodeSize) => void;
  readonly onFocus: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const measure = () =>
      onMeasure(node.id, { width: button.offsetWidth, height: button.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [node.id, onMeasure]);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`workgraph-node workgraph-node--${node.kind} ${selected ? "is-selected" : ""}`}
      data-node-id={node.id}
      data-execution-state={node.executionStatus}
      aria-pressed={selected}
      onClick={onChoose}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) onFocus();
      }}
      title={node.target ? "Show this work item's configuration" : "Original project intent"}
    >
      <span>
        {node.kind === "intent"
          ? "ORIGINAL INTENT"
          : node.kind === "work"
            ? "WORK ITEM"
            : node.kind.toUpperCase()}
      </span>
      <strong>{node.title}</strong>
      <span className="workgraph-status" title={node.executionStatus}>
        {node.executionStatus ?? ""}
      </span>
      <small title={node.subtitle}>{node.subtitle}</small>
    </button>
  );
}
