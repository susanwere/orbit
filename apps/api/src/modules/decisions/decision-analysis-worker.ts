import type { SqlDatabase } from "@orbit/db";
import type { DecisionAnalysisService } from "./decision-analysis-service.js";

interface Job extends Record<string, unknown> { event_id: string; attempts: number }
export class DecisionAnalysisWorker {
  constructor(private readonly db: SqlDatabase, private readonly analysis: DecisionAnalysisService,
    private readonly projectScope?:string) {}

  async processBatch(limit = 10): Promise<number> {
    let count = 0;
    for (let n = 0; n < Math.min(limit, 50); n++) {
      // Claim in a short transaction so network inference never holds a database lock.
      const job = await this.db.transaction(async tx => {
        const result = await tx.query<Job>(`SELECT event_id, attempts FROM decision_analysis_jobs
          WHERE (status IN ('pending','failed') AND attempts < 5 AND next_attempt_at <= now())
          OR (status='processing' AND attempts < 5 AND claimed_at < now() - interval '2 minutes')
          AND ($1::text IS NULL OR project_id=$1)
          ORDER BY next_attempt_at, event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [this.projectScope??null]);
        const item = result.rows[0];
        if (!item) return null;
        await tx.query(`UPDATE decision_analysis_jobs SET status='processing', attempts=attempts+1,
          claimed_at=now() WHERE event_id=$1`,[item.event_id]);
        return item;
      });
      if (!job) break;
      try {
        const status = await this.analysis.analyze(job.event_id);
        await this.db.query(`UPDATE decision_analysis_jobs SET status=$2,
          completed_at=now(),failure_reason=NULL WHERE event_id=$1 AND status='processing'`,
          [job.event_id,status]);
      } catch (error) {
        // Never persist raw model content, request details or provider secrets.
        const reason = error instanceof Error ? error.name : "Unknown";
        await this.db.query(`UPDATE decision_analysis_jobs
          SET status='failed', failure_reason=$2,
          next_attempt_at=now()+($3 * interval '1 second')
          WHERE event_id=$1 AND status='processing'`,
          [job.event_id,reason.slice(0,100),Math.min(300,2 ** job.attempts)]);
      }
      count++;
    }
    return count;
  }
}
