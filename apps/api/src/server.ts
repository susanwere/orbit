import { PgDatabase } from "@orbit/db";
import { buildApp } from "./app.js";
import { PostgresWebhookInboxStore } from "./modules/integrations/github/webhook-inbox.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5433/orbit";

const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const organizationId = process.env.ORBIT_ORGANIZATION_ID;
const database =
  githubWebhookSecret && organizationId ? new PgDatabase(databaseUrl) : undefined;

const app = await buildApp({
  githubWebhook:
    githubWebhookSecret && organizationId && database
      ? {
          secret: githubWebhookSecret,
          organizationId,
          inbox: new PostgresWebhookInboxStore(database),
        }
      : undefined,
});

if (database) {
  app.addHook("onClose", async () => {
    await database.close();
  });
}

await app.listen({ port, host });
console.log(`Orbit API listening on http://${host}:${port}`);
