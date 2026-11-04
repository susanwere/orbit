import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import { permittedRepositoryPath } from "./repository-path-policy.js";

const execFile = promisify(execFileCallback);
export interface GitCommand {
  (args: string[], cwd: string): Promise<string>;
}
const gitCommand =
  (token: string): GitCommand =>
  async (args, cwd) => {
    const result = await execFile("git", args, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_2: "core.fsmonitor",
        GIT_CONFIG_VALUE_2: "false",
        GIT_CONFIG_KEY_1: "core.hooksPath",
        GIT_CONFIG_VALUE_1: "/dev/null",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0:
          "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64"),
      },
    });
    return result.stdout;
  };

interface DeliveryJob extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  workflow_step_id: string;
  agent_session_id: string;
  allowed_repositories: string[];
  allowed_paths: string[];
  status: string;
  changed_paths: string[];
  repair_source_job_id: string | null;
  repair_pull_number: number | null;
  repair_head_sha: string | null;
  repair_repository: string | null;
}

/** A CI repair may update versions, but removing dependencies needs separate human review. */
export function assertRepairPreservesDependencies(
  originalManifest: string,
  repairedManifest: string,
): void {
  const originalPackage: unknown = JSON.parse(originalManifest);
  const repairedPackage: unknown = JSON.parse(repairedManifest);
  if (
    !originalPackage ||
    typeof originalPackage !== "object" ||
    Array.isArray(originalPackage) ||
    !repairedPackage ||
    typeof repairedPackage !== "object" ||
    Array.isArray(repairedPackage)
  )
    throw new DomainError("validation", "CI repair requires valid package manifests.");
  for (const category of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const originalDependencies: unknown = Reflect.get(originalPackage, category);
    const repairedDependencies: unknown = Reflect.get(repairedPackage, category);
    if (!originalDependencies || typeof originalDependencies !== "object") continue;
    for (const dependency of Object.keys(originalDependencies)) {
      if (
        !repairedDependencies ||
        typeof repairedDependencies !== "object" ||
        !Object.hasOwn(repairedDependencies, dependency)
      )
        throw new DomainError(
          "forbidden",
          "CI repair removed a declared dependency. Preserve the implementation and repair its dependency setup, or request separate human review.",
        );
    }
  }
}

/**
 * Runs only in an independently isolated delivery worker with a disposable
 * checkout and restricted GitHub credentials. Never callable by HTTP clients.
 * The caller is responsible for OS-level mount and network isolation.
 */
export class MuseGithubDeliveryService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly token: string,
    git?: GitCommand,
    private readonly request: typeof fetch = fetch,
  ) {
    this.git = git ?? gitCommand(token);
  }

  private readonly git: GitCommand;

  async deliver(input: {
    jobId: string;
    projectId: string;
    workspace: string;
    baseBranch: string;
    expectedBaseSha?: string;
  }) {
    if (process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true" || !this.token)
      throw new DomainError("forbidden", "Trusted isolated delivery is required.");
    if (!isAbsolute(input.workspace) || resolve(input.workspace) !== input.workspace)
      throw new DomainError("validation", "An absolute disposable checkout is required.");
    if (
      !/^[A-Za-z0-9._/-]+$/.test(input.baseBranch) ||
      input.baseBranch.includes("..") ||
      input.baseBranch.startsWith("-")
    )
      throw new DomainError("validation", "Invalid base branch.");

    const record = await this.db.query<DeliveryJob>(
      `SELECT job.id,job.organization_id,job.project_id,job.workflow_step_id,
         job.agent_session_id,job.status,contract.allowed_repositories,contract.allowed_paths,output.changed_paths,job.repair_source_job_id,source.github_pull_number AS repair_pull_number,source.github_head_sha AS repair_head_sha,source.github_repository AS repair_repository
       FROM muse_execution_jobs job
       JOIN agent_sessions session ON session.id=job.agent_session_id
         AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN execution_contracts contract ON contract.id=session.execution_contract_id
         AND contract.project_id=session.project_id AND contract.organization_id=session.organization_id
       JOIN workflow_step_executions step ON step.id=job.workflow_step_id
         AND step.project_id=job.project_id AND step.organization_id=job.organization_id
       JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=job.project_id AND plan.organization_id=job.organization_id
       JOIN muse_job_outputs output ON output.job_id=job.id AND output.project_id=job.project_id AND output.organization_id=job.organization_id AND output.source='execution'
       LEFT JOIN muse_execution_jobs source ON source.id=job.repair_source_job_id AND source.project_id=job.project_id AND source.organization_id=job.organization_id AND source.workflow_step_id=job.workflow_step_id AND source.status='FAILED' AND source.github_ci_state='FAILED'
       JOIN principals requester ON requester.id=job.delivery_requested_by_principal_id AND requester.organization_id=job.organization_id AND requester.type='human' AND requester.role IN ('admin','member')
       WHERE job.id=$1 AND job.project_id=$2 AND job.status='TURN_FINISHED'
         AND job.github_repository IS NULL AND session.state='RUNNING'
         AND step.state='RUNNING' AND step.agent_session_id=session.id AND step.completion_kind='github_ci'
         AND job.delivery_state='RUNNING' AND plan.status='APPROVED' AND plan.revision=step.plan_revision
         AND (step.approval_required=false OR step.approved_by_principal_id IS NOT NULL)
         AND (session.requested_by_principal_id=requester.id OR session.human_owner_principal_id=requester.id OR requester.role='admin')
         AND EXISTS (SELECT 1 FROM project_repositories repository WHERE repository.project_id=job.project_id AND repository.organization_id=job.organization_id AND repository.full_name=contract.allowed_repositories->>0)
         AND NOT EXISTS (
           SELECT 1 FROM workflow_step_prerequisites dependency JOIN workflow_step_executions prior
           ON prior.id=dependency.prerequisite_step_id AND prior.project_id=dependency.project_id AND prior.organization_id=dependency.organization_id
           WHERE dependency.step_id=step.id AND dependency.project_id=step.project_id AND dependency.organization_id=step.organization_id
             AND (prior.state <> 'COMPLETED' OR prior.plan_id <> step.plan_id))
         AND NOT EXISTS (
           SELECT 1 FROM human_gates gate WHERE gate.project_id=job.project_id
             AND gate.organization_id=job.organization_id AND gate.agent_session_id=job.agent_session_id
             AND gate.status='OPEN'
         )`,
      [input.jobId, input.projectId],
    );
    const job = record.rows[0];
    if (
      !job ||
      !Array.isArray(job.allowed_repositories) ||
      job.allowed_repositories.length !== 1 ||
      !Array.isArray(job.allowed_paths) ||
      job.allowed_paths.length === 0
    ) {
      throw new DomainError("invalid_state", "Job is not eligible for trusted delivery.");
    }
    const repository = job.allowed_repositories[0];
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new DomainError("validation", "Invalid contracted repository.");

    const origin = (await this.git(["remote", "get-url", "origin"], input.workspace)).trim();
    const acceptedOrigins = [
      `https://github.com/${repository}.git`,
      `https://github.com/${repository}`,
      `git@github.com:${repository}.git`,
    ];
    if (!acceptedOrigins.includes(origin))
      throw new DomainError("forbidden", "Checkout origin does not match the execution contract.");
    const base = (
      await this.git(["rev-parse", input.expectedBaseSha ?? input.baseBranch], input.workspace)
    ).trim();
    if (
      !/^[0-9a-f]{40}$/.test(base) ||
      (input.expectedBaseSha !== undefined && base !== input.expectedBaseSha)
    )
      throw new DomainError("invalid_state", "Base commit must be pinned locally.");
    if ((await this.git(["rev-parse", "HEAD"], input.workspace)).trim() !== base)
      throw new DomainError("invalid_state", "Checkout is no longer at the pinned execution base.");
    const changed = (
      await this.git(
        ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
        input.workspace,
      )
    )
      .split("\0")
      .filter(Boolean);
    const deleted = (await this.git(["ls-files", "--deleted", "-z"], input.workspace))
      .split("\0")
      .filter(Boolean);
    const stagedBefore = (
      await this.git(["diff", "--cached", "--name-only", "-z"], input.workspace)
    )
      .split("\0")
      .filter(Boolean);
    if (deleted.length || stagedBefore.length)
      throw new DomainError("forbidden", "Deleted or pre-staged files require separate review.");
    if (!changed.length || changed.length > 250)
      throw new DomainError("invalid_state", "Expected 1 to 250 changed files.");
    if (
      !Array.isArray(job.changed_paths) ||
      changed.length !== job.changed_paths.length ||
      changed.some((path) => !job.changed_paths.includes(path))
    )
      throw new DomainError(
        "invalid_state",
        "Checkout changes differ from the retained execution output. Review them before delivery.",
      );
    for (const path of changed) {
      const absolute = resolve(input.workspace, path);
      if (
        relative(input.workspace, absolute).startsWith("..") ||
        !permittedRepositoryPath(path, job.allowed_paths) ||
        path.startsWith(".git/")
      )
        throw new DomainError("forbidden", "Generated changes exceed granted paths.");
      const info = await lstat(absolute);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (await realpath(absolute)) !== absolute ||
        info.size > 300000
      )
        throw new DomainError("forbidden", "Only bounded regular files may be delivered.");
    }

    if (job.repair_source_job_id) {
      for (const path of changed.filter(
        (path) => path === "package.json" || path.endsWith("/package.json"),
      )) {
        const originalManifest = await this.git(["show", `${base}:${path}`], input.workspace);
        const repairedManifest = await readFile(resolve(input.workspace, path), "utf8");
        assertRepairPreservesDependencies(originalManifest, repairedManifest);
      }
    }

    let branch = `orbit/muse-${job.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
    if (job.repair_source_job_id) {
      if (
        !job.repair_pull_number ||
        job.repair_repository !== repository ||
        job.repair_head_sha !== base
      )
        throw new DomainError("invalid_state", "Repair delivery has no matching failed PR base.");
      const previous = await this.request(
        `https://api.github.com/repos/${repository}/pulls/${job.repair_pull_number}`,
        {
          redirect: "error",
          headers: { Authorization: "Bearer " + this.token, Accept: "application/vnd.github+json" },
        },
      );
      const previousPull = (await previous.json()) as {
        state?: string;
        merged_at?: string | null;
        head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
        base?: { repo?: { full_name?: string } };
      };
      if (
        !previous.ok ||
        previousPull.state !== "open" ||
        previousPull.merged_at ||
        previousPull.head?.sha !== base ||
        previousPull.head.repo?.full_name !== repository ||
        previousPull.base?.repo?.full_name !== repository ||
        !previousPull.head.ref ||
        !/^orbit\/muse-[A-Za-z0-9_-]+$/.test(previousPull.head.ref)
      )
        throw new DomainError(
          "invalid_state",
          "Failed PR changed before repair delivery; reconcile it instead of overwriting changes.",
        );
      branch = previousPull.head.ref;
      if ((await this.git(["branch", "--show-current"], input.workspace)).trim() !== branch)
        throw new DomainError("invalid_state", "Repair checkout is not on its original PR branch.");
    } else await this.git(["checkout", "-b", branch, base], input.workspace);
    await this.git(["add", "--", ...changed], input.workspace);
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z"], input.workspace))
      .split("\0")
      .filter(Boolean);
    if (staged.length !== changed.length || staged.some((path) => !changed.includes(path)))
      throw new DomainError("invalid_state", "Staged changes did not match validated files.");
    await this.git(
      [
        "-c",
        "user.name=Orbit Worker",
        "-c",
        "user.email=orbit-worker@users.noreply.github.com",
        "commit",
        "-m",
        `Orbit Muse execution ${job.id}`,
      ],
      input.workspace,
    );
    const head = (await this.git(["rev-parse", "HEAD"], input.workspace)).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new DomainError("invalid_state", "Invalid commit SHA.");
    await this.git(["push", "origin", `HEAD:refs/heads/${branch}`], input.workspace);

    const response = job.repair_source_job_id
      ? await this.request(
          `https://api.github.com/repos/${repository}/pulls/${job.repair_pull_number}`,
          {
            redirect: "error",
            headers: {
              Authorization: "Bearer " + this.token,
              Accept: "application/vnd.github+json",
            },
          },
        )
      : await this.request(`https://api.github.com/repos/${repository}/pulls`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.token,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            draft: true,
            title: `Orbit Muse execution ${job.id}`,
            head: branch,
            base: input.baseBranch,
            body: `Generated by the isolated Orbit worker for job ${job.id}. Human review required.`,
          }),
        });
    if (!response.ok) throw new DomainError("invalid_state", "GitHub PR delivery failed.");
    let pull = (await response.json()) as {
      number?: number;
      draft?: boolean;
      head?: { sha?: string };
    };
    // A push can finish before GitHub's PR endpoint reflects the repaired head.
    // Re-read only the same repair PR; never push again or accept a different commit.
    for (
      let attempt = 0;
      job.repair_source_job_id && pull.head?.sha !== head && attempt < 3;
      attempt++
    ) {
      await delay(250 * (attempt + 1));
      const confirmation = await this.request(
        `https://api.github.com/repos/${repository}/pulls/${job.repair_pull_number}`,
        {
          redirect: "error",
          headers: { Authorization: "Bearer " + this.token, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!confirmation.ok)
        throw new DomainError("invalid_state", "Could not confirm the repaired PR head.");
      pull = (await confirmation.json()) as typeof pull;
    }
    if (
      !Number.isSafeInteger(pull.number) ||
      !pull.number ||
      pull.number < 1 ||
      (job.repair_source_job_id ? pull.number !== job.repair_pull_number : pull.draft !== true) ||
      pull.head?.sha !== head
    )
      throw new DomainError("invalid_state", "GitHub PR head does not match delivered commit.");

    const bound = await this.db.query<{ id: string } & Record<string, unknown>>(
      `UPDATE muse_execution_jobs SET github_repository=$3,github_pull_number=$4,github_head_sha=$5,github_review_state=$7
       WHERE id=$1 AND project_id=$2 AND organization_id=$6
         AND status='TURN_FINISHED' AND github_repository IS NULL
       RETURNING id`,
      [
        job.id,
        job.project_id,
        repository,
        pull.number,
        head,
        job.organization_id,
        pull.draft === false ? "READY" : "DRAFT",
      ],
    );
    if (!bound.rows[0]) throw new DomainError("invalid_state", "Delivery binding conflict.");
    return { jobId: job.id, repository, pullNumber: pull.number, headSha: head };
  }
}
