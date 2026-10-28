import { PgDatabase } from "@orbit/db";
import { HmacJwtAuthVerifier } from "./modules/auth/verified-principal.js";
import { buildApp } from "./app.js";
import { ContextVersionRepository } from "./modules/context/context-version-repository.js";
import { ContextChangeProposalRepository } from "./modules/context/context-change-proposal-repository.js";
import { DecisionReviewRepository } from "./modules/decisions/decision-review-repository.js";
import { DecisionReviewService } from "./modules/decisions/decision-review-service.js";
import { PostgresDecisionPromotion } from "./modules/decisions/postgres-decision-promotion.js";
import { NoopDomainEventPublisher } from "./modules/events/domain-event-publisher.js";
import { PostgresExecutionImpactService } from "./modules/execution/postgres-execution-impact.js";
import { ImpactAwareEventPublisher } from "./modules/execution/impact-aware-event-publisher.js";
import { ProjectEventStream } from "./modules/events/project-event-stream.js";
import { PostgresWebhookInboxStore } from "./modules/integrations/github/webhook-inbox.js";
import { ProjectAuthorizationService } from "./modules/projects/project-authorization.js";
import { WhyProvenanceQuery } from "./modules/provenance/why-provenance-query.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5433/orbit";

const database = new PgDatabase(databaseUrl);
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const organizationId = process.env.ORBIT_ORGANIZATION_ID;

const auth = process.env.ORBIT_AUTH_SECRET && process.env.ORBIT_AUTH_ISSUER
  ? new HmacJwtAuthVerifier({
      secret: process.env.ORBIT_AUTH_SECRET,
      issuer: process.env.ORBIT_AUTH_ISSUER,
      audience: "orbit-api",
    })
  : undefined;

const decisionReview = new DecisionReviewService(
  new ProjectAuthorizationService(database),
  new DecisionReviewRepository(database),
  new ContextVersionRepository(database),
  new ContextChangeProposalRepository(database),
  new PostgresDecisionPromotion(
    database,
    new ImpactAwareEventPublisher(
      new PostgresExecutionImpactService(database),
      new NoopDomainEventPublisher(),
    ),
    undefined,
    (error) => console.error("Post-commit event handling failed:", error),
  ),
);

const app = await buildApp({
  auth,
  whyProvenance: auth
    ? {
        query: new WhyProvenanceQuery(database, new ProjectAuthorizationService(database)),
        auth,
      }
    : undefined,
  eventStream: auth
    ? {
        authorization: new ProjectAuthorizationService(database),
        stream: new ProjectEventStream(database),
        auth,
      }
    : undefined,
  decisionReview: auth ? decisionReview : undefined,
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
