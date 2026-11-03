import type { KnowledgeArchitecture } from "@orbit/domain";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import { ContextIcon } from "./ProjectContextEmptyState.js";

export function ProjectArchitectureEvidence({
  snapshot,
  architecture = snapshot.content.summary.architectureDetails,
}: {
  readonly snapshot: ProjectKnowledgeSnapshot;
  readonly architecture?: KnowledgeArchitecture | null;
}) {
  const matches = snapshot.content.repositories.flatMap((repository) =>
    repository.inspected.map((path) => ({ repository, path })),
  );
  return (
    <>
      <section className="context-evidence-card">
        <h3>
          <ContextIcon kind="layers" />
          Architecture at a Glance
        </h3>
        {architecture?.facts.length ? (
          <dl className="context-project-details">
            {architecture.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.description}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="context-review-muted">
            Structured architecture facts are not available in this version. The saved architecture
            description is shown in the main panel.
          </p>
        )}
      </section>
      <section className="context-evidence-card">
        <h3>
          <ContextIcon kind="history" />
          Data Flow
        </h3>
        {architecture?.dataFlow.length ? (
          <ol className="context-data-flow">
            {architecture.dataFlow.map((step, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        ) : (
          <p className="context-review-muted">
            No verified data flow was recorded in this version.
          </p>
        )}
      </section>
      <section className="context-evidence-card">
        <h3>
          <ContextIcon kind="documents" />
          Related Evidence
        </h3>
        {matches.length ? (
          <ul className="context-related-evidence">
            {matches.map(({ repository, path }) => (
              <li key={`${repository.fullName}/${path}`}>
                <a
                  href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}/blob/${encodeURIComponent(repository.commitSha ?? "HEAD")}/${path.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {path} ↗
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="context-review-muted">No matching inspected source paths are available.</p>
        )}
      </section>
    </>
  );
}
