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

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/intent/documents",
    async (request) => {
      const principal = auth.verify(request.headers.authorization);
      const access = await authorization.authorize(principal.id, request.params.projectId, "read");
      const docs = await db.query<Record<string, unknown>>(
        `SELECT d.id,d.original_filename,d.media_type,d.size_bytes,a.document_version
         FROM intent_document_attachments a
         JOIN project_documents d ON d.id=a.document_id AND d.project_id=a.project_id
         WHERE a.organization_id=$1 AND a.project_id=$2 ORDER BY a.attached_at,a.document_id`,
        [access.organizationId, access.projectId],
      );
      return { documents: docs.rows };
    },
  );

  app.post<{ Params: { projectId: string }; Body: { statement?: unknown; documentIds?: unknown } }>(
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
      const documentIds = request.body?.documentIds ?? [];
      if (!Array.isArray(documentIds) || documentIds.length > 10 ||
          documentIds.some((item) => typeof item !== "string" || !/^[0-9a-f-]{36}$/.test(item)) ||
          new Set(documentIds).size !== documentIds.length) {
        throw new DomainError("validation", "Provide up to 10 distinct document IDs.");
      }
      const id = randomUUID();
      const result = await db.transaction(async (tx) => {
        if (documentIds.length) {
          const owned = await tx.query<{ id: string; version: number } & Record<string, unknown>>(
            `SELECT id,version FROM project_documents
             WHERE organization_id=$1 AND project_id=$2 AND id=ANY($3::text[])`,
            [access.organizationId, access.projectId, documentIds],
          );
          if (owned.rows.length !== documentIds.length) {
            throw new DomainError("validation", "One or more documents do not belong to this project.");
          }
        }
        const created = await tx.query<IntentRow>(
        `INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (project_id) DO NOTHING
         RETURNING id,organization_id,project_id,statement,created_by_principal_id,created_at`,
        [id, access.organizationId, access.projectId, statement.trim(), principal.id],
      );
        if (created.rows[0] && documentIds.length) {
          await tx.query(
            `INSERT INTO intent_document_attachments(intent_id,organization_id,project_id,document_id,document_version)
             SELECT $1,$2,$3,id,version FROM project_documents
             WHERE organization_id=$2 AND project_id=$3 AND id=ANY($4::text[])`,
            [id, access.organizationId, access.projectId, documentIds],
          );
        }
        return created;
      });
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
