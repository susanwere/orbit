import type { SqlDatabase } from "@orbit/db";

export interface WebhookInboxEntry {
  readonly organizationId: string;
  readonly projectId?: string;
  readonly provider: "github";
  readonly deliveryId: string;
  readonly eventName: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly receivedAt: string;
}

export interface WebhookPersistResult {
  readonly inserted: boolean;
  readonly id?: string;
}

export interface WebhookInboxStore {
  persist(entry: WebhookInboxEntry): Promise<WebhookPersistResult>;
}

interface InsertedWebhookRow extends Record<string, unknown> {
  id: string;
}

export class PostgresWebhookInboxStore implements WebhookInboxStore {
  constructor(private readonly database: SqlDatabase) {}

  async persist(entry: WebhookInboxEntry): Promise<WebhookPersistResult> {
    const result = await this.database.query<InsertedWebhookRow>(
      `INSERT INTO webhook_inbox (
         organization_id,
         project_id,
         provider,
         delivery_id,
         event_name,
         signature_valid,
         headers,
         payload,
         status,
         received_at
       ) VALUES ($1, $2, $3, $4, $5, true, $6::jsonb, $7::jsonb, 'received', $8)
       ON CONFLICT (provider, delivery_id) DO NOTHING
       RETURNING id`,
      [
        entry.organizationId,
        entry.projectId ?? null,
        entry.provider,
        entry.deliveryId,
        entry.eventName,
        JSON.stringify(entry.headers),
        JSON.stringify(entry.payload),
        entry.receivedAt,
      ],
    );

    const row = result.rows[0];
    return row ? { inserted: true, id: row.id } : { inserted: false };
  }
}
