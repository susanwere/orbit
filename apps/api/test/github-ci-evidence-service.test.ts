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
    emptyAssociations?: boolean;
    wrongBranch?: boolean;
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
            head_sha: overrides.emptyAssociations ? "abc123" : "merge-commit-sha",
            head_branch: overrides.wrongBranch ? "other-branch" : "orbit/job",
            pull_requests: overrides.emptyAssociations
              ? []
              : [{ number: overrides.associated === false ? 10 : 5, head: { sha: "abc123" } }],
            repository: { full_name: "owner/repo" },
          }
        : {
            number: 5,
            head: { sha: "abc123", ref: "orbit/job", repo: { full_name: "owner/repo" } },
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
                rows:
                  overrides.eligible === false
                    ? []
                    : [{ agent_session_id: "session", job_id: "job" }],
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
    expect(
      f.writes.some((sql) =>
        sql.includes("SET github_ci_state='PASSED',github_ci_report=$5::jsonb"),
      ),
    ).toBe(true);
    expect(f.writes.some((sql) => sql.includes("SET state='COMPLETED'"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("step.state IN ('RUNNING','WAITING')"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("SET state='DONE'"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("INSERT INTO muse_execution_activity"))).toBe(true);
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

it("completes a merged PR with cleared CI associations only for its pinned commit and branch", async () => {
  const test = fixture({ emptyAssociations: true });
  await expect(test.service.verify(input)).resolves.toMatchObject({ state: "COMPLETED" });
  const mismatched = fixture({ emptyAssociations: true, wrongBranch: true });
  await expect(mismatched.service.verify(input)).rejects.toMatchObject({ code: "invalid_state" });
  expect(mismatched.writes).toHaveLength(0);
});
