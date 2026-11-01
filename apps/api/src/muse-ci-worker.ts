/** Trusted delivery subprocess: no repository scripts, checkout execution or Meta credential. */
import { PgDatabase } from "@orbit/db";
import {
  GithubCiMonitor,
  GithubPrReadinessService,
} from "./modules/execution/github-ci-monitor.js";

async function main() {
  const projectId = process.argv.find((argument) => argument.startsWith("--project="))?.slice(10);
  if (
    !projectId ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(projectId) ||
    !process.env.DATABASE_URL ||
    !process.env.ORBIT_GITHUB_EVIDENCE_TOKEN ||
    !process.env.ORBIT_WORKER_GITHUB_TOKEN ||
    process.env.META_API_KEY
  )
    throw new Error(
      "CI monitoring needs a project, database and separate read/write GitHub credentials, never a Meta key.",
    );
  const database = new PgDatabase(process.env.DATABASE_URL);
  try {
    const jobs = await database.query<{ id: string } & Record<string, unknown>>(
      `SELECT job.id FROM muse_execution_jobs job JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id AND step.agent_session_id=job.agent_session_id WHERE job.project_id=$1 AND job.status='TURN_FINISHED' AND job.github_repository='susanwere/private-test' AND step.state='RUNNING' AND (job.github_ci_checked_at IS NULL OR job.github_ci_checked_at < now()-interval '30 seconds') ORDER BY job.github_ci_checked_at NULLS FIRST LIMIT 1`,
      [projectId],
    );
    const job = jobs.rows[0];
    if (!job) return;
    await database.transaction(async (transaction) => {
      const lock = await transaction.query<{ acquired: boolean } & Record<string, unknown>>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [`orbit:muse-ci:${job.id}`],
      );
      if (!lock.rows[0]?.acquired) return;
      try {
        const monitor = new GithubCiMonitor(database, process.env.ORBIT_GITHUB_EVIDENCE_TOKEN!);
        await new GithubPrReadinessService(
          database,
          monitor,
          process.env.ORBIT_WORKER_GITHUB_TOKEN!,
        ).markReady({ jobId: job.id, projectId });
      } catch {
        await database.query(
          `UPDATE muse_execution_jobs SET github_review_state='ERROR',github_review_error='CI/readiness could not be independently checked. Check repository access, Actions/Pull requests read permissions and delivery Pull requests write permission. The workflow remains incomplete.',github_ci_checked_at=now() WHERE id=$1 AND project_id=$2 AND status='TURN_FINISHED'`,
          [job.id, projectId],
        );
      }
    });
  } finally {
    await database.close();
  }
}
main().catch(() => {
  process.stderr.write(
    "CI monitor could not run; check private configuration. No model, push or merge was started.\n",
  );
  process.exitCode = 1;
});
