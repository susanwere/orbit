import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

export type ProjectPermission = "read" | "review";

interface AccessRow extends Record<string, unknown> {
  project_organization_id: string;
  principal_organization_id: string;
  principal_type: string;
  principal_role: string | null;
}

export interface AuthorizedProjectActor {
  readonly principalId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly role: "admin" | "member" | "viewer";
}

export class ProjectAuthorizationService {
  constructor(private readonly database: SqlDatabase) {}

  async authorize(
    principalId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<AuthorizedProjectActor> {
    const result = await this.database.query<AccessRow>(
      `SELECT
         project.organization_id AS project_organization_id,
         principal.organization_id AS principal_organization_id,
         principal.type AS principal_type,
         principal.role AS principal_role
       FROM projects project
       JOIN principals principal ON principal.id = $2
       WHERE project.id = $1`,
      [projectId, principalId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new DomainError("not_found", "Project or principal not found.");
    }
    if (
      row.project_organization_id !== row.principal_organization_id ||
      row.principal_type !== "human"
    ) {
      throw new DomainError("forbidden", "Principal cannot access this project.");
    }
    if (
      row.principal_role !== "admin" &&
      row.principal_role !== "member" &&
      row.principal_role !== "viewer"
    ) {
      throw new DomainError("forbidden", "Principal has no project role.");
    }
    if (permission === "review" && row.principal_role === "viewer") {
      throw new DomainError("forbidden", "Viewer role cannot review project decisions.");
    }

    return {
      principalId,
      organizationId: row.project_organization_id,
      projectId,
      role: row.principal_role,
    };
  }
}
