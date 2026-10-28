import {
  DomainError,
  type ContextVersion,
  type ProjectContext,
  type ProjectContextHead,
} from "@orbit/domain";
import { hashProjectContext } from "./canonical-context.js";
import type { SqlDatabase, SqlExecutor } from "../../lib/sql.js";

interface ContextVersionRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  version_number: number;
  parent_context_version_id: string | null;
  content: ProjectContext;
  content_hash: string;
  created_from_decision_id: string | null;
  created_at: Date | string;
}

interface ContextHeadRow extends Record<string, unknown> {
  organization_id: string;
  project_id: string;
  current_context_version_id: string;
  version_number: number;
  updated_at: Date | string;
}

export interface AppendContextVersionInput {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly content: ProjectContext;
  readonly expectedCurrentVersionId: string | null;
  readonly createdFromDecisionId?: string;
  readonly createdAt: string;
}

const asIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

function mapVersion(row: ContextVersionRow): ContextVersion {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    parentContextVersionId: row.parent_context_version_id ?? undefined,
    content: row.content,
    contentHash: row.content_hash,
    createdFromDecisionId: row.created_from_decision_id ?? undefined,
    createdAt: asIsoString(row.created_at),
  };
}

function mapHead(row: ContextHeadRow): ProjectContextHead {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    currentContextVersionId: row.current_context_version_id,
    versionNumber: row.version_number,
    updatedAt: asIsoString(row.updated_at),
  };
}

export function buildNextContextVersion(
  input: AppendContextVersionInput,
  currentHead: ProjectContextHead | null,
): ContextVersion {
  if (input.content.projectId !== input.projectId) {
    throw new DomainError(
      "project_mismatch",
      "ProjectContext belongs to a different project.",
    );
  }

  const actualCurrentVersionId = currentHead?.currentContextVersionId ?? null;
  if (input.expectedCurrentVersionId !== actualCurrentVersionId) {
    throw new DomainError(
      "stale_context_version",
      `Expected current context ${input.expectedCurrentVersionId ?? "none"}, but current context is ${actualCurrentVersionId ?? "none"}.`,
    );
  }

  if (currentHead && currentHead.organizationId !== input.organizationId) {
    throw new DomainError(
      "organization_mismatch",
      "Project context head belongs to a different organization.",
    );
  }

  return {
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    versionNumber: (currentHead?.versionNumber ?? 0) + 1,
    parentContextVersionId: currentHead?.currentContextVersionId,
    content: input.content,
    contentHash: hashProjectContext(input.content),
    createdFromDecisionId: input.createdFromDecisionId,
    createdAt: input.createdAt,
  };
}

export class ContextVersionRepository {
  constructor(private readonly database: SqlDatabase) {}

  async getHead(projectId: string): Promise<ProjectContextHead | null> {
    const result = await this.database.query<ContextHeadRow>(
      `SELECT
         organization_id,
         project_id,
         current_context_version_id,
         version_number,
         updated_at
       FROM project_context_heads
       WHERE project_id = $1`,
      [projectId],
    );

    return result.rows[0] ? mapHead(result.rows[0]) : null;
  }

  async getCurrent(projectId: string): Promise<ContextVersion | null> {
    const result = await this.database.query<ContextVersionRow>(
      `SELECT
         cv.id,
         cv.organization_id,
         cv.project_id,
         cv.version_number,
         cv.parent_context_version_id,
         cv.content,
         cv.content_hash,
         cv.created_from_decision_id,
         cv.created_at
       FROM project_context_heads h
       JOIN context_versions cv
         ON cv.project_id = h.project_id
        AND cv.id = h.current_context_version_id
       WHERE h.project_id = $1`,
      [projectId],
    );

    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async getHistory(projectId: string): Promise<readonly ContextVersion[]> {
    const result = await this.database.query<ContextVersionRow>(
      `SELECT
         id,
         organization_id,
         project_id,
         version_number,
         parent_context_version_id,
         content,
         content_hash,
         created_from_decision_id,
         created_at
       FROM context_versions
       WHERE project_id = $1
       ORDER BY version_number ASC`,
      [projectId],
    );

    return result.rows
      .map(mapVersion)
      .sort((left, right) => left.versionNumber - right.versionNumber);
  }

  async append(input: AppendContextVersionInput): Promise<ContextVersion> {
    return this.database.transaction(async (transaction) => {
      // Locks even when the project has no head yet, avoiding a concurrent
      // "first version" race that SELECT ... FOR UPDATE cannot lock.
      await transaction.query<Record<string, never>>(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [input.projectId],
      );

      const head = await this.getHeadForUpdate(transaction, input.projectId);
      const version = buildNextContextVersion(input, head);

      await transaction.query<Record<string, never>>(
        `INSERT INTO context_versions (
           id,
           organization_id,
           project_id,
           version_number,
           parent_context_version_id,
           content,
           content_hash,
           created_from_decision_id,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          version.id,
          version.organizationId,
          version.projectId,
          version.versionNumber,
          version.parentContextVersionId ?? null,
          JSON.stringify(version.content),
          version.contentHash,
          version.createdFromDecisionId ?? null,
          version.createdAt,
        ],
      );

      if (head) {
        const updated = await transaction.query<Record<string, never>>(
          `UPDATE project_context_heads
           SET current_context_version_id = $2,
               version_number = $3,
               updated_at = $4
           WHERE project_id = $1
             AND current_context_version_id = $5`,
          [
            version.projectId,
            version.id,
            version.versionNumber,
            version.createdAt,
            head.currentContextVersionId,
          ],
        );

        if (updated.rowCount !== 1) {
          throw new DomainError(
            "stale_context_version",
            "Project context head changed while creating the next version.",
          );
        }
      } else {
        await transaction.query<Record<string, never>>(
          `INSERT INTO project_context_heads (
             project_id,
             organization_id,
             current_context_version_id,
             version_number,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            version.projectId,
            version.organizationId,
            version.id,
            version.versionNumber,
            version.createdAt,
          ],
        );
      }

      return version;
    });
  }

  private async getHeadForUpdate(
    transaction: SqlExecutor,
    projectId: string,
  ): Promise<ProjectContextHead | null> {
    const result = await transaction.query<ContextHeadRow>(
      `SELECT
         organization_id,
         project_id,
         current_context_version_id,
         version_number,
         updated_at
       FROM project_context_heads
       WHERE project_id = $1
       FOR UPDATE`,
      [projectId],
    );

    return result.rows[0] ? mapHead(result.rows[0]) : null;
  }
}
