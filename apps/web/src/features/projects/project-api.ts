/** ORB-23: typed project creation transport. Caller owns authentication (ORB-54). */
export interface CreatedProject {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly created_at: string;
}
export interface ProjectPage {
  readonly projects: CreatedProject[];
  readonly nextCursor: string | null;
}
export interface ConnectedRepository {
  readonly id: string;
  readonly project_id: string;
  readonly owner: string;
  readonly repo: string;
  readonly full_name: string;
  readonly html_url: string;
  readonly created_at: string;
}
export class ProjectApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}
export interface ProjectCreationApi {
  createProject(name: string): Promise<CreatedProject>;
  listProjects(limit?: number, before?: string): Promise<ProjectPage>;
  connectRepository(projectId: string, repository: string): Promise<ConnectedRepository>;
}
export interface ProjectApiOptions {
  readonly onUnauthorized?: (authorizationHeader: string) => void;
}

export function createProjectApi(
  baseUrl: string,
  getAuthorization: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
  options: ProjectApiOptions = {},
): ProjectCreationApi {
  const send = async <T>(path: string, body: Record<string, string>): Promise<T> => {
    const authorization = getAuthorization();
    if (!authorization) throw new ProjectApiError(401, "Sign in to create or connect a project.");
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, baseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProjectApiError(0, "Connection unavailable. Your changes have been preserved.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthorized?.(authorization);
        throw new ProjectApiError(401, "Your session has expired. Sign in again.");
      }
      if (response.status === 403) {
        throw new ProjectApiError(403, "You do not have permission to access this project.");
      }
      const payload: unknown = await response.json().catch(() => null);
      const message =
        payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
          ? payload.message
          : "Request failed. Please retry.";
      throw new ProjectApiError(response.status, message);
    }
    return (await response.json()) as T;
  };
  const listProjects = async (limit = 25, before?: string): Promise<ProjectPage> => {
    const authorization = getAuthorization();
    if (!authorization) throw new ProjectApiError(401, "Sign in to view projects.");
    const url = new URL("/projects", baseUrl);
    url.searchParams.set("limit", String(limit));
    if (before) url.searchParams.set("before", before);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { Authorization: authorization },
      });
    } catch {
      throw new ProjectApiError(0, "Connection unavailable. Retry loading projects.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthorized?.(authorization);
        throw new ProjectApiError(401, "Your session has expired. Sign in again.");
      }
      if (response.status === 403) {
        throw new ProjectApiError(403, "You do not have permission to view projects.");
      }
      throw new ProjectApiError(response.status, "Could not load projects. Please retry.");
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("projects" in payload) ||
        !Array.isArray(payload.projects) || !("nextCursor" in payload) ||
        !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
      throw new ProjectApiError(0, "Invalid project list response.");
    }
    return payload as ProjectPage;
  };
  return {
    listProjects,
    createProject: (name) => send<CreatedProject>("/projects", { name }),
    connectRepository: (id, repository) =>
      send<ConnectedRepository>(`/projects/${encodeURIComponent(id)}/repositories`, { repository }),
  };
}
