import cors from "@fastify/cors";
import {
  registerPlanningRoutes,
  type PlanningRouteOptions,
} from "./modules/planning/planning-routes.js";
import {
  registerOriginalIntentRoutes,
  type OriginalIntentOptions,
} from "./modules/intent/original-intent-routes.js";
import {
  registerAuthExchangeRoutes,
  type AuthExchangeOptions,
} from "./modules/auth/auth-exchange-routes.js";
import {
  registerProjectManagementRoutes,
  type ProjectManagementOptions,
} from "./modules/projects/project-management-routes.js";
import {
  registerOperationsRoutes,
  type OperationsOptions,
} from "./modules/operations/operations-routes.js";
import {
  registerWorkflowStepRoutes,
  type WorkflowStepRouteOptions,
} from "./modules/execution/workflow-step-routes.js";
import { registerHumanGateRoutes } from "./modules/execution/human-gate-routes.js";
import type { HumanGateService } from "./modules/execution/human-gate-service.js";
import { registerAgentSessionRoutes } from "./modules/agents/agent-session-routes.js";
import type { AgentSessionService } from "./modules/agents/agent-session-service.js";
import type { MuseExecutionJobService } from "./modules/execution/muse-execution-worker.js";
import {
  registerProjectReadRoutes,
  type ProjectReadRoutesOptions,
} from "./modules/projects/project-read-routes.js";
import {
  registerNotificationRoutes,
  type NotificationRouteOptions,
} from "./modules/notifications/notification-routes.js";
import type { AuthVerifier } from "./modules/auth/verified-principal.js";
import { DomainError } from "@orbit/domain";
import Fastify from "fastify";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteOptions,
} from "./modules/integrations/github/webhook-route.js";
import { registerDecisionReviewRoutes } from "./modules/decisions/decision-review-route.js";
import type { DecisionReviewService } from "./modules/decisions/decision-review-service.js";
import {
  registerWhyProvenanceRoutes,
  type WhyProvenanceRouteOptions,
} from "./modules/provenance/why-provenance-route.js";
import {
  registerProjectEventRoutes,
  type EventRouteOptions,
} from "./modules/events/project-event-route.js";
import { registerTaskRoutes, type TaskRouteOptions } from "./modules/tasks/task-routes.js";

export interface AppOptions {
  readonly authExchange?: AuthExchangeOptions;
  readonly originalIntent?: OriginalIntentOptions;
  readonly planning?: PlanningRouteOptions;
  readonly projectManagement?: ProjectManagementOptions;
  readonly operations?: OperationsOptions;
  readonly workflowSteps?: WorkflowStepRouteOptions;
  readonly humanGates?: { auth: AuthVerifier; service: HumanGateService };
  readonly agentSessions?: {
    auth: AuthVerifier;
    service: AgentSessionService;
    museJobs?: MuseExecutionJobService;
  };
  readonly projectReads?: ProjectReadRoutesOptions;
  readonly githubWebhook?: GitHubWebhookRouteOptions;
  readonly decisionReview?: DecisionReviewService;
  readonly auth?: AuthVerifier;
  readonly notifications?: NotificationRouteOptions;
  readonly eventStream?: EventRouteOptions;
  readonly whyProvenance?: WhyProvenanceRouteOptions;
  readonly tasks?: TaskRouteOptions;
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

  if (options.authExchange) await app.register(registerAuthExchangeRoutes, options.authExchange);
  if (options.originalIntent)
    await app.register(registerOriginalIntentRoutes, options.originalIntent);
  if (options.planning) await app.register(registerPlanningRoutes, options.planning);
  if (options.projectManagement)
    await app.register(registerProjectManagementRoutes, options.projectManagement);
  if (options.operations) await app.register(registerOperationsRoutes, options.operations);
  if (options.workflowSteps) await app.register(registerWorkflowStepRoutes, options.workflowSteps);
  if (options.humanGates) await app.register(registerHumanGateRoutes, options.humanGates);
  if (options.agentSessions) await app.register(registerAgentSessionRoutes, options.agentSessions);
  if (options.projectReads) await app.register(registerProjectReadRoutes, options.projectReads);

  if (options.githubWebhook) {
    await app.register(registerGitHubWebhookRoutes, options.githubWebhook);
  }

  if (options.decisionReview) {
    if (!options.auth) throw new Error("Review routes require verified authentication.");
    await app.register((instance) =>
      registerDecisionReviewRoutes(instance, options.decisionReview!, options.auth!),
    );
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

  if (options.tasks) {
    await app.register(registerTaskRoutes, options.tasks);
  }

  return app;
}
