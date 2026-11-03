interface GithubRunIdentity {
  readonly event?: string;
  readonly head_sha?: string;
  readonly head_branch?: string;
  readonly repository?: { full_name?: string };
  readonly pull_requests?: readonly { number?: number; head?: { sha?: string } }[];
}

/** GitHub may clear PR associations after merge; require the exact delivered head and branch then. */
export function isGitHubRunForPullRequest(
  run: GithubRunIdentity,
  pull: {
    readonly repository: string;
    readonly number: number;
    readonly headSha: string;
    readonly headBranch?: string;
    readonly merged: boolean;
  },
): boolean {
  if (
    run.event !== "pull_request" ||
    run.repository?.full_name !== pull.repository ||
    !Array.isArray(run.pull_requests)
  )
    return false;
  if (run.pull_requests.length)
    return run.pull_requests.some(
      (candidate) => candidate.number === pull.number && candidate.head?.sha === pull.headSha,
    );
  return Boolean(
    pull.merged &&
      pull.headBranch &&
      run.head_sha === pull.headSha &&
      run.head_branch === pull.headBranch,
  );
}
