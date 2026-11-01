import { randomUUID } from "node:crypto";
import { DomainError, type ProjectContext } from "@orbit/domain";
import type { SqlExecutor } from "@orbit/db";
import { initializeProjectContext } from "./initialize-project-context.js";
import { buildNextContextVersion } from "./context-version-repository.js";

interface ContextRow extends Record<string, unknown> {
  id: string;
  version_number: number;
  content: ProjectContext;
}

/**
 * Publish only a human-approved knowledge snapshot. Preserve authoritative
 * decisions and workflow reviews; knowledge lives in a namespaced attribute.
 * Called inside the same transaction that records approval.
 */
export async function promoteApprovedKnowledge(
  tx: SqlExecutor,
  organizationId: string,
  projectId: string,
  snapshotId: string,
  revision: number,
): Promise<string> {
  await initializeProjectContext(tx, projectId, organizationId);
  const rows = await tx.query<ContextRow>(
    `SELECT version.id,version.version_number,version.content
     FROM project_context_heads head
     JOIN context_versions version ON version.id=head.current_context_version_id
     WHERE head.organization_id=$1 AND head.project_id=$2 FOR UPDATE OF head`,
    [organizationId, projectId],
  );
  const current = rows.rows[0];
  if (!current) throw new DomainError("not_found", "Project context head missing.");
  const source = await tx.query<{ content: unknown } & Record<string, unknown>>(
    "SELECT content FROM project_knowledge_snapshots WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND revision=$4",
    [organizationId, projectId, snapshotId, revision],
  );
  if (!source.rows[0]) throw new DomainError("not_found", "Knowledge snapshot missing.");
  const knowledge = { snapshotId, revision, content: source.rows[0].content };
  const next = buildNextContextVersion(
    {
      id: `context_${randomUUID()}`,
      organizationId,
      projectId,
      expectedCurrentVersionId: current.id,
      createdAt: new Date().toISOString(),
      content: {
        ...current.content,
        attributes: { ...current.content.attributes, approvedProjectKnowledge: knowledge },
      },
    },
    {
      organizationId,
      projectId,
      currentContextVersionId: current.id,
      versionNumber: current.version_number,
      updatedAt: new Date().toISOString(),
    },
  );
  await tx.query(
    `INSERT INTO context_versions
       (id,organization_id,project_id,version_number,parent_context_version_id,content,content_hash,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      next.id,
      organizationId,
      projectId,
      next.versionNumber,
      current.id,
      JSON.stringify(next.content),
      next.contentHash,
      next.createdAt,
    ],
  );
  const updated = await tx.query(
    `UPDATE project_context_heads
     SET current_context_version_id=$3,version_number=$4,updated_at=$5
     WHERE organization_id=$1 AND project_id=$2 AND current_context_version_id=$6`,
    [organizationId, projectId, next.id, next.versionNumber, next.createdAt, current.id],
  );
  if (updated.rowCount !== 1)
    throw new DomainError("stale_context_version", "Project context changed during approval.");
  return next.id;
}
