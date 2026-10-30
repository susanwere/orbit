import { useEffect, useState } from "react";
import type { CreatedProject, ProjectCreationApi } from "./project-api.js";
import "./project-dashboard.css";

interface Props {
  readonly api: ProjectCreationApi;
  readonly onOpen: (project: CreatedProject) => void;
  readonly onCreate: () => void;
  readonly onHome: () => void;
}

export function ProjectDashboard({ api, onOpen, onCreate, onHome }: Props) {
  const [projects, setProjects] = useState<CreatedProject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.listProjects().then(
      (page) => {
        if (cancelled) return;
        setProjects(page.projects);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : "Could not load projects.");
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.listProjects(25, cursor);
      setProjects((current) => {
        const seen = new Set(current.map((project) => project.id));
        return [...current, ...page.projects.filter((project) => !seen.has(project.id))];
      });
      setCursor(page.nextCursor);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load more projects.");
    } finally {
      setLoadingMore(false);
    }
  }
  const matches = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <main className="project-dashboard">
      <aside className="project-dashboard-sidebar" aria-label="Workspace navigation">
        <button
          type="button"
          className="project-dashboard-logo project-dashboard-home"
          onClick={onHome}
          aria-label="Orbit home"
        >
          ◈ Orbit
        </button>
        <button type="button" className="project-dashboard-home-link" onClick={onHome}>
          ⌂ &nbsp; Home
        </button>
        <span className="project-dashboard-current">▦ &nbsp; Projects</span>
        <p>Intent-led engineering, with humans in control.</p>
      </aside>
      <section className="project-dashboard-main" aria-labelledby="project-dashboard-heading">
        <header className="project-dashboard-header">
          <div>
            <p className="project-dashboard-eyebrow">YOUR WORKSPACE</p>
            <h1 id="project-dashboard-heading">Projects</h1>
            <p>Pick up where you left off or start something new.</p>
          </div>
          <button className="project-dashboard-create" type="button" onClick={onCreate}>
            + New project
          </button>
        </header>
        <label className="project-dashboard-search-label" htmlFor="project-search">
          Search projects
        </label>
        <input
          id="project-search"
          className="project-dashboard-search"
          placeholder="Search by project name…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading ? <p role="status">Loading projects…</p> : null}
        {error ? (
          <div role="alert" className="project-dashboard-error">
            {error}{" "}
            <button type="button" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : null}
        {!loading && !error && projects.length === 0 ? (
          <div className="project-dashboard-empty">
            <h2>No projects yet</h2>
            <p>
              Create your first project and Orbit will help turn your intent into a reviewable plan.
            </p>
            <button type="button" onClick={onCreate}>
              Create project
            </button>
          </div>
        ) : null}
        {!loading && matches.length === 0 && projects.length > 0 ? (
          <p role="status">No matching projects in the loaded results.</p>
        ) : null}
        <div className="project-dashboard-grid">
          {matches.map((project) => (
            <button
              type="button"
              className="project-dashboard-card"
              key={project.id}
              onClick={() => onOpen(project)}
            >
              <span className="project-dashboard-card-icon" aria-hidden="true">
                ◈
              </span>
              <strong>{project.name}</strong>
              <small>Created {new Date(project.created_at).toLocaleDateString()}</small>
              <span className="project-dashboard-card-link">Open project →</span>
            </button>
          ))}
        </div>
        {cursor && !loading ? (
          <button
            className="project-dashboard-more"
            type="button"
            disabled={loadingMore}
            onClick={() => {
              void more();
            }}
          >
            {loadingMore ? "Loading…" : "Load more projects"}
          </button>
        ) : null}
        {cursor && query ? (
          <p className="project-dashboard-note">
            Search currently covers loaded projects. Load more to expand results.
          </p>
        ) : null}
      </section>
    </main>
  );
}
