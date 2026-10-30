import { useState } from "react";
import { WorkGraphCanvas } from "./WorkGraphCanvas.js";
import type { CreatedProject } from "../projects/project-api.js";
import type { ProjectIntentApi, ProjectPlan, StoredIntent } from "../intent/intent-api.js";
import "./plan-review.css";

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
interface WorkGraph {
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
  readonly plan: ProjectPlan;
  readonly api: ProjectIntentApi;
  readonly onBack: () => void;
  readonly onUpdated: (plan: ProjectPlan) => void;
}

export function PlanReview({ project, originalIntent, plan, api, onBack, onUpdated }: Props) {
  const [graph, setGraph] = useState<WorkGraph | null>(() => readGraph(plan.content));
  const [revision, setRevision] = useState(plan.revision);
  const [status, setStatus] = useState(plan.status);
  const [dirty, setDirty] = useState(false);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "workflows" | "dependencies">("overview");
  const [selectedWorkflow, setSelectedWorkflow] = useState<number | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedItem = graph?.workItems.find((item) => item.key === selectedItemKey);
  const approved = status === "APPROVED";
  const canEdit = !approved && !busy;
  const selectedIndex = graph?.workItems.findIndex((item) => item.key === selectedItemKey) ?? -1;
  const openItem = (key: string) => {
    setSelectedItemKey(key);
    setActiveTab("overview");
    setSelectedWorkflow(null);
    setSelectedStep(null);
    setEditing(false);
  };

  const currentWorkflow = selectedWorkflow === null ? null : selectedItem?.workflows[selectedWorkflow];
  const currentStep = selectedStep === null ? null : currentWorkflow?.steps[selectedStep];
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
      [name]: value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };
  async function latest() {
    setBusy(true);
    setError(null);
    try {
      const current = await api.getPlan(project.id);
      if (!current) throw new Error("The plan is not available.");
      const latestGraph = readGraph(current.content);
      if (!latestGraph) throw new Error("The plan has an unsupported shape.");
      setGraph(latestGraph);
      setSelectedItemKey((key) =>
        latestGraph.workItems.some((item) => item.key === key) ? key : null,
      );
      setRevision(current.revision);
      setStatus(current.status);
      setDirty(false);
      onUpdated(current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reload the plan.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!graph || !canEdit || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updatePlan(project.id, revision, graph);
      setRevision(updated.revision);
      setStatus(updated.status);
      setGraph(readGraph(updated.content));
      setDirty(false);
      onUpdated(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the plan.");
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (busy || dirty || approved || !graph) return;
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

  return (
    <main className="orbit-workspace">
      <aside className="orbit-workspace-nav" aria-label="Project navigation">
        <a className="orbit-workspace-mark" href="#plan-heading" aria-label="Orbit workspace">
          ◈
        </a>
        <span className="orbit-workspace-nav-label">Workspace</span>
        <button type="button" className="orbit-workspace-nav-action" onClick={onBack}>
          ← Intent
        </button>
        <div className="orbit-workspace-nav-group">
          <span>PROJECT</span>
          <strong>{project.name}</strong>
        </div>
        <div className="orbit-workspace-nav-group">
          <span>PLANNING</span>
          <strong>Workflows</strong>
          <small>{graph?.workItems.length ?? 0} work items</small>
        </div>
        <p className="orbit-workspace-nav-note">
          Approval records human acceptance. Agent execution is separate.
        </p>
      </aside>
      <div className="orbit-workspace-main">
        <header className="orbit-workspace-toolbar">
          <div>
            <span className="orbit-workspace-breadcrumb">
              ORBIT / {project.name} / {selectedItem ? selectedItem.key : "WORKFLOW"}
            </span>
            <h1 id="plan-heading">{selectedItem ? selectedItem.title : "Workflow canvas"}</h1>
          </div>
          <span className="orbit-workspace-state">
            {approved ? "Approved" : dirty ? "Unsaved changes" : "Proposed plan"}
          </span>
        </header>
        {selectedItem && graph ? (
          <section className="orbit-detail-page" aria-label="Work item configuration">
            <button
              type="button"
              className="orbit-detail-back"
              onClick={() => { setSelectedItemKey(null); setSelectedWorkflow(null); setSelectedStep(null); setEditing(false); }}
            >
              ← Back to workflow canvas
            </button>
            <div className="orbit-detail-heading">
              <div>
                <span className="orbit-detail-eyebrow">WORK ITEM / {selectedItem.key}</span>
                <h2>{selectedStep !== null && currentStep ? currentStep.title : currentWorkflow ? currentWorkflow.name : selectedItem.title}</h2>
                <p>{selectedStep !== null ? "Step details" : currentWorkflow ? "Workflow steps and checkpoints" : selectedItem.description}</p>
              </div>
              <div className="orbit-detail-heading-actions">
                {!approved && <button type="button" className="orbit-detail-back" onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "✎ Edit"}</button>}
                <span className="orbit-detail-tag">{approved ? "Approved" : "Proposed"}</span>
              </div>
            </div>
            {selectedWorkflow !== null && (
              <button className="orbit-detail-back" type="button" onClick={() => { setSelectedWorkflow(null); setSelectedStep(null); setEditing(false); }}>
                ← All workflows
              </button>
            )}
            {selectedWorkflow === null ? (
              <div className="orbit-detail-content">
                <div className="orbit-detail-tabs" role="tablist" aria-label="Work item sections">
                  {(["overview", "workflows", "dependencies"] as const).map((tab) => (
                    <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "is-active" : ""} onClick={() => setActiveTab(tab)}>
                      {tab === "workflows" ? `Workflows (${selectedItem.workflows.length})` : tab === "overview" ? "Overview" : "Dependencies"}
                    </button>
                  ))}
                </div>
                {activeTab === "overview" && (
                  <div className="orbit-detail-card">
                    <h3>About this work</h3>
                    {editing ? <>
                      <label htmlFor="item-title">Title</label>
                      <input id="item-title" disabled={!canEdit} value={selectedItem.title} onChange={(event) => editItem(selectedIndex, { title: event.target.value })} />
                      <label htmlFor="item-description">Description</label>
                      <textarea id="item-description" disabled={!canEdit} rows={4} value={selectedItem.description} onChange={(event) => editItem(selectedIndex, { description: event.target.value })} />
                    </> : <p>{selectedItem.description}</p>}
                    <p className="orbit-detail-muted">{selectedItem.workflows.length} workflows · {selectedItem.dependsOn.length} dependencies</p>
                  </div>
                )}
                {activeTab === "dependencies" && (
                  <div className="orbit-detail-card">
                    <h3>Depends on</h3>
                    {graph.workItems.filter((item) => item.key !== selectedItem.key).map((item) => (
                      <label className="orbit-dependency-choice" key={item.key}>
                        <input type="checkbox" disabled={!canEdit || !editing} checked={selectedItem.dependsOn.includes(item.key)}
                          onChange={(event) => editItem(selectedIndex, { dependsOn: event.target.checked ? [...selectedItem.dependsOn, item.key] : selectedItem.dependsOn.filter((key) => key !== item.key) })} />
                        <span><strong>{item.title}</strong><small>{item.key}</small></span>
                      </label>
                    ))}
                    <p className="orbit-detail-muted">Dependencies determine what must finish before execution can begin. Editing the plan does not execute work.</p>
                  </div>
                )}
                {activeTab === "workflows" && (
                  <div className="orbit-detail-card">
                    <h3>How we'll get there</h3>
                    <p>Open a workflow to explore its steps.</p>
                    <div className="orbit-nested-graph" aria-label="Workflows in this work item">
                      {selectedItem.workflows.map((workflow, index) => (
                        <button className="orbit-nested-node" type="button" key={index} onClick={() => { setSelectedWorkflow(index); setSelectedStep(null); setEditing(false); }}>
                          <span>WORKFLOW {index + 1}</span>
                          <strong>{workflow.name}</strong>
                          <small>{workflow.steps.length} steps · {workflow.steps.filter((step) => step.requiresApproval).length} approval gates</small>
                          <span>Explore →</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : currentWorkflow && (
              <div className="orbit-detail-content">
                {selectedStep !== null && currentStep ? (
                  <div className="orbit-detail-card">
                    <button className="orbit-detail-back" type="button" onClick={() => { setSelectedStep(null); setEditing(false); }}>← All steps</button>
                    <h3>{currentStep.title}</h3>
                    <p>{currentStep.requiresApproval ? "Human approval required" : "No additional approval gate"} · {currentStep.executor}</p>
                    {editing && <>
                      <label htmlFor="step-title">What needs to happen?</label>
                      <input id="step-title" value={currentStep.title} disabled={!canEdit} onChange={(event) => {
                        const next = structuredClone(graph);
                        next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[selectedStep]!.title = event.target.value;
                        change(next);
                      }} />
                      <label htmlFor="step-executor">Who handles this?</label>
                      <select id="step-executor" value={currentStep.executor} disabled={!canEdit} onChange={(event) => {
                        const next = structuredClone(graph);
                        next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[selectedStep]!.executor = event.target.value as Executor;
                        change(next);
                      }}><option value="human">Human</option><option value="agent">Agent (proposed)</option><option value="system">System</option></select>
                      <label className="orbit-approval-choice"><input type="checkbox" checked={currentStep.requiresApproval} disabled={!canEdit} onChange={(event) => {
                        const next = structuredClone(graph);
                        next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.steps[selectedStep]!.requiresApproval = event.target.checked;
                        change(next);
                      }} />Requires human approval</label>
                    </>}
                    <p className="orbit-detail-muted">Execution is not available from this planning view. Prerequisite completion must be verified by the execution service.</p>
                  </div>
                ) : (
                  <div className="orbit-detail-card">
                    <h3>{currentWorkflow.name}</h3>
                    <p>Explore the steps in this workflow. Downstream steps await verified completion of earlier steps.</p>
                    {editing && <>
                      <label htmlFor="workflow-name">Workflow name</label>
                      <input id="workflow-name" disabled={!canEdit} value={currentWorkflow.name} onChange={(event) => {
                        const next = structuredClone(graph);
                        next.workItems[selectedIndex]!.workflows[selectedWorkflow]!.name = event.target.value;
                        change(next);
                      }} />
                    </>}
                    <div className="orbit-nested-graph" aria-label="Workflow steps">
                      {currentWorkflow.steps.map((step, index) => (
                        <button key={index} type="button" className="orbit-nested-node" onClick={() => { setSelectedStep(index); setEditing(false); }}>
                          <span>STEP {index + 1}</span>
                          <strong>{step.title}</strong>
                          <small>{step.requiresApproval ? "◆ Human review" : step.executor}</small>
                          <span>{index === 0 ? "Awaiting authorization" : "Waiting for previous step"} · Explore →</span>
                        </button>
                      ))}
                    </div>
                    <p className="orbit-detail-muted">These are proposed steps, not actual execution statuses. Later steps are not executable until their prerequisites have completed.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="orbit-full-canvas" aria-label="Plan overview">
            {graph && (
              <details className="orbit-plan-settings">
                <summary>Plan details and work item management</summary>
                <div className="orbit-plan-settings-content">
                  {originalIntent && (
                    <p className="orbit-detail-muted">
                      <strong>Original intent (immutable):</strong> {originalIntent.statement}
                    </p>
                  )}
                  <label htmlFor="plan-summary">Proposed outcome</label>
                  <textarea
                    id="plan-summary"
                    rows={3}
                    maxLength={2000}
                    value={graph.summary}
                    disabled={!canEdit}
                    onChange={(event) => change({ ...graph, summary: event.target.value })}
                  />
                  {(
                    [
                      ["guardrails", "Proposed guardrails"],
                      ["decisionsToReview", "Decisions requiring review"],
                      ["assumptions", "Assumptions"],
                    ] as const
                  ).map(([key, title]) => (
                    <div key={key}>
                      <label htmlFor={`plan-${key}`}>{title} (one per line)</label>
                      <textarea
                        id={`plan-${key}`}
                        rows={3}
                        value={graph[key].join("\n")}
                        disabled={!canEdit}
                        onChange={(event) => editList(key, event.target.value)}
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={!canEdit || graph.workItems.length >= 30}
                    onClick={() => {
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
                    }}
                  >
                    + Add work item
                  </button>
                </div>
              </details>
            )}

            <div className="orbit-workspace-stage-head">
              <span>PROJECT WORK GRAPH</span>
              <strong>{graph?.workItems.length ?? 0} proposed work items</strong>
            </div>
            {graph ? (
              <WorkGraphCanvas
                items={graph.workItems}
                intent={originalIntent?.statement ?? "Original intent"}
                approved={approved}
                selectedItemKey={null}
                onSelect={(key) => {
                  if (key) openItem(key);
                }}
              />
            ) : (
              <p role="alert" className="intent-error">
                The proposal could not be displayed. No approval was performed.
              </p>
            )}
          </section>
        )}
        <footer className="orbit-plan-footer">
          <div>
            <strong>
              {approved
                ? "Plan approved"
                : dirty
                  ? "You have unsaved changes"
                  : "Review the proposed plan"}
            </strong>
            <small>Human approval does not start agents or execute code.</small>
            {error && (
              <p role="alert" className="intent-error">
                {error}
              </p>
            )}
          </div>
          <div className="orbit-plan-footer-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void latest();
              }}
            >
              Reload latest
            </button>
            {!approved && (
              <>
                <button
                  type="button"
                  disabled={busy || !dirty}
                  onClick={() => {
                    void save();
                  }}
                >
                  Save changes
                </button>
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
        </footer>
      </div>
    </main>
  );
}
