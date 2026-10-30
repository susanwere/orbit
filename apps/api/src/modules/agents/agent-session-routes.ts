import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { AgentSessionService } from "./agent-session-service.js";
import type { MuseExecutionJobService } from "../execution/muse-execution-worker.js";
export async function registerAgentSessionRoutes(
  app: FastifyInstance,
  opts: {
    auth: AuthVerifier;
    service: AgentSessionService;
    museJobs?: MuseExecutionJobService;
  },
) {
  app.post<{
    Params: { projectId: string };
    Body: {
      agentDefinitionId: string;
      workItemId: string;
      mission: string;
      humanOwnerPrincipalId: string;
    };
  }>("/projects/:projectId/agent-sessions", async (req, reply) => {
    const principal = opts.auth.verify(req.headers.authorization);
    const body = req.body;
    const result = await opts.service.create({
      projectId: req.params.projectId,
      requestedBy: principal.id,
      humanOwner: body?.humanOwnerPrincipalId,
      agentDefinitionId: body?.agentDefinitionId,
      workItemId: body?.workItemId,
      mission: body?.mission ?? "",
    });
    return reply.status(201).send(result);
  });
  app.get<{ Params: { projectId: string; sessionId: string } }>(
    "/projects/:projectId/agent-sessions/:sessionId",
    async (req) => {
      const principal = opts.auth.verify(req.headers.authorization);
      return opts.service.get(req.params.projectId, principal.id, req.params.sessionId);
    },
  );
  app.post<{ Params: { projectId: string; sessionId: string } }>(
    "/projects/:projectId/agent-sessions/:sessionId/start",
    async (req) => {
      const principal = opts.auth.verify(req.headers.authorization);
      return opts.service.start(req.params.projectId, principal.id, req.params.sessionId);
    },
  );
  // Dispatch is explicit, authenticated, and only queues already-running
  // sessions whose approved step and ExecutionContract pass backend checks.
  if (opts.museJobs) {
    app.post<{ Params: { projectId: string; sessionId: string } }>(
      "/projects/:projectId/agent-sessions/:sessionId/dispatch-muse",
      async (req, reply) => {
        const principal = opts.auth.verify(req.headers.authorization);
        const job = await opts.museJobs!.enqueue({
          projectId: req.params.projectId,
          sessionId: req.params.sessionId,
          principalId: principal.id,
        });
        return reply.status(202).send({ job });
      },
    );
  }
}
