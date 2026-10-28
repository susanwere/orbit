import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebhookInboxStore } from "./webhook-inbox.js";
import { verifyGitHubWebhookSignature } from "./webhook-signature.js";

export interface GitHubWebhookRouteOptions {
  readonly secret: string;
  readonly organizationId: string;
  readonly inbox: WebhookInboxStore;
  readonly onAccepted?: (webhookInboxId: string) => void | Promise<void>;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeHeaders(request: FastifyRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "content-type",
    "user-agent",
    "x-github-delivery",
    "x-github-event",
    "x-github-hook-id",
  ]) {
    const value = firstHeader(request.headers[name]);
    if (value) result[name] = value;
  }
  return result;
}

export async function registerGitHubWebhookRoutes(
  app: FastifyInstance,
  options: GitHubWebhookRouteOptions,
): Promise<void> {
  const rawBodies = new WeakMap<FastifyRequest, Buffer>();

  // This parser is encapsulated inside the GitHub webhook plugin so other JSON
  // APIs keep Fastify's normal parser. Signature verification always uses the
  // exact bytes received from GitHub, never a re-serialized object.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const rawBody = body as Buffer;
      rawBodies.set(request, rawBody);

      try {
        done(null, JSON.parse(rawBody.toString("utf8")));
      } catch (error) {
        const parseError = error as Error & { statusCode?: number };
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    },
  );

  app.post("/webhooks/github", async (request, reply) => {
    const rawBody = rawBodies.get(request);
    const signature = firstHeader(request.headers["x-hub-signature-256"]);
    const deliveryId = firstHeader(request.headers["x-github-delivery"]);
    const eventName = firstHeader(request.headers["x-github-event"]);

    if (!rawBody) {
      return reply.status(400).send({
        error: "invalid_webhook_body",
        message: "GitHub webhook body must be JSON.",
      });
    }

    if (!verifyGitHubWebhookSignature(rawBody, signature, options.secret)) {
      return reply.status(401).send({
        error: "invalid_signature",
        message: "GitHub webhook signature verification failed.",
      });
    }

    if (!deliveryId || !eventName) {
      return reply.status(400).send({
        error: "missing_github_headers",
        message: "GitHub delivery and event headers are required.",
      });
    }

    const persisted = await options.inbox.persist({
      organizationId: options.organizationId,
      provider: "github",
      deliveryId,
      eventName,
      headers: safeHeaders(request),
      payload: request.body,
      receivedAt: new Date().toISOString(),
    });

    if (persisted.inserted && persisted.id && options.onAccepted) {
      const inboxId = persisted.id;
      setImmediate(() => {
        void Promise.resolve(options.onAccepted?.(inboxId)).catch((error) => {
          request.log.error(
            { err: error, webhookInboxId: inboxId },
            "GitHub webhook downstream notification failed",
          );
        });
      });
    }

    return reply.status(202).send({
      accepted: true,
      duplicate: !persisted.inserted,
    });
  });
}
