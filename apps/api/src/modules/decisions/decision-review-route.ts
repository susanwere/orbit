import { DomainError, type ContextChangeOperation, type JsonValue } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { DecisionReviewService } from "./decision-review-service.js";
import type { AuthVerifier } from "../auth/verified-principal.js";

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function parseOperations(value: unknown): readonly ContextChangeOperation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DomainError("validation", "operations must be an array.");
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new DomainError("validation", "Each context operation must be an object.");
    }
    const record = item as Record<string, unknown>;
    if (
      (record.op !== "add" && record.op !== "replace" && record.op !== "remove") ||
      typeof record.path !== "string"
    ) {
      throw new DomainError("validation", "Context operation has invalid op or path.");
    }

    if (record.op === "remove") {
      return { op: "remove", path: record.path };
    }
    if (!("value" in record) || !isJsonValue(record.value)) {
      throw new DomainError("validation", "Add/replace operations require a JSON value.");
    }
    return { op: record.op, path: record.path, value: record.value };
  });
}

function expectedVersion(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { expectedContextVersionId?: unknown }).expectedContextVersionId !== "string"
  ) {
    throw new DomainError("validation", "expectedContextVersionId is required.");
  }
  return (body as { expectedContextVersionId: string }).expectedContextVersionId;
}

export async function registerDecisionReviewRoutes(
  app: FastifyInstance,
  service: DecisionReviewService,
  auth: AuthVerifier,
): Promise<void> {
  app.get<{ Params: { projectId: string; proposalId: string } }>(
    "/projects/:projectId/decision-proposals/:proposalId",
    async (request) =>
      service.get(
        auth.verify(request.headers.authorization).id,
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
  }>("/projects/:projectId/decision-proposals/:proposalId", async (request) => {
    const version = expectedVersion(request.body);
    return service.edit(
      auth.verify(request.headers.authorization).id,
      request.params.projectId,
      request.params.proposalId,
      {
        title: request.body?.title,
        rationale: request.body?.rationale,
        operations: parseOperations(request.body?.operations),
        expectedContextVersionId: version,
      },
    );
  });

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { expectedContextVersionId?: string };
  }>("/projects/:projectId/decision-proposals/:proposalId/rebase", async (request) =>
    service.rebase(
      auth.verify(request.headers.authorization).id,
      request.params.projectId,
      request.params.proposalId,
      expectedVersion(request.body),
    ),
  );

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { expectedContextVersionId?: string };
  }>("/projects/:projectId/decision-proposals/:proposalId/approve", async (request) =>
    service.approve(
      auth.verify(request.headers.authorization).id,
      request.params.projectId,
      request.params.proposalId,
      expectedVersion(request.body),
    ),
  );

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { expectedContextVersionId?: string };
  }>("/projects/:projectId/decision-proposals/:proposalId/reject", async (request, reply) => {
    await service.reject(
      auth.verify(request.headers.authorization).id,
      request.params.projectId,
      request.params.proposalId,
      expectedVersion(request.body),
    );
    return reply.status(204).send();
  });
}
