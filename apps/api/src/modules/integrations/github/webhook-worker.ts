import type { SqlDatabase } from "@orbit/db";
import { normalizeGitHubWebhook } from "./event-normalizer.js";

interface InboxRow extends Record<string, unknown> {
  id: string; organization_id: string; project_id: string | null;
  delivery_id: string; event_name: string; payload: unknown;
  received_at: Date | string; attempts: number;
}
const MAX_ATTEMPTS = 5;
const toIso = (x: Date | string) => x instanceof Date ? x.toISOString() : x;
export class GithubWebhookWorker {
  constructor(private readonly db: SqlDatabase, private readonly projectScope?: string) {}

  /** Each claimed row and its resulting domain event commit atomically. */
  async processBatch(limit = 20): Promise<number> {
    let processed = 0;
    for (let i = 0; i < Math.min(limit, 100); i++) {
      const didWork = await this.db.transaction(async (tx) => {
        const claimed = await tx.query<InboxRow>(`
          SELECT * FROM webhook_inbox
          WHERE ((status IN ('received','failed') AND attempts < $1
                 AND next_attempt_at <= now())
             OR (status = 'processing' AND claimed_at < now() - interval '2 minutes'
                 AND attempts < $1))
          AND ($2::text IS NULL OR project_id=$2)
          ORDER BY received_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        `, [MAX_ATTEMPTS,this.projectScope??null]);
        const row = claimed.rows[0];
        if (!row) return false;
        await tx.query(`UPDATE webhook_inbox SET status='processing',
          attempts=attempts+1, claimed_at=now() WHERE id=$1`, [row.id]);
        try {
          if (!row.project_id) throw new Error("Webhook has no verified project mapping");
          const event = normalizeGitHubWebhook({
            organizationId: row.organization_id,
            projectId: row.project_id,
            deliveryId: row.delivery_id,
            eventName: row.event_name,
            payload: row.payload,
            receivedAt: toIso(row.received_at),
          });
          if (event) {
            await tx.query(`INSERT INTO events(
              id,organization_id,project_id,type,occurred_at,correlation_id,
              causation_id,actor_type,actor_id,entity_type,entity_id,payload
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
            ON CONFLICT(id) DO NOTHING`, [
              event.id,event.organizationId,event.projectId,event.type,event.occurredAt,
              event.correlationId,event.causationId,event.actor.type,event.actor.id,
              event.entityType,event.entityId,JSON.stringify({
                ...event.payload, sourceArtifact: event.sourceArtifact,
              }),
            ]);
            await tx.query(`INSERT INTO decision_analysis_jobs (event_id,organization_id,project_id)
              VALUES ($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`,
              [event.id,event.organizationId,event.projectId]);
          }
          await tx.query(`UPDATE webhook_inbox
            SET status=$2,processed_at=now(),failure_reason=NULL WHERE id=$1`,
          [row.id,event ? "processed" : "ignored"]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown processing error";
          await tx.query(`UPDATE webhook_inbox SET status='failed', failure_reason=$2,
            next_attempt_at=now()+($3 * interval '1 second')
            WHERE id=$1`, [row.id,reason.slice(0,500),Math.min(300,2 ** row.attempts)]);
        }
        return true;
      });
      if (!didWork) break;
      processed++;
    }
    return processed;
  }
}
