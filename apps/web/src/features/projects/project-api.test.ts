import { describe, expect, it, vi } from "vitest";
import { createProjectApi, ProjectApiError } from "./project-api.js";

describe("project API authorization handling", () => {
  it("reports an expired session and invalidates the authorization used for a 401", async () => {
    const onUnauthorized = vi.fn();
    const sendRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const projectApi = createProjectApi(
      "http://localhost:4000",
      () => "Bearer old-session",
      sendRequest,
      { onUnauthorized },
    );

    await expect(projectApi.createProject("HN Jobs Viewer")).rejects.toMatchObject({
      status: 401,
      message: "Your session has expired. Sign in again.",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith("Bearer old-session");
  });

  it("reports forbidden access without signing out a valid session", async () => {
    const onUnauthorized = vi.fn();
    const sendRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    const projectApi = createProjectApi(
      "http://localhost:4000",
      () => "Bearer valid-session",
      sendRequest,
      { onUnauthorized },
    );

    await expect(projectApi.createProject("HN Jobs Viewer")).rejects.toMatchObject({
      status: 403,
      message: "You do not have permission to access this project.",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("never sends a request without authorization", async () => {
    const sendRequest = vi.fn<typeof fetch>();
    const projectApi = createProjectApi("http://localhost:4000", () => undefined, sendRequest);

    await expect(projectApi.createProject("HN Jobs Viewer")).rejects.toBeInstanceOf(
      ProjectApiError,
    );
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("does not lose user-provided project data on network errors", async () => {
    const sendRequest = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const projectApi = createProjectApi(
      "http://localhost:4000",
      () => "Bearer valid-session",
      sendRequest,
    );

    await expect(projectApi.createProject("HN Jobs Viewer")).rejects.toMatchObject({
      status: 0,
      message: "Connection unavailable. Your changes have been preserved.",
    });
  });
});

describe("listing existing projects", () => {
  it("requests the organization-scoped list with pagination cursor and bearer token", async () => {
    const payload = {
      projects: [
        {
          id: "a",
          name: "Existing project",
          organization_id: "org",
          created_at: "2026-10-30T00:00:00Z",
        },
      ],
      nextCursor: "a",
    };
    const sendRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const api = createProjectApi("http://localhost:4000", () => "Bearer secret", sendRequest);
    await expect(api.listProjects(10, "cursor")).resolves.toEqual(payload);
    expect(sendRequest).toHaveBeenCalledWith(
      "http://localhost:4000/projects?limit=10&before=cursor",
      { headers: { Authorization: "Bearer secret" } },
    );
  });

  it("does not list projects without a session", async () => {
    const sendRequest = vi.fn<typeof fetch>();
    const api = createProjectApi("http://localhost:4000", () => undefined, sendRequest);
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401 });
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe("project name lookup", () => {
  it("encodes the name and uses an authenticated GET", async () => {
    const project = {
      id: "project-id",
      organization_id: "org",
      name: "My / Project",
      created_at: "2026-11-03",
    };
    const sendRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(project)));
    const api = createProjectApi("http://localhost:4000", () => "Bearer session", sendRequest);
    expect(await api.getProjectByName(project.name)).toEqual(project);
    expect(sendRequest).toHaveBeenCalledWith(
      "http://localhost:4000/projects/by-name/My%20%2F%20Project",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer session" }),
      }),
    );
  });
});
