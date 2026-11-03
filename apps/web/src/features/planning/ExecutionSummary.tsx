import Markdown from "react-markdown";
import "./execution-summary.css";

/** Preserve stored output and fenced code; only promote known standalone prose labels to headings. */
export function formatExecutionSummary(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1]!;
        if (!fence) fence = { marker: marker[0]!, length: marker.length };
        else if (
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          !fenceMatch[2]!.trim()
        )
          fence = null;
        return line;
      }
      if (fence) return line;
      const label =
        /^ {0,3}(What was implemented|What changed|Where|Verification result|Verification|Files changed|Key updates|Discovery|Notes?):\s*$/i.exec(
          line,
        );
      return label ? `\n### ${label[1]}\n` : line;
    })
    .join("\n");
}

/** Local worker paths resolve only against the exact delivered commit, never against the Orbit app. */
export function executionSummaryLink(
  address: string,
  repository?: string | null,
  headSha?: string | null,
): string | undefined {
  try {
    const external = new URL(address);
    return external.protocol === "https:" || external.protocol === "http:"
      ? external.href
      : undefined;
  } catch {
    // Repository-relative paths are handled below, without following filesystem URLs.
  }
  if (address.startsWith("#")) return address;
  if (
    !repository ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((segment) => segment === "." || segment === "..") ||
    !headSha ||
    !/^[a-f0-9]{40}$/i.test(headSha)
  )
    return undefined;
  let path: string;
  try {
    path = decodeURIComponent(address);
  } catch {
    return undefined;
  }
  if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  const location = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*))?)?$/.exec(path);
  if (!location) return undefined;
  const sourcePath = location[1]!;
  const segments = sourcePath.split("/");
  if (
    !sourcePath ||
    /[\\\x00-\x1f\x7f?#:]/.test(sourcePath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    return undefined;
  const line = location[2];
  const finalLine = location[3];
  if (
    (line && !Number.isSafeInteger(Number(line))) ||
    (finalLine && (!Number.isSafeInteger(Number(finalLine)) || Number(finalLine) < Number(line)))
  )
    return undefined;
  return `https://github.com/${repository}/blob/${headSha}/${segments.map(encodeURIComponent).join("/")}${line ? `#L${line}${finalLine ? `-L${finalLine}` : ""}` : ""}`;
}

export function ExecutionSummary({
  content,
  repository,
  headSha,
}: {
  readonly content: string;
  readonly repository?: string | null;
  readonly headSha?: string | null;
}) {
  return (
    <div className="execution-summary-markdown">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(address) => executionSummaryLink(address, repository, headSha)}
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
        {formatExecutionSummary(content)}
      </Markdown>
    </div>
  );
}
