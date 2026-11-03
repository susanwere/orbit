import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectContextEmptyState } from "./ProjectContextEmptyState.js";

const render = (props?: { repositories?: Parameters<typeof ProjectContextEmptyState>[0]["repositories"]; documentCount?: number; generating?: boolean }) =>
  renderToStaticMarkup(
    <ProjectContextEmptyState
      repositories={props?.repositories ?? []}
      documentCount={props?.documentCount ?? 0}
      generating={props?.generating ?? false}
      onGenerate={() => {}}
    />,
  );

describe("Project Context first-run state", () => {
  it("offers generation without requiring documents or repositories", () => {
    const markup = render();
    expect(markup).toContain("Generate Project Context");
    expect(markup).toContain("Supporting documents");
    expect(markup).toContain("No documents uploaded");
    expect(markup).toContain("None connected");
  });

  it("describes actual connected sources without fictional counts", () => {
    const markup = render({
      repositories: [
        {
          id: "repo-1",
          project_id: "project-1",
          owner: "acme",
          repo: "web",
          full_name: "acme/web",
          html_url: "https://github.com/acme/web",
          created_at: "2026-11-03",
        },
      ],
      documentCount: 2,
    });
    expect(markup).toContain("1 connected");
    expect(markup).toContain("2 uploaded");
    expect(markup).toContain("Available");
  });

  it("disables generation while Muse is analyzing", () => {
    const markup = render({ generating: true });
    expect(markup).toContain("Muse is analyzing your sources");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
  });

  it("does not claim repositories are missing if their status is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ProjectContextEmptyState repositories={null} documentCount={0} generating={false} onGenerate={() => {}} />,
    );
    expect(markup).toContain("Connection status unavailable");
    expect(markup).not.toContain("None connected");
  });
});
