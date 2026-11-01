import { describe, expect, it, vi } from "vitest";
import { collectRepositoryEvidence, selectRepositoryFiles } from "./repository-evidence.js";

describe("repository architecture evidence", () => {
  it("prioritizes manifests, entry points and source while excluding secrets and dependencies", () => {
    const selected = selectRepositoryFiles([
      { path: "src/features/jobs.tsx", type: "blob", size: 200 },
      { path: "src/server.ts", type: "blob", size: 200 },
      { path: "node_modules/react/index.js", type: "blob", size: 200 },
      { path: ".env", type: "blob", size: 200 },
      { path: "src/credentials.ts", type: "blob", size: 200 },
      { path: "README.md", type: "blob", size: 200 },
    ]);
    expect(selected.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/server.ts",
      "src/features/jobs.tsx",
    ]);
  });

  it("fetches source at an immutable commit instead of a moving branch", async () => {
    const sha = "a".repeat(40);
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/acme/app")) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (input.endsWith("/commits/main")) {
        return new Response(JSON.stringify({ sha }), { status: 200 });
      }
      if (input.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({ tree: [{ path: "src/main.ts", type: "blob", size: 20 }] }),
          { status: 200 },
        );
      }
      return new Response("export const main = true;", { status: 200 });
    });
    const result = await collectRepositoryEvidence(
      "acme/app",
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.commitSha).toBe(sha);
    expect(result.inspected).toEqual(["src/main.ts"]);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes(`?ref=${sha}`))).toBe(true);
  });

  it("does not claim analysis when the repository is inaccessible", async () => {
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const result = await collectRepositoryEvidence(
      "acme/private",
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.files).toEqual([]);
    expect(result.commitSha).toBeNull();
  });
});
