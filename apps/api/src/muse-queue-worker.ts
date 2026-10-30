/**
 * One-job worker entrypoint. Must run inside an independently provisioned
 * sandbox with a disposable, prechecked checkout and restricted credentials.
 * This program does not create the OS sandbox.
 */
import { resolve } from "node:path";
import { PgDatabase } from "@orbit/db";
import { MuseGithubDeliveryService } from "./modules/execution/muse-github-delivery.js";
import { MuseExecutionWorker } from "./modules/execution/muse-execution-worker.js";
import {
  MuseCodeCliExecutor,
  LocalMuseProcessRunner,
} from "./modules/execution/muse-code-executor.js";

async function main() {
  const workspace = process.env.ORBIT_WORKER_WORKSPACE;
  const url = process.env.DATABASE_URL;
  const token = process.env.ORBIT_WORKER_GITHUB_TOKEN;
  const baseBranch = process.env.ORBIT_WORKER_BASE_BRANCH ?? "main";
  if (
    process.env.ORBIT_MUSE_ISOLATED_WORKER !== "true" ||
    process.env.ORBIT_WORKER_SANDBOX_CONFIRMED !== "yes" ||
    !workspace ||
    resolve(workspace) !== workspace ||
    !url ||
    !token ||
    !process.env.META_API_KEY
  ) {
    throw new Error(
      "Worker requires a provisioned isolated checkout, database and private credentials.",
    );
  }
  const db = new PgDatabase(url);
  try {
    const worker = new MuseExecutionWorker(
      db,
      new MuseCodeCliExecutor(new LocalMuseProcessRunner()),
    );
    const result = await worker.runNext(workspace);
    if (!result) {
      process.stdout.write("No eligible queued Muse execution.\n");
      return;
    }
    if (result.status !== "TURN_FINISHED") {
      process.stdout.write(`Muse execution outcome: ${result.status}. No delivery attempted.\n`);
      if (result.status !== "LEASE_LOST") process.exitCode = 1;
      return;
    }
    const job = await db.query<{ project_id: string } & Record<string, unknown>>(
      "SELECT project_id FROM muse_execution_jobs WHERE id=$1 AND status='TURN_FINISHED'",
      [result.jobId],
    );
    const projectId = job.rows[0]?.project_id;
    if (!projectId) throw new Error("Job has no deliverable project.");
    const delivery = new MuseGithubDeliveryService(db, token);
    const delivered = await delivery.deliver({
      jobId: result.jobId,
      projectId,
      workspace,
      baseBranch,
    });
    process.stdout.write(
      `Delivered job ${delivered.jobId} as ${delivered.repository} PR #${delivered.pullNumber}. Await independent CI evidence.\n`,
    );
  } finally {
    await db.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + "\n" : "Worker failed.\n");
  process.exitCode = 1;
});
