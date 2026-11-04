import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent.js";

describe("generated context Markdown", () => {
  it("renders headings, paragraphs, lists and fenced code without changing stored text", () => {
    const content =
      "## Architecture\n\nUses **React** and `TypeScript`.\n\n- Frontend\n- API\n\n```ts\nconst pageSize = 5;\n```";
    const markup = renderToStaticMarkup(<MarkdownContent content={content} />);
    expect(markup).toContain("<h4>Architecture</h4>");
    expect(markup).toContain("<strong>React</strong>");
    expect(markup).toContain("<code>TypeScript</code>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain('<pre tabindex="0" aria-label="Code block">');
    expect(markup).toContain("const pageSize = 5;");
    expect(content).toContain("## Architecture");
  });
  it("blocks HTML, images and unsafe or app-relative links in generated evidence", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={
          "<script>alert(1)</script>\n\n![tracking](https://example.test/pixel)\n\n[unsafe](javascript:alert) [local](file:///etc/passwd) [app](/auth/logout) [source](https://example.test/source)"
        }
      />,
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('href="file:');
    expect(markup).not.toContain('href="/auth');
    expect(markup).toContain('href="https://example.test/source"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});
