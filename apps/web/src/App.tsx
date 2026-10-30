import { useState } from "react";
import { Landing } from "./Landing.js";
import { Universe } from "./Universe.js";
import { ProjectCreation } from "./features/projects/ProjectCreation.js";
import { ProjectDashboard } from "./features/projects/ProjectDashboard.js";
import { IntentEntry } from "./features/intent/IntentEntry.js";
import type { ProjectIntentApi } from "./features/intent/intent-api.js";
import type { CreatedProject, ProjectCreationApi } from "./features/projects/project-api.js";

interface AppProps {
  /** Injected after authenticated session setup. Never pass tokens into components. */
  readonly projectApi?: ProjectCreationApi;
  readonly intentApi?: ProjectIntentApi;
}

export function App({ projectApi, intentApi }: AppProps) {
  const [page, setPage] = useState<"landing" | "dashboard" | "create" | "universe" | "project">(
    projectApi ? "dashboard" : "landing",
  );
  const [activeProject, setActiveProject] = useState<CreatedProject | null>(null);

  if (page === "project" && activeProject && intentApi) {
    return (
      <IntentEntry project={activeProject} api={intentApi} onBack={() => setPage("dashboard")} />
    );
  }

  if (page === "dashboard" && projectApi) {
    return (
      <ProjectDashboard
        api={projectApi}
        onHome={() => setPage("landing")}
        onCreate={() => setPage("create")}
        onOpen={(project) => {
          setActiveProject(project);
          setPage("project");
        }}
      />
    );
  }

  if (page === "universe") return <Universe onExit={() => setPage("landing")} />;

  if (page === "create" && projectApi) {
    return (
      <ProjectCreation
        api={projectApi}
        onCancel={() => setPage("dashboard")}
        onCreated={(project) => {
          setActiveProject(project);
          setPage("project");
        }}
      />
    );
  }

  return <Landing onEnter={() => setPage(projectApi ? "dashboard" : "universe")} />;
}
