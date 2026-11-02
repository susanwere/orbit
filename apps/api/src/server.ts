import { LocalDocumentStorage } from "./modules/documents/document-storage.js";
import { PgDatabase } from "@orbit/db";
import { MuseWorkGraphPlanner } from "./modules/planning/muse-work-graph-planner.js";
import type { PlanningRouteOptions } from "./modules/planning/planning-routes.js";
import type { OriginalIntentOptions } from "./modules/intent/original-intent-routes.js";
import { StepSessionBindingService } from "./modules/execution/step-session-binding-service.js";
import { WorkflowStepExecutionService } from "./modules/execution/workflow-step-execution-service.js";
import { MuseExecutionJobService } from "./modules/execution/muse-execution-worker.js";
import { GithubCiMonitor } from "./modules/execution/github-ci-monitor.js";
import { GithubCiEvidenceService } from "./modules/execution/github-ci-evidence-service.js";
import { ApprovedStepMaterializer } from "./modules/execution/approved-step-materializer.js";
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
import { ProjectKnowledgeRefreshWorker } from "./modules/context/project-knowledge-refresh-worker.js";
import { WhyProvenanceQuery } from "./modules/provenance/why-provenance-query.js";
import { TaskService } from "./modules/tasks/task-service.js";
import { MuseSparkTaskDrafter } from "./modules/tasks/task-drafter.js";
import { TaskExecutionService } from "./modules/tasks/task-execution-service.js";
import { MuseDeliveryRequestService } from "./modules/execution/muse-delivery-request-service.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL ?? "***localhost:5433/orbit";

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

const documentStorage = new LocalDocumentStorage(
  process.env.ORBIT_DOCUMENT_STORAGE_DIR ?? ".orbit-documents",
);

const planning: PlanningRouteOptions | undefined = auth
  ? {
      auth,
      db: database,
      authorization: new ProjectAuthorizationService(database),
      documentStorage,
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

const knowledgeRefreshWorker =
  process.env.MODEL_API_KEY && process.env.ORBIT_SYSTEM_PRINCIPAL_ID
    ? new ProjectKnowledgeRefreshWorker(
        database,
        documentStorage,
        new MetaModelApiClient({
          apiKey: process.env.MODEL_API_KEY,
          baseUrl: process.env.MODEL_API_BASE_URL,
        }),
        process.env.ORBIT_SYSTEM_PRINCIPAL_ID,
        process.env.ORBIT_GITHUB_EVIDENCE_TOKEN,
      )
    : undefined;

const app = await buildApp({
  emailPassword: auth && process.env.ORBIT_AUTH_SECRET && process.env.ORBIT_AUTH_ISSUER ? {
    database,
    tokenIssuer: new OrbitAccessTokenIssuer({ secret: process.env.ORBIT_AUTH_SECRET, issuer: process.env.ORBIT_AUTH_ISSUER, audience: "orbit-api" }),
    allowedOrigins: (process.env.ORBIT_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
    secureCookies: process.env.NODE_ENV === "production",
  } : undefined,
  museVoice:
    auth && process.env.MODEL_API_KEY
      ? {
          auth,
          authorization: new ProjectAuthorizationService(database),
          apiKey: process.env.MODEL_API_KEY,
          baseUrl: process.env.MODEL_API_BASE_URL,
        }
      : undefined,
  knowledge: auth
    ? {
        auth,
        db: database,
        authorization: new ProjectAuthorizationService(database),
        storage: documentStorage,
        githubToken: process.env.ORBIT_GITHUB_EVIDENCE_TOKEN,
        model: process.env.MODEL_API_KEY
          ? new MetaModelApiClient({
              apiKey: process.env.MODEL_API_KEY,
              baseUrl: process.env.MODEL_API_BASE_URL,
            })
          : undefined,
      }
    : undefined,
  projectDocuments:
    auth && (process.env.NODE_ENV !== "production" || process.env.ORBIT_DOCUMENT_STORAGE_DIR)
      ? {
          db: database,
          auth,
          authorization: new ProjectAuthorizationService(database),
          storage: documentStorage,
        }
      : undefined,
  planning,
  originalIntent,
  authExchange:
    auth && process.env.ORBIT_AUTH_SECRET && process.env.ORBIT_AUTH_ISSUER
      ? {
          database,
          identityVerifier,
          allowedOrigins: (
            process.env.ORBIT_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"
          ).split(","),
          secureCookies: process.env.NODE_ENV === "production",
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
  workflowSteps: auth
    ? {
        auth,
        db: database,
        authorization: new ProjectAuthorizationService(database),
        ciMonitor: process.env.ORBIT_GITHUB_EVIDENCE_TOKEN
          ? new GithubCiMonitor(database, process.env.ORBIT_GITHUB_EVIDENCE_TOKEN)
          : undefined,
        evidence: process.env.ORBIT_GITHUB_EVIDENCE_TOKEN
          ? new GithubCiEvidenceService(
              database,
              new ProjectAuthorizationService(database),
              process.env.ORBIT_GITHUB_EVIDENCE_TOKEN,
            )
          : undefined,
        execution: new WorkflowStepExecutionService(
          database,
          new ProjectAuthorizationService(database),
        ),
        binding: new StepSessionBindingService(database, new ProjectAuthorizationService(database)),
        materializer: new ApprovedStepMaterializer(
          database,
          new ProjectAuthorizationService(database),
        ),
      }
    : undefined,
  humanGates: auth
    ? { auth, service: new HumanGateService(database, new ProjectAuthorizationService(database)) }
    : undefined,
  agentSessions: auth
    ? {
        auth,
        museJobs: new MuseExecutionJobService(database, new ProjectAuthorizationService(database)),
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
  tasks: auth
    ? {
        auth,
        tasks: new TaskService(
          database,
          new ProjectAuthorizationService(database),
          process.env.MODEL_API_KEY
            ? new MuseSparkTaskDrafter(
                new MetaModelApiClient({
                  apiKey: process.env.MODEL_API_KEY,
                  baseUrl: process.env.MODEL_API_BASE_URL,
                }),
              )
            : undefined,
        ),
        execution: new TaskExecutionService(
          database,
          new ProjectAuthorizationService(database),
          new ApprovedStepMaterializer(database, new ProjectAuthorizationService(database)),
          new AgentSessionService(
            database,
            new ProjectAuthorizationService(database),
            new AgentContextSnapshotService(database, new ProjectAuthorizationService(database)),
          ),
          new StepSessionBindingService(database, new ProjectAuthorizationService(database)),
          new WorkflowStepExecutionService(database, new ProjectAuthorizationService(database)),
          new MuseExecutionJobService(database, new ProjectAuthorizationService(database)),
          new MuseDeliveryRequestService(database, new ProjectAuthorizationService(database)),
        ),
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
  void knowledgeRefreshWorker?.processBatch().catch((error) => app.log.error(error));
  void effectsWorker.processBatch().catch((error) => app.log.error(error));
}, 5000);
void webhookWorker.processBatch().catch((error) => app.log.error(error));
app.addHook("onClose", async () => {
  clearInterval(workerTimer);
  await database.close();
});

await app.listen({ port, host });
console.log(`Orbit API listening on http://${host}:${port}`);
