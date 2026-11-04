import { afterEach, describe, expect, it, vi } from "vitest";
import { generateProjectKnowledgeSnapshot } from "../src/modules/context/project-knowledge-routes.js";
import { ProjectKnowledgeRefreshWorker } from "../src/modules/context/project-knowledge-refresh-worker.js";
vi.mock("../src/modules/context/project-knowledge-routes.js", () => ({
  generateProjectKnowledgeSnapshot: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
describe("context refresh lease", () => {
  it("renews its exact attempt while generation runs and stops after saving", async () => {
    vi.useFakeTimers();
    let finish: (snapshot: Record<string, unknown>) => void = () => undefined;
    vi.mocked(generateProjectKnowledgeSnapshot).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const queries: { sql: string; parameters: unknown[] }[] = [];
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      queries.push({ sql, parameters });
      return {
        rows: sql.startsWith("SELECT")
          ? [
              {
                id: "job",
                organization_id: "org",
                project_id: "project",
                repository_full_name: "owner/repo",
                merge_commit_sha: "a".repeat(40),
                pull_number: 19,
                attempts: 2,
              },
            ]
          : [],
      };
    });
    const worker = new ProjectKnowledgeRefreshWorker(
      {
        query,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ query }),
      } as never,
      {} as never,
      {} as never,
      "system",
    );
    const processing = worker.processBatch(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      queries.some(
        ({ sql, parameters }) =>
          sql.includes("SET claimed_at=now()") && parameters[0] === "job" && parameters[1] === 3,
      ),
    ).toBe(true);
    finish({ id: "snapshot" });
    await expect(processing).resolves.toBe(1);
    expect(
      queries.some(
        ({ sql, parameters }) => sql.includes("status='COMPLETED'") && parameters[2] === 3,
      ),
    ).toBe(true);
    const count = queries.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queries).toHaveLength(count);
  });
});
