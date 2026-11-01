import { useEffect, useState, type FormEvent } from "react";
import type { ProjectIntentApi, ProjectTask } from "./intent-api.js";
import { describeTaskActivity, type EnrichedProjectTask } from "./task-activity.js";

interface TaskListProps {
  readonly projectId: string;
  readonly api: Pick<
    ProjectIntentApi,
    "updateTask" | "addTask" | "executeTask" | "getTasks" | "getMuseJob" | "approveTaskProposal"
  >;
  readonly tasks: readonly ProjectTask[];
  readonly agentDefinitionId: string;
  readonly onTasksChanged: (tasks: readonly ProjectTask[]) => void;
  readonly onRefresh: () => Promise<void>;
}

function enrichTasks(tasks: readonly ProjectTask[]): EnrichedProjectTask[] {
  return tasks.map((task) => ({
    ...task,
    displayState: task.display_state ?? task.state,
    blockedBy: task.blocked_by ?? [],
    job: null,
  }));
}

/**
 * Prompt-first task list: edit the prompt, click Execute, and Muse runs,
 * opens the PR and repairs CI. Merging the PR stays with the human.
 */
export function TaskList({
  projectId,
  api,
  tasks,
  agentDefinitionId,
  onTasksChanged,
  onRefresh,
}: TaskListProps) {
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [newTaskRequest, setNewTaskRequest] = useState("");
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [enrichedTasks, setEnrichedTasks] = useState<readonly EnrichedProjectTask[]>(() =>
    enrichTasks(tasks),
  );

  useEffect(() => {
    setEnrichedTasks(enrichTasks(tasks));
  }, [tasks]);

  const hasWorkingTask = enrichedTasks.some((task) => describeTaskActivity(task).isWorking);
  useEffect(() => {
    if (!hasWorkingTask) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const freshTasks = await api.getTasks(projectId);
        const enriched = await Promise.all(
          freshTasks.map(async (freshTask): Promise<EnrichedProjectTask> => {
            const base: EnrichedProjectTask = {
              ...freshTask,
              displayState: freshTask.display_state ?? freshTask.state,
              blockedBy: freshTask.blocked_by ?? [],
              job: null,
            };
            if (!freshTask.session_id) return base;
            try {
              return { ...base, job: await api.getMuseJob(projectId, freshTask.session_id) };
            } catch {
              return base;
            }
          }),
        );
        if (!cancelled) setEnrichedTasks(enriched);
      } catch {
        // Keep the last known friendly status; the next poll retries.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, projectId, hasWorkingTask]);

  async function savePrompt(task: EnrichedProjectTask, executeAfterSave = false) {
    const wasNeedsInput = task.displayState === "NEEDS_INPUT";
    setPendingTaskId(task.id);
    setTaskError(null);
    setNotice(null);
    try {
      const updated = await api.updateTask(
        projectId,
        task.id,
        task.revision,
        draftTitle,
        draftPrompt,
      );
      onTasksChanged(tasks.map((candidate) => (candidate.id === task.id ? updated : candidate)));
      setEditingTaskId(null);
      const updatedEnriched: EnrichedProjectTask = {
        ...updated,
        displayState: updated.display_state ?? updated.state,
        blockedBy: (updated as EnrichedProjectTask).blocked_by ?? task.blockedBy ?? [],
        job: null,
      };
      setEnrichedTasks((current) =>
        current.map((existing) => (existing.id === task.id ? updatedEnriched : existing)),
      );
      setNotice("Prompt updated — sending it to Muse now…");
      if (executeAfterSave || wasNeedsInput) {
        if (!agentDefinitionId) {
          setNotice("Prompt saved. Connect a repository and authorize Muse Code, then Execute.");
          return;
        }
        try {
          await api.executeTask(projectId, task.id, agentDefinitionId);
          setNotice("Updated prompt sent — Muse is running with it now.");
          await onRefresh();
        } catch (failure) {
          setTaskError(
            failure instanceof Error
              ? failure.message
              : "Prompt updated, but could not start execution. Click Execute.",
          );
        }
      } else {
        setNotice("Prompt saved. It will be used the next time this task executes.");
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "";
      if (message.includes("Refresh")) {
        try {
          const fresh = await api.getTasks(projectId);
          const current = fresh.find((candidate) => candidate.id === task.id);
          if (current) {
            setDraftTitle(current.title);
            setDraftPrompt(current.prompt);
            setEnrichedTasks((currentTasks) =>
              currentTasks.map((existing) =>
                existing.id === task.id
                  ? {
                      ...current,
                      displayState: current.display_state ?? current.state,
                      blockedBy: (current as EnrichedProjectTask).blocked_by ?? [],
                      job: existing.job ?? null,
                    }
                  : existing,
              ),
            );
            onTasksChanged(fresh);
            setTaskError(
              message + " Refreshed to the latest revision — you can save and re-execute now.",
            );
          } else {
            setTaskError(message + " Refresh the task list and edit again.");
          }
        } catch {
          setTaskError(message);
        }
      } else {
        setTaskError(
          failure instanceof Error ? failure.message : "Could not save the prompt. Try again.",
        );
      }
    } finally {
      setPendingTaskId(null);
    }
  }

  async function executeTask(task: ProjectTask) {
    if (!agentDefinitionId) {
      setTaskError("Connect a repository and authorize Muse Code first, then execute.");
      return;
    }
    setPendingTaskId(task.id);
    setTaskError(null);
    setNotice(null);
    try {
      await api.executeTask(projectId, task.id, agentDefinitionId);
      setNotice(
        `"${task.title}" is running. Muse will open a PR and fix CI failures automatically — you only merge.`,
      );
      await onRefresh();
    } catch (failure) {
      setTaskError(failure instanceof Error ? failure.message : "Could not start this task.");
    } finally {
      setPendingTaskId(null);
    }
  }

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = newTaskRequest.trim();
    if (!request) return;
    setPendingTaskId("new-task");
    setTaskError(null);
    setNotice(null);
    try {
      const drafted = await api.addTask(projectId, request);
      if (drafted.existingTaskId) {
        setNotice(
          "Muse Spark found this is already covered by an upcoming task — no duplicate created.",
        );
      } else {
        setNotice("New task drafted by Muse Spark. Edit its prompt if needed, then Execute.");
        setNewTaskRequest("");
      }
      await onRefresh();
    } catch (failure) {
      setTaskError(failure instanceof Error ? failure.message : "Could not add that task.");
    } finally {
      setPendingTaskId(null);
    }
  }

  return (
    <section aria-label="Project tasks" className="task-list">
      <h3>Tasks</h3>
      <p>
        Muse Spark planned these from your intent. Edit any prompt, then Execute — Muse Code runs
        it, opens the PR, and keeps repairing CI failures until CI is green. You only review and
        merge the PR.
      </p>
      {notice && (
        <p role="status" className="intent-confirmed">
          {notice}
        </p>
      )}
      {taskError && (
        <p role="alert" className="intent-error">
          {taskError}
        </p>
      )}
      <ul>
        {enrichedTasks.map((task) => {
          const displayState = task.displayState;
          const isEditing = editingTaskId === task.id;
          // Orbit rule: any task that has finished a turn (FAILED, NEEDS_INPUT, DRAFT) or is ACTIVE with CI FAILED can be edited to fix CI
          const isCiFailing = !!task.last_error?.toLowerCase().includes("ci failed");
          const canEdit =
            ["DRAFT", "NEEDS_INPUT", "FAILED", "ACTIVE"].includes(displayState) || isCiFailing;
          const blockedBy = task.blockedBy;
          const activity = describeTaskActivity(task);
          const pullNumber = task.job?.github_pull_number ?? task.github_pull_number;
          const repository = task.job?.github_repository ?? task.github_repository;
          return (
            <li key={task.id}>
              <strong>{task.title}</strong>
              <p role="status" aria-live="polite">
                {activity.isWorking ? "⏳ " : ""}
                {activity.headline}
              </p>
              {activity.detail && <p>{activity.detail}</p>}
              {repository && pullNumber ? (
                <p>
                  <a
                    href={`https://github.com/${repository}/pull/${pullNumber}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View PR #{pullNumber}
                  </a>
                  {task.job?.github_ci_state ? ` · CI checks: ${task.job.github_ci_state}` : ""}
                  {task.automatic_repairs
                    ? ` · CI repair attempts so far: ${task.automatic_repairs}`
                    : ""}
                </p>
              ) : null}
              {isEditing ? (
                <>
                  <label htmlFor={`task-title-${task.id}`}>Task title</label>
                  <input
                    id={`task-title-${task.id}`}
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    maxLength={200}
                  />
                  <label htmlFor={`task-prompt-${task.id}`}>Prompt for Muse</label>
                  <textarea
                    id={`task-prompt-${task.id}`}
                    value={draftPrompt}
                    onChange={(event) => setDraftPrompt(event.target.value)}
                    rows={6}
                    maxLength={4000}
                  />
                  <button
                    type="button"
                    onClick={() => void savePrompt(task, true)}
                    disabled={pendingTaskId === task.id}
                  >
                    {task.displayState === "NEEDS_INPUT"
                      ? "Save and re-execute"
                      : "Save prompt and execute"}
                  </button>
                  <button type="button" onClick={() => setEditingTaskId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <p>{task.prompt}</p>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTaskId(task.id);
                        setDraftTitle(task.title);
                        setDraftPrompt(task.prompt);
                      }}
                    >
                      Edit prompt
                    </button>
                  )}
                  {["DRAFT", "NEEDS_INPUT", "FAILED"].includes(displayState) &&
                    blockedBy.length === 0 && (
                      <button
                        type="button"
                        className="cta-primary"
                        onClick={() => void executeTask(task)}
                        disabled={pendingTaskId === task.id}
                      >
                        {pendingTaskId === task.id ? "Starting…" : "Execute"}
                      </button>
                    )}
                  {task.last_error?.toLowerCase()?.includes("ci failed") && (
                    <button
                      type="button"
                      onClick={() => {
                        const followUpPrompt = `Fix CI failure for task "${task.title}": ${task.last_error?.slice(0, 600) ?? "CI failed"}. Review the failing checks and fix the code.`;
                        setNewTaskRequest(followUpPrompt);
                        document
                          .getElementById("orbit-new-task-request")
                          ?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      Create follow-up task for CI fix
                    </button>
                  )}
                  {displayState === "NEEDS_INPUT" && blockedBy.length === 0 && (
                    <button
                      type="button"
                      onClick={async () => {
                        setPendingTaskId(task.id);
                        setTaskError(null);
                        try {
                          await api.approveTaskProposal(projectId, task.id);
                          setNotice("Proposal approved — dependent tasks are now unblocked.");
                          await onRefresh();
                        } catch (failure) {
                          setTaskError(
                            failure instanceof Error
                              ? failure.message
                              : "Could not approve this proposal.",
                          );
                        } finally {
                          setPendingTaskId(null);
                        }
                      }}
                      disabled={pendingTaskId === task.id}
                    >
                      Approve proposal
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <form
        onSubmit={(event) => {
          void addTask(event);
        }}
      >
        <label htmlFor="orbit-new-task-request">Describe another task</label>
        <textarea
          id="orbit-new-task-request"
          value={newTaskRequest}
          onChange={(event) => setNewTaskRequest(event.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="e.g. Add pagination with Load More, 20 jobs at a time…"
        />
        <button type="submit" disabled={pendingTaskId === "new-task" || !newTaskRequest.trim()}>
          {pendingTaskId === "new-task" ? "Drafting…" : "Add task"}
        </button>
      </form>
    </section>
  );
}
