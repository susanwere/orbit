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

export interface WorkflowExecutionStep {
  readonly id: string;
  readonly work_item_key: string;
  readonly workflow_index: number;
  readonly step_index: number;
  readonly state: string;
  readonly blocker_reason: string | null;
  readonly agent_session_id: string | null;
}

export interface ProjectIntentApi {
  getIntent(projectId: string): Promise<StoredIntent | null>;
  submitIntent(projectId: string, statement: string): Promise<StoredIntent>;
  getPlan(projectId: string): Promise<ProjectPlan | null>;
  generatePlan(projectId: string): Promise<ProjectPlan>;
  updatePlan(projectId: string, expectedRevision: number, content: unknown): Promise<ProjectPlan>;
  approvePlan(projectId: string, expectedRevision: number): Promise<ProjectPlan>;
  getRepositories(projectId: string): Promise<readonly ConnectedRepository[]>;
  getExecutionSteps(projectId: string): Promise<readonly WorkflowExecutionStep[]>;
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
    getExecutionSteps: async (id) =>
      (await request<{ steps: WorkflowExecutionStep[] }>(`${path(id)}/execution/steps`)).steps,
    getRepositories: async (id) =>
      (await request<{ repositories: ConnectedRepository[] }>(`${path(id)}/repositories`))
        .repositories,
  };
}
