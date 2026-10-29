import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

interface NotificationRow extends Record<string, unknown> {
  id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date | string;
}
export interface NotificationRouteOptions {
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
  db: SqlDatabase;
}
export async function registerNotificationRoutes(
  app: FastifyInstance,
  options: NotificationRouteOptions,
) {
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/projects/:projectId/notifications",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      await options.authorization.authorize(principal.id, request.params.projectId, "read");
      const requested = Number(request.query.limit ?? 20);
      if (!Number.isInteger(requested) || requested < 1 || requested > 100)
        throw new DomainError("validation", "limit must be 1-100");
      const result = await options.db.query<NotificationRow>(
        `SELECT id,type,subject_type,subject_id,
      title,body,read_at,created_at FROM notifications
      WHERE project_id=$1 AND recipient_principal_id=$2
      ORDER BY created_at DESC,id DESC LIMIT $3`,
        [request.params.projectId, principal.id, requested],
      );
      const count = await options.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM notifications
      WHERE project_id=$1 AND recipient_principal_id=$2 AND read_at IS NULL`,
        [request.params.projectId, principal.id],
      );
      return {
        notifications: result.rows.map((row) => ({
          ...row,
          created_at:
            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        })),
        unreadCount: Number(count.rows[0]?.count ?? 0),
      };
    },
  );
  app.post<{ Params: { projectId: string; notificationId: string } }>(
    "/projects/:projectId/notifications/:notificationId/read",
    async (request, reply) => {
      const principal = options.auth.verify(request.headers.authorization);
      await options.authorization.authorize(principal.id, request.params.projectId, "read");
      const updated = await options.db.query<{ id: string }>(
        `UPDATE notifications SET read_at=COALESCE(read_at,now())
      WHERE project_id=$1 AND recipient_principal_id=$2 AND id=$3 RETURNING id`,
        [request.params.projectId, principal.id, request.params.notificationId],
      );
      if (!updated.rows.length) throw new DomainError("not_found", "Notification not found.");
      return reply.status(204).send();
    },
  );
}
