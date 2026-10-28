import cors from "@fastify/cors";
import {registerOperationsRoutes,type OperationsOptions} from "./modules/operations/operations-routes.js";
import {registerHumanGateRoutes} from "./modules/execution/human-gate-routes.js";
import type {HumanGateService} from "./modules/execution/human-gate-service.js";
import { registerAgentSessionRoutes } from "./modules/agents/agent-session-routes.js";
import type { AgentSessionService } from "./modules/agents/agent-session-service.js";
import { registerProjectReadRoutes, type ProjectReadRoutesOptions } from "./modules/projects/project-read-routes.js";
import { registerNotificationRoutes, type NotificationRouteOptions } from "./modules/notifications/notification-routes.js";
import type { AuthVerifier } from "./modules/auth/verified-principal.js";
import { DomainError } from "@orbit/domain";
import Fastify from "fastify";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteOptions,
} from "./modules/integrations/github/webhook-route.js";
import { registerDecisionReviewRoutes } from "./modules/decisions/decision-review-route.js";
import type { DecisionReviewService } from "./modules/decisions/decision-review-service.js";
import { registerWhyProvenanceRoutes, type WhyProvenanceRouteOptions } from "./modules/provenance/why-provenance-route.js";
import { registerProjectEventRoutes, type EventRouteOptions } from "./modules/events/project-event-route.js";

export interface AppOptions {
  readonly operations?: OperationsOptions;
  readonly humanGates?: {auth:AuthVerifier;service:HumanGateService};
  readonly agentSessions?: {auth:AuthVerifier;service:AgentSessionService};
  readonly projectReads?: ProjectReadRoutesOptions;
  readonly githubWebhook?: GitHubWebhookRouteOptions;
  readonly decisionReview?: DecisionReviewService;
  readonly auth?: AuthVerifier;
  readonly notifications?: NotificationRouteOptions;
  readonly eventStream?: EventRouteOptions;
  readonly whyProvenance?: WhyProvenanceRouteOptions;
}

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof DomainError) {
      const status =
        error.code === "unauthenticated"
          ? 401
          : error.code === "forbidden"
            ? 403
            : error.code === "not_found"
              ? 404
              : error.code === "stale_context_version"
                ? 409
                : error.code === "promotion_unavailable"
                  ? 503
                  : 400;
      return reply.status(status).send({
        error: error.code,
        message: error.message,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: "internal_error",
      message: "Unexpected error",
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "orbit-api",
  }));

  if(options.operations)await app.register(registerOperationsRoutes,options.operations);
  if (options.humanGates) await app.register(registerHumanGateRoutes, options.humanGates);
  if (options.agentSessions) await app.register(registerAgentSessionRoutes, options.agentSessions);
  if (options.projectReads) await app.register(registerProjectReadRoutes, options.projectReads);

  if (options.githubWebhook) {
    await app.register(registerGitHubWebhookRoutes, options.githubWebhook);
  }

  if (options.decisionReview) {
    if (!options.auth) throw new Error("Review routes require verified authentication.");
    await app.register((instance) => registerDecisionReviewRoutes(instance, options.decisionReview!, options.auth!));
  }

  if (options.notifications) {
    await app.register(registerNotificationRoutes, options.notifications);
  }

  if (options.eventStream) {
    await app.register(registerProjectEventRoutes, options.eventStream);
  }

  if (options.whyProvenance) {
    await app.register(registerWhyProvenanceRoutes, options.whyProvenance);
  }

  return app;
}
