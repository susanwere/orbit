import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

export interface StreamEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}
interface EventRow extends Record<string, unknown> {
  id: string;
  type: string;
  occurred_at: Date | string;
  payload: unknown;
}
const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : value;

/** Durable store is the source of truth; live SSE only reads committed rows. */
export class ProjectEventStream {
  constructor(private readonly db: SqlDatabase) {}

  async cursor(projectId: string, eventId: string): Promise<{ at: string; id: string }> {
    const result = await this.db.query<EventRow>(
      "SELECT id, type, occurred_at, payload FROM events WHERE project_id = $1 AND id = $2",
      [projectId, eventId],
    );
    const event = result.rows[0];
    if (!event) throw new DomainError("validation", "Invalid Last-Event-ID for this project.");
    return { at: iso(event.occurred_at), id: event.id };
  }

  async read(
    projectId: string,
    after: { at: string; id: string } | null,
    limit = 100,
  ): Promise<{ events: StreamEvent[]; cursor: { at: string; id: string } | null }> {
    const rows = await this.db.query<EventRow>(
      `SELECT id, type, occurred_at, payload FROM events
       WHERE project_id = $1
         AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::text))
       ORDER BY occurred_at ASC, id ASC LIMIT $4`,
      [projectId, after?.at ?? null, after?.id ?? null, limit],
    );
    const events = rows.rows.map((row) => ({
      id: row.id, type: row.type, occurredAt: iso(row.occurred_at), payload: row.payload,
    }));
    const last = events.at(-1);
    return { events, cursor: last ? { at: last.occurredAt, id: last.id } : after };
  }
}
