import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectArchitectureEvidence } from "./ProjectArchitecture.js";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
const snapshot: ProjectKnowledgeSnapshot = {
  id: "old",
  revision: 1,
  created_at: "2026-11-03",
  content: {
    summary: {
      summary: "Legacy",
      architecture: "Existing prose",
      features: [],
      constraints: [],
      unknowns: [],
    },
    documents: [],
    repositories: [],
  },
};
describe("architecture evidence", () => {
  it("shows evidence gaps without offering diagram generation", () => {
    const markup = renderToStaticMarkup(<ProjectArchitectureEvidence snapshot={snapshot} />);
    expect(markup).toContain("Structured architecture facts are not available");
    expect(markup).toContain("No verified data flow");
    expect(markup).not.toContain("Build diagram");
    expect(markup).not.toContain("request an evidence-based diagram");
  });
  it("shows saved facts and data flow", () => {
    const markup = renderToStaticMarkup(
      <ProjectArchitectureEvidence
        snapshot={snapshot}
        architecture={{
          facts: [{ label: "Runtime", description: "Python" }],
          dataFlow: ["Browser calls the API."],
        }}
      />,
    );
    expect(markup).toContain("Python");
    expect(markup).toContain("Browser calls the API.");
  });
});
