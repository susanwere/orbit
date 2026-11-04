import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import { ProjectContextReview, splitKnowledgeArchitecture } from "./ProjectContextReview.js";

const snapshot: ProjectKnowledgeSnapshot = {
  id: "knowledge-1",
  revision: 1,
  created_at: "2026-11-03T12:00:00Z",
  review_status: "PROPOSED",
  content: {
    summary: {
      summary: "Evidence-based project overview.",
      architecture: "React frontend.\n\nTechnologies Used\nReact: actively used.",
      features: ["Partially Implemented: export. Evidence: src/export.ts."],
      constraints: ["Observed: authenticated access required."],
      unknowns: ["Deployment unverified."],
    },
    documents: [],
    repositories: [
      {
        fullName: "susanwere/orbit",
        inspected: ["src/App.tsx"],
        commitSha: "a".repeat(40),
        truncated: true,
        summary: null,
      },
    ],
  },
};
function renderVersion(version = snapshot) {
  return renderToStaticMarkup(
    <ProjectContextReview
      snapshot={version}
      history={[version]}
      projectName="Orbit"
      hasIntent
      error={null}
      loading={false}
      reviewing={false}
      onSelectVersion={vi.fn()}
      onRefresh={vi.fn()}
      onGenerate={vi.fn()}
      onOpenIntent={vi.fn()}
      onReview={vi.fn().mockResolvedValue(true)}
    />,
  );
}
describe("generated project context", () => {
  it("offers review actions for a proposal with real version and evidence metadata", () => {
    const markup = renderVersion();
    expect(markup).toContain("Approve Context");
    expect(markup).toContain("Request Changes");
    expect(markup).toContain("Proposed");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Evidence-based project overview.");
    expect(markup).toContain("susanwere/orbit");
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain("Representative sample");
    expect(markup).not.toContain("1,024 commits");
    expect(markup).not.toContain("PostgreSQL");
  });
  it.each(["APPROVED", "CHANGES_REQUESTED"] as const)(
    "does not offer another approval for %s versions",
    (review_status) => {
      const markup = renderVersion({ ...snapshot, review_status, review_note: "Review recorded." });
      expect(markup).not.toContain("Approve Context");
      expect(markup).not.toContain("Request Changes");
      expect(markup).toContain("Review recorded.");
      expect(markup).toContain("Version history");
      if (review_status === "APPROVED") expect(markup).toContain("Current approved");
    },
  );
  it("formats saved overview and feature evidence without regenerating the snapshot", () => {
    const version = {
      ...snapshot,
      content: {
        ...snapshot.content,
        summary: {
          ...snapshot.content.summary,
          summary: "## Purpose\n\nA **jobs viewer** using `React`.\n\n- Browse jobs\n- Load more",
          features: ["**Pagination** uses `PAGE_SIZE`."],
        },
      },
    };
    const markup = renderVersion(version);
    expect(markup).toContain("<h4>Purpose</h4>");
    expect(markup).toContain("<strong>jobs viewer</strong>");
    expect(markup).toContain("<code>React</code>");
    expect(markup).toContain("<strong>Pagination</strong>");
    expect(version.content.summary.summary).toContain("## Purpose");
  });
  it("separates technology inventory while keeping old architecture prose intact", () => {
    expect(splitKnowledgeArchitecture(snapshot.content.summary.architecture)).toEqual({
      architecture: "React frontend.",
      technologies: "React: actively used.",
    });
    expect(splitKnowledgeArchitecture("Existing architecture without headings.")).toEqual({
      architecture: "Existing architecture without headings.",
      technologies: "",
    });
    expect(splitKnowledgeArchitecture("API\n## 3. TECHNOLOGIES USED\nFastify").technologies).toBe(
      "Fastify",
    );
  });
});
