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
  readonly state: string;
  readonly blocker_reason: string | null;
  readonly work_item_key: string;
  readonly workflow_index: number;
  readonly step_index: number;
  readonly approval_required: boolean;
  readonly approved_at: string | null;
  readonly agent_session_id: string | null;
}

export interface MuseJobStatus {
  readonly id: string;
  readonly status: string;
  readonly workflow_step_id: string;
  readonly attempts: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly failure_reason: string | null;
  readonly github_repository: string | null;
  readonly github_pull_number: number | null;
}

export interface ProjectIntentApi {
  getIntent(projectId: string): Promise<StoredIntent | null>;
  submitIntent(projectId: string, statement: string): Promise<StoredIntent>;
  getPlan(projectId: string): Promise<ProjectPlan | null>;
  generatePlan(projectId: string): Promise<ProjectPlan>;
  updatePlan(projectId: string, expectedRevision: number, content: unknown): Promise<ProjectPlan>;
  approvePlan(projectId: string, expectedRevision: number): Promise<ProjectPlan>;
  getRepositories(projectId: string): Promise<readonly ConnectedRepository[]>;
  prepareExecution(projectId: string): Promise<unknown>;
  getExecutionSteps(projectId: string): Promise<readonly ExecutionStep[]>;
  getApprovedAgents(projectId: string): Promise<readonly ApprovedAgent[]>;
  onboardMuse(projectId: string, repository: string): Promise<void>;
  approveExecutionStep(projectId: string, stepId: string): Promise<void>;
  authorizeExecutionRetry(projectId: string, stepId: string): Promise<void>;
  createAgentSession(
    projectId: string,
    definitionId: string,
    workItemId: string,
    mission: string,
  ): Promise<string>;
  bindExecutionSession(projectId: string, stepId: string, sessionId: string): Promise<void>;
  startAgentSession(projectId: string, sessionId: string): Promise<void>;
  dispatchMuse(projectId: string, sessionId: string): Promise<void>;
  getMuseJob(projectId: string, sessionId: string): Promise<MuseJobStatus | null>;
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
    submitIntent: async (id, statement) =>
      (await request<{ intent: StoredIntent }>(`${path(id)}/intent`, "POST", { statement })).intent,
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
    prepareExecution: async (id) => request<unknown>(`${path(id)}/execution/prepare`, "POST"),
    onboardMuse: async (id, repository) => {
      await request(path(id) + "/approved-agents/muse", "POST", { repository, approved: true });
    },
    getApprovedAgents: async (id) =>
      (await request<{ agents: ApprovedAgent[] }>(`${path(id)}/approved-agents`)).agents,
    getExecutionSteps: async (id) =>
      (await request<{ steps: ExecutionStep[] }>(`${path(id)}/execution/steps`)).steps,
    approveExecutionStep: async (id, stepId) => {
      await request(`${path(id)}/execution/steps/${encodeURIComponent(stepId)}/approve`, "POST");
    },
    authorizeExecutionRetry: async (id, stepId) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/authorize-retry`,
        "POST",
        { acknowledgeFailedAttempt: true },
      );
    },
    createAgentSession: async (id, agentDefinitionId, workItemId, mission) =>
      (
        await request<{ session: { id: string } }>(`${path(id)}/agent-sessions/self`, "POST", {
          agentDefinitionId,
          workItemId,
          mission,
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
      );
    },
    getMuseJob: async (id, sessionId) =>
      (
        await request<{ job: MuseJobStatus | null }>(
          `${path(id)}/agent-sessions/${encodeURIComponent(sessionId)}/muse-job`,
        )
      ).job,
    verifyGithubCi: async (id, stepId, repository, runId, pullNumber) => {
      await request(
        `${path(id)}/execution/steps/${encodeURIComponent(stepId)}/verify-github-ci`,
        "POST",
        { repository, runId, pullNumber },
      );
    },
    getRepositories: async (id) =>
      (await request<{ repositories: ConnectedRepository[] }>(`${path(id)}/repositories`))
        .repositories,
  };
}
