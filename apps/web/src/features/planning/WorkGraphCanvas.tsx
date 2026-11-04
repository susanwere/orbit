import { Canvas } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExecutionStep, MuseJobStatus, ProjectTask } from "../intent/intent-api.js";
import { selectWorkItemExecution, workItemExecutionStatus } from "./work-item-execution.js";
import { executionDisplayState, overallWorkflowStatus } from "./work-item-status.js";
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
      executionStatus: "Proposed",
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
  tasks: readonly ProjectTask[] = [],
) {
  const projection = projectPlanGraph(items, statement);
  for (const node of projection.nodes) {
    const matchingSteps = executionSteps.filter(
      (step) =>
        step.work_item_key === node.target &&
        (node.workflowIndex === undefined || step.workflow_index === node.workflowIndex),
    );
    node.executionStatus = overallWorkflowStatus(matchingSteps, jobs);
    const task = tasks.find((candidate) => candidate.task_key === node.target);
    if (node.kind === "work" && task) {
      const executionStep = selectWorkItemExecution(task.task_key, matchingSteps, task);
      const job = executionStep?.agent_session_id ? jobs[executionStep.agent_session_id] : null;
      node.executionStatus = workItemExecutionStatus(true, task, executionStep, job);
      if (
        task.state === "STARTING" &&
        ["BLOCKED", "Awaiting execution"].includes(node.executionStatus)
      )
        node.executionStatus = "RUNNING";
      if (
        task.state === "NEEDS_INPUT" &&
        job?.status === "TURN_FINISHED" &&
        job.changed_paths?.length === 0
      )
        node.executionStatus = "NEEDS_INPUT";
      const deliveryState = job?.delivery_state ?? task.delivery_state;
      const ciState = job?.github_ci_state ?? task.github_ci_state;
      const isProcessing =
        deliveryState === "REQUESTED" ||
        deliveryState === "RUNNING" ||
        ciState === "WAITING" ||
        ciState === "PENDING";
      if (
        task.state === "ACTIVE" &&
        isProcessing &&
        deliveryState !== "ERROR" &&
        job?.status !== "FAILED" &&
        job?.local_execution_state !== "ERROR" &&
        ["WAITING", "BLOCKED", "Awaiting execution"].includes(node.executionStatus)
      )
        node.executionStatus = "RUNNING";
    }
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
          executionStatus: executionDisplayState(
            executionStep,
            executionStep?.agent_session_id ? jobs[executionStep.agent_session_id] : null,
          ),
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
  readonly tasks?: readonly ProjectTask[];
  readonly executableItemKeys?: readonly string[];
  readonly executingItemKey?: string | null;
  readonly onExecute?: (workItemKey: string) => void;
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
  tasks,
  executableItemKeys = [],
  executingItemKey = null,
  onExecute,
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
        ? projectExecutionGraph(items, intent, executionSteps, museJobs, tasks)
        : projectPlanGraph(items, intent),
    [items, intent, approved, executionSteps, museJobs, tasks],
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
                  {approved &&
                    node.target &&
                    executableItemKeys.includes(node.target) &&
                    onExecute && (
                      <button
                        type="button"
                        disabled={executingItemKey !== null}
                        onClick={() => onExecute(node.target!)}
                      >
                        Execute {node.title}
                      </button>
                    )}
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
              const destination = visibleNodes.find((node) => node.id === edge.to);
              const color =
                destination?.executionStatus === "COMPLETED"
                  ? "#f0a65a"
                  : edge.dependency
                    ? "#b28adc"
                    : "#8d6bb0";
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
                    onExecute={
                      approved &&
                      node.target &&
                      executableItemKeys.includes(node.target) &&
                      onExecute
                        ? () => onExecute(node.target!)
                        : undefined
                    }
                    executionPending={executingItemKey === node.target}
                    executionDisabled={executingItemKey !== null}
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

export function GraphNodeCard({
  node,
  selected,
  onChoose,
  onMeasure,
  onFocus,
  onExecute,
  executionPending,
  executionDisabled,
}: {
  readonly onExecute?: () => void;
  readonly executionPending?: boolean;
  readonly executionDisabled?: boolean;
  readonly node: GraphNode;
  readonly selected: boolean;
  readonly onChoose: () => void;
  readonly onMeasure: (id: string, size: NodeSize) => void;
  readonly onFocus: () => void;
}) {
  const executeAction =
    !node.executionStatus ||
    ["READY", "Proposed", "Awaiting execution", "FAILED", "NEEDS_INPUT"].includes(
      node.executionStatus,
    )
      ? onExecute
      : undefined;
  const visibleStatus = executionPending
    ? "STARTING"
    : (node.executionStatus ?? (executeAction ? "READY" : undefined));
  const isExecuting = visibleStatus === "RUNNING" || visibleStatus === "STARTING";
  const hasStaticGreenBorder =
    node.kind === "intent" || visibleStatus === "COMPLETED" || visibleStatus === "READY_FOR_REVIEW";
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
    <div
      className={`workgraph-node-shell ${executeAction ? "is-ready" : ""} ${isExecuting ? "is-executing" : ""} ${hasStaticGreenBorder ? "is-settled" : ""}`}
      aria-busy={isExecuting}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`workgraph-node workgraph-node--${node.kind} ${selected ? "is-selected" : ""}`}
        data-node-id={node.id}
        data-execution-state={visibleStatus}
        aria-pressed={selected}
        onClick={onChoose}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) onFocus();
        }}
        title={node.target ? "Show this work item's configuration" : "Original project intent"}
      >
        <div className="workgraph-node-heading">
          <span>
            {node.kind === "intent"
              ? "ORIGINAL INTENT"
              : node.kind === "work"
                ? "WORK ITEM"
                : node.kind.toUpperCase()}
          </span>
          {visibleStatus && (
            <span
              className="workgraph-status"
              data-state={visibleStatus}
              aria-label={`Status: ${visibleStatus.replaceAll("_", " ")}`}
            >
              {visibleStatus.replaceAll("_", " ")}
            </span>
          )}
        </div>
        <strong>{node.title}</strong>
        <small title={node.subtitle}>{node.subtitle}</small>
      </button>
      {executeAction && (
        <button
          type="button"
          className="workgraph-execute"
          aria-label={`Execute ${node.title}`}
          title={`Execute ${node.title}`}
          disabled={executionDisabled || executionPending}
          onClick={(event) => {
            event.stopPropagation();
            executeAction();
          }}
        >
          <span aria-hidden="true">▶</span> {executionPending ? "Starting…" : "Execute"}
        </button>
      )}
    </div>
  );
}
