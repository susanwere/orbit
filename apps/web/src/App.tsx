import { useEffect, useState } from "react";
import { Landing } from "./Landing.js";
import { Universe } from "./Universe.js";
import { ProjectCreation } from "./features/projects/ProjectCreation.js";
import { ProjectDashboard } from "./features/projects/ProjectDashboard.js";
import { ProjectCanvas } from "./features/planning/ProjectCanvas.js";
import type { ProjectIntentApi } from "./features/intent/intent-api.js";
import type { CreatedProject, ProjectCreationApi } from "./features/projects/project-api.js";

import { projectNameFromPath, projectPath } from "./features/projects/project-navigation.js";

interface AppProps {
  /** Injected after authenticated session setup. Never pass tokens into components. */
  readonly projectApi?: ProjectCreationApi;
  readonly intentApi?: ProjectIntentApi;
}

export function App({ projectApi, intentApi }: AppProps) {
  const [page, setPage] = useState<"landing" | "dashboard" | "create" | "universe" | "project">(
    projectApi
      ? typeof window !== "undefined" && projectNameFromPath(window.location.pathname)
        ? "project"
        : typeof window !== "undefined" && window.location.pathname === "/new-project"
          ? "create"
          : "dashboard"
      : "landing",
  );
  const [activeProject, setActiveProject] = useState<CreatedProject | null>(null);
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const routeProjectName = projectNameFromPath(pathname);
  function navigate(nextPage: typeof page, nextPath: string) {
    if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath);
    setPathname(nextPath);
    setPage(nextPage);
    setProjectError(null);
  }
  function openProject(project: CreatedProject) {
    setActiveProject(project);
    navigate("project", projectPath(project));
  }
  useEffect(() => {
    if (!projectApi) return;
    const restoreNavigation = () => {
      const nextPath = window.location.pathname;
      setPathname(nextPath);
      setProjectError(null);
      setPage(
        projectNameFromPath(nextPath)
          ? "project"
          : nextPath === "/new-project"
            ? "create"
            : "dashboard",
      );
    };
    window.addEventListener("popstate", restoreNavigation);
    return () => window.removeEventListener("popstate", restoreNavigation);
  }, [projectApi]);
  useEffect(() => {
    if (
      !projectApi ||
      page !== "project" ||
      !routeProjectName ||
      activeProject?.name === routeProjectName
    )
      return;
    let active = true;
    setProjectError(null);
    void projectApi
      .getProjectByName(routeProjectName)
      .then((project) => {
        if (!active) return;
        setActiveProject(project);
        const canonicalPath = projectPath(project);
        window.history.replaceState(null, "", canonicalPath);
        setPathname(canonicalPath);
      })
      .catch((error: unknown) => {
        if (active)
          setProjectError(error instanceof Error ? error.message : "Could not open project.");
      });
    return () => {
      active = false;
    };
  }, [projectApi, page, routeProjectName, activeProject?.name, loadAttempt]);
  if (page === "project" && (!activeProject || activeProject.name !== routeProjectName)) {
    return (
      <main className="orbit-detail-page">
        {projectError ? (
          <>
            <p role="alert">{projectError}</p>
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              Retry
            </button>
          </>
        ) : (
          <p role="status">Loading project…</p>
        )}
        <button type="button" onClick={() => navigate("dashboard", "/projects")}>
          Back to projects
        </button>
      </main>
    );
  }

  if (page === "project" && activeProject && intentApi) {
    return (
      <ProjectCanvas
        key={activeProject.id}
        project={activeProject}
        api={intentApi}
        onBack={() => navigate("dashboard", "/projects")}
      />
    );
  }

  if (page === "dashboard" && projectApi) {
    return (
      <ProjectDashboard
        api={projectApi}
        onHome={() => navigate("landing", "/")}
        onCreate={() => navigate("create", "/new-project")}
        onOpen={openProject}
      />
    );
  }

  if (page === "universe") return <Universe onExit={() => setPage("landing")} />;

  if (page === "create" && projectApi) {
    return (
      <ProjectCreation
        api={projectApi}
        onCancel={() => navigate("dashboard", "/projects")}
        onCreated={openProject}
      />
    );
  }

  return (
    <Landing
      onEnter={() => (projectApi ? navigate("dashboard", "/projects") : setPage("universe"))}
    />
  );
}
