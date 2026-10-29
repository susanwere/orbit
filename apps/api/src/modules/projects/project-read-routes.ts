import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { ContextVersionRepository } from "../context/context-version-repository.js";

export interface ProjectReadRoutesOptions {
  db: SqlDatabase;
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
}
export async function registerProjectReadRoutes(
  app: FastifyInstance,
  options: ProjectReadRoutesOptions,
) {
  const versions = new ContextVersionRepository(options.db);
  const authorize = async (token: string | undefined, projectId: string) => {
    const principal = options.auth.verify(token);
    return options.authorization.authorize(principal.id, projectId, "read");
  };
  const missing = () => {
    throw new DomainError("not_found", "Requested resource not found.");
  };
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/context", async (request) => {
    await authorize(request.headers.authorization, request.params.projectId);
    return (await versions.getCurrent(request.params.projectId)) ?? missing();
  });
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; before?: string } }>(
    "/projects/:projectId/context/versions",
    async (request) => {
      await authorize(request.headers.authorization, request.params.projectId);
      const limit = Number(request.query.limit ?? 25);
      const before = request.query.before ? Number(request.query.before) : null;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (before !== null && (!Number.isInteger(before) || before < 1))
      )
        throw new DomainError("validation", "Invalid pagination.");
      const rows = await options.db.query<Record<string, unknown>>(
        `SELECT id,version_number,created_at,
      parent_context_version_id,content_hash,created_from_decision_id
      FROM context_versions WHERE project_id=$1 AND ($2::integer IS NULL OR version_number<$2)
      ORDER BY version_number DESC LIMIT $3`,
        [request.params.projectId, before, limit + 1],
      );
      const hasMore = rows.rows.length > limit;
      const slice = rows.rows.slice(0, limit);
      return { versions: slice, nextCursor: hasMore ? String(slice.at(-1)?.version_number) : null };
    },
  );
  app.get<{ Params: { projectId: string; version: string } }>(
    "/projects/:projectId/context/versions/:version",
    async (request) => {
      await authorize(request.headers.authorization, request.params.projectId);
      const version = Number(request.params.version);
      if (!Number.isSafeInteger(version) || version < 1)
        throw new DomainError("validation", "Invalid version.");
      const result = await options.db.query<Record<string, unknown>>(
        `SELECT * FROM context_versions
      WHERE project_id=$1 AND version_number=$2`,
        [request.params.projectId, version],
      );
      return result.rows[0] ?? missing();
    },
  );
  app.get<{
    Params: { projectId: string };
    Querystring: { status?: string; limit?: string; before?: string };
  }>("/projects/:projectId/decisions", async (request) => {
    await authorize(request.headers.authorization, request.params.projectId);
    const { status, before } = request.query;
    if (status && !["ACTIVE", "SUPERSEDED", "PROPOSED", "REJECTED"].includes(status))
      throw new DomainError("validation", "Invalid decision status.");
    const limit = Number(request.query.limit ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError("validation", "Invalid limit.");
    const rows = await options.db.query<Record<string, unknown>>(
      `SELECT id,title,rationale,status,created_at,
        source_artifact_id,'decision' AS kind FROM decisions
        WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR id<$3)
        UNION ALL
        SELECT id,title,rationale,status,created_at,source_artifact_id,'proposal' AS kind
        FROM decision_proposals WHERE project_id=$1
        AND ($2::text IS NULL OR status=$2 OR ($2='PROPOSED' AND status='READY_FOR_REVIEW'))
        AND ($3::text IS NULL OR id<$3)
        ORDER BY id DESC LIMIT $4`,
      [request.params.projectId, status ?? null, before ?? null, limit + 1],
    );
    const hasMore = rows.rows.length > limit;
    const slice = rows.rows.slice(0, limit);
    return { decisions: slice, nextCursor: hasMore ? slice.at(-1)?.id : null };
  });
  app.get<{ Params: { projectId: string; decisionId: string } }>(
    "/projects/:projectId/decisions/:decisionId",
    async (request) => {
      await authorize(request.headers.authorization, request.params.projectId);
      const result = await options.db.query<Record<string, unknown>>(
        `SELECT d.*,s.provider,s.url AS source_url,
      s.external_id FROM decisions d LEFT JOIN source_artifacts s ON s.id=d.source_artifact_id
      WHERE d.project_id=$1 AND d.id=$2`,
        [request.params.projectId, request.params.decisionId],
      );
      if (result.rows[0]) return { kind: "decision", ...result.rows[0] };
      const proposal = await options.db.query<Record<string, unknown>>(
        `SELECT d.*,s.provider,s.url AS source_url,
      s.external_id FROM decision_proposals d LEFT JOIN source_artifacts s ON s.id=d.source_artifact_id
      WHERE d.project_id=$1 AND d.id=$2`,
        [request.params.projectId, request.params.decisionId],
      );
      return proposal.rows[0] ? { kind: "proposal", ...proposal.rows[0] } : missing();
    },
  );
}
