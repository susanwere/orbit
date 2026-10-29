import { useState } from "react";
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
  ) return null;
  for (const item of data.workItems) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.key !== "string" ||
      typeof item.title !== "string" ||
      typeof item.description !== "string" ||
      !Array.isArray(item.dependsOn) ||
      !Array.isArray(item.workflows)
    ) return null;
    for (const workflow of item.workflows) {
      if (!workflow || typeof workflow.name !== "string" || !Array.isArray(workflow.steps)) return null;
      for (const step of workflow.steps) {
        if (
          !step ||
          typeof step.title !== "string" ||
          !["human", "agent", "system"].includes(step.executor) ||
          typeof step.requiresApproval !== "boolean"
        ) return null;
      }
    }
  }
  if (![...data.guardrails, ...data.decisionsToReview, ...data.assumptions].every((x) => typeof x === "string")) return null;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approved = status === "APPROVED";
  const canEdit = !approved && !busy;

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
    change({ ...graph, [name]: value.split("\n").map((s) => s.trim()).filter(Boolean) });
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
    <main className="intent-page">
      <section className="intent-panel plan-panel" aria-labelledby="plan-heading">
        <div className="intent-topline">
          <span className="eyebrow">ORBIT / {project.name} / PROPOSED PLAN</span>
          <button type="button" onClick={onBack} className="intent-back">Back to intent</button>
        </div>
        <p className="intent-overline">STEP 02 · HUMAN REVIEW</p>
        <h1 id="plan-heading">Review the proposed plan.</h1>
        <p className="intent-description">Muse Spark suggests the work. You decide what gets approved. No agent runs, repository changes, or external work items are created from this screen.</p>
        {originalIntent && (
          <details className="plan-original">
            <summary>Original intent (immutable)</summary>
            <p>{originalIntent.statement}</p>
          </details>
        )}
        {!graph ? (
          <div role="alert" className="intent-error">
            The proposal could not be displayed. No approval was performed.
            <button type="button" onClick={() => { void latest(); }} disabled={busy}>Reload proposal</button>
          </div>
        ) : (
          <>
            <label htmlFor="plan-summary">Proposed outcome</label>
            <textarea
              id="plan-summary"
              className="plan-textarea"
              rows={3}
              maxLength={2000}
              value={graph.summary}
              disabled={!canEdit}
              onChange={(event) => change({ ...graph, summary: event.target.value })}
            />
            <h2>Work items & workflows</h2>
            <div className="plan-work-items">
              {graph.workItems.map((item, index) => (
                <article className="plan-work-item" key={item.key}>
                  <div className="plan-item-top">
                    <strong>{item.key}</strong>
                    <button
                      type="button"
                      disabled={!canEdit || graph.workItems.length <= 1}
                      onClick={() => {
                        const removed = item.key;
                        change({
                          ...graph,
                          workItems: graph.workItems
                            .filter((entry) => entry.key !== removed)
                            .map((entry) => ({
                              ...entry,
                              dependsOn: entry.dependsOn.filter((key) => key !== removed),
                            })),
                        });
                      }}
                    >Remove item</button>
                  </div>
                  <label htmlFor={`plan-title-${index}`}>Work item title</label>
                  <input
                    id={`plan-title-${index}`}
                    value={item.title}
                    maxLength={200}
                    disabled={!canEdit}
                    onChange={(event) => editItem(index, { title: event.target.value })}
                  />
                  <label htmlFor={`plan-description-${index}`}>Description</label>
                  <textarea
                    id={`plan-description-${index}`}
                    rows={2}
                    maxLength={1200}
                    value={item.description}
                    disabled={!canEdit}
                    onChange={(event) => editItem(index, { description: event.target.value })}
                  />
                  <label htmlFor={`plan-dependencies-${index}`}>Dependencies (work item keys, comma-separated)</label>
                  <input
                    id={`plan-dependencies-${index}`}
                    value={item.dependsOn.join(", ")}
                    disabled={!canEdit}
                    onChange={(event) => editItem(index, {
                      dependsOn: event.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                    })}
                  />
                  <h3>Workflows</h3>
                  {item.workflows.map((workflow, wi) => (
                    <div className="plan-workflow" key={wi}>
                      <strong>{workflow.name}</strong>
                      <ol>
                        {workflow.steps.map((step, si) => (
                          <li key={si}>
                            <label htmlFor={`step-title-${index}-${wi}-${si}`}>Step</label>
                            <input
                              id={`step-title-${index}-${wi}-${si}`}
                              value={step.title}
                              disabled={!canEdit}
                              maxLength={200}
                              onChange={(event) => {
                                const next = structuredClone(graph);
                                next.workItems[index]!.workflows[wi]!.steps[si]!.title = event.target.value;
                                change(next);
                              }}
                            />
                            <label htmlFor={`step-executor-${index}-${wi}-${si}`}>Executor</label>
                            <select
                              id={`step-executor-${index}-${wi}-${si}`}
                              value={step.executor}
                              disabled={!canEdit}
                              onChange={(event) => {
                                const next = structuredClone(graph);
                                next.workItems[index]!.workflows[wi]!.steps[si]!.executor = event.target.value as Executor;
                                change(next);
                              }}
                            >
                              <option value="human">Human</option>
                              <option value="agent">Approved agent (proposed)</option>
                              <option value="system">System</option>
                            </select>
                            <label className="plan-checkbox">
                              <input
                                type="checkbox"
                                checked={step.requiresApproval}
                                disabled={!canEdit}
                                onChange={(event) => {
                                  const next = structuredClone(graph);
                                  next.workItems[index]!.workflows[wi]!.steps[si]!.requiresApproval = event.target.checked;
                                  change(next);
                                }}
                              />
                              Requires human approval
                            </label>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </article>
              ))}
            </div>
            <button
              type="button"
              disabled={!canEdit || graph.workItems.length >= 30}
              onClick={() => {
                const keys = new Set(graph.workItems.map((item) => item.key));
                let i = 1;
                while (keys.has(`NEW-${i}`)) i++;
                change({
                  ...graph,
                  workItems: [
                    ...graph.workItems,
                    {
                      key: `NEW-${i}`,
                      title: "New work item",
                      description: "Describe the work and expected outcome",
                      dependsOn: [],
                      workflows: [{ name: "Implementation", steps: [{ title: "Complete work item", executor: "human", requiresApproval: true }] }],
                    },
                  ],
                });
              }}
            >Add work item</button>
            <div className="plan-lists">
              {([
                ["guardrails", "Proposed guardrails"],
                ["decisionsToReview", "Decisions requiring review"],
                ["assumptions", "Assumptions"],
              ] as const).map(([key, heading]) => (
                <div key={key}>
                  <label htmlFor={`plan-${key}`}>{heading} (one per line)</label>
                  <textarea
                    id={`plan-${key}`}
                    rows={3}
                    value={graph[key].join("\n")}
                    disabled={!canEdit}
                    onChange={(event) => editList(key, event.target.value)}
                  />
                </div>
              ))}
            </div>
            <p className="intent-hint">All work and guardrails above are proposals, not executed or enforced policies. Approval records human acceptance; execution is a separate controlled step.</p>
            {error && <p role="alert" className="intent-error">{error}</p>}
            <div className="intent-actions">
              <button type="button" onClick={() => { void latest(); }} disabled={busy}>Reload latest</button>
              {!approved && (
                <>
                  <button type="button" onClick={() => { void save(); }} disabled={busy || !dirty}>Save changes</button>
                  <button type="button" className="cta-primary" onClick={() => { void approve(); }} disabled={busy || dirty}>
                    {busy ? "Working…" : "Approve plan"}
                  </button>
                </>
              )}
            </div>
            {dirty && <p role="status" className="intent-muted">Save your edits before approving this plan.</p>}
            {approved && <p role="status" className="intent-confirmed">Plan approved by a human. No agents have started; execution is a separate authorized workflow.</p>}
          </>
        )}
      </section>
    </main>
  );
}
