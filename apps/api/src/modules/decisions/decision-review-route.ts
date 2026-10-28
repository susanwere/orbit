import { DomainError } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { DecisionReviewService } from "./decision-review-service.js";

function principalId(headers: Record<string, unknown>): string {
  const value = headers["x-principal-id"];
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id !== "string" || !id.trim()) {
    throw new DomainError("unauthenticated", "x-principal-id is required.");
  }
  return id;
}

function expectedVersion(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { expectedContextVersionId?: unknown }).expectedContextVersionId !== "string"
  ) {
    throw new DomainError(
      "validation",
      "expectedContextVersionId is required.",
    );
  }
  return (body as { expectedContextVersionId: string }).expectedContextVersionId;
}

export async function registerDecisionReviewRoutes(
  app: FastifyInstance,
  service: DecisionReviewService,
): Promise<void> {
  app.get<{ Params: { projectId: string; proposalId: string } }>(
    "/projects/:projectId/decision-proposals/:proposalId",
    async (request) =>
      service.get(
        principalId(request.headers),
        request.params.projectId,
        request.params.proposalId,
      ),
  );

  app.patch<{
    Params: { projectId: string; proposalId: string };
    Body: {
      title?: string;
      rationale?: string;
      operations?: unknown[];
      expectedContextVersionId?: string;
    };
  }>(
    "/projects/:projectId/decision-proposals/:proposalId",
    async (request) => {
      const version = expectedVersion(request.body);
      return service.edit(
        principalId(request.headers),
        request.params.projectId,
        request.params.proposalId,
        {
          title: request.body?.title,
          rationale: request.body?.rationale,
          operations: request.body?.operations as never,
          expectedContextVersionId: version,
        },
      );
    },
  );

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { expectedContextVersionId?: string };
  }>(
    "/projects/:projectId/decision-proposals/:proposalId/approve",
    async (request) =>
      service.approve(
        principalId(request.headers),
        request.params.projectId,
        request.params.proposalId,
        expectedVersion(request.body),
      ),
  );

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { expectedContextVersionId?: string };
  }>(
    "/projects/:projectId/decision-proposals/:proposalId/reject",
    async (request, reply) => {
      await service.reject(
        principalId(request.headers),
        request.params.projectId,
        request.params.proposalId,
        expectedVersion(request.body),
      );
      return reply.status(204).send();
    },
  );
}
