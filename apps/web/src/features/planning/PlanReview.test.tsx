import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlanReview } from "./PlanReview.js";
import { createIntentApi } from "../intent/intent-api.js";

const project = {
  id: "project-1",
  organization_id: "org-1",
  name: "Canvas project",
  created_at: "2026-11-01T10:00:00Z",
};

describe("canvas composer visibility", () => {
  it("offers an editable unsaved draft only when there is no persisted plan", () => {
    const sendRequest = vi.fn<typeof fetch>();
    const markup = renderToStaticMarkup(
      <PlanReview
        project={project}
        originalIntent={null}
        plan={null}
        api={createIntentApi("http://localhost:4000", () => undefined, sendRequest)}
        onBack={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    expect(markup).toContain('id="canvas-project-idea"');
    expect(markup).toContain(
      "Add docs, specs, or context to help Muse Spark create a better plan.",
    );
    expect(markup).toContain('aria-label="Attach supporting documents"');
    expect(markup).toContain('accept=".pdf,.docx,.md,.txt"');
    expect(markup).toContain("Generate plan");
    expect(markup).not.toContain("Approve plan");
    expect(sendRequest).not.toHaveBeenCalled();
  });
  it("keeps the graph and review actions for a saved plan and does not show the composer", () => {
    const sendRequest = vi.fn<typeof fetch>();
    const markup = renderToStaticMarkup(
      <PlanReview
        project={project}
        originalIntent={null}
        plan={{
          id: "plan-1",
          project_id: project.id,
          original_intent_id: "intent-1",
          revision: 1,
          status: "READY_FOR_REVIEW",
          failure_reason: null,
          content: {
            summary: "A real saved plan",
            workItems: [
              {
                key: "WORK-1",
                title: "Build the app",
                description: "Build it",
                dependsOn: [],
                workflows: [],
              },
            ],
            guardrails: [],
            decisionsToReview: [],
            assumptions: [],
          },
        }}
        api={createIntentApi("http://localhost:4000", () => undefined, sendRequest)}
        onBack={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    expect(markup).not.toContain('id="canvas-project-idea"');
    expect(markup).toContain("Approve plan");
    expect(markup).toContain("Connected plan graph");
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe("saved intent lifecycle", () => {
  const savedIntent = {
    id: "intent-1",
    organization_id: project.organization_id,
    project_id: project.id,
    statement: "Build an accessible app",
    created_at: "2026-11-01T10:00:00Z",
  };
  it.each([null, "GENERATING", "FAILED"] as const)(
    "keeps the saved Original Intent node visible for planning state %s",
    (status) => {
      const markup = renderToStaticMarkup(
        <PlanReview
          project={project}
          originalIntent={savedIntent}
          plan={
            status
              ? {
                  id: "plan-1",
                  project_id: project.id,
                  original_intent_id: savedIntent.id,
                  revision: 1,
                  status,
                  failure_reason: status === "FAILED" ? "Provider temporarily unavailable" : null,
                  content: null,
                }
              : null
          }
          api={createIntentApi("http://localhost:4000", () => undefined)}
          onBack={() => undefined}
          onUpdated={() => undefined}
        />,
      );
      expect(markup).not.toContain('id="canvas-project-idea"');
      expect(markup).toContain("Original intent");
      expect(markup).toContain("Connected plan graph");
      expect(markup).not.toContain("Approve plan");
      if (status === "FAILED") {
        expect(markup).toContain("Provider temporarily unavailable");
        expect(markup).toContain("Retry planning");
      }
      if (status === "GENERATING") expect(markup).toContain("Check planning status");
    },
  );
  it("does not flash the composer while project state is loading", () => {
    const markup = renderToStaticMarkup(
      <PlanReview
        project={project}
        originalIntent={null}
        plan={null}
        isLoading
        api={createIntentApi("http://localhost:4000", () => undefined)}
        onBack={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    expect(markup).toContain("Loading workflow");
    expect(markup).not.toContain('id="canvas-project-idea"');
  });
});
