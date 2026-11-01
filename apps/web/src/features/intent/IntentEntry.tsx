import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PlanReview } from "../planning/PlanReview.js";
import type { CreatedProject, ConnectedRepository } from "../projects/project-api.js";
import type {
  ProjectIntentApi,
  ProjectPlan,
  StoredIntent,
  ExecutionStep,
  MuseJobStatus,
  ApprovedAgent,
} from "./intent-api.js";
import {
  loadExecutionStatus,
  canReplaceQueuedSession,
  canRequestDelivery,
} from "./execution-status.js";
import { authorizeFreshCiRepair } from "./ci-repair.js";
import { MuseAttemptDetails } from "./MuseAttemptDetails.js";
import { TaskList } from "./TaskList.js";
import type { ProjectTask } from "./intent-api.js";
import "./intent-entry.css";

interface IntentEntryProps {
  readonly project: CreatedProject;
  readonly api: ProjectIntentApi;
  readonly onBack: () => void;
}

type Phase = "loading" | "ready" | "saving" | "planning" | "error";

export function IntentEntry({ project, api, onBack }: IntentEntryProps) {
  const [statement, setStatement] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [savedDocuments, setSavedDocuments] = useState<
    readonly { id: string; original_filename: string; media_type: string; size_bytes: number }[]
  >([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [intent, setIntent] = useState<StoredIntent | null>(null);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [repositoryError, setRepositoryError] = useState(false);
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [executionPreparing, setExecutionPreparing] = useState(false);
  const [executionSummary, setExecutionSummary] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionSteps, setExecutionSteps] = useState<readonly ExecutionStep[]>([]);
  const [executionLoaded, setExecutionLoaded] = useState(false);
  const [stepActionPending, setStepActionPending] = useState<string | null>(null);
  const [museJobs, setMuseJobs] = useState<Record<string, MuseJobStatus | null>>({});
  const [executionNotice, setExecutionNotice] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [deliveryAcknowledgements, setDeliveryAcknowledgements] = useState<Record<string, boolean>>(
    {},
  );
  const [githubRunIds, setGithubRunIds] = useState<Record<string, string>>({});
  const [agentDefinitionId, setAgentDefinitionId] = useState("");
  const [approvedAgents, setApprovedAgents] = useState<readonly ApprovedAgent[]>([]);
  const [agentCatalogError, setAgentCatalogError] = useState<string | null>(null);
  const [onboardingRepository, setOnboardingRepository] = useState("");
  const [onboardingApproved, setOnboardingApproved] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [pendingSessionIds, setPendingSessionIds] = useState<Record<string, string>>({});
  const [projectTasks, setProjectTasks] = useState<readonly ProjectTask[]>([]);
  const busy = phase === "loading" || phase === "saving" || phase === "planning";

  const refreshTasks = useCallback(async () => {
    const loadedTasks = await api.getTasks(project.id);
    setProjectTasks(loadedTasks);
  }, [api, project.id]);

  useEffect(() => {
    if (!plan || (plan.status !== "APPROVED" && plan.status !== "READY_FOR_REVIEW")) return;
    let cancelled = false;
    void api
      .getTasks(project.id)
      .then((loadedTasks) => {
        if (!cancelled) setProjectTasks(loadedTasks);
      })
      .catch(() => {
        if (!cancelled) setProjectTasks([]);
      });
    void api
      .getApprovedAgents(project.id)
      .then((agents) => {
        if (cancelled) return;
        setApprovedAgents(agents);
        setAgentCatalogError(null);
        setAgentDefinitionId((current) =>
          agents.some((agent) => agent.id === current)
            ? current
            : agents.length === 1 && agents[0]?.provider.toLowerCase() === "meta"
              ? agents[0].id
              : "",
        );
      })
      .catch(() => {
        if (!cancelled) setAgentCatalogError("Could not load approved agents.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, project.id, plan?.status]);

  const refresh = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const [savedIntent, savedPlan] = await Promise.all([
        api.getIntent(project.id),
        api.getPlan(project.id),
      ]);
      setIntent(savedIntent);
      setPlan(savedPlan);
      if (savedIntent) {
        setStatement(savedIntent.statement);
        try {
          setSavedDocuments(await api.getIntentDocuments(project.id));
        } catch {
          setAttachmentError("Could not load saved document attachments.");
        }
      }
      setPhase("ready");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load project intent.");
      setPhase("error");
    }
  }, [api, project.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.getIntent(project.id),
      api.getPlan(project.id),
      api.getRepositories(project.id),
    ]).then((results) => {
      if (cancelled) return;
      const [intentResult, planResult, repositoryResult] = results;
      if (!intentResult || intentResult.status === "rejected") {
        setPhase("error");
        setError("Could not load project intent. Retry to continue.");
        return;
      }
      if (!planResult || planResult.status === "rejected") {
        setPhase("error");
        setError("Could not load the planning state. Retry to continue.");
        return;
      }
      setIntent(intentResult.value);
      if (intentResult.value) setStatement(intentResult.value.statement);
      setPlan(planResult.value);
      if (planResult.value?.status === "APPROVED") {
        void loadExecutionStatus(api, project.id)
          .then((status) => {
            if (!cancelled) {
              setExecutionSteps(status.steps);
              setMuseJobs(status.jobs);
              setExecutionLoaded(true);
              if (status.jobRefreshFailed)
                setExecutionError(
                  "Could not refresh some Muse jobs. Refresh execution status to retry.",
                );
            }
          })
          .catch(() => {
            if (!cancelled) {
              setExecutionError("Could not load execution status. Refresh to retry.");
            }
          });
      }
      if (repositoryResult?.status === "fulfilled") {
        setRepositories(repositoryResult.value);
        setOnboardingRepository(
          (selected) => selected || repositoryResult.value[0]?.full_name || "",
        );
        setRepositoryError(false);
      } else {
        setRepositoryError(true);
      }
      setRepositoryLoading(false);
      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [api, project.id]);

  useEffect(() => {
    if (plan?.status !== "APPROVED") return;
    let cancelled = false;
    void api
      .getApprovedAgents(project.id)
      .then((agents) => {
        if (cancelled) return;
        setApprovedAgents(agents);
        setAgentCatalogError(null);
        setAgentDefinitionId((current) =>
          agents.some((agent) => agent.id === current)
            ? current
            : agents.length === 1 && agents[0]?.provider.toLowerCase() === "meta"
              ? agents[0].id
              : "",
        );
      })
      .catch(() => {
        if (!cancelled) setAgentCatalogError("Could not load approved agents.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, project.id, plan?.status]);

  const hasActiveLocalExecution = Object.values(museJobs).some(
    (job) =>
      Boolean(
        job?.github_pull_number &&
          executionSteps.some(
            (step) => step.id === job.workflow_step_id && step.state === "RUNNING",
          ),
      ) ||
      ["REQUESTED", "RUNNING"].includes(job?.delivery_state ?? "") ||
      job?.status === "RUNNING" ||
      (job?.status === "QUEUED" &&
        ["REQUESTED", "PREPARING", "RUNNING"].includes(job.local_execution_state ?? "")),
  );
  useEffect(() => {
    if (!hasActiveLocalExecution) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await loadExecutionStatus(api, project.id);
        if (cancelled) return;
        setExecutionSteps(status.steps);
        setMuseJobs((current) => ({ ...current, ...status.jobs }));
        if (status.jobRefreshFailed)
          setExecutionError("Some job statuses could not refresh. Retrying automatically.");
        else setExecutionError(null);
      } catch {
        if (!cancelled)
          setExecutionError("Could not refresh local execution status. Retrying automatically.");
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, project.id, hasActiveLocalExecution]);

  async function reloadRepositories() {
    setRepositoryLoading(true);
    setRepositoryError(false);
    try {
      const loaded = await api.getRepositories(project.id);
      setRepositories(loaded);
      setOnboardingRepository((selected) =>
        loaded.some((item) => item.full_name === selected)
          ? selected
          : (loaded[0]?.full_name ?? ""),
      );
    } catch {
      setRepositoryError(true);
    } finally {
      setRepositoryLoading(false);
    }
  }

  async function connectRepository() {
    if (!repositoryInput.trim() || registrationBusy) return;
    setRegistrationBusy(true);
    setRegistrationError(null);
    try {
      const registration = await api.connectRepository(project.id, repositoryInput.trim());
      setRepositories((current) => [
        ...current.filter((repository) => repository.id !== registration.id),
        registration,
      ]);
      setOnboardingRepository(registration.full_name);
      setRepositoryInput("");
      await reloadRepositories();
    } catch (failure) {
      setRegistrationError(
        failure instanceof Error
          ? failure.message
          : "Could not connect repository. Retry to continue.",
      );
    } finally {
      setRegistrationBusy(false);
    }
  }

  async function onboardMuse() {
    if (!onboardingApproved || !onboardingRepository || onboardingBusy) return;
    setOnboardingBusy(true);
    setAgentCatalogError(null);
    try {
      await api.onboardMuse(project.id, onboardingRepository);
      const agents = await api.getApprovedAgents(project.id);
      setApprovedAgents(agents);
      setAgentDefinitionId(agents.find((agent) => agent.provider === "meta")?.id ?? "");
      setOnboardingApproved(false);
    } catch (failure) {
      setAgentCatalogError(
        failure instanceof Error ? failure.message : "Could not authorize Muse Code.",
      );
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function generate() {
    setPhase("planning");
    setError(null);
    try {
      const result = await api.generatePlan(project.id);
      setPlan(result);
      setPhase("ready");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Planning failed. Try again.");
      setPhase("error");
    }
  }

  async function loadExecutionSteps() {
    setExecutionError(null);
    try {
      const status = await loadExecutionStatus(api, project.id);
      setExecutionSteps(status.steps);
      setMuseJobs(status.jobs);
      setExecutionLoaded(true);
      if (status.jobRefreshFailed)
        setExecutionError("Could not refresh some Muse jobs. Refresh execution status to retry.");
    } catch (failure) {
      setExecutionError(
        failure instanceof Error ? failure.message : "Could not load execution status.",
      );
    }
  }

  async function actOnStep(
    step: ExecutionStep,
    action: "approve" | "retry" | "start" | "dispatch" | "job" | "create",
  ) {
    if (stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    setExecutionNotice(null);
    try {
      if (action === "approve") {
        await api.approveExecutionStep(project.id, step.id);
      } else if (action === "retry") {
        await api.authorizeExecutionRetry(project.id, step.id);
      } else if (action === "create" && plan) {
        if (!agentDefinitionId.trim()) {
          throw new Error("Provide the ID of an approved Muse coding agent definition.");
        }
        let sessionId = pendingSessionIds[step.id];
        if (!sessionId) {
          const graph = plan.content as {
            workItems?: {
              key: string;
              title: string;
              description: string;
              workflows: { steps: { title: string }[] }[];
            }[];
          } | null;
          const workItem = graph?.workItems?.find((item) => item.key === step.work_item_key);
          const stepTitle =
            workItem?.workflows?.[step.workflow_index]?.steps?.[step.step_index]?.title;
          const mission = [
            workItem?.title ?? step.work_item_key,
            workItem?.description ?? "Implement the approved work item.",
            stepTitle ? `Approved step: ${stepTitle}` : "",
            "Follow the approved execution contract and human gates.",
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000);
          sessionId = await api.createAgentSession(
            project.id,
            agentDefinitionId.trim(),
            `work:${plan.id}:${step.work_item_key}`,
            mission,
            step.ci_repair_source_job_id ?? undefined,
          );
          setPendingSessionIds((current) => ({ ...current, [step.id]: sessionId! }));
        }
        await api.bindExecutionSession(project.id, step.id, sessionId);
        setPendingSessionIds((current) => {
          const updated = { ...current };
          delete updated[step.id];
          return updated;
        });
      } else if (step.agent_session_id) {
        if (action === "start") await api.startAgentSession(project.id, step.agent_session_id);
        if (action === "dispatch") await api.dispatchMuse(project.id, step.agent_session_id);
        const job = await api.getMuseJob(project.id, step.agent_session_id);
        setMuseJobs((current) => ({ ...current, [step.agent_session_id!]: job }));
      }
      setExecutionSteps(await api.getExecutionSteps(project.id));
    } catch (failure) {
      setExecutionError(failure instanceof Error ? failure.message : "Step action failed.");
    } finally {
      setStepActionPending(null);
    }
  }

  async function reviewStep(
    step: ExecutionStep,
    action: "authorize" | "output" | "human" | "reject" | "replace",
  ) {
    if (stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      const note = reviewNotes[step.id] ?? "";
      if (action === "replace") {
        const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
        if (!job || !canReplaceQueuedSession(step, job))
          throw new Error(
            "Refresh status. Replacement is only needed for an unstarted job missing revision feedback.",
          );
        await api.retireUnstartedJob(project.id, step.id, job.id);
        await api.authorizeExecutionRetry(project.id, step.id);
      } else if (action === "authorize") await api.authorizeProposalReview(project.id, step.id);
      else if (action === "human") await api.completeHumanReview(project.id, step.id, note);
      else {
        const outputHash = step.agent_session_id
          ? museJobs[step.agent_session_id]?.output_hash
          : null;
        if (!outputHash) throw new Error("Refresh and review the retained output first.");
        await api.reviewOutput(
          project.id,
          step.id,
          outputHash,
          note,
          action === "reject" ? "reject" : "approve",
        );
      }
      await loadExecutionSteps();
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : "Review failed. Your instructions are preserved.";
      if (action === "replace") await loadExecutionSteps();
      setExecutionError(message);
    } finally {
      setStepActionPending(null);
    }
  }

  async function requestDelivery(step: ExecutionStep) {
    const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
    if (
      stepActionPending ||
      !deliveryAcknowledgements[step.id] ||
      !canRequestDelivery(step, job) ||
      !job?.output_hash
    )
      return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      await api.requestDelivery(project.id, step.id, job.id, job.output_hash);
      await loadExecutionSteps();
    } catch (failure) {
      setExecutionError(
        failure instanceof Error
          ? failure.message
          : "Could not request PR delivery. Refresh status before retrying.",
      );
    } finally {
      setStepActionPending(null);
    }
  }

  async function inspectCi(step: ExecutionStep, prepareRepair = false) {
    const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
    if (!job || stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      if (prepareRepair) {
        await authorizeFreshCiRepair(api, project.id, step, job);
        setPendingSessionIds((current) => {
          const remainingSessions = { ...current };
          delete remainingSessions[step.id];
          return remainingSessions;
        });
        setExecutionNotice(
          "CI repair authorized. No Muse job was started. Create and bind a new repair session, then explicitly start and execute it.",
        );
      } else await api.inspectGithubCi(project.id, step.id, job.id);
      await loadExecutionSteps();
    } catch (failure) {
      await loadExecutionSteps();
      setExecutionError(
        failure instanceof Error
          ? failure.message
          : "CI inspection could not finish; no execution was started.",
      );
    } finally {
      setStepActionPending(null);
    }
  }

  async function verifyCi(step: ExecutionStep) {
    const job = step.agent_session_id ? museJobs[step.agent_session_id] : null;
    const runId = Number(githubRunIds[step.id] ?? "");
    if (
      !job?.github_repository ||
      !job.github_pull_number ||
      !Number.isSafeInteger(runId) ||
      runId <= 0
    ) {
      setExecutionError("Enter a valid GitHub Actions run ID for the delivered pull request.");
      return;
    }
    if (stepActionPending) return;
    setStepActionPending(step.id);
    setExecutionError(null);
    try {
      await api.verifyGithubCi(
        project.id,
        step.id,
        job.github_repository,
        runId,
        job.github_pull_number,
      );
      await loadExecutionSteps();
    } catch (failure) {
      setExecutionError(failure instanceof Error ? failure.message : "CI verification failed.");
    } finally {
      setStepActionPending(null);
    }
  }

  async function prepareExecution() {
    if (plan?.status !== "APPROVED" || executionPreparing) return;
    setExecutionPreparing(true);
    setExecutionError(null);
    try {
      await api.prepareExecution(project.id);
      const steps = await api.getExecutionSteps(project.id);
      setExecutionSteps(steps);
      setExecutionLoaded(true);
      const blocked = steps.filter((step) => step.blocker_reason !== null);
      setExecutionSummary(
        `Prepared ${steps.length} execution steps. ${blocked.length} have blockers. No agents have started.`,
      );
    } catch (failure) {
      // An existing execution may already be prepared. Never retry silently.
      setExecutionError(
        failure instanceof Error ? failure.message : "Could not prepare execution.",
      );
    } finally {
      setExecutionPreparing(false);
    }
  }

  async function encodeDocument(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read " + file.name));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string" || !result.includes(","))
          reject(new Error("Could not encode " + file.name));
        else resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || intent) return;
    const text = statement.trim();
    if (!text || text.length > 10_000) {
      setError("Describe what you want to build (up to 10,000 characters).");
      return;
    }
    setPhase("saving");
    setError(null);
    try {
      const uploaded = [];
      for (const file of attachmentFiles) {
        const mediaType = file.name.toLowerCase().endsWith(".md")
          ? "text/markdown"
          : file.name.toLowerCase().endsWith(".txt")
            ? "text/plain"
            : file.type;
        const stored = await api.uploadDocument(project.id, {
          filename: file.name,
          mediaType,
          base64: await encodeDocument(file),
        });
        uploaded.push(stored);
      }
      const saved = await api.submitIntent(
        project.id,
        text,
        uploaded.map((doc) => doc.id),
      );
      setSavedDocuments(uploaded.map((doc) => ({ ...doc, media_type: "", size_bytes: 0 })));
      setIntent(saved);
      setStatement(saved.statement);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save intent. Try again.");
      setPhase("error");
      return;
    }
    await generate();
  }

  const proposed = plan?.status === "READY_FOR_REVIEW" || plan?.status === "APPROVED";
  if (reviewOpen && plan && proposed) {
    return (
      <PlanReview
        project={project}
        originalIntent={intent}
        plan={plan}
        api={api}
        onBack={() => setReviewOpen(false)}
        onUpdated={setPlan}
      />
    );
  }
  return (
    <main className="intent-page">
      <section className="intent-panel" aria-labelledby="intent-heading">
        <div className="intent-topline">
          <span className="eyebrow">ORBIT / {project.name}</span>
          <button type="button" onClick={onBack} className="intent-back">
            Back to Orbit
          </button>
        </div>
        <p className="intent-overline">STEP 01 · PRODUCT INTENT</p>
        <h1 id="intent-heading">What do you want to build?</h1>
        <p className="intent-description">
          Describe the outcome you want. Orbit will propose work items, workflows, dependencies, and
          approval points for you to review before any execution begins.
        </p>

        {phase === "loading" ? (
          <p role="status" className="intent-muted">
            Loading your project…
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            className="intent-composer"
          >
            <label htmlFor="orbit-intent-statement">Your original intent</label>
            <textarea
              id="orbit-intent-statement"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              readOnly={Boolean(intent)}
              disabled={busy || Boolean(intent)}
              rows={7}
              maxLength={10_000}
              required
              placeholder="Build a React application that fetches Hacker News job postings and displays them in a responsive list…"
            />
            {!intent && (
              <div className="intent-attachments">
                <label htmlFor="orbit-intent-files">
                  Supporting documents (optional, up to 10)
                </label>
                <input
                  id="orbit-intent-files"
                  type="file"
                  multiple
                  accept=".md,.txt,.pdf,.docx"
                  disabled={busy}
                  onChange={(event) => {
                    const incoming = Array.from(event.target.files ?? []);
                    const next = [...attachmentFiles, ...incoming];
                    if (
                      next.length > 10 ||
                      next.some((file) => file.size > 5 * 1024 * 1024 || file.size === 0)
                    ) {
                      setAttachmentError(
                        "Attach at most 10 documents, each between 1 byte and 5 MB.",
                      );
                    } else {
                      setAttachmentError(null);
                      setAttachmentFiles(next);
                    }
                    event.target.value = "";
                  }}
                />
                {attachmentFiles.map((file, index) => (
                  <div key={index} className="intent-attachment-row">
                    <span>
                      {file.name} ({Math.ceil(file.size / 1024)} KB)
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setAttachmentFiles((files) => files.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {savedDocuments.length > 0 && (
              <section aria-label="Attached project documents">
                <strong>Attached documents</strong>
                {savedDocuments.map((doc) => (
                  <p key={doc.id}>{doc.original_filename}</p>
                ))}
              </section>
            )}
            {attachmentError && (
              <p role="alert" className="intent-error">
                {attachmentError}
              </p>
            )}
            <p className="intent-hint">
              {intent
                ? "Original intent saved. It is preserved as the historical source of truth."
                : "Include your users, desired behavior, and important constraints. Voice capture with Muse Voice is coming next."}
            </p>
            {error && (
              <p role="alert" className="intent-error">
                {error}
              </p>
            )}
            {intent && !error && (
              <p role="status" className="intent-confirmed">
                Original intent saved. Your words will not be overwritten by planning.
              </p>
            )}
            <div className="intent-actions">
              {!intent && (
                <button type="submit" className="cta-primary" disabled={busy || !statement.trim()}>
                  {phase === "saving" ? "Saving intent…" : "Save intent & propose plan"}
                </button>
              )}
              {intent && !proposed && plan?.status !== "GENERATING" && (
                <button
                  type="button"
                  className="cta-primary"
                  onClick={() => {
                    void generate();
                  }}
                  disabled={busy}
                >
                  {phase === "planning" ? "Muse Spark is planning…" : "Generate or retry plan"}
                </button>
              )}
              {phase === "error" && !intent && (
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Reload project state
                </button>
              )}
              {plan?.status === "GENERATING" && (
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                  }}
                  disabled={busy}
                >
                  Check planning status
                </button>
              )}
            </div>
          </form>
        )}

        {phase === "planning" && (
          <p role="status" className="intent-muted">
            Muse Spark is generating a proposed work graph. No agents are running.
          </p>
        )}
        {proposed && (
          <div className="intent-next" role="status">
            <strong>{plan.status === "APPROVED" ? "Plan approved" : "Proposed plan ready"}</strong>
            <p>
              {plan.status === "APPROVED"
                ? "Your plan is approved. Execution is not started automatically."
                : "Muse Spark returned a proposal. The Plan Review experience is the next step; no work has started."}
            </p>
            <button type="button" className="cta-primary" onClick={() => setReviewOpen(true)}>
              {plan.status === "APPROVED" ? "View approved plan" : "Review proposed plan"}
            </button>
            {projectTasks.length > 0 && (
              <TaskList
                projectId={project.id}
                api={api}
                tasks={projectTasks}
                agentDefinitionId={agentDefinitionId}
                onTasksChanged={setProjectTasks}
                onRefresh={refreshTasks}
              />
            )}
            {plan.status === "APPROVED" && (
              <div className="execution-dashboard" role="region" aria-label="Execution dashboard">
                <strong>Workflow execution</strong>
                <p role="status">
                  {executionSteps.length
                    ? `${executionSteps.filter((step) => step.state === "COMPLETED").length} of ${executionSteps.length} steps completed`
                    : executionLoaded
                      ? "No execution prepared"
                      : "Loading execution status…"}
                </p>
                <p>
                  Prepare, authorize and dispatch work below. No agent runs without explicit
                  approval.
                </p>
                <button
                  type="button"
                  onClick={() => void loadExecutionSteps()}
                  disabled={Boolean(stepActionPending)}
                >
                  Refresh status
                </button>
              </div>
            )}
            {plan.status === "APPROVED" && executionLoaded && executionSteps.length === 0 && (
              <button
                type="button"
                className="cta-primary"
                onClick={() => void prepareExecution()}
                disabled={executionPreparing || Boolean(executionSummary)}
              >
                {executionPreparing ? "Preparing execution…" : "Prepare execution"}
              </button>
            )}
            {plan.status === "APPROVED" && (
              <section id="orbit-execution-steps" aria-label="Execution step review">
                <h3>Execution steps</h3>
                <p>
                  Review real backend statuses and approve only the required human gates. Approval
                  does not start an agent.
                </p>
                <button
                  type="button"
                  onClick={() => void loadExecutionSteps()}
                  disabled={Boolean(stepActionPending)}
                >
                  Refresh execution status
                </button>
                {executionSteps.some((step) => !step.agent_session_id) && (
                  <div>
                    <label htmlFor="orbit-agent-definition">Execution agent</label>
                    <select
                      id="orbit-agent-definition"
                      value={agentDefinitionId}
                      onChange={(event) => setAgentDefinitionId(event.target.value)}
                      disabled={approvedAgents.length === 0}
                    >
                      <option value="">Select an approved agent</option>
                      {approvedAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} ({agent.provider})
                        </option>
                      ))}
                    </select>
                    {approvedAgents.length === 0 && (
                      <div className="execution-onboarding">
                        <h4>Connect Meta Muse Code</h4>
                        <p>
                          Authorize Muse Code for a connected repository. Running code still
                          requires plan and step approval.
                        </p>
                        <label htmlFor="muse-repository">Repository</label>
                        <select
                          id="muse-repository"
                          disabled={repositoryLoading || registrationBusy}
                          value={onboardingRepository}
                          onChange={(event) => setOnboardingRepository(event.target.value)}
                        >
                          <option value="">
                            {repositoryLoading ? "Loading repositories…" : "Choose a repository"}
                          </option>
                          {repositories.map((repository) => (
                            <option key={repository.id} value={repository.full_name}>
                              {repository.full_name}
                            </option>
                          ))}
                        </select>
                        {repositoryError && (
                          <p role="alert">
                            Could not load the repositories connected to this project.
                            <button type="button" onClick={() => void reloadRepositories()}>
                              Retry loading repositories
                            </button>
                          </p>
                        )}
                        {!repositoryLoading && !repositoryError && repositories.length === 0 && (
                          <p role="status">
                            No repository registration was found for this project. Connect a GitHub
                            repository below to continue with this project.
                          </p>
                        )}
                        <label htmlFor="muse-repository-registration">
                          GitHub repository URL or owner/repo
                        </label>
                        <input
                          id="muse-repository-registration"
                          value={repositoryInput}
                          onChange={(event) => setRepositoryInput(event.target.value)}
                          placeholder="susanwere/private-test"
                          disabled={registrationBusy}
                        />
                        <button
                          type="button"
                          disabled={registrationBusy || !repositoryInput.trim()}
                          onClick={() => void connectRepository()}
                        >
                          {registrationBusy ? "Connecting repository…" : "Connect repository"}
                        </button>
                        {registrationError && <p role="alert">{registrationError}</p>}
                        <label>
                          <input
                            type="checkbox"
                            checked={onboardingApproved}
                            onChange={(event) => setOnboardingApproved(event.target.checked)}
                          />
                          I authorize Muse Code to modify the approved paths in this repository.
                        </label>
                        <button
                          type="button"
                          disabled={
                            !onboardingApproved ||
                            !onboardingRepository ||
                            onboardingBusy ||
                            repositoryLoading ||
                            repositoryError
                          }
                          onClick={() => void onboardMuse()}
                        >
                          {onboardingBusy ? "Authorizing…" : "Authorize Muse Code"}
                        </button>
                      </div>
                    )}
                    {agentCatalogError && <p role="alert">{agentCatalogError}</p>}
                    <p>
                      Only approved agents with access to this repository are listed. Credentials
                      stay on the worker, and every session receives its own execution contract.
                    </p>
                  </div>
                )}
                {executionSteps.length > 0 && (
                  <ol>
                    {executionSteps.map((step) => (
                      <li key={step.id}>
                        <details>
                          <summary>
                            <strong>
                              {step.work_item_key} · Workflow {step.workflow_index + 1}, Step{" "}
                              {step.step_index + 1}
                            </strong>
                            {" · "}
                            {step.state}
                            {step.ci_repair_source_job_id && " · CI repair"}
                            {step.agent_session_id &&
                              step.state !== "COMPLETED" &&
                              museJobs[step.agent_session_id]?.status === "TURN_FINISHED" && (
                                <span>
                                  {" "}
                                  {step.completion_kind === "human_review"
                                    ? "· Muse proposal ready for human review"
                                    : "· Muse turn finished; awaiting delivery and CI verification"}
                                </span>
                              )}
                            {step.state === "BLOCKED" && step.blocker_reason && (
                              <span> · Blocked: {step.blocker_reason.replaceAll("_", " ")}</span>
                            )}
                          </summary>
                          {step.title && <p>{step.title}</p>}
                          {step.executor !== "human" &&
                            step.approval_required &&
                            !step.approved_at &&
                            step.state === "BLOCKED" && (
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() => void actOnStep(step, "approve")}
                              >
                                {stepActionPending === step.id ? "Approving…" : "Approve step"}
                              </button>
                            )}
                          {step.executor !== "human" &&
                            step.executor !== "system" &&
                            !step.agent_session_id &&
                            step.state === "BLOCKED" &&
                            step.blocker_reason !== "prerequisite_incomplete" &&
                            step.blocker_reason !== "human_approval_required" && (
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending) || !agentDefinitionId.trim()}
                                onClick={() => void actOnStep(step, "create")}
                              >
                                {pendingSessionIds[step.id]
                                  ? "Retry binding created session"
                                  : "Create & bind agent session"}
                              </button>
                            )}
                          {step.agent_session_id &&
                            step.blocker_reason === null &&
                            (step.state === "READY" || step.state === "BLOCKED") && (
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() => void actOnStep(step, "start")}
                              >
                                Start authorized session
                              </button>
                            )}
                          {step.agent_session_id &&
                            step.state === "RUNNING" &&
                            museJobs[step.agent_session_id] === null && (
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() => void actOnStep(step, "dispatch")}
                              >
                                Execute Muse Code locally
                              </button>
                            )}
                          {step.agent_session_id &&
                            step.state === "RUNNING" &&
                            museJobs[step.agent_session_id]?.status === "QUEUED" &&
                            museJobs[step.agent_session_id]?.needs_revision_replacement === false &&
                            (!museJobs[step.agent_session_id]?.local_execution_state ||
                              museJobs[step.agent_session_id]?.local_execution_state ===
                                "ERROR") && (
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() => void actOnStep(step, "dispatch")}
                              >
                                {museJobs[step.agent_session_id]?.local_execution_state === "ERROR"
                                  ? "Retry local setup"
                                  : "Execute queued job locally"}
                              </button>
                            )}
                          {step.agent_session_id && (
                            <button
                              type="button"
                              disabled={Boolean(stepActionPending)}
                              onClick={() => void actOnStep(step, "job")}
                            >
                              Check Muse job
                            </button>
                          )}
                          {canReplaceQueuedSession(
                            step,
                            step.agent_session_id ? museJobs[step.agent_session_id] : null,
                          ) && (
                            <div>
                              <p>
                                To include revision feedback in a fresh session, retire this
                                unstarted job. Its existing snapshot is preserved; no Muse execution
                                starts.
                              </p>
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() => void reviewStep(step, "replace")}
                              >
                                Retire queued session and authorize a fresh attempt
                              </button>
                            </div>
                          )}
                          <MuseAttemptDetails
                            step={step}
                            job={step.agent_session_id ? museJobs[step.agent_session_id] : null}
                          />
                          {step.agent_session_id && museJobs[step.agent_session_id] && (
                            <p role="status">
                              Muse job: {museJobs[step.agent_session_id]?.status}
                              {museJobs[step.agent_session_id]?.local_execution_state &&
                                ` · Local worker: ${museJobs[step.agent_session_id]?.local_execution_state}`}
                              {museJobs[step.agent_session_id]?.local_execution_error && (
                                <span role="alert">
                                  {" "}
                                  · {museJobs[step.agent_session_id]?.local_execution_error}
                                </span>
                              )}
                              {museJobs[step.agent_session_id]?.local_execution_state ===
                                "REQUESTED" &&
                                " · Waiting for the local worker to pick up this request."}
                              {museJobs[step.agent_session_id]?.status === "QUEUED" &&
                                museJobs[step.agent_session_id]?.needs_revision_replacement ===
                                  false &&
                                " · Session is current. No replacement needed."}
                              {step.state !== "COMPLETED" &&
                                step.completion_kind !== "human_review" &&
                                museJobs[step.agent_session_id]?.status === "TURN_FINISHED" &&
                                (museJobs[step.agent_session_id]?.changed_paths?.length === 0
                                  ? museJobs[step.agent_session_id]?.needs_ci_repair_retry
                                    ? " · No files changed. CI remains failed; authorize a fresh CI repair below."
                                    : " · No files changed. There is no new code to deliver; review the retained response."
                                  : " · The Muse turn ended. The step stays running until delivery and CI are independently verified.")}
                              {museJobs[step.agent_session_id]?.github_pull_number
                                ? ` · PR #${museJobs[step.agent_session_id]?.github_pull_number}`
                                : ""}
                              {museJobs[step.agent_session_id]?.failure_reason
                                ? ` · ${museJobs[step.agent_session_id]?.failure_reason}`
                                : ""}
                            </p>
                          )}
                          {step.agent_session_id &&
                            (museJobs[step.agent_session_id]?.status === "TURN_FINISHED" ||
                              museJobs[step.agent_session_id]?.review_output) && (
                              <section aria-label="Agent output review">
                                <h4>Agent response</h4>
                                {museJobs[step.agent_session_id]?.review_output ? (
                                  <>
                                    {museJobs[step.agent_session_id]?.output_source ===
                                      "read_only_recovery" && (
                                      <p>
                                        This is a new read-only proposal. The original turn's
                                        response was not retained.
                                      </p>
                                    )}
                                    <pre
                                      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                                    >
                                      {museJobs[step.agent_session_id]?.review_output}
                                    </pre>
                                    {step.state === "RUNNING" &&
                                      !step.ci_repair_source_job_id &&
                                      !museJobs[step.agent_session_id]?.repair_source_job_id &&
                                      museJobs[step.agent_session_id]?.changed_paths?.length ===
                                        0 &&
                                      step.completion_kind !== "human_review" && (
                                        <>
                                          <p>
                                            For proposal-only work with no code changes, an
                                            administrator can explicitly authorize human review.
                                            Code changes still require GitHub CI.
                                          </p>
                                          <button
                                            type="button"
                                            disabled={Boolean(stepActionPending)}
                                            onClick={() => void reviewStep(step, "authorize")}
                                          >
                                            Authorize proposal-only review
                                          </button>
                                        </>
                                      )}
                                  </>
                                ) : (
                                  <p>
                                    The response was not retained by the older worker. Regenerate a
                                    read-only proposal locally before reviewing this step.
                                  </p>
                                )}
                              </section>
                            )}
                          {((step.executor === "human" &&
                            !step.agent_session_id &&
                            ["BLOCKED", "READY"].includes(step.state) &&
                            step.blocker_reason !== "prerequisite_incomplete") ||
                            (step.completion_kind === "human_review" &&
                              step.state === "RUNNING" &&
                              step.agent_session_id &&
                              museJobs[step.agent_session_id]?.output_hash)) && (
                            <section aria-label="Human review decision">
                              <label htmlFor={`review-note-${step.id}`}>
                                Optional comment or changes to the proposal (shared with subsequent
                                agents)
                              </label>
                              <textarea
                                id={`review-note-${step.id}`}
                                maxLength={2000}
                                value={reviewNotes[step.id] ?? ""}
                                onChange={(event) =>
                                  setReviewNotes((current) => ({
                                    ...current,
                                    [step.id]: event.target.value,
                                  }))
                                }
                              />
                              <p>
                                Approval preserves the proposal and optional comments as project
                                context for later workflows. It does not verify code or CI.
                              </p>
                              <button
                                type="button"
                                disabled={Boolean(stepActionPending)}
                                onClick={() =>
                                  void reviewStep(
                                    step,
                                    step.executor === "human" ? "human" : "output",
                                  )
                                }
                              >
                                Approve reviewed content and complete this step
                              </button>
                              {step.executor !== "human" && (
                                <button
                                  type="button"
                                  disabled={
                                    Boolean(stepActionPending) || !reviewNotes[step.id]?.trim()
                                  }
                                  onClick={() => void reviewStep(step, "reject")}
                                >
                                  Request revision (a new authorized attempt is required)
                                </button>
                              )}
                            </section>
                          )}
                          {step.agent_session_id &&
                            step.state === "RUNNING" &&
                            museJobs[step.agent_session_id]?.needs_ci_repair_retry && (
                              <section aria-label="CI repair made no changes">
                                <p>
                                  The repair turn changed no files. It did not fix the CI failure or
                                  update the PR.
                                </p>
                                <p>{museJobs[step.agent_session_id]?.repair_ci_report?.summary}</p>
                                <button
                                  type="button"
                                  disabled={Boolean(stepActionPending)}
                                  onClick={() => void inspectCi(step, true)}
                                >
                                  Authorize a fresh CI repair
                                </button>
                                <p>
                                  Then create and bind a fresh session and explicitly execute it.
                                  The finished turn and snapshot stay unchanged.
                                </p>
                              </section>
                            )}
                          {step.agent_session_id &&
                            museJobs[step.agent_session_id]?.delivery_state && (
                              <div role="status">
                                PR delivery: {museJobs[step.agent_session_id]?.delivery_state}
                                {museJobs[step.agent_session_id]?.delivery_state === "REQUESTED" &&
                                  " · Waiting for the local worker. Keep npm run muse:local:serve running for this project."}
                                {museJobs[step.agent_session_id]?.delivery_state === "RUNNING" &&
                                  " · Creating a branch, commit and pull request."}
                                {museJobs[step.agent_session_id]?.delivery_error && (
                                  <p role="alert">
                                    {museJobs[step.agent_session_id]?.delivery_error}
                                  </p>
                                )}
                              </div>
                            )}
                          {canRequestDelivery(
                            step,
                            step.agent_session_id ? museJobs[step.agent_session_id] : null,
                          ) && (
                            <section aria-label="Deliver generated changes">
                              <p>
                                Generated files:{" "}
                                {step.agent_session_id
                                  ? museJobs[step.agent_session_id]?.changed_paths?.join(", ")
                                  : ""}
                              </p>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={deliveryAcknowledgements[step.id] ?? false}
                                  onChange={(event) =>
                                    setDeliveryAcknowledgements((current) => ({
                                      ...current,
                                      [step.id]: event.target.checked,
                                    }))
                                  }
                                />
                                I reviewed the generated changes and authorize pushing them to
                                susanwere/private-test and opening a pull request.
                              </label>
                              <button
                                type="button"
                                disabled={
                                  Boolean(stepActionPending) || !deliveryAcknowledgements[step.id]
                                }
                                onClick={() => void requestDelivery(step)}
                              >
                                Push generated changes and create PR
                              </button>
                              <p>
                                Delivery does not complete the step. Review and merge the PR after
                                CI passes, then independently verify its GitHub Actions evidence
                                here.
                              </p>
                            </section>
                          )}
                          {step.agent_session_id &&
                            museJobs[step.agent_session_id]?.github_pull_number &&
                            museJobs[step.agent_session_id]?.github_repository && (
                              <div>
                                <a
                                  href={`https://github.com/${museJobs[step.agent_session_id]?.github_repository}/pull/${museJobs[step.agent_session_id]?.github_pull_number}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Review generated pull request
                                </a>
                                <p role="status">
                                  PR:{" "}
                                  {museJobs[step.agent_session_id]?.github_review_state ?? "DRAFT"}{" "}
                                  · CI:{" "}
                                  {museJobs[step.agent_session_id]?.github_ci_state ?? "WAITING"}
                                </p>
                                {museJobs[step.agent_session_id]?.github_review_error && (
                                  <p role="alert">
                                    {museJobs[step.agent_session_id]?.github_review_error}
                                  </p>
                                )}
                                {museJobs[step.agent_session_id]?.github_ci_report && (
                                  <section aria-label="CI diagnostics">
                                    <p>
                                      {museJobs[step.agent_session_id]?.github_ci_report?.summary}
                                    </p>
                                    <p>
                                      These are job and failed-step summaries. Open GitHub for full
                                      logs; raw logs and credentials are not sent to Muse.
                                    </p>
                                  </section>
                                )}
                                {step.state === "RUNNING" && (
                                  <button
                                    type="button"
                                    disabled={Boolean(stepActionPending)}
                                    onClick={() => void inspectCi(step)}
                                  >
                                    Check CI and failures
                                  </button>
                                )}
                                {step.state === "RUNNING" &&
                                  museJobs[step.agent_session_id]?.github_ci_state === "FAILED" && (
                                    <div>
                                      <p>
                                        Share these failure diagnostics with a fresh authorized Muse
                                        session. The existing response, snapshot and PR history are
                                        preserved; no model starts yet.
                                      </p>
                                      <button
                                        type="button"
                                        disabled={Boolean(stepActionPending)}
                                        onClick={() => void inspectCi(step, true)}
                                      >
                                        Authorize CI repair with Muse
                                      </button>
                                    </div>
                                  )}
                                <p>
                                  Delivered commit:{" "}
                                  <code>{museJobs[step.agent_session_id]?.github_head_sha}</code>
                                </p>
                                {museJobs[step.agent_session_id]?.github_ci_url &&
                                step.state === "COMPLETED" ? (
                                  <p>
                                    CI and merged PR independently verified by ORBIT.{" "}
                                    <a
                                      href={
                                        museJobs[step.agent_session_id]?.github_ci_url ?? undefined
                                      }
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      View GitHub Actions evidence (run{" "}
                                      {museJobs[step.agent_session_id]?.github_ci_run_id})
                                    </a>
                                  </p>
                                ) : (
                                  <p>
                                    CI has not been verified by ORBIT. After CI passes and the PR is
                                    merged, enter the CI run ID below.
                                  </p>
                                )}
                                {step.state !== "COMPLETED" && (
                                  <>
                                    <label htmlFor={`github-run-${step.id}`}>
                                      GitHub Actions run ID
                                    </label>
                                    <input
                                      id={`github-run-${step.id}`}
                                      type="number"
                                      min="1"
                                      step="1"
                                      value={githubRunIds[step.id] ?? ""}
                                      onChange={(event) =>
                                        setGithubRunIds((current) => ({
                                          ...current,
                                          [step.id]: event.target.value,
                                        }))
                                      }
                                      placeholder="From the Actions run URL"
                                    />
                                    <button
                                      type="button"
                                      disabled={
                                        Boolean(stepActionPending) || !githubRunIds[step.id]?.trim()
                                      }
                                      onClick={() => void verifyCi(step)}
                                    >
                                      Verify GitHub CI
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          {step.state === "FAILED" && (
                            <button
                              type="button"
                              disabled={Boolean(stepActionPending)}
                              onClick={() => void actOnStep(step, "retry")}
                            >
                              {stepActionPending === step.id
                                ? "Authorizing…"
                                : "Acknowledge failure & authorize retry"}
                            </button>
                          )}
                        </details>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            {executionSummary && <p role="status">{executionSummary}</p>}
            {executionNotice && <p role="status">{executionNotice}</p>}
            {executionError && (
              <p role="alert" className="intent-error">
                {executionError}
              </p>
            )}
          </div>
        )}

        <aside className="intent-repository" aria-label="Connected repositories">
          <h2>Repository</h2>
          {repositories.length ? (
            <ul>
              {repositories.map((repository) => (
                <li key={repository.id}>
                  <a href={repository.html_url} target="_blank" rel="noreferrer">
                    {repository.full_name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {repositoryError ? "Repository summary unavailable." : "No repository connected yet."}
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
