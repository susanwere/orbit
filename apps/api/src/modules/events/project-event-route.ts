import { DomainError } from "@orbit/domain";
import { verifyEventToken } from "./verify-event-token.js";
import type { FastifyInstance } from "fastify";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { ProjectEventStream } from "./project-event-stream.js";

export interface EventRouteOptions {
  authorization: ProjectAuthorizationService;
  stream: ProjectEventStream;
  pollIntervalMs?: number;
  tokenSecret: string;
}

export async function registerProjectEventRoutes(
  app: FastifyInstance,
  options: EventRouteOptions,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/events/stream",
    async (request, reply) => {
      const principal = verifyEventToken(request.headers.authorization, options.tokenSecret);
      await options.authorization.authorize(principal, request.params.projectId, "read");
      const header = request.headers["last-event-id"];
      if (header !== undefined && (typeof header !== "string" || header.length > 256)) {
        throw new DomainError("validation", "Invalid Last-Event-ID.");
      }
      const projectId = request.params.projectId;
      let cursor = header ? await options.stream.cursor(projectId, header) : null;

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": connected\n\n");

      let closed = false;
      let running = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        closed = true;
        if (timer) clearInterval(timer);
      };
      request.raw.on("close", cleanup);

      const poll = async () => {
        if (running || closed) return;
        running = true;
        try {
          // Drain all available batches without advancing past undelivered rows.
          for (let pages = 0; pages < 10 && !closed; pages++) {
            const batch = await options.stream.read(projectId, cursor);
            for (const event of batch.events) {
              if (closed) break;
              response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
                occurredAt: event.occurredAt, payload: event.payload,
              })}\n\n`);
              cursor = { at: event.occurredAt, id: event.id };
            }
            if (batch.events.length < 100) break;
          }
        } catch (error) {
          app.log.error(error);
          cleanup();
          response.end();
        } finally {
          running = false;
        }
      };

      timer = setInterval(() => {
        if (closed) return;
        response.write(": heartbeat\n\n");
        void poll();
      }, options.pollIntervalMs ?? 2000);
      void poll();
    },
  );
}
