import { useContextVersionNotice } from "./use-context-version-notice.js";
import { useEffect, useRef, useState } from "react";
import { canExecuteCanvasTask } from "./canvas-task-execution.js";
import { useCanvasExecution } from "./use-canvas-execution.js";
import { CanvasComposer } from "./CanvasComposer.js";
import { PlanSection, type PlanSectionKey } from "./PlanSection.js";
import { CanvasSidebar } from "./CanvasSidebar.js";
import { ProjectContextDocuments } from "./ProjectContextDocuments.js";
import { ExecutionOutcomeNotice } from "./ExecutionOutcomeNotice.js";
import { isReadyForReview, executionDisplayState } from "./work-item-status.js";
import { AgentAuthorizationModal } from "./AgentAuthorizationModal.js";
import { WorkItemExecutionDetails } from "./WorkItemExecutionDetails.js";
import { workItemExecutionStatus, selectWorkItemExecution } from "./work-item-execution.js";
import { CanvasExecution } from "./CanvasExecution.js";
import "../projects/project-dashboard.css";
import { WorkGraphCanvas } from "./WorkGraphCanvas.js";
import type { ConnectedRepository, CreatedProject } from "../projects/project-api.js";
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
  const [projectRepositories, setProjectRepositories] = useState<readonly ConnectedRepository[]>(
    [],
  );
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesFailed, setRepositoriesFailed] = useState(false);
  const isWorkItemDetailOpen = selectedItemKey !== null;
  useEffect(() => {
    if (!isWorkItemDetailOpen) return;
    let active = true;
    setProjectRepositories([]);
    setRepositoriesLoading(true);
    setRepositoriesFailed(false);
    void api
      .getRepositories(project.id)
      .then((repositories) => {
        if (active) setProjectRepositories(repositories);
      })
      .catch(() => {
        if (active) setRepositoriesFailed(true);
      })
      .finally(() => {
        if (active) setRepositoriesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, project.id, isWorkItemDetailOpen]);

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
  const { tasks, executionSteps, museJobs, executionError, refreshExecution } = useCanvasExecution(
    api,
    project.id,
    approved && !isLoading,
    plan?.id ?? null,
    revision,
  );
  const [dismissedExecutionNotices, setDismissedExecutionNotices] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [authorizationItemKey, setAuthorizationItemKey] = useState<string | null>(null);
  const latestExecutionOutcome = executionSteps
    .flatMap((step) => {
      const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
      return job?.github_pull_number && (step.state === "COMPLETED" || isReadyForReview(step, job))
        ? [{ step, job }]
        : [];
    })
    .sort((left, right) =>
      (right.job.activity?.at(-1)?.occurredAt ?? right.job.finished_at ?? "").localeCompare(
        left.job.activity?.at(-1)?.occurredAt ?? left.job.finished_at ?? "",
      ),
    )[0];
  const executionPending = useRef(false);
  const executionNoticeKey = latestExecutionOutcome
    ? JSON.stringify([
        project.id,
        latestExecutionOutcome.job.id,
        latestExecutionOutcome.job.github_head_sha,
        latestExecutionOutcome.step.state,
      ])
    : null;
  const [executingItemKey, setExecutingItemKey] = useState<string | null>(null);
  const [taskExecutionError, setTaskExecutionError] = useState<string | null>(null);
  async function executeWorkItem(workItemKey: string) {
    if (!approved || executionPending.current) return;
    executionPending.current = true;
    setExecutingItemKey(workItemKey);
    setTaskExecutionError(null);
    try {
      const [latestTasks, approvedAgents] = await Promise.all([
        api.getTasks(project.id),
        api.getApprovedAgents(project.id),
      ]);
      const task = latestTasks.find((candidate) => candidate.task_key === workItemKey);
      if (!task || !canExecuteCanvasTask(task)) {
        throw new Error("This work item is no longer ready to execute. Refresh its status.");
      }
      const codingAgent = approvedAgents.find((agent) => agent.provider.toLowerCase() === "meta");
      if (!codingAgent) {
        setAuthorizationItemKey(workItemKey);
        return;
      }
      await api.executeTask(project.id, task.id, codingAgent.id);
      setCanvasSection("workflow");
      setSelectedItemKey(null);
    } catch (cause) {
      setTaskExecutionError(cause instanceof Error ? cause.message : "Could not start execution.");
    } finally {
      executionPending.current = false;
      setExecutingItemKey(null);
      refreshExecution();
    }
  }
  const canEdit = status === "READY_FOR_REVIEW" && !busy;
  const canCompose = !isLoading && !currentIntent && status === null;
  const showComposer = canCompose && (canvasSection === "composer" || canvasSection === "workflow");
  const isContextOpen = canvasSection === "context";
  const contextNotice = useContextVersionNotice(api, project.id);
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
    setEditing(false);
  };

  const selectedTask = tasks.find((task) => task.task_key === selectedItemKey);
  const selectedExecutionStep = selectedItemKey
    ? selectWorkItemExecution(selectedItemKey, executionSteps, selectedTask)
    : undefined;
  const hasAgentExecutor =
    selectedItem?.workflows.some((workflow) =>
      workflow.steps.some((step) => step.executor === "agent"),
    ) ?? false;
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
      {authorizationItemKey && (
        <AgentAuthorizationModal
          api={api}
          projectId={project.id}
          workItemTitle={
            graph?.workItems.find((item) => item.key === authorizationItemKey)?.title ??
            "this work item"
          }
          onClose={() => setAuthorizationItemKey(null)}
          onAuthorized={() => {
            const workItemKey = authorizationItemKey;
            setAuthorizationItemKey(null);
            void executeWorkItem(workItemKey);
          }}
        />
      )}
      <CanvasSidebar
        projectName={project.name}
        selectedItemKey={selectedItemKey}
        approved={approved}
        hasPlan={Boolean(currentIntent) || status !== null}
        canCompose={canCompose}
        isComposerOpen={showComposer}
        activeSection={projectSection}
        isContextOpen={isContextOpen}
        hasNewContextVersion={contextNotice.hasNewVersion}
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
            onVersionViewed={contextNotice.markViewed}
            availableRevision={contextNotice.latestRevision}
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
            aria-label="Work item execution"
          >
            <button
              type="button"
              className="orbit-detail-back"
              onClick={() => {
                setSelectedItemKey(null);
                setEditing(false);
              }}
            >
              ← Back to workflow canvas
            </button>
            {taskExecutionError && <p role="alert">{taskExecutionError}</p>}
            <div className="orbit-detail-heading">
              <div>
                <span className="orbit-detail-eyebrow">WORK ITEM / {selectedItem.key}</span>
                <h2>{selectedItem.title}</h2>
                <details className="orbit-detail-description" key={selectedItem.key}>
                  <summary>Description</summary>
                  <p>{selectedItem.description}</p>
                </details>
              </div>
              <div className="orbit-detail-heading-actions">
                {canEdit && (
                  <button
                    type="button"
                    className="orbit-detail-back"
                    onClick={() => setEditing((current) => !current)}
                  >
                    {editing ? "Done editing" : "✎ Edit"}
                  </button>
                )}
                <span
                  className="step-execution-badge"
                  data-state={workItemExecutionStatus(
                    approved,
                    selectedTask,
                    selectedExecutionStep,
                    selectedJob,
                  )}
                >
                  {workItemExecutionStatus(
                    approved,
                    selectedTask,
                    selectedExecutionStep,
                    selectedJob,
                  ).replaceAll("_", " ")}
                </span>
              </div>
            </div>
            {editing ? (
              <div className="work-item-edit-panel orbit-detail-card">
                <label htmlFor="work-item-title">Title</label>
                <input
                  id="work-item-title"
                  disabled={!canEdit}
                  value={selectedItem.title}
                  onChange={(event) => editItem(selectedIndex, { title: event.target.value })}
                />
                <label htmlFor="work-item-description">Description</label>
                <textarea
                  id="work-item-description"
                  disabled={!canEdit}
                  rows={5}
                  value={selectedItem.description}
                  onChange={(event) => editItem(selectedIndex, { description: event.target.value })}
                />
                <h3>Depends on</h3>
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
                      <span>{item.title}</span>
                    </label>
                  ))}
              </div>
            ) : (
              <WorkItemExecutionDetails
                key={selectedItem.key}
                projectRepositories={projectRepositories}
                repositoriesLoading={repositoriesLoading}
                repositoriesFailed={repositoriesFailed}
                workItemTitle={selectedItem.title}
                dependencyTitles={selectedItem.dependsOn.map(
                  (key) => graph.workItems.find((item) => item.key === key)?.title ?? key,
                )}
                executor={hasAgentExecutor ? "agent" : (selectedExecutionStep?.executor ?? "human")}
                executionStep={selectedExecutionStep}
                job={selectedJob}
                task={selectedTask}
                approved={approved}
                onExecute={
                  hasAgentExecutor ? () => void executeWorkItem(selectedItem.key) : undefined
                }
                isExecuting={executingItemKey !== null}
                onOpenExecution={() => setCanvasSection("execution")}
              />
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
            {taskExecutionError && <p role="alert">{taskExecutionError}</p>}
            {latestExecutionOutcome &&
              executionNoticeKey &&
              !dismissedExecutionNotices.has(executionNoticeKey) && (
                <div className="canvas-execution-outcome">
                  <ExecutionOutcomeNotice
                    onDismiss={() =>
                      setDismissedExecutionNotices(
                        (current) => new Set([...current, executionNoticeKey]),
                      )
                    }
                    step={latestExecutionOutcome.step}
                    job={latestExecutionOutcome.job}
                  />
                </div>
              )}
            {currentIntent || graph ? (
              <WorkGraphCanvas
                tasks={tasks}
                executableItemKeys={
                  approved ? tasks.filter(canExecuteCanvasTask).map((task) => task.task_key) : []
                }
                executingItemKey={executingItemKey}
                onExecute={(workItemKey) => void executeWorkItem(workItemKey)}
                planActions={planActions}
                items={graph?.workItems ?? []}
                intent={currentIntent?.statement ?? "Original intent"}
                approved={approved}
                onSelectDetail={(workItemKey) => {
                  openItem(workItemKey);
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
