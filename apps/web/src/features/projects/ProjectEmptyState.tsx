import type { CreatedProject } from "./project-api.js";
import "./project-creation.css";

interface ProjectEmptyStateProps {
  readonly project: CreatedProject;
  readonly onBack: () => void;
}

/**
 * A freshly created project contains no implied work, decisions, designs or PRs.
 * Intent authoring is introduced in ORB-24, not simulated here.
 */
export function ProjectEmptyState({ project, onBack }: ProjectEmptyStateProps) {
  return (
    <main className="project-create-page">
      <section className="project-create-form" aria-labelledby="project-empty-heading">
        <p className="eyebrow">ORBIT / PROJECT CREATED</p>
        <h1 id="project-empty-heading">{project.name}</h1>
        <p role="status">Your project is ready. No work has started yet.</p>
        <p>
          Begin by describing what you want to build. Intent authoring will be available in the
          next step of Orbit.
        </p>
        <dl className="project-empty-facts">
          <div>
            <dt>Intent</dt>
            <dd>Not entered</dd>
          </div>
          <div>
            <dt>Work items</dt>
            <dd>None</dd>
          </div>
          <div>
            <dt>Designs</dt>
            <dd>None</dd>
          </div>
          <div>
            <dt>Pull requests</dt>
            <dd>None</dd>
          </div>
        </dl>
        <div className="project-create-actions">
          <button type="button" onClick={onBack}>
            Back to Orbit
          </button>
        </div>
      </section>
    </main>
  );
}
