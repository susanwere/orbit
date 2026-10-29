import { PgDatabase } from "@orbit/db";
import { MuseWorkGraphPlanner } from "./modules/planning/muse-work-graph-planner.js";
import type { PlanningRouteOptions } from "./modules/planning/planning-routes.js";
import type { OriginalIntentOptions } from "./modules/intent/original-intent-routes.js";
import { HumanGateService } from "./modules/execution/human-gate-service.js";
import { AgentSessionService } from "./modules/agents/agent-session-service.js";
import { AgentContextSnapshotService } from "./modules/context/agent-context-snapshot-service.js";
import { ProjectAuthorizationService } from "./modules/projects/project-authorization.js";
import { MetaModelApiClient } from "./modules/decisions/meta-model-client.js";
import { MuseDecisionDetector } from "./modules/decisions/muse-decision-detector.js";
import { DecisionAnalysisService } from "./modules/decisions/decision-analysis-service.js";
import { DecisionAnalysisWorker } from "./modules/decisions/decision-analysis-worker.js";
import { HmacJwtAuthVerifier } from "./modules/auth/verified-principal.js";
import { OidcTokenVerifier } from "./modules/auth/oidc-token-verifier.js";
import { OrbitAccessTokenIssuer } from "./modules/auth/orbit-access-token.js";
import { buildApp } from "./app.js";
import { ContextVersionRepository } from "./modules/context/context-version-repository.js";
import { ContextChangeProposalRepository } from "./modules/context/context-change-proposal-repository.js";
import { DecisionReviewRepository } from "./modules/decisions/decision-review-repository.js";
import { DecisionReviewService } from "./modules/decisions/decision-review-service.js";
import { PostgresDecisionPromotion } from "./modules/decisions/postgres-decision-promotion.js";
import { NoopDomainEventPublisher } from "./modules/events/domain-event-publisher.js";
import { PostgresExecutionImpactService } from "./modules/execution/postgres-execution-impact.js";
import { DomainEffectsWorker } from "./modules/execution/domain-effects-worker.js";
import { ProjectEventStream } from "./modules/events/project-event-stream.js";
import { PostgresWebhookInboxStore } from "./modules/integrations/github/webhook-inbox.js";
import { GithubWebhookWorker } from "./modules/integrations/github/webhook-worker.js";
import { WhyProvenanceQuery } from "./modules/provenance/why-provenance-query.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5433/orbit";

const database = new PgDatabase(databaseUrl);
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const organizationId = process.env.ORBIT_ORGANIZATION_ID;
const projectId = process.env.ORBIT_PROJECT_ID;
const webhookWorker = new GithubWebhookWorker(database);
const effectsWorker = new DomainEffectsWorker(
  database,
  new PostgresExecutionImpactService(database),
);
const analysisWorker =
  process.env.MODEL_API_KEY && process.env.ORBIT_SYSTEM_PRINCIPAL_ID
    ? new DecisionAnalysisWorker(
        database,
        new DecisionAnalysisService(
          database,
          new MuseDecisionDetector(
            new MetaModelApiClient({
              apiKey: process.env.MODEL_API_KEY,
              baseUrl: process.env.MODEL_API_BASE_URL,
            }),
          ),
          process.env.ORBIT_SYSTEM_PRINCIPAL_ID,
        ),
      )
    : undefined;

const auth =
  process.env.ORBIT_AUTH_SECRET && process.env.ORBIT_AUTH_ISSUER
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
  new PostgresDecisionPromotion(database, new NoopDomainEventPublisher(), undefined, () =>
    console.error("Post-commit event handling failed."),
  ),
);

const identityVerifier =
  auth &&
  process.env.ORBIT_OIDC_ISSUER &&
  process.env.ORBIT_OIDC_AUDIENCE &&
  process.env.ORBIT_OIDC_JWKS_URL
    ? new OidcTokenVerifier({
        issuer: process.env.ORBIT_OIDC_ISSUER,
        audience: process.env.ORBIT_OIDC_AUDIENCE,
        jwksUrl: process.env.ORBIT_OIDC_JWKS_URL,
      })
    : undefined;

const originalIntent: OriginalIntentOptions | undefined = auth
  ? { auth, db: database, authorization: new ProjectAuthorizationService(database) }
  : undefined;

const planning: PlanningRouteOptions | undefined = auth
  ? {
      auth,
      db: database,
      authorization: new ProjectAuthorizationService(database),
      planner: process.env.MODEL_API_KEY
        ? new MuseWorkGraphPlanner(
            new MetaModelApiClient({
              apiKey: process.env.MODEL_API_KEY,
              baseUrl: process.env.MODEL_API_BASE_URL,
            }),
          )
        : undefined,
    }
  : undefined;

const app = await buildApp({
  planning,
  originalIntent,
  authExchange:
    identityVerifier && process.env.ORBIT_AUTH_SECRET && process.env.ORBIT_AUTH_ISSUER
      ? {
          database,
          identityVerifier,
          tokenIssuer: new OrbitAccessTokenIssuer({
            secret: process.env.ORBIT_AUTH_SECRET,
            issuer: process.env.ORBIT_AUTH_ISSUER,
            audience: "orbit-api",
          }),
        }
      : undefined,
  auth,
  projectManagement: auth
    ? { auth, db: database, authorization: new ProjectAuthorizationService(database) }
    : undefined,
  operations: auth
    ? { auth, db: database, authorization: new ProjectAuthorizationService(database) }
    : undefined,
  humanGates: auth
    ? { auth, service: new HumanGateService(database, new ProjectAuthorizationService(database)) }
    : undefined,
  agentSessions: auth
    ? {
        auth,
        service: new AgentSessionService(
          database,
          new ProjectAuthorizationService(database),
          new AgentContextSnapshotService(database, new ProjectAuthorizationService(database)),
        ),
      }
    : undefined,
  projectReads: auth
    ? { auth, db: database, authorization: new ProjectAuthorizationService(database) }
    : undefined,
  notifications: auth
    ? { auth, db: database, authorization: new ProjectAuthorizationService(database) }
    : undefined,
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
    githubWebhookSecret && organizationId && projectId
      ? {
          secret: githubWebhookSecret,
          organizationId,
          projectId,
          inbox: new PostgresWebhookInboxStore(database),
          onAccepted: async () => {
            await webhookWorker.processBatch();
          },
        }
      : undefined,
});

const workerTimer = setInterval(() => {
  void webhookWorker.processBatch().catch((error) => app.log.error(error));
  void analysisWorker?.processBatch().catch((error) => app.log.error(error));
  void effectsWorker.processBatch().catch((error) => app.log.error(error));
}, 5000);
void webhookWorker.processBatch().catch((error) => app.log.error(error));
app.addHook("onClose", async () => {
  clearInterval(workerTimer);
  await database.close();
});

await app.listen({ port, host });
console.log(`Orbit API listening on http://${host}:${port}`);
