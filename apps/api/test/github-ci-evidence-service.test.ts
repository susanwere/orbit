import { describe, expect, it } from "vitest";
import { GithubCiEvidenceService } from "../src/modules/execution/github-ci-evidence-service.js";

const input = {
  projectId: "project",
  principalId: "human",
  stepId: "step",
  repository: "owner/repo",
  runId: 123,
  pullNumber: 5,
};

function fixture(
  overrides: {
    conclusion?: string;
    merged?: boolean;
    eligible?: boolean;
    associated?: boolean;
  } = {},
) {
  const writes: string[] = [];
  const fetchImpl = async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("/actions/runs/")
        ? {
            status: "completed",
            conclusion: overrides.conclusion ?? "success",
            event: "pull_request",
            name: "CI",
            head_sha: "merge-commit-sha",
            pull_requests: [
              { number: overrides.associated === false ? 10 : 5, head: { sha: "abc123" } },
            ],
            repository: { full_name: "owner/repo" },
          }
        : {
            number: 5,
            head: { sha: "abc123" },
            base: { repo: { full_name: "owner/repo" } },
            merged_at: overrides.merged === false ? null : "2026-10-30T12:00:00Z",
          },
  });
  const service = new GithubCiEvidenceService(
    {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string) => {
            writes.push(sql);
            if (sql.includes("SELECT step.agent_session_id")) {
              return {
                rows: overrides.eligible === false ? [] : [{ agent_session_id: "session" }],
              };
            }
            if (sql.includes("RETURNING id,state")) {
              return { rows: [{ id: "step", state: "COMPLETED" }] };
            }
            return { rows: [] };
          },
        }),
    } as never,
    { authorize: async () => ({ organizationId: "org" }) } as never,
    "server-only-test-token",
    fetchImpl as never,
    () => "test",
  );
  return { service, writes };
}

describe("GitHub CI-backed step completion", () => {
  it("persists verified evidence and completes linked session and step atomically", async () => {
    const f = fixture();
    await expect(f.service.verify(input)).resolves.toMatchObject({ state: "COMPLETED" });
    expect(f.writes.some((sql) => sql.includes("job.status='TURN_FINISHED'"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("gate.status='OPEN'"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("contract.allowed_repositories @>"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("job.github_head_sha=$7"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("job.github_pull_number=$6"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("INSERT INTO evidence"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("SET state='COMPLETED'"))).toBe(true);
  });

  it("rejects unsuccessful CI or unmerged PR before DB mutation", async () => {
    for (const options of [{ conclusion: "failure" }, { merged: false }]) {
      const f = fixture(options);
      await expect(f.service.verify(input)).rejects.toMatchObject({ code: "invalid_state" });
      expect(f.writes).toHaveLength(0);
    }
  });

  it("rejects CI from an unrelated pull request", async () => {
    const f = fixture({ associated: false });
    await expect(f.service.verify(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(f.writes).toHaveLength(0);
  });

  it("denies a stale or blocked step without producing evidence", async () => {
    const f = fixture({ eligible: false });
    await expect(f.service.verify(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(f.writes.some((sql) => sql.includes("INSERT INTO evidence"))).toBe(false);
  });

  it("rejects invalid untrusted GitHub identifiers", async () => {
    const f = fixture();
    await expect(
      f.service.verify({ ...input, repository: "https://evil.example/x" }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(f.writes).toHaveLength(0);
  });
});
