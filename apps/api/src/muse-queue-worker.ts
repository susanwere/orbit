/** Separate execution and GitHub delivery entrypoints. Neither process receives the other's credential. */
import { resolve } from "node:path";
import { PgDatabase } from "@orbit/db";
import { MuseGithubDeliveryService } from "./modules/execution/muse-github-delivery.js";
import { MuseExecutionWorker } from "./modules/execution/muse-execution-worker.js";
import { MuseCodeCliExecutor, LocalMuseProcessRunner } from "./modules/execution/muse-code-executor.js";

async function main() {
  const mode = process.argv[2];
  const workspace = process.env.ORBIT_WORKER_WORKSPACE;
  if (
    (mode !== "execute" && mode !== "deliver") ||
    process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true" ||
    process.env.ORBIT_WORKER_SANDBOX_CONFIRMED !== "yes" ||
    !workspace ||
    resolve(workspace) !== workspace ||
    !process.env.DATABASE_URL
  ) {
    throw new Error("Worker requires mode, isolated checkout and database.");
  }
  if (mode === "execute" && (!process.env.META_API_KEY || process.env.ORBIT_WORKER_GITHUB_TOKEN))
    throw new Error("Execution needs Muse credentials only, never a GitHub token.");
  if (mode === "deliver" && (!process.env.ORBIT_WORKER_GITHUB_TOKEN || process.env.META_API_KEY))
    throw new Error("Delivery needs a GitHub token only, never Muse credentials.");
  const db = new PgDatabase(process.env.DATABASE_URL);
  try {
    if (mode === "execute") {
      const worker = new MuseExecutionWorker(
        db,
        new MuseCodeCliExecutor(new LocalMuseProcessRunner()),
      );
      const result = await worker.runNext(workspace);
      if (!result) return process.stdout.write("No eligible queued Muse execution.\n");
      process.stdout.write(
        `Muse outcome: ${result.status}; independent delivery and CI verification required.\n`,
      );
      if (result.status !== "TURN_FINISHED" && result.status !== "LEASE_LOST") {
        process.exitCode = 1;
      }
      return;
    }
    // Explicit job selection: do not deliver some unrelated project's most recent job.
    const jobId = process.env.ORBIT_WORKER_JOB_ID;
    if (!jobId || !/^musejob_[a-zA-Z0-9-]{20,80}$/.test(jobId))
      throw new Error("Delivery requires an explicit ORBIT_WORKER_JOB_ID.");
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
