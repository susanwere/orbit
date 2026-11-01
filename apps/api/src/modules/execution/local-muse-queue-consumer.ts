import type { SqlDatabase } from "@orbit/db";

export interface LocalMuseJobRunner {
  prepare(jobId: string): Promise<void>;
  execute(jobId: string): Promise<void>;
}

/** Trusted host only: consumes explicit browser requests, never arbitrary queued jobs. */
export class LocalMuseQueueConsumer {
  constructor(
    private readonly database: SqlDatabase,
    private readonly runner: LocalMuseJobRunner,
  ) {}

  async recoverInterruptedRequests(projectId: string): Promise<void> {
    const interrupted = await this.database.query<{ id: string } & Record<string, unknown>>(
      `SELECT id FROM muse_execution_jobs WHERE project_id=$1 AND status='QUEUED' AND attempts=0 AND local_execution_state IN ('PREPARING','RUNNING')`,
      [projectId],
    );
    for (const job of interrupted.rows)
      await this.database.transaction(async (transaction) => {
        const locked = await transaction.query<{ acquired: boolean } & Record<string, unknown>>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
          [`orbit:local-muse:${job.id}`],
        );
        if (locked.rows[0]?.acquired)
          await transaction.query(
            `UPDATE muse_execution_jobs SET local_execution_state='ERROR',local_execution_error='The local consumer stopped before the job started. Retry local setup to continue.'
        WHERE id=$1 AND project_id=$2 AND status='QUEUED' AND attempts=0 AND local_execution_state IN ('PREPARING','RUNNING')`,
            [job.id, projectId],
          );
      });
  }

  async runNext(projectId: string): Promise<string | null> {
    await this.recoverInterruptedRequests(projectId);
    const candidates = await this.database.query<{ id: string } & Record<string, unknown>>(
      `SELECT job.id FROM muse_execution_jobs job
       JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN execution_contracts contract ON contract.id=session.execution_contract_id AND contract.project_id=job.project_id AND contract.organization_id=job.organization_id
       WHERE job.project_id=$1 AND job.status='QUEUED' AND job.local_execution_state='REQUESTED'
         AND contract.allowed_repositories='["susanwere/private-test"]'::jsonb
       ORDER BY job.local_execution_requested_at,job.id LIMIT 1`,
      [projectId],
    );
    const candidate = candidates.rows[0];
    if (!candidate) return null;
    return this.database.transaction(async (transaction) => {
      // Hold only an advisory lock, not the job row: the Docker worker must claim it independently.
      const locked = await transaction.query<{ acquired: boolean } & Record<string, unknown>>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [`orbit:local-muse:${candidate.id}`],
      );
      if (!locked.rows[0]?.acquired) return null;
      const preparing = await this.database.query<{ id: string } & Record<string, unknown>>(
        `UPDATE muse_execution_jobs SET local_execution_state='PREPARING',local_execution_error=NULL
         WHERE id=$1 AND project_id=$2 AND status='QUEUED' AND attempts=0 AND local_execution_state='REQUESTED' RETURNING id`,
        [candidate.id, projectId],
      );
      if (!preparing.rows[0]) return null;
      try {
        await this.runner.prepare(candidate.id);
        const active = await this.database.query<{ id: string } & Record<string, unknown>>(
          `UPDATE muse_execution_jobs SET local_execution_state='RUNNING'
           WHERE id=$1 AND project_id=$2 AND status='QUEUED' AND local_execution_state='PREPARING' RETURNING id`,
          [candidate.id, projectId],
        );
        if (!active.rows[0]) return candidate.id;
        await this.runner.execute(candidate.id);
        const finished = await this.database.query<{ id: string } & Record<string, unknown>>(
          `UPDATE muse_execution_jobs SET local_execution_state='FINISHED',local_execution_error=NULL
           WHERE id=$1 AND project_id=$2 AND status='TURN_FINISHED' AND local_execution_state='RUNNING' RETURNING id`,
          [candidate.id, projectId],
        );
        if (!finished.rows[0]) throw new Error("Execution did not produce a finished turn.");
      } catch {
        // Provider/child-process errors may contain credentials or private output.
        await this.database.query(
          `UPDATE muse_execution_jobs SET local_execution_state='ERROR',local_execution_error=$3
           WHERE id=$1 AND project_id=$2 AND local_execution_state IN ('PREPARING','RUNNING')`,
          [
            candidate.id,
            projectId,
            "Local execution could not finish. Check Docker, the disposable checkout and step prerequisites. Retry local setup only if the job is still queued; failed executions require an authorized new attempt.",
          ],
        );
      }
      return candidate.id;
    });
  }
}
