import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContextSourceCard, ProjectContextEmptyState } from "./ProjectContextEmptyState.js";

describe("initial project context", () => {
  it("offers one generation action and identifies optional evidence sources", () => {
    const markup = renderToStaticMarkup(
      <ProjectContextEmptyState generating={false} disabled={false} onGenerate={vi.fn()} />,
    );
    expect(markup).toContain("Let Muse understand your project");
    expect(markup.match(/class="context-generate-button"/g)).toHaveLength(1);
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain("Repository (optional)");
    expect(markup).toContain("Documents (0)");
    expect(markup).toContain("Original Intent");
    expect(markup).not.toContain("KNOWLEDGE VERSION");
  });
  it("links each connected repository directly to GitHub in a new tab", () => {
    const markup = renderToStaticMarkup(
      <ProjectContextEmptyState
        generating={false}
        disabled={false}
        onGenerate={vi.fn()}
        repositories={[
          {
            id: "repo-1",
            full_name: "susanwere/orbit",
            html_url: "https://github.com/susanwere/orbit",
          },
        ]}
      />,
    );
    expect(markup).toContain("Repository (connected)");
    expect(markup).toContain("susanwere/orbit");
    expect(markup).toContain('href="https://github.com/susanwere/orbit"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("No repository connected");
  });
  it("shows document totals and provides an Original Intent action", () => {
    const markup = renderToStaticMarkup(
      <ProjectContextEmptyState
        generating={false}
        disabled={false}
        documentCount={3}
        onGenerate={vi.fn()}
        onOpenIntent={vi.fn()}
      />,
    );
    expect(markup).toContain("Documents (3)");
    expect(markup).toContain("3 supporting documents");
    expect(markup).toContain('class="context-intent-link"');
    expect(markup).toContain("View your project goal and scope");
  });
  it("disables duplicate generation and announces progress", () => {
    const markup = renderToStaticMarkup(
      <ProjectContextEmptyState generating disabled={false} onGenerate={vi.fn()} />,
    );
    expect(markup).not.toContain('class="context-generate-button"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("Muse is understanding your project");
    expect(markup).toContain("Nothing is approved automatically");
  });
  it("distinguishes available evidence from a missing source", () => {
    const connected = renderToStaticMarkup(
      <ContextSourceCard
        icon="repository"
        title="Repository (connected)"
        description="owner/repo"
        available
        expanded
        onClick={vi.fn()}
      />,
    );
    expect(connected).toContain('aria-label="Available"');
    expect(connected).toContain('aria-expanded="true"');
    const missing = renderToStaticMarkup(
      <ContextSourceCard
        icon="documents"
        title="Documents"
        description="0 files"
        onClick={vi.fn()}
      />,
    );
    expect(missing).not.toContain('aria-label="Available"');
    expect(missing).toContain("0 files");
  });
});
