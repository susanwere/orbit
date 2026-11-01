export interface RepositoryEvidence {
  commitSha: string | null;
  inspected: string[];
  files: { path: string; text: string }[];
  truncated: boolean;
  totalCandidates: number;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

const ALLOWED_SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|vue|svelte)$/i;
const MANIFEST = /^(?:README(?:\.[^/]*)?|package\.json|pyproject\.toml|Cargo\.toml|Gemfile|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|tsconfig\.json|vite\.config\.[jt]s)$/i;
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".git",
  ".next",
  ".venv",
  "venv",
  "generated",
  "__generated__",
  "fixtures",
]);
const MAX_FILES = 20;
const MAX_FILE_SIZE = 25_000;
const MAX_FILE_EXCERPT = 2_000;
const MAX_TOTAL_EXCERPT = 28_000;

function score(path: string): number {
  const name = path.split("/").at(-1) ?? "";
  if (/^README(?:\.|$)/i.test(name)) return 100;
  if (MANIFEST.test(name)) return 90;
  if (/(?:^|\/)(?:main|index|app|server|routes|router|api|config)\.[^/]+$/i.test(path))
    return 75;
  if (/(?:^|\/)(?:controllers?|services?|modules?|features?|components?|lib|src)\//i.test(path))
    return 55;
  if (/(?:^|\/)(?:test|tests|__tests__)\//i.test(path) || /\.(?:test|spec)\./i.test(path))
    return 35;
  return 20;
}

export function selectRepositoryFiles(tree: readonly TreeEntry[]): TreeEntry[] {
  return tree
    .filter((entry) => {
      if (entry.type !== "blob" || !entry.size || entry.size > MAX_FILE_SIZE) return false;
      const segments = entry.path.split("/");
      const name = segments.at(-1) ?? "";
      if (
        segments.some((segment) => EXCLUDED_SEGMENTS.has(segment) || segment.startsWith(".")) ||
        /(?:^|[._-])(?:secret|credentials?|token|password|private|lock)(?:[._-]|$)/i.test(name) ||
        /\.(?:min|map|snap|lock)\b/i.test(name) ||
        name === ".env"
      )
        return false;
      return MANIFEST.test(name) || ALLOWED_SOURCE.test(name);
    })
    .sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

export async function collectRepositoryEvidence(
  repository: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryEvidence> {
  const empty = (): RepositoryEvidence => ({
    commitSha: null,
    inspected: [],
    files: [],
    truncated: false,
    totalCandidates: 0,
  });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return empty();
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Orbit-Knowledge",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const base = `https://api.github.com/repos/${repository}`;
  const get = (url: string, accept?: string) =>
    fetchImpl(url, {
      headers: { ...headers, ...(accept ? { Accept: accept } : {}) },
      signal: AbortSignal.timeout(8_000),
    });
  const metadata = await get(base);
  if (!metadata.ok) return empty();
  const details = (await metadata.json()) as { default_branch?: string };
  if (!details.default_branch) return empty();
  const commitResponse = await get(
    `${base}/commits/${encodeURIComponent(details.default_branch)}`,
  );
  if (!commitResponse.ok) return empty();
  const commit = (await commitResponse.json()) as { sha?: string };
  const commitSha = commit.sha;
  if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) return empty();
  const treeResponse = await get(`${base}/git/trees/${commitSha}?recursive=1`);
  if (!treeResponse.ok) return { ...empty(), commitSha };
  const manifest = (await treeResponse.json()) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  const eligible = manifest.tree ?? [];
  const candidates = selectRepositoryFiles(eligible);
  const files: RepositoryEvidence["files"] = [];
  let remaining = MAX_TOTAL_EXCERPT;
  for (const item of candidates) {
    if (remaining <= 0) break;
    const path = item.path.split("/").map(encodeURIComponent).join("/");
    const response = await get(
      `${base}/contents/${path}?ref=${commitSha}`,
      "application/vnd.github.raw+json",
    );
    if (!response.ok) continue;
    const excerpt = (await response.text()).slice(0, Math.min(MAX_FILE_EXCERPT, remaining));
    if (!excerpt || excerpt.includes("\u0000")) continue;
    files.push({ path: item.path, text: excerpt });
    remaining -= excerpt.length;
  }
  return {
    commitSha,
    files,
    inspected: files.map((file) => file.path),
    truncated: Boolean(manifest.truncated) || eligible.length > MAX_FILES,
    totalCandidates: eligible.filter((entry) => entry.type === "blob").length,
  };
}
