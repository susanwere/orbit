/** ORB-23: typed project creation transport. Caller owns authentication (ORB-54). */
export interface CreatedProject {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly created_at: string;
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
  connectRepository(projectId: string, repository: string): Promise<ConnectedRepository>;
}
export function createProjectApi(
  baseUrl: string,
  getAuthorization: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
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
  return {
    createProject: (name) => send<CreatedProject>("/projects", { name }),
    connectRepository: (id, repository) =>
      send<ConnectedRepository>(`/projects/${encodeURIComponent(id)}/repositories`, { repository }),
  };
}
