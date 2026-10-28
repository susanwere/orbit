import { PgDatabase } from "@orbit/db";
import { buildApp } from "./app.js";
import { ContextVersionRepository } from "./modules/context/context-version-repository.js";
import { ContextChangeProposalRepository } from "./modules/context/context-change-proposal-repository.js";
import { DecisionReviewRepository } from "./modules/decisions/decision-review-repository.js";
import { DecisionReviewService } from "./modules/decisions/decision-review-service.js";
import { PostgresDecisionPromotion } from "./modules/decisions/postgres-decision-promotion.js";
import { NoopDomainEventPublisher } from "./modules/events/domain-event-publisher.js";
import { PostgresWebhookInboxStore } from "./modules/integrations/github/webhook-inbox.js";
import { ProjectAuthorizationService } from "./modules/projects/project-authorization.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5433/orbit";

const database = new PgDatabase(databaseUrl);
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const organizationId = process.env.ORBIT_ORGANIZATION_ID;

const decisionReview = new DecisionReviewService(
  new ProjectAuthorizationService(database),
  new DecisionReviewRepository(database),
  new ContextVersionRepository(database),
  new ContextChangeProposalRepository(database),
  new PostgresDecisionPromotion(database, new NoopDomainEventPublisher()),
);

const app = await buildApp({
  decisionReview,
  githubWebhook:
    githubWebhookSecret && organizationId
      ? {
          secret: githubWebhookSecret,
          organizationId,
          inbox: new PostgresWebhookInboxStore(database),
        }
      : undefined,
});

app.addHook("onClose", async () => {
  await database.close();
});

await app.listen({ port, host });
console.log(`Orbit API listening on http://${host}:${port}`);
