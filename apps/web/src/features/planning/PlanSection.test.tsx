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
    expect(markup.match(/Original Intent<\/button>/g)).toHaveLength(1);
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

describe("plan detail item cards", () => {
  it.each(["guardrails", "decisionsToReview", "assumptions"] as const)(
    "renders each %s item as a separate connected card",
    (section) => {
      const markup = renderToStaticMarkup(
        <PlanSection
          {...sectionProps}
          section={section}
          graph={{
            ...graph,
            [section]: [
              "API Integration: Keep the public API boundary.",
              "Preserve keyboard accessibility.",
            ],
          }}
        />,
      );
      expect(markup.match(/class="plan-detail-item-card"/g)).toHaveLength(2);
      expect(markup).toContain("<h3>API Integration</h3>");
      expect(markup).toContain("Keep the public API boundary.");
      expect(markup).toContain("Preserve keyboard accessibility.");
      expect(markup).not.toContain('data-approved="true"');
    },
  );
  it("uses approval markers only after the plan is approved", () => {
    const markup = renderToStaticMarkup(
      <PlanSection {...sectionProps} section="guardrails" approved canEdit={false} />,
    );
    expect(markup).toContain('title="Approved as part of the plan"');
    expect(markup).toContain("✓");
    expect(markup).not.toContain(">Edit</button>");
  });
  it("preserves empty sections and does not split URLs into headings", () => {
    const empty = renderToStaticMarkup(<PlanSection {...sectionProps} section="assumptions" />);
    expect(empty).toContain("None proposed.");
    expect(empty).not.toContain('class="plan-detail-item-card"');
    const url = renderToStaticMarkup(
      <PlanSection
        {...sectionProps}
        section="outcome"
        graph={{ ...graph, summary: "https://example.com/jobs" }}
      />,
    );
    expect(url).toContain("https://example.com/jobs");
    expect(url).not.toContain("<h3>https</h3>");
  });
});
