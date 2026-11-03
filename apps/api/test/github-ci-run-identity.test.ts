import { describe, expect, it } from "vitest";
import { isGitHubRunForPullRequest } from "../src/modules/execution/github-ci-run-identity.js";
const headSha = "a".repeat(40);
const pull = {
  repository: "owner/repository",
  number: 16,
  headSha,
  headBranch: "orbit/job-16",
  merged: true,
};
const mergedRun = {
  event: "pull_request",
  head_sha: headSha,
  head_branch: pull.headBranch,
  repository: { full_name: pull.repository },
  pull_requests: [],
};
describe("merged PR CI identity", () => {
  it("accepts an exact merged PR commit and branch when GitHub clears associations", () => {
    expect(isGitHubRunForPullRequest(mergedRun, pull)).toBe(true);
  });
  it("rejects unmerged PRs or mismatched commits, branches, repositories and event types", () => {
    expect(isGitHubRunForPullRequest(mergedRun, { ...pull, merged: false })).toBe(false);
    for (const changed of [
      { head_sha: "b".repeat(40) },
      { head_branch: "other-branch" },
      { repository: { full_name: "other/repository" } },
      { event: "push" },
      { pull_requests: undefined },
    ])
      expect(isGitHubRunForPullRequest({ ...mergedRun, ...changed }, pull)).toBe(false);
    expect(isGitHubRunForPullRequest(mergedRun, { ...pull, headBranch: undefined })).toBe(false);
  });
  it("never replaces an explicit different PR association with a commit-only match", () => {
    expect(
      isGitHubRunForPullRequest(
        { ...mergedRun, pull_requests: [{ number: 17, head: { sha: headSha } }] },
        pull,
      ),
    ).toBe(false);
  });
  it("retains normal PR associations including CI runs on GitHub test-merge commits", () => {
    expect(
      isGitHubRunForPullRequest(
        {
          ...mergedRun,
          head_sha: "b".repeat(40),
          pull_requests: [{ number: pull.number, head: { sha: headSha } }],
        },
        { ...pull, merged: false },
      ),
    ).toBe(true);
  });
});
