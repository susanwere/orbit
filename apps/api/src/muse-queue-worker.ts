/** Separate execution and GitHub delivery entrypoints. Neither process receives the other's credential. */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseLocalWorkerPolicy,
  verifyLocalWorkerSandbox,
  verifyLocalDeliverySandbox,
} from "./modules/execution/local-worker-policy.js";
import { resolve } from "node:path";
import { PgDatabase } from "@orbit/db";
import { MuseGithubDeliveryService } from "./modules/execution/muse-github-delivery.js";
import { MuseExecutionWorker } from "./modules/execution/muse-execution-worker.js";
import {
  MuseCodeCliExecutor,
  LocalMuseProcessRunner,
} from "./modules/execution/muse-code-executor.js";

async function main() {
  const mode = process.argv[2];
  const workspace = process.env.ORBIT_WORKER_WORKSPACE;
  if (
    (mode !== "execute" && mode !== "deliver" && mode !== "check" && mode !== "recover") ||
    process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true" ||
    (mode === "deliver" && process.env.ORBIT_WORKER_SANDBOX_CONFIRMED !== "yes") ||
    !workspace ||
    resolve(workspace) !== workspace ||
    !process.env.DATABASE_URL
  ) {
    throw new Error("Worker requires mode, isolated checkout and database.");
  }
  if (
    (mode === "execute" || mode === "recover") &&
    (!process.env.META_API_KEY || process.env.ORBIT_WORKER_GITHUB_TOKEN)
  ) {
    throw new Error("Execution needs Muse credentials only, never a GitHub token.");
  }
  if (mode === "deliver" && (!process.env.ORBIT_WORKER_GITHUB_TOKEN || process.env.META_API_KEY)) {
    throw new Error("Delivery needs a GitHub token only, never Muse credentials.");
  }
  const policyPath = process.env.ORBIT_WORKER_POLICY;
  const policy = parseLocalWorkerPolicy(JSON.parse(await readFile(policyPath ?? "", "utf8")));
  if (policy) {
    if (mode === "recover" && policy.readOnly !== true)
      throw new Error("Output regeneration requires read-only mounts.");
    if (mode === "deliver") await verifyLocalDeliverySandbox(workspace);
    else await verifyLocalWorkerSandbox(workspace, policy);
    const git = promisify(execFile);
    const gitOptions = {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    };
    const head = (await git("git", ["rev-parse", "HEAD"], gitOptions)).stdout.trim();
    const origin = (await git("git", ["remote", "get-url", "origin"], gitOptions)).stdout.trim();
    if (head !== policy.baseSha || origin !== `https://github.com/${policy.repository}.git`)
      throw new Error("Checkout differs from the pinned repository policy.");
    if (mode === "check") {
      const probe = await new LocalMuseProcessRunner().run(
        [
          "exec",
          "--provider",
          "echo",
          "--trust-workspace",
          "--disable-web-tools",
          "--no-foreign-personal-context",
          "--no-session-log",
          "--contributor-mode",
          "off",
          "--sandbox-network",
          "restricted",
          "--json",
          "--workspace",
          workspace,
          "Local CLI startup probe; do not call tools.",
        ],
        { cwd: workspace, timeoutMs: 30000, maxOutputBytes: 100000 },
      );
      if (probe.exitCode !== 0)
        throw new Error("Muse file-only startup probe failed; no job claimed.");
      process.stdout.write(
        "Docker mount, credential and CLI startup probes passed. No job claimed; no Meta model invoked.\n",
      );
      return;
    }
  }
  const db = new PgDatabase(process.env.DATABASE_URL);
  try {
    if (mode === "execute" || mode === "recover") {
      const shellAllowed =
        process.env.ORBIT_MUSE_ALLOW_SHELL === "true" &&
        mode === "execute" &&
        process.env.ORBIT_MUSE_ISOLATED_WORKER === "true";
      const worker = new MuseExecutionWorker(
        db,
        new MuseCodeCliExecutor(
          new LocalMuseProcessRunner(true),
          shellAllowed ? false : true,
          mode === "recover",
        ),
      );
      const result =
        mode === "recover" && policy
          ? await worker.recoverOutput(workspace, policy)
          : await worker.runNext(workspace, policy ?? undefined);
      if (!result)
        throw new Error(
          "Selected job is no longer eligible. Check approvals, prerequisites and revision feedback; no job claimed.",
        );
      process.stdout.write(`Muse job ${result.jobId} outcome: ${result.status}\n`);
      if (
        result.status !== "TURN_FINISHED" &&
        result.status !== "LEASE_LOST" &&
        result.status !== "OUTPUT_REGENERATED"
      ) {
        process.exitCode = 1;
      }
      return;
    }
    // Explicit job selection: do not deliver some unrelated project's most recent job.
    const jobId = process.env.ORBIT_WORKER_JOB_ID;
    if (!jobId || !/^musejob_[a-zA-Z0-9-]{20,80}$/.test(jobId) || jobId !== policy.jobId) {
      throw new Error("Delivery requires an explicit ORBIT_WORKER_JOB_ID.");
    }
    const job = await db.query<{ project_id: string } & Record<string, unknown>>(
      "SELECT project_id FROM muse_execution_jobs WHERE id=$1 AND status='TURN_FINISHED' AND github_repository IS NULL",
      [jobId],
    );
    if (!job.rows[0]) throw new Error("Job has no pending deliverable.");
    const service = new MuseGithubDeliveryService(db, process.env.ORBIT_WORKER_GITHUB_TOKEN!);
    const delivered = await service.deliver({
      jobId,
      projectId: job.rows[0].project_id,
      workspace,
      baseBranch: process.env.ORBIT_WORKER_BASE_BRANCH ?? "main",
      expectedBaseSha: policy.baseSha,
    });
    process.stdout.write(
      `Delivered ${delivered.jobId} as ${delivered.repository} PR #${delivered.pullNumber}. Await CI verification.\n`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + "\n" : "Worker failed.\n");
  process.exitCode = 1;
});
