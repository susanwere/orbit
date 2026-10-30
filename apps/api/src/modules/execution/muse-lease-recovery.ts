import type { SqlDatabase } from "@orbit/db";

/**
 * Crash recovery for jobs whose worker lease has expired.
 * Fail closed: never automatically replay code changes or grant a fresh session.
 * A human must authorize a new execution attempt.
 */
export class MuseLeaseRecoveryService {
  constructor(private readonly db: SqlDatabase) {}

  async recoverExpired(limit = 50): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid recovery batch size.");
    return this.db.transaction(async (tx) => {
      const claims = await tx.query<{
        id: string;
        project_id: string;
        agent_session_id: string;
        workflow_step_id: string;
      } & Record<string, unknown>>(
        `SELECT id,project_id,agent_session_id,workflow_step_id
         FROM muse_execution_jobs WHERE status='RUNNING'
           AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
         ORDER BY lease_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      for (const job of claims.rows) {
        const updated = await tx.query<{ id: string } & Record<string, unknown>>(
          `UPDATE muse_execution_jobs SET status='FAILED',
             failure_reason='Worker lease expired; execution requires human review.',
             finished_at=now(),lease_expires_at=NULL
           WHERE id=$1 AND project_id=$2 AND status='RUNNING'
           RETURNING id`,
          [job.id, job.project_id],
        );
        if (!updated.rows[0]) continue;
        await tx.query(
          `UPDATE agent_sessions SET state='FAILED',ended_at=now()
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.agent_session_id, job.project_id],
        );
        await tx.query(
          `UPDATE workflow_step_executions SET state='FAILED'
           WHERE id=$1 AND project_id=$2 AND state='RUNNING'`,
          [job.workflow_step_id, job.project_id],
        );
      }
      return claims.rows.length;
    });
  }
}
