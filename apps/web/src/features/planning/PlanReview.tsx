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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedItem = graph?.workItems.find((item) => item.key === selectedItemKey);
  const approved = status === "APPROVED";
  const canEdit = !approved && !busy;
  const selectedIndex = graph?.workItems.findIndex((item) => item.key === selectedItemKey) ?? -1;
  const openItem = (key: string) => {
    setSelectedItemKey(key);
    setActiveTab("overview");
  };

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
              onClick={() => setSelectedItemKey(null)}
            >
              ← Back to workflow canvas
            </button>
            <div className="orbit-detail-heading">
              <div>
                <span className="orbit-detail-eyebrow">WORK ITEM / {selectedItem.key}</span>
                <h2>{selectedItem.title}</h2>
                <p>Configure this work item and the workflows it contains.</p>
              </div>
              <span className="orbit-detail-tag">
                {approved ? "Read only · Approved" : "Proposed"}
              </span>
            </div>
            <div className="orbit-detail-tabs" role="tablist" aria-label="Configuration sections">
              {(["overview", "workflows", "dependencies"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  className={activeTab === tab ? "is-active" : ""}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === "overview"
                    ? "Overview"
                    : tab === "workflows"
                      ? `Workflows (${selectedItem.workflows.length})`
                      : "Dependencies"}
                </button>
              ))}
            </div>
            <div className="orbit-detail-content">
              {activeTab === "overview" && (
                <div className="orbit-detail-card">
                  <h3>Work item details</h3>
                  <p>Give this work item a clear outcome and description.</p>
                  <label htmlFor="item-title">Title</label>
                  <input
                    id="item-title"
                    value={selectedItem.title}
                    maxLength={200}
                    disabled={!canEdit}
                    onChange={(event) => editItem(selectedIndex, { title: event.target.value })}
                  />
                  <label htmlFor="item-description">Description</label>
                  <textarea
                    id="item-description"
                    rows={5}
                    value={selectedItem.description}
                    maxLength={1200}
                    disabled={!canEdit}
                    onChange={(event) =>
                      editItem(selectedIndex, { description: event.target.value })
                    }
                  />
                  <div className="orbit-detail-muted">
                    {selectedItem.workflows.length} workflows · {selectedItem.dependsOn.length}{" "}
                    dependencies
                  </div>
                </div>
              )}
              {activeTab === "dependencies" && (
                <div className="orbit-detail-card">
                  <h3>Dependencies</h3>
                  <p>Choose which other work items must be completed first.</p>
                  <div className="orbit-dependency-choices">
                    {graph.workItems
                      .filter((item) => item.key !== selectedItem.key)
                      .map((item) => (
                        <label className="orbit-dependency-choice" key={item.key}>
                          <input
                            type="checkbox"
                            disabled={!canEdit}
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
                    {graph.workItems.length <= 1 && <p>No other work items available.</p>}
                  </div>
                </div>
              )}
              {activeTab === "workflows" && (
                <div className="orbit-detail-card">
                  <h3>Workflows</h3>
                  <p>
                    Each work item can contain multiple workflows, with their own steps and approval
                    requirements.
                  </p>
                  {selectedItem.workflows.map((workflow, workflowIndex) => (
                    <details
                      className="orbit-workflow-detail"
                      key={workflowIndex}
                      open={workflowIndex === 0 ? true : undefined}
                    >
                      <summary>
                        <span>
                          <strong>{workflow.name}</strong>
                          <small>
                            {workflow.steps.length} steps ·{" "}
                            {workflow.steps.filter((step) => step.requiresApproval).length} approval
                            gates
                          </small>
                        </span>
                        <span>Configure</span>
                      </summary>
                      <div className="orbit-workflow-fields">
                        <label htmlFor={`workflow-${workflowIndex}-name`}>Workflow name</label>
                        <input
                          id={`workflow-${workflowIndex}-name`}
                          disabled={!canEdit}
                          value={workflow.name}
                          onChange={(event) => {
                            const next = structuredClone(graph);
                            next.workItems[selectedIndex]!.workflows[workflowIndex]!.name =
                              event.target.value;
                            change(next);
                          }}
                        />
                        {workflow.steps.map((step, stepIndex) => (
                          <div className="orbit-step-card" key={stepIndex}>
                            <span className="orbit-detail-eyebrow">STEP {stepIndex + 1}</span>
                            <label htmlFor={`step-${workflowIndex}-${stepIndex}`}>Step title</label>
                            <input
                              id={`step-${workflowIndex}-${stepIndex}`}
                              disabled={!canEdit}
                              maxLength={200}
                              value={step.title}
                              onChange={(event) => {
                                const next = structuredClone(graph);
                                next.workItems[selectedIndex]!.workflows[workflowIndex]!.steps[
                                  stepIndex
                                ]!.title = event.target.value;
                                change(next);
                              }}
                            />
                            <label htmlFor={`executor-${workflowIndex}-${stepIndex}`}>
                              Executor
                            </label>
                            <select
                              id={`executor-${workflowIndex}-${stepIndex}`}
                              disabled={!canEdit}
                              value={step.executor}
                              onChange={(event) => {
                                const next = structuredClone(graph);
                                next.workItems[selectedIndex]!.workflows[workflowIndex]!.steps[
                                  stepIndex
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
                                disabled={!canEdit}
                                checked={step.requiresApproval}
                                onChange={(event) => {
                                  const next = structuredClone(graph);
                                  next.workItems[selectedIndex]!.workflows[workflowIndex]!.steps[
                                    stepIndex
                                  ]!.requiresApproval = event.target.checked;
                                  change(next);
                                }}
                              />
                              Requires human approval
                            </label>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="orbit-full-canvas" aria-label="Plan overview">
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
