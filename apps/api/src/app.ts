import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteOptions,
} from "./modules/integrations/github/webhook-route.js";

export interface AppOptions {
  readonly githubWebhook?: GitHubWebhookRouteOptions;
}

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "orbit-api",
  }));

  if (options.githubWebhook) {
    await app.register(registerGitHubWebhookRoutes, options.githubWebhook);
  }

  return app;
}
