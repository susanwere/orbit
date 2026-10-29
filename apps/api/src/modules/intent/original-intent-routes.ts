import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

export interface OriginalIntentOptions {
  readonly db: SqlDatabase;
  readonly auth: AuthVerifier;
  readonly authorization: ProjectAuthorizationService;
}

interface IntentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  statement: string;
  created_by_principal_id: string;
  created_at: string;
}

/** The first submitted intent is immutable. Revisions belong to versioned context. */
export async function registerOriginalIntentRoutes(
  app: FastifyInstance,
  { db, auth, authorization }: OriginalIntentOptions,
) {
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/intent", async (request) => {
    const principal = auth.verify(request.headers.authorization);
    const access = await authorization.authorize(principal.id, request.params.projectId, "read");
    const result = await db.query<IntentRow>(
      "SELECT id,organization_id,project_id,statement,created_by_principal_id,created_at FROM intents WHERE organization_id=$1 AND project_id=$2",
      [access.organizationId, access.projectId],
    );
    return { intent: result.rows[0] ?? null };
  });

  app.post<{ Params: { projectId: string }; Body: { statement?: unknown } }>(
    "/projects/:projectId/intent",
    async (request, reply) => {
      const principal = auth.verify(request.headers.authorization);
      const access = await authorization.authorize(
        principal.id,
        request.params.projectId,
        "review",
      );
      const statement = request.body?.statement;
      if (typeof statement !== "string" || !statement.trim() || statement.length > 10_000) {
        throw new DomainError("validation", "Original intent must contain 1-10000 characters.");
      }
      const id = randomUUID();
      const result = await db.query<IntentRow>(
        `INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (project_id) DO NOTHING
         RETURNING id,organization_id,project_id,statement,created_by_principal_id,created_at`,
        [id, access.organizationId, access.projectId, statement.trim(), principal.id],
      );
      if (!result.rows[0]) {
        return reply.code(409).send({
          error: "original_intent_exists",
          message: "Original intent already exists and cannot be overwritten.",
        });
      }
      return reply.code(201).send({ intent: result.rows[0] });
    },
  );
}
