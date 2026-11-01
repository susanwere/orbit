import { DomainError } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { TaskService } from "./task-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";

export interface TaskRouteOptions {
  readonly auth: AuthVerifier;
  readonly tasks: TaskService;
  readonly execution: TaskExecutionService;
}

/** Prompt-first task surface: list, edit, add (deduplicated by Muse Spark), and one-click Execute. */
export async function registerTaskRoutes(app: FastifyInstance, options: TaskRouteOptions) {
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/tasks", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    const tasks = await options.tasks.initialize(request.params.projectId, principal.id);
    return { tasks };
  });

  app.patch<{
    Params: { projectId: string; taskId: string };
    Body: { revision?: unknown; title?: unknown; prompt?: unknown };
  }>("/projects/:projectId/tasks/:taskId", async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (
      typeof request.body?.revision !== "number" ||
      typeof request.body?.title !== "string" ||
      typeof request.body?.prompt !== "string"
    )
      throw new DomainError("validation", "Provide the current revision, title and prompt.");
    const task = await options.tasks.update({
      projectId: request.params.projectId,
      taskId: request.params.taskId,
      principalId: principal.id,
      revision: request.body.revision,
      title: request.body.title,
      prompt: request.body.prompt,
    });
    return { task };
  });

  app.post<{ Params: { projectId: string }; Body: { request?: unknown } }>(
    "/projects/:projectId/tasks",
    async (request, reply) => {
      const principal = options.auth.verify(request.headers.authorization);
      if (typeof request.body?.request !== "string")
        throw new DomainError("validation", "Describe the new task.");
      const drafted = await options.tasks.add({
        projectId: request.params.projectId,
        principalId: principal.id,
        request: request.body.request,
      });
      return reply.status(drafted.existingTaskId ? 200 : 201).send(drafted);
    },
  );

  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { agentDefinitionId?: unknown };
  }>("/projects/:projectId/tasks/:taskId/execute", async (request, reply) => {
    const principal = options.auth.verify(request.headers.authorization);
    if (
      typeof request.body?.agentDefinitionId !== "string" ||
      !request.body.agentDefinitionId.trim()
    )
      throw new DomainError("validation", "Choose the approved Muse agent to execute this task.");
    const executed = await options.execution.execute({
      projectId: request.params.projectId,
      taskId: request.params.taskId,
      principalId: principal.id,
      agentDefinitionId: request.body.agentDefinitionId,
    });
    return reply.status(202).send(executed);
  });

  app.post<{ Params: { projectId: string; taskId: string }; Body: { note?: unknown } }>(
    "/projects/:projectId/tasks/:taskId/approve-proposal",
    async (request, reply) => {
      const principal = options.auth.verify(request.headers.authorization);
      const note = typeof request.body?.note === "string" ? request.body.note : undefined;
      const task = await options.tasks.approveProposal({
        projectId: request.params.projectId,
        taskId: request.params.taskId,
        principalId: principal.id,
        ...(note ? { note } : {}),
      });
      return reply.status(200).send({ task });
    },
  );
}
