import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextGenerationProgress } from "./ContextGenerationProgress.js";

describe("context generation progress", () => {
  it("waits for backend events instead of inventing completed analysis", () => {
    const markup = renderToStaticMarkup(
      <ContextGenerationProgress repositoryCount={1} documentCount={2} hasIntent />,
    );
    expect(markup).toContain("1 repositories · 2 documents · Intent saved");
    expect(markup).toContain("Connecting to context generation…");
    expect(markup).toContain('role="progressbar"');
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).not.toContain("Completed");
  });
  it("shows completed and active stages only from real timestamped events", () => {
    const markup = renderToStaticMarkup(
      <ContextGenerationProgress
        repositoryCount={0}
        documentCount={0}
        hasIntent={false}
        activity={[
          {
            stage: "sources",
            status: "completed",
            message: "Source list loaded.",
            occurredAt: "2026-11-03T10:00:00Z",
          },
          {
            stage: "documents",
            status: "started",
            message: "Reading requirements.pdf.",
            occurredAt: "2026-11-03T10:00:01Z",
          },
        ]}
      />,
    );
    expect(markup).toContain("Completed");
    expect(markup).toContain("In progress");
    expect(markup).toContain("Pending");
    expect(markup).toContain("Reading requirements.pdf.");
    expect(markup).toContain('dateTime="2026-11-03T10:00:01Z"');
    expect(markup).toContain("Nothing is approved automatically");
  });
});
