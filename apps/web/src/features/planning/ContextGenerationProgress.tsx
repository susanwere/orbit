import type { KnowledgeGenerationActivity, KnowledgeGenerationStage } from "@orbit/domain";

interface ContextGenerationProgressProps {
  readonly repositoryCount: number;
  readonly documentCount: number;
  readonly hasIntent: boolean;
  readonly activity?: readonly KnowledgeGenerationActivity[];
}
const stages: readonly { stage: KnowledgeGenerationStage; title: string }[] = [
  { stage: "sources", title: "Loading original intent and sources" },
  { stage: "documents", title: "Reviewing supporting documents" },
  { stage: "repositories", title: "Reading repository evidence" },
  { stage: "summary", title: "Drafting project context summary" },
  { stage: "saving", title: "Saving a reviewable version" },
];

export function ContextGenerationProgress({
  repositoryCount,
  documentCount,
  hasIntent,
  activity = [],
}: ContextGenerationProgressProps) {
  const latestActivity = activity.at(-1);
  return (
    <>
      <div className="context-generation-card" aria-busy="true">
        <ol className="context-generation-steps" aria-label="Context generation status">
          {stages.map(({ stage, title }) => {
            const entries = activity.filter((entry) => entry.stage === stage);
            const completed = entries.some((entry) => entry.status === "completed");
            const active = entries.length > 0 && !completed;
            const state = completed ? "ready" : active ? "active" : "pending";
            return (
              <li key={stage} data-state={state}>
                <span className="context-generation-marker" aria-hidden="true">
                  {completed ? "✓" : active ? <i /> : null}
                </span>
                <div>
                  <strong>{title}</strong>
                  {active && <p>{entries.at(-1)?.message}</p>}
                </div>
                <span className="context-generation-badge">
                  {completed ? "Completed" : active ? "In progress" : "Pending"}
                </span>
              </li>
            );
          })}
        </ol>
        <div
          className="context-generation-progress"
          role="progressbar"
          aria-label="Generating project context summary"
          aria-valuetext="In progress"
        >
          <span />
        </div>
        <details className="context-activity-log" open>
          <summary>Activity log</summary>
          <p className="context-activity-sources">
            {repositoryCount} repositories · {documentCount} documents ·{" "}
            {hasIntent ? "Intent saved" : "No saved intent"}
          </p>
          {activity.length ? (
            <ol aria-label="Generation activity">
              {activity.slice(-12).map((entry, index) => (
                <li key={`${entry.occurredAt}-${index}`}>
                  <time dateTime={entry.occurredAt}>
                    {new Date(entry.occurredAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>Connecting to context generation…</p>
          )}
        </details>
        <p className="context-generation-live" role="status">
          {latestActivity?.message ?? "Connecting to context generation…"}
        </p>
      </div>
      <p className="context-generation-reassurance">
        <span aria-hidden="true">ⓘ</span> This creates a reviewable version. Nothing is approved
        automatically.
      </p>
    </>
  );
}
