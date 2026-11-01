import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlExecutor } from "@orbit/db";
import { buildNextContextVersion } from "./context-version-repository.js";

/** Backfills the first context for projects created through the intent entry flow. */
export async function initializeProjectContext(
  transaction: SqlExecutor,
  projectId: string,
  organizationId: string,
) {
  // Use the same lock as ContextVersionRepository.append, including for an absent head.
  await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]);
  const heads = await transaction.query<Record<string, unknown>>(
    "SELECT project_id FROM project_context_heads WHERE project_id=$1 AND organization_id=$2",
    [projectId, organizationId],
  );
  if (heads.rows.length) return;
  const history = await transaction.query<Record<string, unknown>>(
    "SELECT id FROM context_versions WHERE project_id=$1 LIMIT 1",
    [projectId],
  );
  if (history.rows.length) {
    throw new DomainError(
      "invalid_state",
      "Project context history exists without a current head. Repair the context head before creating a session.",
    );
  }
  const intents = await transaction.query<
    { id: string; statement: string } & Record<string, unknown>
  >("SELECT id,statement FROM intents WHERE project_id=$1 AND organization_id=$2", [
    projectId,
    organizationId,
  ]);
  const intent = intents.rows[0];
  if (!intent)
    throw new DomainError(
      "validation",
      "Save the original project intent before creating an agent session.",
    );
  const version = buildNextContextVersion(
    {
      id: `context_${randomUUID()}`,
      organizationId,
      projectId,
      content: {
        projectId,
        originalIntentId: intent.id,
        currentIntent: intent.statement,
        constraints: [],
        attributes: {},
      },
      expectedCurrentVersionId: null,
      createdAt: new Date().toISOString(),
    },
    null,
  );
  await transaction.query(
    `INSERT INTO context_versions(id,organization_id,project_id,version_number,content,content_hash,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [
      version.id,
      organizationId,
      projectId,
      version.versionNumber,
      JSON.stringify(version.content),
      version.contentHash,
      version.createdAt,
    ],
  );
  await transaction.query(
    `INSERT INTO project_context_heads(project_id,organization_id,current_context_version_id,version_number,updated_at)
     VALUES($1,$2,$3,$4,$5)`,
    [projectId, organizationId, version.id, version.versionNumber, version.createdAt],
  );
}
