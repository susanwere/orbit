import { isGitHubRunForPullRequest } from "./github-ci-run-identity.js";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

export interface GithubCiReport {
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly state: "WAITING" | "PENDING" | "FAILED" | "PASSED";
  readonly summary: string;
  readonly mergedAt?: string | null;
  readonly runs: readonly {
    id: number;
    name: string;
    conclusion: string | null;
    url: string;
    failures: readonly string[];
  }[];
}
interface DeliveredJob extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  github_repository: string;
  github_pull_number: number;
  github_head_sha: string;
}
interface GithubPull {
  number?: number;
  node_id?: string;
  draft?: boolean;
  state?: string;
  merged_at?: string | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
  base?: { repo?: { full_name?: string } };
}
interface GithubRun {
  id: number;
  name: string;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  head_sha?: string;
  head_branch?: string;
  repository?: { full_name?: string };
  event?: string;
  pull_requests?: { number?: number; head?: { sha?: string } }[];
}
interface GithubJob {
  name?: string;
  conclusion?: string;
  steps?: { name?: string; conclusion?: string }[];
}

/** Bounded diagnostic labels only: never ingest raw logs or credential-bearing transcripts. */
function diagnosticLabel(label: string, credential: string): string {
  return label
    .slice(0, 160)
    .replaceAll(credential, "[redacted]")
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_]+|(?:authorization|api[_-]?key|token|password)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(/[\x00-\x1f\x7f]/g, " ");
}

/** Trusted read-only GitHub observer; no model invocation, push, merge or workflow completion. */
export class GithubCiMonitor {
  constructor(
    private readonly database: SqlDatabase,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async load<T>(repository: string, suffix: string): Promise<T> {
    if (!this.token)
      throw new DomainError(
        "invalid_state",
        "Configure the API/worker read-only ORBIT_GITHUB_EVIDENCE_TOKEN to inspect CI.",
      );
    const response = await this.request(`https://api.github.com/repos/${repository}${suffix}`, {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new DomainError(
        "invalid_state",
        "GitHub CI could not be read. Check the evidence token's repository access and Actions/Pull requests read permissions.",
      );
    return (await response.json()) as T;
  }

  async inspect(input: {
    jobId: string;
    projectId: string;
    organizationId?: string;
  }): Promise<GithubCiReport> {
    const jobs = await this.database.query<DeliveredJob>(
      `SELECT job.id,job.organization_id,job.project_id,job.github_repository,job.github_pull_number,job.github_head_sha
       FROM muse_execution_jobs job
       JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id AND step.agent_session_id=job.agent_session_id
       JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN execution_contracts contract ON contract.id=session.execution_contract_id AND contract.project_id=job.project_id AND contract.organization_id=job.organization_id
       JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=job.project_id AND plan.organization_id=job.organization_id
       WHERE job.id=$1 AND job.project_id=$2 AND ($3::text IS NULL OR job.organization_id=$3)
         AND job.status='TURN_FINISHED' AND step.state IN ('RUNNING','WAITING') AND session.state IN ('RUNNING','WAITING')
         AND NOT EXISTS (SELECT 1 FROM human_gates gate WHERE gate.project_id=job.project_id AND gate.organization_id=job.organization_id AND gate.agent_session_id=session.id AND gate.status='OPEN')
         AND step.completion_kind='github_ci' AND plan.status='APPROVED' AND plan.revision=step.plan_revision
         AND contract.allowed_repositories @> jsonb_build_array(job.github_repository)
         AND job.github_repository IS NOT NULL AND job.github_pull_number IS NOT NULL AND job.github_head_sha IS NOT NULL`,
      [input.jobId, input.projectId, input.organizationId ?? null],
    );
    const job = jobs.rows[0];
    if (
      !job ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(job.github_repository) ||
      !/^[a-f0-9]{40}$/.test(job.github_head_sha)
    )
      throw new DomainError(
        "invalid_state",
        "No current delivered code job is eligible for CI inspection.",
      );
    const pull = await this.load<GithubPull>(
      job.github_repository,
      `/pulls/${job.github_pull_number}`,
    );
    if (
      pull.number !== job.github_pull_number ||
      pull.head?.sha !== job.github_head_sha ||
      pull.head.repo?.full_name !== job.github_repository ||
      pull.base?.repo?.full_name !== job.github_repository ||
      !pull.head.ref
    )
      throw new DomainError(
        "invalid_state",
        "The PR head/repository changed. Reconcile delivery before inspecting or repairing CI.",
      );
    const runsResponse = await this.load<{ total_count: number; workflow_runs: GithubRun[] }>(
      job.github_repository,
      `/actions/runs?event=pull_request&branch=${encodeURIComponent(pull.head.ref)}&per_page=100`,
    );
    if (!Array.isArray(runsResponse.workflow_runs) || runsResponse.total_count > 100)
      throw new DomainError(
        "invalid_state",
        "CI history exceeds the bounded inspection window. Review GitHub before marking this PR ready.",
      );
    const latest = new Map<number, GithubRun>();
    for (const run of runsResponse.workflow_runs) {
      if (
        !isGitHubRunForPullRequest(run, {
          repository: job.github_repository,
          number: job.github_pull_number,
          headSha: job.github_head_sha,
          headBranch: pull.head.ref,
          merged: Boolean(pull.merged_at),
        })
      )
        continue;
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.workflow_id))
        continue;
      const previous = latest.get(run.workflow_id);
      if (
        !previous ||
        run.run_number > previous.run_number ||
        (run.run_number === previous.run_number &&
          ((run.run_attempt ?? 1) > (previous.run_attempt ?? 1) ||
            ((run.run_attempt ?? 1) === (previous.run_attempt ?? 1) && run.id > previous.id)))
      )
        latest.set(run.workflow_id, run);
    }
    if (latest.size > 20)
      throw new DomainError("invalid_state", "Too many CI workflows for bounded inspection.");
    const reports: GithubCiReport["runs"][number][] = [];
    for (const run of [...latest.values()].sort((left, right) => left.id - right.id)) {
      const failures: string[] = [];
      if (run.status === "completed" && run.conclusion !== "success") {
        const details = await this.load<{ jobs: GithubJob[] }>(
          job.github_repository,
          `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        );
        for (const failedJob of (details.jobs ?? []).filter(
          (candidate) => !["success", "skipped"].includes(candidate.conclusion ?? ""),
        )) {
          failures.push(
            diagnosticLabel(failedJob.name ?? "Unnamed CI job", this.token) +
              ": " +
              (failedJob.steps ?? [])
                .filter((step) => !["success", "skipped"].includes(step.conclusion ?? ""))
                .map((step) => diagnosticLabel(step.name ?? "Unnamed step", this.token))
                .slice(0, 5)
                .join(", "),
          );
          if (failures.length >= 8) break;
        }
      }
      reports.push({
        id: run.id,
        name: diagnosticLabel(run.name, this.token),
        conclusion: run.conclusion,
        url: `https://github.com/${job.github_repository}/actions/runs/${run.id}`,
        failures,
      });
    }
    const selected = [...latest.values()];
    const state: GithubCiReport["state"] = selected.some(
      (run) => run.status === "completed" && run.conclusion !== "success",
    )
      ? "FAILED"
      : !selected.some((run) => run.name === "CI")
        ? "WAITING"
        : selected.some((run) => run.status !== "completed")
          ? "PENDING"
          : "PASSED";
    const summary =
      `CI ${state} for ${job.github_repository} PR #${job.github_pull_number} at ${job.github_head_sha}. ` +
      reports
        .map(
          (run) =>
            `${run.name}: ${run.conclusion ?? "pending"}${run.failures.length ? ` (${run.failures.join("; ")})` : ""}. ${run.url}`,
        )
        .join(" ");
    const report: GithubCiReport = {
      repository: job.github_repository,
      pullNumber: job.github_pull_number,
      headSha: job.github_head_sha,
      state,
      summary: summary.slice(0, 3000),
      mergedAt: pull.merged_at ?? null,
      runs: reports,
    };
    // Head-bound compare prevents a slow read from attaching results to another delivery.
    const stored = await this.database.query<{ id: string } & Record<string, unknown>>(
      `UPDATE muse_execution_jobs SET github_ci_state=$4,github_ci_report=$5::jsonb,github_ci_checked_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND status='TURN_FINISHED' AND github_head_sha=$6 AND EXISTS (SELECT 1 FROM workflow_step_executions current_step WHERE current_step.id=muse_execution_jobs.workflow_step_id AND current_step.project_id=muse_execution_jobs.project_id AND current_step.organization_id=muse_execution_jobs.organization_id AND current_step.agent_session_id=muse_execution_jobs.agent_session_id AND current_step.state IN ('RUNNING','WAITING')) RETURNING id`,
      [
        job.id,
        job.project_id,
        job.organization_id,
        state,
        JSON.stringify(report),
        job.github_head_sha,
      ],
    );
    if (!stored.rows[0])
      throw new DomainError(
        "invalid_state",
        "Delivery changed during CI inspection; refresh status.",
      );
    return report;
  }
}

/** Write credential belongs only in the trusted delivery process. Re-read CI before the mutation. */
export class GithubPrReadinessService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly monitor: GithubCiMonitor,
    private readonly deliveryToken: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async markReady(input: { jobId: string; projectId: string }) {
    if (
      process.env.META_API_KEY ||
      !this.deliveryToken ||
      process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true"
    )
      throw new DomainError(
        "forbidden",
        "PR readiness requires a separate trusted delivery process without a Meta credential.",
      );
    const report = await this.monitor.inspect(input);
    if (report.state === "WAITING" || report.state === "PENDING") return report;
    const response = await this.request(
      `https://api.github.com/repos/${report.repository}/pulls/${report.pullNumber}`,
      {
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.deliveryToken}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new DomainError("invalid_state", "Could not recheck the draft PR.");
    const pull = (await response.json()) as GithubPull;
    if (pull.merged_at && pull.head?.sha === report.headSha) return report;
    if (
      pull.head?.sha !== report.headSha ||
      pull.base?.repo?.full_name !== report.repository ||
      pull.state !== "open" ||
      pull.merged_at ||
      !pull.node_id
    )
      throw new DomainError(
        "invalid_state",
        "PR changed before readiness; no review readiness was granted.",
      );
    const shouldBeDraft = report.state === "FAILED";
    if (pull.draft !== shouldBeDraft) {
      const mutationName = shouldBeDraft
        ? "convertPullRequestToDraft"
        : "markPullRequestReadyForReview";
      const ready = await this.request("https://api.github.com/graphql", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.deliveryToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          query: `mutation ReviewState($id: ID!) { ${mutationName}(input: {pullRequestId: $id}) { pullRequest { number isDraft headRefOid } } }`,
          variables: { id: pull.node_id },
        }),
      });
      const mutation = (await ready.json()) as {
        errors?: unknown;
        data?: Record<
          string,
          { pullRequest?: { number?: number; isDraft?: boolean; headRefOid?: string } } | undefined
        >;
      };
      const readyPull = mutation.data?.[mutationName]?.pullRequest;
      if (
        !ready.ok ||
        mutation.errors ||
        readyPull?.number !== report.pullNumber ||
        readyPull.isDraft !== shouldBeDraft ||
        readyPull.headRefOid !== report.headSha
      )
        throw new DomainError(
          "invalid_state",
          "GitHub did not confirm the review state for the delivered head.",
        );
    }
    await this.database.query(
      `UPDATE muse_execution_jobs SET github_review_state=$4,github_review_error=NULL WHERE id=$1 AND project_id=$2 AND github_head_sha=$3 AND github_ci_state=$5`,
      [
        input.jobId,
        input.projectId,
        report.headSha,
        shouldBeDraft ? "DRAFT" : "READY",
        report.state,
      ],
    );
    return report;
  }
}
