import cors from "@fastify/cors";
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
  readonly githubWebhook?: GitHubWebhookRouteOptions;
  readonly decisionReview?: DecisionReviewService;
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

  if (options.githubWebhook) {
    await app.register(registerGitHubWebhookRoutes, options.githubWebhook);
  }

  if (options.decisionReview) {
    await app.register(registerDecisionReviewRoutes, options.decisionReview);
  }

  if (options.eventStream) {
    await app.register(registerProjectEventRoutes, options.eventStream);
  }

  if (options.whyProvenance) {
    await app.register(registerWhyProvenanceRoutes, options.whyProvenance);
  }

  return app;
}
