import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecutionSummary,
  executionSummaryLink,
  formatExecutionSummary,
} from "./ExecutionSummary.js";
const repository = "owner/repository";
const headSha = "a".repeat(40);
function renderSummary(content: string) {
  return renderToStaticMarkup(createElement(ExecutionSummary, { content, repository, headSha }));
}
describe("execution summary Markdown", () => {
  it("formats existing prose sections, bullets and inline code without changing verification claims", () => {
    const markdown =
      "What was implemented:\n- Changed `PAGE_SIZE` from 10 to 5.\n\nVerification result:\n- Not run. Shell execution is disabled.";
    const markup = renderSummary(markdown);
    expect(markup).toContain("<h4>What was implemented</h4>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<code>PAGE_SIZE</code>");
    expect(markup).toContain("Not run. Shell execution is disabled.");
    expect(markdown).toContain("What was implemented:\n-");
  });
  it("renders fenced code blocks and preserves code that resembles summary headings", () => {
    const markdown = "### Change\n\n```tsx\nconst PAGE_SIZE = 5;\n// <script> is code\nNotes:\n```";
    const markup = renderSummary(markdown);
    expect(markup).toContain(
      '<pre tabindex="0" aria-label="Code block"><code class="language-tsx">',
    );
    expect(markup).toContain("const PAGE_SIZE = 5;");
    expect(markup).toContain("&lt;script&gt;");
    expect(formatExecutionSummary(markdown)).toBe(markdown);
  });
  it("links worker file references to the exact delivered GitHub commit and line", () => {
    const markup = renderSummary("[App.tsx](/workspace/src/App.tsx:47)");
    expect(markup).toContain(
      `href="https://github.com/${repository}/blob/${headSha}/src/App.tsx#L47"`,
    );
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(executionSummaryLink("src/App.tsx:47-50", repository, headSha)).toContain("#L47-L50");
    expect(executionSummaryLink("/workspace/notes file.md", repository, headSha)).toContain(
      "notes%20file.md",
    );
  });
  it("does not render raw HTML, tracking images or executable link protocols", () => {
    const markup = renderSummary(
      '<script>alert(1)</script>\n\n[Unsafe](javascript:alert)\n\n![tracking](https://example.test/pixel)\n\n<iframe src="https://example.test"></iframe>',
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain("Unsafe");
  });
  it("keeps unknown file references readable without linking to the app or inventing a source revision", () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionSummary, { content: "[App.tsx](/workspace/src/App.tsx:47)" }),
    );
    expect(markup).toContain("App.tsx");
    expect(markup).not.toContain("href=");
    for (const address of [
      "/workspace/../.env",
      "/workspace/src/../../.env",
      "file:///workspace/src/App.tsx",
      "data:text/html,unsafe",
      "/projects/project/settings",
      "//evil.test/path",
      "/workspace/src/file.ts:50-1",
    ])
      expect(executionSummaryLink(address, repository, headSha)).toBeUndefined();
  });
});
