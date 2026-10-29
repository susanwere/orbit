import type { SqlDatabase } from "@orbit/db";
import type { PostgresExecutionImpactService } from "./postgres-execution-impact.js";
interface JobRow extends Record<string, unknown> {
  event_id: string;
  attempts: number;
}
interface EventRow extends Record<string, unknown> {
  organization_id: string;
  project_id: string;
  payload: Record<string, unknown>;
}
/** Replays committed context updates independently of request success/failure. */
export class DomainEffectsWorker {
  constructor(
    private readonly db: SqlDatabase,
    private readonly impact: PostgresExecutionImpactService,
  ) {}
  async processBatch(limit = 10): Promise<number> {
    let processed = 0;
    for (let n = 0; n < Math.min(limit, 50); n++) {
      const job = await this.db.transaction(async (tx) => {
        const result = await tx.query<JobRow>(`
          SELECT event_id,attempts FROM domain_effect_jobs
          WHERE (status IN ('pending','failed') AND attempts < 8 AND next_attempt_at<=now())
          OR (status='processing' AND attempts < 8 AND claimed_at<now()-interval '3 minutes')
          ORDER BY next_attempt_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        const item = result.rows[0];
        if (!item) return null;
        await tx.query(
          `UPDATE domain_effect_jobs SET status='processing',
          attempts=attempts+1,claimed_at=now() WHERE event_id=$1`,
          [item.event_id],
        );
        return item;
      });
      if (!job) break;
      try {
        const event = await this.db.query<EventRow>(
          `
          SELECT organization_id,project_id,payload FROM events
          WHERE id=$1 AND type='context.updated'`,
          [job.event_id],
        );
        const row = event.rows[0];
        const before = row?.payload.previousContextVersionId;
        const after = row?.payload.currentContextVersionId;
        if (!row || typeof before !== "string" || typeof after !== "string")
          throw new Error("Missing context event provenance");
        await this.impact.evaluate({
          organizationId: row.organization_id,
          projectId: row.project_id,
          previousContextVersionId: before,
          currentContextVersionId: after,
        });
        await this.db.query(
          `UPDATE domain_effect_jobs SET status='completed',
          completed_at=now(),failure_reason=NULL WHERE event_id=$1 AND status='processing'`,
          [job.event_id],
        );
      } catch (error) {
        // Do not leak event payloads, credentials, or private context to failure records.
        const reason = error instanceof Error ? error.name : "UnknownError";
        await this.db.query(
          `UPDATE domain_effect_jobs SET status='failed',
          failure_reason=$2,next_attempt_at=now()+($3*interval '1 second')
          WHERE event_id=$1 AND status='processing'`,
          [job.event_id, reason.slice(0, 100), Math.min(1800, 2 ** job.attempts)],
        );
      }
      processed++;
    }
    return processed;
  }
}
