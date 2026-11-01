import "./project-dashboard.css";
import "./project-creation.css";
import { useState, type FormEvent } from "react";
import type { CreatedProject, ProjectCreationApi } from "./project-api.js";
import { ProjectApiError } from "./project-api.js";

interface ProjectCreationProps {
  readonly api: ProjectCreationApi;
  readonly onCreated: (project: CreatedProject) => void;
  readonly onCancel?: () => void;
}
/**
 * A project can be created without GitHub. Repository registration is a separate
 * mutation; failure does not discard the newly created project or form data.
 */
export function ProjectCreation({ api, onCreated, onCancel }: ProjectCreationProps) {
  const [projectName, setProjectName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [creationPhase, setCreationPhase] = useState<"idle" | "creating" | "connecting" | "error">(
    "idle",
  );
  const [creationError, setCreationError] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(null);
  const isSubmitting = creationPhase === "creating" || creationPhase === "connecting";
  async function handleProjectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const trimmedProjectName = projectName.trim();
    if (!trimmedProjectName) {
      setCreationError("Enter a project name.");
      return;
    }
    setCreationError(null);
    let project = createdProject;
    if (!project) {
      setCreationPhase("creating");
      try {
        project = await api.createProject(trimmedProjectName);
        setCreatedProject(project);
      } catch (creationFailure) {
        setCreationError(
          creationFailure instanceof ProjectApiError
            ? creationFailure.message
            : "Project creation failed.",
        );
        setCreationPhase("error");
        return;
      }
    }
    if (repositoryUrl.trim()) {
      setCreationPhase("connecting");
      try {
        await api.connectRepository(project.id, repositoryUrl.trim());
      } catch (connectionFailure) {
        setCreationError(
          (connectionFailure instanceof ProjectApiError
            ? connectionFailure.message
            : "Repository connection failed.") +
            " Your project was saved. Retry to connect its repository.",
        );
        setCreationPhase("error");
        return;
      }
    }
    setCreationPhase("idle");
    onCreated(project);
  }
  return (
    <main className="project-setup-page" aria-labelledby="create-project-heading">
      <div className="project-dashboard-orbit project-dashboard-orbit-left" aria-hidden="true">
        <i />
        <i />
      </div>
      <div className="project-dashboard-orbit project-dashboard-orbit-right" aria-hidden="true">
        <i />
      </div>
      <nav className="project-dashboard-topbar" aria-label="Project setup navigation">
        <button
          type="button"
          className="project-dashboard-home"
          onClick={onCancel}
          disabled={!onCancel || isSubmitting}
          aria-label="Back to projects"
        >
          <span className="project-dashboard-brand-mark" aria-hidden="true" />
          Orbit
        </button>
      </nav>
      <div className="project-setup-layout">
        <section className="project-setup-intro">
          <h1 id="create-project-heading">
            Start with
            <br /> intent.
          </h1>
          <p>Give the project a name. Connecting an existing GitHub repository is optional.</p>
          <ul className="project-setup-benefits">
            <li>
              <span className="project-setup-benefit-icon" aria-hidden="true">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 32 32"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                >
                  <path d="M18 2 4 19h10l-1 11 15-18H18l2-10Z" />
                </svg>
              </span>
              <strong>Turn ideas into projects</strong>
            </li>
            <li>
              <span className="project-setup-benefit-icon">
                <GitHubMark />
              </span>
              <div>
                <strong>Link a GitHub repository</strong>
                <p>Keep code, context, and evidence in sync.</p>
              </div>
            </li>
          </ul>
        </section>
        <form
          onSubmit={(event) => {
            void handleProjectSubmit(event);
          }}
          className="project-setup-form"
          aria-label="Create a project"
          aria-busy={isSubmitting}
        >
          <div className="project-setup-field">
            <label htmlFor="orbit-project-name">Project name</label>
            <input
              id="orbit-project-name"
              autoFocus
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={120}
              required
              disabled={Boolean(createdProject) || isSubmitting}
              placeholder="e.g. Open Jobs Viewer"
            />
          </div>
          <div className="project-setup-field">
            <label htmlFor="orbit-project-repo">
              GitHub repository <span>(optional)</span>
            </label>
            <div className="project-setup-repository">
              <span className="project-setup-repository-icon">
                <GitHubMark />
              </span>
              <input
                id="orbit-project-repo"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="owner/repository or https://github.com/owner/repository"
                disabled={isSubmitting}
                aria-describedby="project-repository-help"
                spellCheck={false}
                autoCapitalize="none"
              />
            </div>
          </div>
          <p id="project-repository-help" className="project-setup-help">
            <span aria-hidden="true">ⓘ</span> An empty project is valid. Repositories can be
            connected later.
          </p>
          {createdProject && (
            <p role="status" className="project-setup-status">
              Project saved. You can finish or retry connecting its repository.
            </p>
          )}
          {creationError && (
            <p role="alert" className="project-setup-error">
              {creationError}
            </p>
          )}
          <div className="project-setup-actions">
            {onCancel && (
              <button type="button" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </button>
            )}
            <button type="submit" className="project-setup-submit" disabled={isSubmitting}>
              {creationPhase === "creating"
                ? "Creating…"
                : creationPhase === "connecting"
                  ? "Connecting repository…"
                  : createdProject
                    ? "Continue"
                    : "Create project"}
            </button>
            {createdProject && (
              <button
                type="button"
                onClick={() => onCreated(createdProject)}
                disabled={isSubmitting}
              >
                Continue without repository
              </button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.58 9.58 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}
