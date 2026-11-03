import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanSection } from "./PlanSection.js";

const graph = {
  summary: "Build an accessible jobs viewer",
  workItems: [],
  guardrails: ["Keep keyboard navigation"],
  decisionsToReview: ["Choose a job source"],
  assumptions: [],
};
const sectionProps = {
  graph,
  originalIntent: {
    id: "intent-1",
    organization_id: "org-1",
    project_id: "project-1",
    statement: "The immutable original request",
    created_at: "2026-11-01T10:00:00Z",
  },
  approved: false,
  canEdit: true,
  dirty: true,
  busy: false,
  onSectionChange: () => undefined,
  onSummaryChange: () => undefined,
  onListChange: () => undefined,
  onCancel: () => undefined,
  onSave: async () => true,
};

describe("focused plan sections", () => {
  it("renders the proposed outcome with horizontal section tabs", () => {
    const markup = renderToStaticMarkup(<PlanSection {...sectionProps} section="outcome" />);
    expect(markup).toContain(graph.summary);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="plan-details-tab-outcome" aria-selected="true"');
    expect(markup).toContain("Decisions to Review");
    expect(markup).not.toContain("Related sections");
    expect(markup).not.toContain("canvas-plan-section-heading");
    expect(markup).toContain(">Edit</button>");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("Plan details and work item management");
  });
  it("keeps original intent immutable even when the plan can be edited", () => {
    const markup = renderToStaticMarkup(
      <PlanSection {...sectionProps} section="original-intent" />,
    );
    expect(markup).toContain(sectionProps.originalIntent.statement);
    expect(markup.match(/Original Intent/g)).toHaveLength(1);
    expect(markup.match(/Saved · immutable/g)).toHaveLength(1);
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("Save changes");
  });
  it("shows approved outcomes as text without editing controls", () => {
    const markup = renderToStaticMarkup(
      <PlanSection {...sectionProps} section="outcome" approved canEdit={false} dirty={false} />,
    );
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain(">Edit</button>");
    expect(markup).toContain("Read-only · plan approved");
    expect(markup).not.toContain("Save changes");
    expect(markup).not.toContain("Cancel");
  });
});
