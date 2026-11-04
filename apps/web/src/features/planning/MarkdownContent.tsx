import Markdown from "react-markdown";
import "./execution-summary.css";

/** Generated prose is untrusted: allow web links and anchors, never app/file URLs. */
function safeMarkdownLink(address: string): string | undefined {
  if (address.startsWith("#")) return address;
  try {
    const external = new URL(address);
    return external.protocol === "https:" || external.protocol === "http:"
      ? external.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function MarkdownContent({
  content,
  className = "",
  resolveLink = safeMarkdownLink,
}: {
  readonly content: string;
  readonly className?: string;
  readonly resolveLink?: (address: string) => string | undefined;
}) {
  return (
    <div className={`execution-summary-markdown markdown-content ${className}`.trim()}>
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={resolveLink}
        components={{
          h1: ({ children }) => <h4>{children}</h4>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h4>{children}</h4>,
          h4: ({ children }) => <h5>{children}</h5>,
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target={href.startsWith("#") ? undefined : "_blank"}
                rel={href.startsWith("#") ? undefined : "noopener noreferrer"}
              >
                {children}
              </a>
            ) : (
              <span className="execution-summary-reference">{children}</span>
            ),
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="Code block">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
