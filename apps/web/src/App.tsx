import { useState } from "react";
import { Landing } from "./Landing.js";
import { Universe } from "./Universe.js";
import { ProjectCreation } from "./features/projects/ProjectCreation.js";
import { ProjectEmptyState } from "./features/projects/ProjectEmptyState.js";
import type { CreatedProject, ProjectCreationApi } from "./features/projects/project-api.js";

interface AppProps {
  /** Injected after authenticated session setup. Never pass tokens into components. */
  readonly projectApi?: ProjectCreationApi;
}

export function App({ projectApi }: AppProps) {
  const [page, setPage] = useState<"landing" | "create" | "universe" | "project">("landing");
  const [activeProject, setActiveProject] = useState<CreatedProject | null>(null);

  if (page === "project" && activeProject) {
    return <ProjectEmptyState project={activeProject} onBack={() => setPage("landing")} />;
  }

  if (page === "universe") return <Universe onExit={() => setPage("landing")} />;

  if (page === "create" && projectApi) {
    return (
      <ProjectCreation
        api={projectApi}
        onCancel={() => setPage("landing")}
        onCreated={(project) => {
          setActiveProject(project);
          setPage("project");
        }}
      />
    );
  }

  return <Landing onEnter={() => setPage(projectApi ? "create" : "universe")} />;
}
