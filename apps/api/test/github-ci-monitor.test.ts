import { afterEach, describe, expect, it } from "vitest";
import {
  GithubCiMonitor,
  GithubPrReadinessService,
} from "../src/modules/execution/github-ci-monitor.js";

const input = { jobId: "job", projectId: "project", organizationId: "org" };
const sha = "a".repeat(40);
const originalMetaKey = process.env.META_API_KEY;
const originalIsolation = process.env.ORBIT_MUSE_ISOLATED_WORKER;
afterEach(() => {
  if (originalMetaKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = originalMetaKey;
  if (originalIsolation === undefined) delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
  else process.env.ORBIT_MUSE_ISOLATED_WORKER = originalIsolation;
});
function fixture(
  options: {
    failure?: boolean;
    merged?: boolean;
    emptyAssociations?: boolean;
    wrongBranch?: boolean;
    wrongCommit?: boolean;
    pending?: boolean;
    unrelated?: boolean;
    moved?: boolean;
    draft?: boolean;
    eligible?: boolean;
    mutationHead?: string;
    missingCi?: boolean;
  } = {},
) {
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const requests: string[] = [];
  let mutations = 0;
  const database = {
    query: async (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      if (sql.startsWith("SELECT"))
        return {
          rows:
            options.eligible === false
              ? []
              : [
                  {
                    id: "job",
                    organization_id: "org",
                    project_id: "project",
                    github_repository: "owner/repo",
                    github_pull_number: 5,
                    github_head_sha: sha,
                  },
                ],
        };
      return { rows: [{ id: "job" }] };
    },
  };
  const request: typeof fetch = async (url, requestOptions) => {
    requests.push(String(url));
    if (String(url).endsWith("/graphql")) {
      mutations++;
      const mutationName = String(requestOptions?.body).includes("convertPullRequestToDraft")
        ? "convertPullRequestToDraft"
        : "markPullRequestReadyForReview";
      return new Response(
        JSON.stringify({
          data: {
            [mutationName]: {
              pullRequest: {
                number: 5,
                isDraft: mutationName === "convertPullRequestToDraft",
                headRefOid: options.mutationHead ?? sha,
              },
            },
          },
        }),
      );
    }
    if (String(url).includes("/pulls/"))
      return new Response(
        JSON.stringify({
          number: 5,
          node_id: "PR_5",
          draft: options.draft ?? true,
          state: "open",
          merged_at: options.merged ? "2026-11-03T12:00:00Z" : null,
          head: {
            sha: options.moved ? "b".repeat(40) : sha,
            ref: "orbit/muse-job",
            repo: { full_name: "owner/repo" },
          },
          base: { repo: { full_name: "owner/repo" } },
        }),
      );
    if (String(url).includes("/jobs?"))
      return new Response(
        JSON.stringify({
          jobs: [
            {
              name: "build token=secret",
              conclusion: "failure",
              steps: [{ name: "npm run typecheck", conclusion: "failure" }],
            },
          ],
        }),
      );
    return new Response(
      JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            name: options.missingCi ? "Other workflow" : "CI",
            workflow_id: 10,
            run_number: 1,
            status: options.pending ? "in_progress" : "completed",
            conclusion: options.pending ? null : options.failure ? "failure" : "success",
            repository: { full_name: "owner/repo" },
            event: "pull_request",
            head_sha: options.wrongCommit ? "c".repeat(40) : sha,
            head_branch: options.wrongBranch ? "another-branch" : "orbit/muse-job",
            pull_requests: options.emptyAssociations
              ? []
              : [{ number: options.unrelated ? 20 : 5, head: { sha } }],
          },
        ],
      }),
    );
  };
  const monitor = new GithubCiMonitor(database as never, "test-read-token", request);
  const ready = new GithubPrReadinessService(
    database as never,
    monitor,
    "test-write-token",
    request,
  );
  return { monitor, ready, queries, requests, mutations: () => mutations };
}
function trustedDelivery() {
  delete process.env.META_API_KEY;
  process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
}

describe("CI failure feedback and draft readiness", () => {
  it("retains failing job/step summaries with provenance but never raw logs or completion", async () => {
    const test = fixture({ failure: true });
    const report = await test.monitor.inspect(input);
    expect(report.state).toBe("FAILED");
    expect(report.summary).toContain("npm run typecheck");
    expect(report.summary).not.toContain("token=secret");
    expect(test.requests.some((url) => url.includes("/logs"))).toBe(false);
    expect(test.queries.some((query) => query.sql.includes("SET state='COMPLETED'"))).toBe(false);
    expect(report.runs[0]?.url).toBe("https://github.com/owner/repo/actions/runs/123");
  });
  it("keeps pending, missing CI and unrelated runs from granting readiness", async () => {
    trustedDelivery();
    for (const options of [{ pending: true }, { missingCi: true }, { unrelated: true }]) {
      const test = fixture(options);
      const report = await test.ready.markReady(input);
      expect(["WAITING", "PENDING"]).toContain(report.state);
      expect(test.mutations()).toBe(0);
    }
  });
  it("marks a draft ready only for the current PR head with passing CI", async () => {
    trustedDelivery();
    const test = fixture();
    expect((await test.ready.markReady(input)).state).toBe("PASSED");
    expect(test.mutations()).toBe(1);
    expect(test.queries.at(-1)?.parameters).toContain("READY");
    expect(test.requests.some((url) => url.includes("/merge"))).toBe(false);
  });
  it("keeps failed CI in draft and converts a ready PR back to draft after failure", async () => {
    trustedDelivery();
    const draft = fixture({ failure: true });
    await draft.ready.markReady(input);
    expect(draft.mutations()).toBe(0);
    const ready = fixture({ failure: true, draft: false });
    await ready.ready.markReady(input);
    expect(ready.mutations()).toBe(1);
    expect(ready.queries.at(-1)?.parameters).toContain("DRAFT");
  });
  it("does not duplicate a readiness mutation for an already-ready green PR", async () => {
    trustedDelivery();
    const test = fixture({ draft: false });
    await test.ready.markReady(input);
    expect(test.mutations()).toBe(0);
  });
  it("denies moved or unbound heads before persisting feedback", async () => {
    for (const options of [{ moved: true }, { eligible: false }]) {
      const test = fixture(options);
      await expect(test.monitor.inspect(input)).rejects.toMatchObject({ code: "invalid_state" });
      expect(test.queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(0);
    }
  });
  it("rejects mutation confirmation for another head", async () => {
    trustedDelivery();
    const test = fixture({ mutationHead: "b".repeat(40) });
    await expect(test.ready.markReady(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(test.queries.some((query) => query.parameters.includes("READY"))).toBe(false);
  });
  it("never allows readiness mutation from a model-credential process", async () => {
    trustedDelivery();
    process.env.META_API_KEY = "not-a-real-model-key";
    const test = fixture();
    await expect(test.ready.markReady(input)).rejects.toMatchObject({ code: "forbidden" });
    expect(test.requests).toHaveLength(0);
  });
});

it("reports a merge for the exact delivered head without performing any merge mutation", async () => {
  const test = fixture({ merged: true });
  const report = await test.monitor.inspect(input);
  expect(report.mergedAt).toBe("2026-11-03T12:00:00Z");
  expect(report.state).toBe("PASSED");
  expect(test.mutations()).toBe(0);
});

it("refreshes a merged PR's passing CI when GitHub removed the run association", async () => {
  const test = fixture({ merged: true, emptyAssociations: true });
  expect((await test.monitor.inspect(input)).state).toBe("PASSED");
});
it("does not grant readiness to mismatched unassociated merged CI runs", async () => {
  for (const options of [{ wrongBranch: true }, { wrongCommit: true }]) {
    const test = fixture({ merged: true, emptyAssociations: true, ...options });
    expect((await test.monitor.inspect(input)).state).toBe("WAITING");
  }
});
