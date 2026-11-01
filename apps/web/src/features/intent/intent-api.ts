import { ProjectApiError, type ConnectedRepository } from "../projects/project-api.js";

export interface StoredIntent {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly statement: string;
  readonly created_at: string;
}

export interface ProjectPlan {
  readonly id: string;
  readonly project_id: string;
  readonly original_intent_id: string;
  readonly revision: number;
  readonly status: "GENERATING" | "FAILED" | "READY_FOR_REVIEW" | "APPROVED";
  readonly failure_reason: string | null;
  readonly content: unknown;
}

export interface ApprovedAgent {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly version: number;
}

export interface ExecutionStep {
  readonly id: string;
  readonly plan_id?: string;
  readonly plan_revision?: number;
  readonly executor?: "agent" | "human" | "system";
  readonly title?: string;
  readonly completion_kind?: "github_ci" | "human_review";
  readonly state: string;
  readonly blocker_reason: string | null;
  readonly work_item_key: string;
  readonly workflow_index: number;
  readonly step_index: number;
  readonly approval_required: boolean;
  readonly approved_at: string | null;
  readonly agent_session_id: string | null;
  readonly ci_repair_source_job_id?: string | null;
}

export interface MuseJobStatus {
  readonly id: string;
  readonly status: string;
  readonly workflow_step_id: string;
  readonly local_execution_state?:
    | "REQUESTED"
    | "PREPARING"
    | "RUNNING"
    | "FINISHED"
    | "ERROR"
    | null;
  readonly local_execution_error?: string | null;
  readonly needs_revision_replacement?: boolean;
  readonly needs_ci_repair_retry?: boolean;
  readonly repair_source_job_id?: string | null;
  readonly context_snapshot_id?: string | null;
  readonly repair_repository?: string | null;
  readonly repair_pull_number?: number | null;
  readonly repair_base_sha?: string | null;
  readonly repair_ci_report?: { summary: string } | null;
  readonly review_output?: string | null;
  readonly output_hash?: string | null;
  readonly output_source?: string | null;
  readonly changed_paths?: readonly string[] | null;
  readonly attempts: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly failure_reason: string | null;
  readonly delivery_state?: "REQUESTED" | "RUNNING" | "FINISHED" | "ERROR" | null;
  readonly delivery_error?: string | null;
  readonly github_head_sha?: string | null;
  readonly github_ci_state?: "WAITING" | "PENDING" | "FAILED" | "PASSED" | null;
  readonly github_review_state?: "DRAFT" | "READY" | "ERROR" | null;
  readonly github_review_error?: string | null;
  readonly github_ci_report?: {
    summary: string;
    runs: readonly {
      id: number;
      name: string;
      conclusion: string | null;
      url: string;
      failures: readonly string[];
    }[];
  } | null;
  readonly github_ci_url?: string | null;
  readonly github_ci_run_id?: string | null;
  readonly github_repository: string | null;
  readonly github_pull_number: number | null;
}

export type ProjectTaskState =
  | "DRAFT"
  | "STARTING"
  | "ACTIVE"
  | "NEEDS_INPUT"
  | "IN_REVIEW"
  | "DONE"
  | "FAILED";

export interface ProjectTask {
  readonly id: string;
  readonly task_key: string;
  readonly title: string;
  readonly prompt: string;
  readonly revision: number;
  readonly state: ProjectTaskState;
  readonly display_state?: ProjectTaskState;
  readonly session_id?: string | null;
  readonly dependency_keys?: readonly string[];
  readonly blocked_by?: readonly string[] | null;
  readonly automatic_repairs?: number;
  readonly last_error?: string | null;
  readonly github_repository?: string | null;
  readonly github_pull_number?: number | null;
  readonly github_ci_state?: string | null;
  readonly github_review_state?: string | null;
  readonly delivery_state?: string | null;
  readonly has_human_executor?: boolean;
  readonly has_agent_executor?: boolean;
}

export interface ProjectKnowledgeSummary {
  summary: string;
  architecture: string;
  features: string[];
  constraints: string[];
  unknowns: string[];
}
export interface ProjectKnowledgeSnapshot {
  id: string;
  revision: number;
  created_at: string;
  content: {
    summary: ProjectKnowledgeSummary;
    documents: { id: string; filename: string; version: number; sha256: string; summary: ProjectKnowledgeSummary }[];
    repositories: { fullName: string; inspected: boolean; summary: ProjectKnowledgeSummary | null }[];
  };
}
export interface ProjectIntentApi {
  getProjectKnowledge(projectId: string): Promise<readonly ProjectKnowledgeSnapshot[]>;
  refreshProjectKnowledge(projectId: string): Promise<ProjectKnowledgeSnapshot>;
  getIntent(projectId: string): Promise<StoredIntent | null>;
  getTasks(projectId: string): Promise<readonly ProjectTask[]>;
  updateTask(
    projectId: string,
    taskId: string,
    revision: number,
    title: string,
    prompt: string,
  ): Promise<ProjectTask>;
  addTask(
    projectId: string,
    request: string,
  ): Promise<{ existingTaskId: string | null; task: ProjectTask | null }>;
  executeTask(projectId: string, taskId: string, agentDefinitionId: string): Promise<void>;
  approveTaskProposal(projectId: string, taskId: string, note?: string): Promise<ProjectTask>;
  uploadDocument(
    projectId: string,
    file: { filename: string; mediaType: string; base64: string },
  ): Promise<{ id: string; original_filename: string }>;
  getProjectDocuments(projectId: string): Promise<
    readonly {
      id: string;
      original_filename: string;
      media_type: string;
      size_bytes: number;
      version: number;
      processing_status: string;
      created_at: string;
    }[]
  >;
  getIntentDocuments(
    projectId: string,
  ): Promise<
    readonly { id: string; original_filename: string; media_type: string; size_bytes: number }[]
  >;
  submitIntent(
    projectId: string,
    statement: string,
    documentIds?: readonly string[],
  ): Promise<StoredIntent>;
  getPlan(projectId: string): Promise<ProjectPlan | null>;
  generatePlan(projectId: string): Promise<ProjectPlan>;
  updatePlan(projectId: string, expectedRevision: number, content: unknown): Promise<ProjectPlan>;
  approvePlan(projectId: string, expectedRevision: number): Promise<ProjectPlan>;
  connectRepository(projectId: string, repository: string): Promise<ConnectedRepository>;
  getRepositories(projectId: string): Promise<readonly ConnectedRepository[]>;
  authorizeProposalReview(projectId: string, stepId: string): Promise<void>;
  reviewOutput(
    projectId: string,
    stepId: string,
    outputHash: string,
    note?: string,
    decision?: "approve" | "reject",
  ): Promise<void>;
  completeHumanReview(projectId: string, stepId: string, note?: string): Promise<void>;
  prepareExecution(projectId: string): Promise<unknown>;
  getExecutionSteps(projectId: string): Promise<readonly ExecutionStep[]>;
  getApprovedAgents(projectId: string): Promise<readonly ApprovedAgent[]>;
  onboardMuse(projectId: string, repository: string): Promise<void>;
  approveExecutionStep(projectId: string, stepId: string): Promise<void>;
  retireUnstartedJob(projectId: string, stepId: string, jobId: string): Promise<void>;
  requestDelivery(
    projectId: string,
    stepId: string,
    jobId: string,
    outputHash: string,
  ): Promise<void>;
  authorizeExecutionRetry(projectId: string, stepId: string): Promise<void>;
  createAgentSession(
    projectId: string,
    definitionId: string,
    workItemId: string,
    mission: string,
    repairSourceJobId?: string,
  ): Promise<string>;
  bindExecutionSession(projectId: string, stepId: string, sessionId: string): Promise<void>;
  startAgentSession(projectId: string, sessionId: string): Promise<void>;
  dispatchMuse(projectId: string, sessionId: string): Promise<void>;
  getMuseJob(projectId: string, sessionId: string): Promise<MuseJobStatus | null>;
  inspectGithubCi(projectId: string, stepId: string, jobId: string): Promise<void>;
  prepareCiRepair(projectId: string, stepId: string, jobId: string): Promise<void>;
  verifyGithubCi(
    projectId: string,
    stepId: string,
    repository: string,
    runId: number,
    pullNumber: number,
  ): Promise<void>;
}

export interface ProjectIntentApiOptions {
  readonly onUnauthorized?: (authorizationHeader: string) => void;
}

export function createIntentApi(
  baseUrl: string,
  getAuthorization: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
  options: ProjectIntentApiOptions = {},
): ProjectIntentApi {
  async function request<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
    const authorization = getAuthorization();
    if (!authorization) throw new ProjectApiError(401, "Sign in to manage your project.");
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, baseUrl).toString(), {
        method,
        headers: {
          Authorization: authorization,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new ProjectApiError(0, "Connection unavailable. Your intent has been preserved.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthorized?.(authorization);
        throw new ProjectApiError(401, "Your session has expired. Sign in again.");
      }
      if (response.status === 403) {
        throw new ProjectApiError(403, "You do not have permission to access this project.");
      }
      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : "Request failed. Try again.";
      throw new ProjectApiError(response.status, message);
    }
    return (await response.json()) as T;
  }

  const path = (id: string) => `/projects/${encodeURIComponent(id)}`;
  return {
    getIntent: async (id) =>
      (await request<{ intent: StoredIntent | null }>(`${path(id)}/intent`)).intent,
    uploadDocument: (id, file) =>
      request<{ id: string; original_filename: string }>(`${path(id)}/documents`, "POST", file),
    getProjectKnowledge: async (id) =>
      (await request<{ snapshots: ProjectKnowledgeSnapshot[] }>(`${path(id)}/knowledge`)).snapshots,
    refreshProjectKnowledge: async (id) =>
      (await request<{ snapshot: ProjectKnowledgeSnapshot }>(`${path(id)}/knowledge/refresh`, "POST")).snapshot,
    getProjectDocuments: async (id) =>
      (
        await request<{
          documents: {
            id: string;
            original_filename: string;
            media_type: string;
            size_bytes: number;
            version: number;
            processing_status: string;
            created_at: string;
          }[];
        }>(`${path(id)}/documents`)
      ).documents,
    getIntentDocuments: async (id) =>
      (
        await request<{
          documents: {
            id: string;
            original_filename: string;
            media_type: string;
            size_bytes: number;
          }[];
        }>(`${path(id)}/intent/documents`)
      ).documents,
    submitIntent: async (id, statement, documentIds = []) =>
      (
        await request<{ intent: StoredIntent }>(`${path(id)}/intent`, "POST", {
          statement,
          ...(documentIds.length ? { documentIds } : {}),
        })
      ).intent,
    getPlan: async (id) => (await request<{ plan: ProjectPlan | null }>(`${path(id)}/plan`)).plan,
    generatePlan: async (id) =>
      (await request<{ plan: ProjectPlan }>(`${path(id)}/plan`, "POST")).plan,
    updatePlan: async (id, expectedRevision, content) =>
      (
        await request<{ plan: ProjectPlan }>(`${path(id)}/plan`, "PATCH", {
          expectedRevision,
          content,
        })
      ).plan,
    approvePlan: async (id, expectedRevision) =>
      (
        await request<{ plan: ProjectPlan }>(`${path(id)}/plan/approve`, "POST", {
          expectedRevision,
        })
      ).plan,
    authorizeProposalReview: async (id, stepId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/authorize-proposal-review`,
        "POST",
        { acknowledgeNonCodeStep: true },
      );
    },
    requestDelivery: async (id, stepId, jobId, outputHash) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/request-delivery`,
        "POST",
        { jobId, outputHash, acknowledgePush: true },
      );
    },
    reviewOutput: async (id, stepId, outputHash, note, decision) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/review-output`,
        "POST",
        { outputHash, note, ...(decision ? { decision } : {}) },
      );
    },
    completeHumanReview: async (id, stepId, note) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/complete-human-review`,
        "POST",
        { note },
      );
    },
    prepareExecution: async (id) => request<unknown>(`${path(id)}/execution/prepare`, "POST"),
    onboardMuse: async (id, repository) => {
      await request(path(id) + "/approved-agents/muse", "POST", { repository, approved: true });
    },
    getApprovedAgents: async (id) =>
      (await request<{ agents: ApprovedAgent[] }>(`${path(id)}/approved-agents`)).agents,
    getExecutionSteps: async (id) =>
      (await request<{ steps: ExecutionStep[] }>(`${path(id)}/execution/steps`)).steps,
    getTasks: async (id) => (await request<{ tasks: ProjectTask[] }>(`${path(id)}/tasks`)).tasks,
    updateTask: async (id, taskId, revision, title, prompt) =>
      (
        await request<{ task: ProjectTask }>(
          `${path(id)}/tasks/${encodeURIComponent(taskId)}`,
          "PATCH",
          { revision, title, prompt },
        )
      ).task,
    addTask: async (id, taskRequest) =>
      request<{ existingTaskId: string | null; task: ProjectTask | null }>(
        `${path(id)}/tasks`,
        "POST",
        { request: taskRequest },
      ),
    executeTask: async (id, taskId, agentDefinitionId) => {
      await request(`${path(id)}/tasks/${encodeURIComponent(taskId)}/execute`, "POST", {
        agentDefinitionId,
      });
    },
    approveTaskProposal: async (id, taskId, note) =>
      (
        await request<{ task: ProjectTask }>(
          `${path(id)}/tasks/${encodeURIComponent(taskId)}/approve-proposal`,
          "POST",
          { note },
        )
      ).task,
    approveExecutionStep: async (id, stepId) => {
      await request(`${path(id)}/execution/steps/${encodeURIComponent(stepId)}/approve`, "POST");
    },
    retireUnstartedJob: async (id, stepId, jobId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/retire-unstarted-job`,
        "POST",
        { jobId, acknowledgeReplacement: true },
      );
    },
    authorizeExecutionRetry: async (id, stepId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/authorize-retry`,
        "POST",
        { acknowledgeFailedAttempt: true },
      );
    },
    createAgentSession: async (id, agentDefinitionId, workItemId, mission, repairSourceJobId) =>
      (
        await request<{ session: { id: string } }>(`${path(id)}/agent-sessions/self`, "POST", {
          agentDefinitionId,
          workItemId,
          mission,
          repairSourceJobId,
        })
      ).session.id,
    bindExecutionSession: async (id, stepId, sessionId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/bind-session`,
        "POST",
        { sessionId },
      );
    },
    startAgentSession: async (id, sessionId) => {
      await request(`${path(id)}/agent-sessions/${encodeURIComponent(sessionId)}/start`, "POST");
    },
    dispatchMuse: async (id, sessionId) => {
      await request(
        `${path(id)}/agent-sessions/${encodeURIComponent(sessionId)}/dispatch-muse`,
        "POST",
        { executeLocally: true },
      );
    },
    getMuseJob: async (id, sessionId) =>
      (
        await request<{ job: MuseJobStatus | null }>(
          `${path(id)}/agent-sessions/${encodeURIComponent(sessionId)}/muse-job`,
        )
      ).job,
    inspectGithubCi: async (id, stepId, jobId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/inspect-github-ci`,
        "POST",
        { jobId },
      );
    },
    prepareCiRepair: async (id, stepId, jobId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/prepare-ci-repair`,
        "POST",
        { jobId, acknowledgeRepair: true },
      );
    },
    verifyGithubCi: async (id, stepId, repository, runId, pullNumber) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/verify-github-ci`,
        "POST",
        { repository, runId, pullNumber },
      );
    },
    connectRepository: async (id, repository) =>
      request<ConnectedRepository>(`${path(id)}/repositories`, "POST", { repository }),
    getRepositories: async (id) =>
      (await request<{ repositories: ConnectedRepository[] }>(`${path(id)}/repositories`))
        .repositories,
  };
}
