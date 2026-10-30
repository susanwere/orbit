import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

const execFile = promisify(execFileCallback);
export interface GitCommand {
  (args: string[], cwd: string): Promise<string>;
}
const gitCommand: GitCommand = async (args, cwd) => {
  const result = await execFile("git", args, {
    cwd,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" },
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
}

function permitted(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern || pattern.startsWith("/") || pattern.includes("..") || pattern.includes("\\"))
      return false;
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3) + "/");
    return file === pattern;
  });
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
    private readonly git: GitCommand = gitCommand,
    private readonly request: typeof fetch = fetch,
  ) {}

  async deliver(input: {
    jobId: string;
    projectId: string;
    workspace: string;
    baseBranch: string;
  }) {
    if (process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true" || !this.token)
      throw new DomainError("forbidden", "Trusted isolated delivery is required.");
    if (!isAbsolute(input.workspace) || resolve(input.workspace) !== input.workspace)
      throw new DomainError("validation", "An absolute disposable checkout is required.");
    if (!/^[A-Za-z0-9._/-]+$/.test(input.baseBranch) || input.baseBranch.includes(".."))
      throw new DomainError("validation", "Invalid base branch.");

    const record = await this.db.query<DeliveryJob>(
      `SELECT job.id,job.organization_id,job.project_id,job.workflow_step_id,
         job.agent_session_id,job.status,contract.allowed_repositories,contract.allowed_paths
       FROM muse_execution_jobs job
       JOIN agent_sessions session ON session.id=job.agent_session_id
         AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN execution_contracts contract ON contract.id=session.execution_contract_id
         AND contract.project_id=session.project_id AND contract.organization_id=session.organization_id
       JOIN workflow_step_executions step ON step.id=job.workflow_step_id
         AND step.project_id=job.project_id AND step.organization_id=job.organization_id
       WHERE job.id=$1 AND job.project_id=$2 AND job.status='TURN_FINISHED'
         AND job.github_repository IS NULL AND session.state='RUNNING'
         AND step.state='RUNNING'
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
    const base = (await this.git(["rev-parse", input.baseBranch], input.workspace)).trim();
    if (!/^[0-9a-f]{40}$/.test(base))
      throw new DomainError("invalid_state", "Base commit must be pinned locally.");
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
    for (const path of changed) {
      const absolute = resolve(input.workspace, path);
      if (
        relative(input.workspace, absolute).startsWith("..") ||
        !permitted(path, job.allowed_paths) ||
        path.startsWith(".git/")
      )
        throw new DomainError("forbidden", "Generated changes exceed granted paths.");
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 300000)
        throw new DomainError("forbidden", "Only bounded regular files may be delivered.");
    }

    const branch = `orbit/muse-${job.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
    await this.git(["checkout", "-b", branch, base], input.workspace);
    await this.git(["add", "--", ...changed], input.workspace);
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z"], input.workspace))
      .split("\0")
      .filter(Boolean);
    if (staged.length !== changed.length || staged.some((p) => !changed.includes(p)))
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

    const response = await this.request(`https://api.github.com/repos/${repository}/pulls`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `Orbit Muse execution ${job.id}`,
        head: branch,
        base: input.baseBranch,
        body: `Generated by the isolated Orbit worker for job ${job.id}. Human review required.`,
      }),
    });
    if (!response.ok) throw new DomainError("invalid_state", "GitHub PR delivery failed.");
    const pull = (await response.json()) as { number?: number; head?: { sha?: string } };
    if (
      !Number.isSafeInteger(pull.number) ||
      !pull.number ||
      pull.number < 1 ||
      pull.head?.sha !== head
    )
      throw new DomainError("invalid_state", "GitHub PR head does not match delivered commit.");

    const bound = await this.db.query<{ id: string } & Record<string, unknown>>(
      `UPDATE muse_execution_jobs SET github_repository=$3,github_pull_number=$4,github_head_sha=$5
       WHERE id=$1 AND project_id=$2 AND organization_id=$6
         AND status='TURN_FINISHED' AND github_repository IS NULL
       RETURNING id`,
      [job.id, job.project_id, repository, pull.number, head, job.organization_id],
    );
    if (!bound.rows[0]) throw new DomainError("invalid_state", "Delivery binding conflict.");
    return { jobId: job.id, repository, pullNumber: pull.number, headSha: head };
  }
}
