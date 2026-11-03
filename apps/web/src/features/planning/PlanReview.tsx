import { useEffect, useState } from "react";
import { useCanvasExecution } from "./use-canvas-execution.js";
import { CanvasComposer } from "./CanvasComposer.js";
import { PlanSection, type PlanSectionKey } from "./PlanSection.js";
import { CanvasSidebar } from "./CanvasSidebar.js";
import { ProjectContextDocuments } from "./ProjectContextDocuments.js";
import { CanvasExecution } from "./CanvasExecution.js";
import "../projects/project-dashboard.css";
import { WorkGraphCanvas } from "./WorkGraphCanvas.js";
import type { CreatedProject } from "../projects/project-api.js";
import type { ProjectIntentApi, ProjectPlan, StoredIntent } from "../intent/intent-api.js";
import "./plan-review.css";
import "./canvas-theme.css";

type Executor = "human" | "agent" | "system";
interface Step {
  title: string;
  executor: Executor;
  requiresApproval: boolean;
}
interface Workflow {
  name: string;
  steps: Step[];
}
interface WorkItem {
  key: string;
  title: string;
  description: string;
  dependsOn: string[];
  workflows: Workflow[];
}
export interface WorkGraph {
  summary: string;
  workItems: WorkItem[];
  guardrails: string[];
  decisionsToReview: string[];
  assumptions: string[];
}

function readGraph(value: unknown): WorkGraph | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.summary !== "string" ||
    !Array.isArray(data.workItems) ||
    !Array.isArray(data.guardrails) ||
    !Array.isArray(data.decisionsToReview) ||
    !Array.isArray(data.assumptions)
  )
    return null;
  for (const item of data.workItems) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.key !== "string" ||
      typeof item.title !== "string" ||
      typeof item.description !== "string" ||
      !Array.isArray(item.dependsOn) ||
      !Array.isArray(item.workflows)
    )
      return null;
    for (const workflow of item.workflows) {
      if (!workflow || typeof workflow.name !== "string" || !Array.isArray(workflow.steps))
        return null;
      for (const step of workflow.steps) {
        if (
          !step ||
          typeof step.title !== "string" ||
          !["human", "agent", "system"].includes(step.executor) ||
          typeof step.requiresApproval !== "boolean"
        )
          return null;
      }
    }
  }
  if (
    ![...data.guardrails, ...data.decisionsToReview, ...data.assumptions].every(
      (x) => typeof x === "string",
    )
  )
    return null;
  return structuredClone(value) as WorkGraph;
}

interface Props {
  readonly project: CreatedProject;
  readonly originalIntent: StoredIntent | null;
  readonly plan: ProjectPlan | null;
  readonly isLoading?: boolean;
  readonly api: ProjectIntentApi;
  readonly onBack: () => void;
  readonly onUpdated: (plan: ProjectPlan) => void;
}

export function PlanReview(props: Props) {
  return <ProjectPlanCanvas key={props.project.id} {...props} />;
}

function ProjectPlanCanvas({
  project,
  originalIntent,
  plan,
  api,
  onBack,
  onUpdated,
  isLoading = false,
}: Props) {
  const [canvasSection, setCanvasSection] = useState<
    "workflow" | "composer" | "context" | "execution" | PlanSectionKey
  >("workflow");
  const [canvasDraftIdea, setCanvasDraftIdea] = useState("");
  const [currentIntent, setCurrentIntent] = useState(originalIntent);
  const [uploadedFileIds, setUploadedFileIds] = useState<Record<string, string>>({});
  const [graph, setGraph] = useState<WorkGraph | null>(() => readGraph(plan?.content));
  const [revision, setRevision] = useState(plan?.revision ?? 0);
  const [status, setStatus] = useState<ProjectPlan["status"] | null>(plan?.status ?? null);
  const [dirty, setDirty] = useState(false);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "workflows" | "dependencies">(
    "workflows",
  );
  const [selectedWorkflow, setSelectedWorkflow] = useState<number | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planningFailure, setPlanningFailure] = useState(plan?.failure_reason ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isLoading || dirty) return;
    setGraph(readGraph(plan?.content));
    setRevision(plan?.revision ?? 0);
    setStatus(plan?.status ?? null);
    setPlanningFailure(plan?.failure_reason ?? null);
  }, [plan, isLoading, dirty]);
  const selectedItem = graph?.workItems.find((item) => item.key === selectedItemKey);
  const approved = status === "APPROVED";
  const { executionSteps, museJobs, executionError, refreshExecution } = useCanvasExecution(
    api,
    project.id,
    approved && !isLoading,
    plan?.id ?? null,
    revision,
  );
  const canEdit = status === "READY_FOR_REVIEW" && !busy;
  const canCompose = !isLoading && !currentIntent && status === null;
  const showComposer = canCompose && (canvasSection === "composer" || canvasSection === "workflow");
  const isContextOpen = canvasSection === "context";
  const isExecutionOpen = canvasSection === "execution";
  const projectSection =
    canvasSection !== "workflow" &&
    canvasSection !== "composer" &&
    canvasSection !== "context" &&
    canvasSection !== "execution"
      ? canvasSection
      : null;
  const planningPending = status === "GENERATING";
  const canGeneratePlan = Boolean(currentIntent) && (status === null || status === "FAILED");
  const selectedIndex = graph?.workItems.findIndex((item) => item.key === selectedItemKey) ?? -1;
  const openItem = (key: string) => {
    setCanvasSection("workflow");
    setSelectedItemKey(key);
    setActiveTab("workflows");
    setSelectedWorkflow(null);
    setSelectedStep(null);
    setEditing(false);
  };

  const currentWorkflow =
    selectedWorkflow === null ? null : selectedItem?.workflows[selectedWorkflow];
  const currentStep = selectedStep === null ? null : currentWorkflow?.steps[selectedStep];
  const selectedExecutionStep = executionSteps.find(
    (step) =>
      step.work_item_key === selectedItemKey &&
      step.workflow_index === selectedWorkflow &&
      step.step_index === selectedStep,
  );
  const selectedJob = selectedExecutionStep?.agent_session_id
    ? museJobs[selectedExecutionStep.agent_session_id]
    : null;
  const change = (next: WorkGraph) => {
    setGraph(next);
    setDirty(true);
    setError(null);
  };
  const editItem = (index: number, patch: Partial<WorkItem>) => {
    if (!graph) return;
    const next = structuredClone(graph);
    next.workItems[index] = { ...next.workItems[index]!, ...patch };
    change(next);
  };
  const editList = (name: "guardrails" | "decisionsToReview" | "assumptions", value: string) => {
    if (!graph) return;
    change({
      ...graph,
      [name]: value.split("\n"),
    });
  };
  async function latest() {
    setBusy(true);
    setError(null);
    try {
      const current = await api.getPlan(project.id);
      if (!current) throw new Error("The plan is not available.");
      const latestGraph = readGraph(current.content);
      setGraph(latestGraph);
      setSelectedItemKey((key) =>
        latestGraph?.workItems.some((item) => item.key === key) ? key : null,
      );
      setRevision(current.revision);
      setStatus(current.status);
      setPlanningFailure(current.failure_reason);
      setDirty(false);
      onUpdated(current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reload the plan.");
    } finally {
      setBusy(false);
    }
  }
  async function submitCanvasIntent(statement: string, files: readonly File[]) {
    if (currentIntent || busy || isLoading)
      throw new Error("Original Intent is already saved or unavailable.");
    setBusy(true);
    setError(null);
    try {
      const documentIds: string[] = [];
      for (const file of files) {
        const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
        let id = uploadedFileIds[fileKey];
        if (!id) {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
            reader.onload = () => {
              const value = reader.result;
              if (typeof value !== "string" || !value.includes(",")) {
                reject(new Error(`Could not encode ${file.name}`));
                return;
              }
              resolve(value.slice(value.indexOf(",") + 1));
            };
            reader.readAsDataURL(file);
          });
          const extension = file.name.toLowerCase().split(".").pop();
          const mediaType =
            extension === "md"
              ? "text/markdown"
              : extension === "txt"
                ? "text/plain"
                : extension === "pdf"
                  ? "application/pdf"
                  : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          const result = await api.uploadDocument(project.id, {
            filename: file.name,
            mediaType,
            base64,
          });
          id = result.id;
          setUploadedFileIds((previous) => ({ ...previous, [fileKey]: result.id }));
        }
        documentIds.push(id);
      }
      const savedIntent = await api.submitIntent(project.id, statement, documentIds);
      setCurrentIntent(savedIntent);
      setCanvasSection("workflow");
      try {
        const proposed = await api.generatePlan(project.id);
        setGraph(readGraph(proposed.content));
        setRevision(proposed.revision);
        setStatus(proposed.status);
        setPlanningFailure(proposed.failure_reason);
        onUpdated(proposed);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Intent saved, but plan generation failed. Retry from the workflow page.",
        );
        setStatus("FAILED");
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryPlanning() {
    if (!canGeneratePlan || busy || isLoading) return;
    setBusy(true);
    setError(null);
    try {
      const generatedPlan = await api.generatePlan(project.id);
      setGraph(readGraph(generatedPlan.content));
      setRevision(generatedPlan.revision);
      setStatus(generatedPlan.status);
      setPlanningFailure(generatedPlan.failure_reason);
      onUpdated(generatedPlan);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Planning failed. Your original intent is still saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!graph || !canEdit || !dirty) return false;
    setBusy(true);
    setError(null);
    try {
      const normalizeList = (entries: string[]) =>
        entries.map((entry) => entry.trim()).filter(Boolean);
      const updated = await api.updatePlan(project.id, revision, {
        ...graph,
        guardrails: normalizeList(graph.guardrails),
        decisionsToReview: normalizeList(graph.decisionsToReview),
        assumptions: normalizeList(graph.assumptions),
      });
      setRevision(updated.revision);
      setStatus(updated.status);
      setGraph(readGraph(updated.content));
      setDirty(false);
      onUpdated(updated);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the plan.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (busy || dirty || !graph || status !== "READY_FOR_REVIEW") return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.approvePlan(project.id, revision);
      setRevision(updated.revision);
      setStatus(updated.status);
      onUpdated(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve the plan.");
    } finally {
      setBusy(false);
    }
  }

  function addWorkItem() {
    if (!graph || !canEdit || graph.workItems.length >= 30) return;
    const keys = new Set(graph.workItems.map((item) => item.key));
    let index = 1;
    while (keys.has(`NEW-${index}`)) index++;
    const key = `NEW-${index}`;
    change({
      ...graph,
      workItems: [
        ...graph.workItems,
        {
          key,
          title: "New work item",
          description: "Describe the expected outcome",
          dependsOn: [],
          workflows: [
            {
              name: "Implementation",
              steps: [
                {
                  title: "Complete work item",
                  executor: "human",
                  requiresApproval: true,
                },
              ],
            },
          ],
        },
      ],
    });
    openItem(key);
  }

  const planActions =
    !isLoading && !showComposer && !approved ? (
      <div id="canvas-plan-actions" className="canvas-plan-actions" aria-label="Plan actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void latest();
          }}
        >
          Reload latest
        </button>
        {status === "READY_FOR_REVIEW" && graph && (
          <>
            <button
              type="button"
              disabled={!canEdit || graph.workItems.length >= 30}
              onClick={addWorkItem}
            >
              + Add work item
            </button>
            {!projectSection && (
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => {
                  void save();
                }}
              >
                Save changes
              </button>
            )}
            <button
              type="button"
              className="cta-primary"
              disabled={busy || dirty || !graph}
              onClick={() => {
                void approve();
              }}
            >
              Approve plan
            </button>
          </>
        )}
      </div>
    ) : null;

  return (
    <main className="orbit-workspace">
      <CanvasSidebar
        projectName={project.name}
        selectedItemKey={selectedItemKey}
        approved={approved}
        hasPlan={Boolean(currentIntent) || status !== null}
        canCompose={canCompose}
        isComposerOpen={showComposer}
        activeSection={projectSection}
        isContextOpen={isContextOpen}
        isExecutionOpen={isExecutionOpen}
        onOpenExecution={() => {
          setCanvasSection("execution");
          setSelectedItemKey(null);
        }}
        onOpenContext={() => {
          setCanvasSection("context");
          setSelectedItemKey(null);
        }}
        onOpenSection={(section) => {
          setCanvasSection(section);
          setSelectedItemKey(null);
        }}
        onOpenComposer={() => {
          if (!canCompose) return;
          setCanvasSection("composer");
          setSelectedItemKey(null);
        }}
        onBack={onBack}
        onOverview={() => {
          setCanvasSection("workflow");
          setSelectedItemKey(null);
          setSelectedWorkflow(null);
          setSelectedStep(null);
          setEditing(false);
        }}
      />
      <div className="orbit-workspace-main">
        <div className="canvas-ambient-orbits" aria-hidden="true">
          <div className="project-dashboard-orbit project-dashboard-orbit-left">
            <i />
            <i />
          </div>
          <div className="project-dashboard-orbit project-dashboard-orbit-right">
            <i />
            <i />
          </div>
        </div>
        <h1 id="plan-heading" className="canvas-heading-accessible">
          {selectedItem ? selectedItem.title : "Workflow Canvas"}
        </h1>
        {!showComposer &&
          !isContextOpen &&
          !isExecutionOpen &&
          (projectSection || selectedItem) &&
          planActions}
        {error && (
          <p role="alert" className="intent-error canvas-action-error">
            {error}
          </p>
        )}
        {isLoading ? (
          <p className="canvas-loading" role="status">
            Loading workflow…
          </p>
        ) : showComposer ? (
          <CanvasComposer
            isPreview={Boolean(currentIntent) || status !== null}
            draftIdea={canvasDraftIdea}
            onDraftChange={setCanvasDraftIdea}
            onOpenIntent={() => setCanvasSection("workflow")}
            onSubmitIntent={submitCanvasIntent}
            onTranscribeVoice={(audioBase64) => api.transcribeVoice(project.id, audioBase64)}
          />
        ) : isContextOpen ? (
          <ProjectContextDocuments
            api={api}
            projectId={project.id}
            projectName={project.name}
            onOpenIntent={() => setCanvasSection("original-intent")}
          />
        ) : isExecutionOpen ? (
          <CanvasExecution api={api} projectId={project.id} />
        ) : projectSection ? (
          <PlanSection
            section={projectSection}
            graph={graph}
            originalIntent={currentIntent}
            approved={approved}
            canEdit={canEdit}
            dirty={dirty}
            busy={busy}
            onSectionChange={setCanvasSection}
            onSummaryChange={(summary) => graph && change({ ...graph, summary })}
            onListChange={editList}
            onCancel={() => {
              setGraph(readGraph(plan?.content));
              setDirty(false);
              setError(null);
            }}
            onSave={save}
          />
        ) : selectedItem && graph ? (
          <section
            className="orbit-detail-page orbit-detail-page--canvas"
            aria-label="Work item configuration"
          >
            <button
              type="button"
              className="orbit-detail-back"
              onClick={() => {
                setSelectedItemKey(null);
                setSelectedWorkflow(null);
                setSelectedStep(null);
                setEditing(false);
              }}
            >
              ← Back to workflow canvas
            </button>
            <div className="orbit-detail-heading">
              <div>
                <span className="orbit-detail-eyebrow">WORK ITEM / {selectedItem.key}</span>
                <h2>
                  {selectedStep !== null && currentStep
                    ? currentStep.title
                    : currentWorkflow
                      ? currentWorkflow.name
                      : selectedItem.title}
                </h2>
                <p>
                  {selectedStep !== null
                    ? "Step details"
                    : currentWorkflow
                      ? "Workflow steps and checkpoints"
                      : selectedItem.description}
                </p>
              </div>
              <div className="orbit-detail-heading-actions">
                {status === "READY_FOR_REVIEW" && graph && (
                  <button
                    type="button"
                    className="orbit-detail-back"
                    onClick={() => setEditing((value) => !value)}
                  >
                    {editing ? "Done editing" : "✎ Edit"}
                  </button>
                )}
                <span className="orbit-detail-tag">{approved ? "Approved" : "Proposed"}</span>
              </div>
            </div>
            {selectedWorkflow !== null && (
              <button
                className="orbit-detail-back"
                type="button"
                onClick={() => {
                  setSelectedWorkflow(null);
                  setSelectedStep(null);
                  setEditing(false);
                }}
              >
                ← All workflows
              </button>
            )}
            {selectedWorkflow === null ? (
              <div className="orbit-detail-content">
                <div className="orbit-canvas-actions">
                  <button
                    type="button"
                    className="orbit-detail-back"
                    onClick={() =>
                      setActiveTab(activeTab === "workflows" ? "dependencies" : "workflows")
                    }
                  >
                    {activeTab === "workflows" ? "Dependencies & details" : "← Back to workflows"}
                  </button>
                </div>
                {activeTab === "overview" && (
                  <div className="orbit-detail-card">
                    <h3>About this work</h3>
                    {editing ? (
                      <>
                        <label htmlFor="item-title">Title</label>
                        <input
                          id="item-title"
                          disabled={!canEdit}
                          value={selectedItem.title}
                          onChange={(event) =>
                            editItem(selectedIndex, { title: event.target.value })
                          }
                        />
                        <label htmlFor="item-description">Description</label>
                        <textarea
                          id="item-description"
                          disabled={!canEdit}
                          rows={4}
                          value={selectedItem.description}
                          onChange={(event) =>
                            editItem(selectedIndex, { description: event.target.value })
                          }
                        />
                      </>
                    ) : (
                      <p>{selectedItem.description}</p>
                    )}
                    <p className="orbit-detail-muted">
                      {selectedItem.workflows.length} workflows · {selectedItem.dependsOn.length}{" "}
                      dependencies
                    </p>
                  </div>
                )}
                {activeTab === "dependencies" && (
                  <div className="orbit-detail-card">
                    <h3>Depends on</h3>
                    {graph.workItems
                      .filter((item) => item.key !== selectedItem.key)
                      .map((item) => (
                        <label className="orbit-dependency-choice" key={item.key}>
                          <input
                            type="checkbox"
                            disabled={!canEdit || !editing}
                            checked={selectedItem.dependsOn.includes(item.key)}
                            onChange={(event) =>
                              editItem(selectedIndex, {
                                dependsOn: event.target.checked
                                  ? [...selectedItem.dependsOn, item.key]
                                  : selectedItem.dependsOn.filter((key) => key !== item.key),
                              })
                            }
                          />
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.key}</small>
                          </span>
                        </label>
                      ))}
                    <p className="orbit-detail-muted">
                      Dependencies determine what must finish before execution can begin. Editing
                      the plan does not execute work.
                    </p>
                  </div>
                )}
                {activeTab === "workflows" && (
                  <div className="orbit-detail-card orbit-detail-card--canvas">
                    <div className="orbit-nested-stage" aria-label="Workflows in this work item">
                      <div className="orbit-nested-stage-head">
                        <span>WORKFLOW GRAPH</span>
                        <strong>{selectedItem.workflows.length} workflows</strong>
                      </div>
                      <div className="orbit-nested-stage-legend">
                        <span>● Workflow</span>
                        <span>Open a node to explore its steps</span>
                      </div>
                      <div className="orbit-nested-graph">
                        {selectedItem.workflows.map((workflow, index) => (
                          <button
                            className="orbit-nested-node"
                            type="button"
                            key={index}
                            onClick={() => {
                              setSelectedWorkflow(index);
                              setSelectedStep(null);
                              setEditing(false);
                            }}
                          >
                            <span>WORKFLOW {index + 1}</span>
                            <strong>{workflow.name}</strong>
                            <small>
                              {workflow.steps.length} steps ·{" "}
                              {workflow.steps.filter((step) => step.requiresApproval).length}{" "}
                              approval gates
                            </small>
                            <span>Explore →</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              currentWorkflow && (
                <div className="orbit-detail-content">
                  {selectedStep !== null && currentStep ? (
                    <div className="orbit-detail-card">
                      <button
                        className="orbit-detail-back"
                        type="button"
                        onClick={() => {
                          setSelectedStep(null);
                          setEditing(false);
                        }}
                      >
                        ← All steps
                      </button>
                      <h3>{currentStep.title}</h3>
                      {selectedExecutionStep && (
                        <section className="canvas-step-evidence" aria-label="Execution evidence">
                          <p>Execution: {selectedExecutionStep.state}</p>
                          {selectedExecutionStep.blocker_reason && (
                            <p>
                              Blocked: {selectedExecutionStep.blocker_reason.replaceAll("_", " ")}
                            </p>
                          )}
                          {selectedExecutionStep.agent_session_id && (
                            <p>Agent session: {selectedExecutionStep.agent_session_id}</p>
                          )}
                          {selectedJob && <p>Muse turn: {selectedJob.status}</p>}
                          {selectedJob?.github_repository && selectedJob.github_pull_number && (
                            <a
                              href={`https://github.com/${selectedJob.github_repository}/pull/${selectedJob.github_pull_number}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Review PR #{selectedJob.github_pull_number}
                            </a>
                          )}
                          {selectedJob?.github_ci_state && (
                            <p>GitHub CI: {selectedJob.github_ci_state}</p>
                          )}
                          {selectedJob?.github_ci_url && (
                            <a href={selectedJob.github_ci_url} target="_blank" rel="noreferrer">
                              Review CI evidence
                            </a>
                          )}
                          <button type="button" onClick={() => setCanvasSection("execution")}>
                            Open execution controls
                          </button>
                        </section>
                      )}

                      <p>
                        {currentStep.requiresApproval
                          ? "Human approval required"
                          : "No additional approval gate"}{" "}
                        · {currentStep.executor}
                      </p>
                      {editing && (
                        <>
                          <label htmlFor="step-title">What needs to happen?</label>
                          <input
                            id="step-title"
                            value={currentStep.title}
                            disabled={!canEdit}
                            onChange={(event) => {
                              const next = structuredClone(graph);
                              next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[
                                selectedStep
                              ]!.title = event.target.value;
                              change(next);
                            }}
                          />
                          <label htmlFor="step-executor">Who handles this?</label>
                          <select
                            id="step-executor"
                            value={currentStep.executor}
                            disabled={!canEdit}
                            onChange={(event) => {
                              const next = structuredClone(graph);
                              next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[
                                selectedStep
                              ]!.executor = event.target.value as Executor;
                              change(next);
                            }}
                          >
                            <option value="human">Human</option>
                            <option value="agent">Agent (proposed)</option>
                            <option value="system">System</option>
                          </select>
                          <label className="orbit-approval-choice">
                            <input
                              type="checkbox"
                              checked={currentStep.requiresApproval}
                              disabled={!canEdit}
                              onChange={(event) => {
                                const next = structuredClone(graph);
                                next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[
                                  selectedStep
                                ]!.requiresApproval = event.target.checked;
                                change(next);
                              }}
                            />
                            Requires human approval
                          </label>
                        </>
                      )}
                      <p className="orbit-detail-muted">
                        Execute from the canvas Execution panel. Prerequisite completion must be
                        verified by the execution service.
                      </p>
                    </div>
                  ) : (
                    <div className="orbit-detail-card orbit-detail-card--canvas">
                      <h3>{currentWorkflow.name}</h3>
                      <p>
                        Explore the steps in this workflow. Downstream steps await verified
                        completion of earlier steps.
                      </p>
                      {editing && (
                        <>
                          <label htmlFor="workflow-name">Workflow name</label>
                          <input
                            id="workflow-name"
                            disabled={!canEdit}
                            value={currentWorkflow.name}
                            onChange={(event) => {
                              const next = structuredClone(graph);
                              next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.name =
                                event.target.value;
                              change(next);
                            }}
                          />
                        </>
                      )}
                      <div className="orbit-nested-stage" aria-label="Workflow steps">
                        <div className="orbit-nested-stage-head">
                          <span>STEP GRAPH</span>
                          <strong>{currentWorkflow.steps.length} steps</strong>
                        </div>
                        <div className="orbit-nested-stage-legend">
                          <span>● Step</span>
                          <span>◆ Human approval</span>
                          <span>Browse future steps without executing them</span>
                        </div>
                        <div className="orbit-nested-graph">
                          {currentWorkflow.steps.map((step, index) => (
                            <button
                              key={index}
                              type="button"
                              className="orbit-nested-node"
                              onClick={() => {
                                setSelectedStep(index);
                                setEditing(false);
                              }}
                            >
                              <span>STEP {index + 1}</span>
                              <strong>{step.title}</strong>
                              <small>
                                {step.requiresApproval ? "◆ Human review" : step.executor}
                              </small>
                              <span>
                                {index === 0
                                  ? "Awaiting authorization"
                                  : "Waiting for previous step"}{" "}
                                · Explore →
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="orbit-detail-muted">
                        These are proposed steps, not actual execution statuses. Later steps are not
                        executable until their prerequisites have completed.
                      </p>
                    </div>
                  )}
                </div>
              )
            )}
          </section>
        ) : (
          <section className="orbit-full-canvas" aria-label="Plan overview">
            {!approved && graph && (
              <div className="canvas-execution-status">
                <span>{graph.workItems.length} proposed work items</span>
              </div>
            )}
            {(currentIntent || graph) &&
              (planningPending || status === "FAILED" || canGeneratePlan || error) && (
                <div className="canvas-planning-notice">
                  {planningPending && (
                    <p role="status">
                      Muse Spark is generating the plan. No execution has started.
                    </p>
                  )}
                  {status === "FAILED" && (
                    <p role="alert">
                      {planningFailure ?? "Planning failed. Your original intent is still saved."}
                    </p>
                  )}
                  {canGeneratePlan && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void retryPlanning();
                      }}
                    >
                      {busy
                        ? "Requesting plan…"
                        : status === "FAILED"
                          ? "Retry planning"
                          : "Generate plan"}
                    </button>
                  )}
                  {planningPending && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void latest();
                      }}
                    >
                      Check planning status
                    </button>
                  )}
                </div>
              )}
            {approved && (
              <div className="canvas-execution-status">
                <span>{graph?.workItems.length ?? 0} approved work items</span>
                <button type="button" onClick={refreshExecution}>
                  Refresh execution status
                </button>
                {executionError && <p role="alert">{executionError}</p>}
              </div>
            )}
            {currentIntent || graph ? (
              <WorkGraphCanvas
                planActions={planActions}
                items={graph?.workItems ?? []}
                intent={currentIntent?.statement ?? "Original intent"}
                approved={approved}
                onSelectDetail={(workItemKey, workflowIndex, stepIndex) => {
                  openItem(workItemKey);
                  setSelectedWorkflow(workflowIndex);
                  setSelectedStep(stepIndex ?? null);
                }}
                executionSteps={executionSteps}
                museJobs={museJobs}
                planLabel={
                  planningPending
                    ? "Planning in progress"
                    : status === "FAILED"
                      ? "Planning failed · original intent saved"
                      : status === null
                        ? "Original intent saved"
                        : undefined
                }
                selectedItemKey={null}
                onSelect={(key) => {
                  if (key) openItem(key);
                  else setCanvasSection("original-intent");
                }}
              />
            ) : (
              <p role="alert" className="intent-error">
                The proposal could not be displayed. No approval was performed.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
