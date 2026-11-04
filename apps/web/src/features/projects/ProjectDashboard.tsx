import { useEffect, useState } from "react";
import type { CreatedProject, ProjectCreationApi, ProjectPage } from "./project-api.js";
import "./project-dashboard.css";

interface Props {
  readonly api: ProjectCreationApi;
  readonly onOpen: (project: CreatedProject) => void;
  readonly onCreate: () => void;
  readonly onHome: () => void;
}

const projectsPerPage = 6;
const visiblePageButtons = 4;
const projectBatchSize = projectsPerPage * visiblePageButtons;

export function ProjectDashboard({ api, onOpen, onCreate, onHome }: Props) {
  const [projectPages, setProjectPages] = useState<ProjectPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingNextPage, setIsLoadingNextPage] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [reloadAttempt, setReloadAttempt] = useState(0);

  useEffect(() => {
    let isActive = true;
    setIsLoading(true);
    setProjectError(null);
    setProjectPages([]);
    setPageIndex(0);
    void api.listProjects(projectBatchSize).then(
      (projectPage) => {
        if (!isActive) return;
        setProjectPages([projectPage]);
        setIsLoading(false);
      },
      (failure: unknown) => {
        if (!isActive) return;
        setProjectError(failure instanceof Error ? failure.message : "Could not load projects.");
        setIsLoading(false);
      },
    );
    return () => {
      isActive = false;
    };
  }, [api, reloadAttempt]);

  const loadedProjects = projectPages.flatMap((projectPage) => projectPage.projects);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingProjects = loadedProjects.filter((project) =>
    project.name.toLocaleLowerCase().includes(normalizedQuery),
  );
  const nextCursor = projectPages.at(-1)?.nextCursor;
  const knownPageCount = Math.max(1, Math.ceil(matchingProjects.length / projectsPerPage));
  const firstVisiblePageIndex = Math.max(
    0,
    Math.min(pageIndex - 1, knownPageCount - visiblePageButtons),
  );
  const visibleProjects = matchingProjects.slice(
    pageIndex * projectsPerPage,
    (pageIndex + 1) * projectsPerPage,
  );

  async function loadNextPage() {
    if (!nextCursor || isLoadingNextPage) return;
    setIsLoadingNextPage(true);
    setProjectError(null);
    try {
      const nextPage = await api.listProjects(projectBatchSize, nextCursor);
      const knownProjectIds = new Set(loadedProjects.map((project) => project.id));
      const additionalProjects = nextPage.projects.filter(
        (project) => !knownProjectIds.has(project.id),
      );
      setProjectPages((previousPages) => [
        ...previousPages,
        { ...nextPage, projects: additionalProjects },
      ]);
      if (!normalizedQuery && additionalProjects.length > 0) {
        const lastAvailablePage =
          Math.ceil((loadedProjects.length + additionalProjects.length) / projectsPerPage) - 1;
        setPageIndex(Math.min(pageIndex + 1, lastAvailablePage));
      }
    } catch (failure) {
      setProjectError(failure instanceof Error ? failure.message : "Could not load more projects.");
    } finally {
      setIsLoadingNextPage(false);
    }
  }

  return (
    <main className="project-dashboard" aria-labelledby="project-dashboard-heading">
      <div className="project-dashboard-orbit project-dashboard-orbit-left" aria-hidden="true">
        <i />
        <i />
      </div>
      <div className="project-dashboard-orbit project-dashboard-orbit-right" aria-hidden="true">
        <i />
      </div>
      <nav className="project-dashboard-topbar" aria-label="Workspace navigation">
        <button
          type="button"
          className="project-dashboard-home"
          onClick={onHome}
          aria-label="Orbit home"
        >
          <span className="project-dashboard-brand-mark" aria-hidden="true" />
          Orbit
        </button>
      </nav>
      <section className="project-dashboard-main">
        <header className="project-dashboard-header">
          <div className="project-dashboard-heading-row">
            <div>
              <h1 id="project-dashboard-heading">Projects</h1>
              <p>Plan, review, and execute software projects with AI agents and your team.</p>
            </div>
            <button className="project-dashboard-create" type="button" onClick={onCreate}>
              <span aria-hidden="true">＋</span> New project
            </button>
          </div>
        </header>
        {!isLoading && loadedProjects.length > 0 && (
          <div className="project-dashboard-toolbar">
            <label className="project-dashboard-search-wrap">
              <span className="project-dashboard-sr-only">Search projects</span>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <circle cx="10.5" cy="10.5" r="7.5" />
                <path d="m16 16 5 5" />
              </svg>
              <input
                type="search"
                disabled={isLoadingNextPage}
                className="project-dashboard-search"
                placeholder="Search projects…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPageIndex(0);
                }}
              />
            </label>
          </div>
        )}
        {isLoading && (
          <p className="project-dashboard-status" role="status">
            Loading projects…
          </p>
        )}
        {projectError && (
          <div role="alert" className="project-dashboard-error">
            {projectError}{" "}
            <button
              type="button"
              disabled={isLoadingNextPage}
              onClick={() => {
                if (projectPages.length) void loadNextPage();
                else setReloadAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!isLoading && !projectError && loadedProjects.length === 0 && (
          <div className="project-dashboard-empty">
            <h2>No projects yet</h2>
            <p>Create your first project and turn your intent into a reviewable plan.</p>
          </div>
        )}
        {!isLoading && loadedProjects.length > 0 && matchingProjects.length === 0 && (
          <p className="project-dashboard-status" role="status">
            No matching projects in the loaded results.
          </p>
        )}
        {loadedProjects.length > 0 && (
          <div className="project-dashboard-grid" aria-busy={isLoading || isLoadingNextPage}>
          {visibleProjects.map((project, projectIndex) => (
            <button
              type="button"
              className={`project-dashboard-card project-dashboard-card--${projectIndex % 3}`}
              key={project.id}
              onClick={() => onOpen(project)}
            >
              <span className="project-dashboard-card-mark" aria-hidden="true" />
              <span className="project-dashboard-card-copy">
                <strong>{project.name}</strong>
                <small>
                  Created{" "}
                  <time dateTime={project.created_at}>
                    {new Date(project.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                </small>
              </span>
              <span className="project-dashboard-card-link" aria-hidden="true">
                →
              </span>
            </button>
          ))}
          </div>
        )}
        {!isLoading && loadedProjects.length > 0 && (
          <>
            <nav className="project-dashboard-pagination" aria-label="Project pages">
              <button
                type="button"
                aria-label="Previous page"
                disabled={pageIndex === 0 || isLoadingNextPage}
                onClick={() => setPageIndex((previousIndex) => previousIndex - 1)}
              >
                ‹
              </button>
              {Array.from(
                { length: Math.min(visiblePageButtons, knownPageCount) },
                (_, pageButtonIndex) => {
                  const knownPageIndex = firstVisiblePageIndex + pageButtonIndex;
                  return (
                    <button
                      type="button"
                      key={knownPageIndex}
                      aria-label={`Page ${knownPageIndex + 1}`}
                      aria-current={pageIndex === knownPageIndex ? "page" : undefined}
                      disabled={isLoadingNextPage}
                      onClick={() => setPageIndex(knownPageIndex)}
                    >
                      {knownPageIndex + 1}
                    </button>
                  );
                },
              )}
              <button
                type="button"
                aria-label="Next page"
                disabled={
                  isLoadingNextPage ||
                  (pageIndex >= knownPageCount - 1 && (!nextCursor || Boolean(normalizedQuery)))
                }
                onClick={() => {
                  if (pageIndex < knownPageCount - 1)
                    setPageIndex((previousIndex) => previousIndex + 1);
                  else void loadNextPage();
                }}
              >
                ›
              </button>
            </nav>
            <p className="project-dashboard-page-status" role="status" aria-live="polite">
              Page {pageIndex + 1}
              {!nextCursor ? ` of ${knownPageCount}` : ""}
            </p>
            {isLoadingNextPage && (
              <p className="project-dashboard-status" role="status">
                Loading more projects…
              </p>
            )}
            {normalizedQuery && nextCursor && (
              <p className="project-dashboard-note">
                Search covers loaded projects.{" "}
                <button
                  type="button"
                  disabled={isLoadingNextPage}
                  onClick={() => {
                    void loadNextPage();
                  }}
                >
                  Load more projects
                </button>{" "}
                to expand results.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
