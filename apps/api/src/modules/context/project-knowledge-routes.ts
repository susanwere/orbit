import type { KnowledgeArchitecture } from "@orbit/domain";
import {
  KNOWLEDGE_ARCHITECTURE_SCHEMA,
  parseKnowledgeArchitecture,
} from "./knowledge-architecture.js";
import {
  PROJECT_KNOWLEDGE_SUMMARY_PROMPT,
  SOURCE_KNOWLEDGE_SUMMARY_PROMPT,
} from "./knowledge-summary-prompt.js";
import { PassThrough } from "node:stream";
import type { KnowledgeGenerationActivity } from "@orbit/domain";
import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { DocumentStorage } from "../documents/document-storage.js";
import { extractDocumentText } from "../documents/planning-documents.js";
import type { StructuredJsonClient } from "../decisions/meta-model-client.js";
import { collectRepositoryEvidence } from "./repository-evidence.js";
import { promoteApprovedKnowledge } from "./promote-approved-knowledge.js";

interface SourceRow extends Record<string, unknown> {
  id: string;
  original_filename: string;
  media_type: string;
  sha256: string;
  storage_key: string;
  version: number;
}
interface RepoRow extends Record<string, unknown> {
  full_name: string;
}
export interface KnowledgeOptions {
  db: SqlDatabase;
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
  storage: DocumentStorage;
  model?: StructuredJsonClient;
  githubToken?: string;
}
const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    architecture: { type: "string" },
    architectureDetails: KNOWLEDGE_ARCHITECTURE_SCHEMA,
    features: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "architecture",
    "architectureDetails",
    "features",
    "constraints",
    "unknowns",
  ],
} as const;
interface Summary {
  summary: string;
  architecture: string;
  architectureDetails: KnowledgeArchitecture | null;
  features: string[];
  constraints: string[];
  unknowns: string[];
}
function validSummary(value: unknown, isProjectSummary = false): Summary {
  if (!value || typeof value !== "object") throw new Error("Invalid knowledge summary.");
  const data = value as Record<string, unknown>;
  if (typeof data.summary !== "string" || typeof data.architecture !== "string")
    throw new Error("Invalid knowledge summary.");
  for (const field of ["features", "constraints", "unknowns"]) {
    if (
      !Array.isArray(data[field]) ||
      !(data[field] as unknown[]).every((v) => typeof v === "string")
    )
      throw new Error("Invalid summary list.");
  }
  return {
    architectureDetails: parseKnowledgeArchitecture(data.architectureDetails),
    summary: data.summary.slice(0, isProjectSummary ? 8_000 : 3_000),
    architecture: data.architecture.slice(0, isProjectSummary ? 16_000 : 3_000),
    features: (data.features as string[])
      .slice(0, 20)
      .map((s) => s.slice(0, isProjectSummary ? 2_000 : 700)),
    constraints: (data.constraints as string[])
      .slice(0, 20)
      .map((s) => s.slice(0, isProjectSummary ? 1_000 : 350)),
    unknowns: (data.unknowns as string[]).slice(0, 20).map((s) => s.slice(0, 350)),
  };
}
export async function summarize(
  model: StructuredJsonClient,
  input: { kind: "document" | "repository" | "project" } & Record<string, unknown>,
): Promise<Summary> {
  const isProjectSummary = input.kind === "project";
  const timeoutMs = isProjectSummary ? 120_000 : 90_000;
  let response: unknown;
  try {
    response = await model.complete({
      model: "muse-spark-1.3",
      schemaName: "OrbitProjectKnowledgeSummary",
      schema: SUMMARY_SCHEMA,
      systemPrompt: isProjectSummary
        ? PROJECT_KNOWLEDGE_SUMMARY_PROMPT
        : SOURCE_KNOWLEDGE_SUMMARY_PROMPT,
      // Source summaries can be as expensive as the final project synthesis.
      // Do not let them inherit the model client's 20-second default timeout.
      timeoutMs,
      userPrompt: JSON.stringify(input).slice(0, 30_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new DomainError(
        "model_api_error",
        `Muse Spark ${input.kind} summary timed out after ${timeoutMs / 1_000} seconds.`,
      );
    }
    throw error;
  }
  return validSummary(response, isProjectSummary);
}
export async function generateProjectKnowledgeSnapshot(
  options: Pick<KnowledgeOptions, "db" | "storage" | "model" | "githubToken">,
  organizationId: string,
  projectId: string,
  principalId: string,
  origin?: {
    kind: "github_merge";
    jobId: string;
    repository: string;
    commitSha: string;
    pullNumber: number;
  },
  onActivity?: (activity: KnowledgeGenerationActivity) => void,
): Promise<Record<string, unknown>> {
  const { db, storage, model, githubToken } = options;
  const report = (
    stage: KnowledgeGenerationActivity["stage"],
    status: KnowledgeGenerationActivity["status"],
    message: string,
  ) =>
    onActivity?.({
      stage,
      status,
      message: message.slice(0, 1000),
      occurredAt: new Date().toISOString(),
    });
  if (!model) throw new DomainError("promotion_unavailable", "Muse Spark is not configured.");
  if (origin) {
    const previous = await db.query<Record<string, unknown>>(
      "SELECT id,revision,content,created_at,review_status FROM project_knowledge_snapshots WHERE organization_id=$1 AND project_id=$2 AND content->'origin'->>'jobId'=$3 LIMIT 1",
      [organizationId, projectId, origin.jobId],
    );
    if (previous.rows[0]) return previous.rows[0];
  }
  report("sources", "started", "Loading original intent and connected sources.");
  const [sources, repos, intents] = await Promise.all([
    db.query<SourceRow>(
      "SELECT id,original_filename,media_type,sha256,storage_key,version FROM project_documents WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at,id LIMIT 10",
      [organizationId, projectId],
    ),
    db.query<RepoRow>(
      "SELECT full_name FROM project_repositories WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at,id LIMIT 3",
      [organizationId, projectId],
    ),
    db.query<{ statement: string } & Record<string, unknown>>(
      "SELECT statement FROM intents WHERE organization_id=$1 AND project_id=$2 LIMIT 1",
      [organizationId, projectId],
    ),
  ]);
  report("sources", "completed", "Original intent and source list loaded.");
  report("documents", "started", "Reviewing supporting documents.");
  const documents = [];
  for (const row of sources.rows) {
    report("documents", "info", `Extracting ${row.original_filename}.`);
    const bytes = await storage.get(row.storage_key);
    const hash = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if (hash !== row.sha256)
      throw new DomainError("validation", "Source integrity verification failed.");
    const extracted = await extractDocumentText(row.media_type, bytes);
    const excerpt = extracted.slice(0, 6_000);
    if (!excerpt) continue;
    report("documents", "info", `Waiting for Muse to summarize ${row.original_filename}.`);
    const summary = await summarize(model, {
      kind: "document",
      filename: row.original_filename,
      excerpt,
    });
    documents.push({
      id: row.id,
      version: row.version,
      filename: row.original_filename,
      sha256: row.sha256,
      summary,
    });
  }
  report(
    "documents",
    "completed",
    sources.rows.length ? "Document analysis complete." : "No supporting documents to analyze.",
  );
  report("repositories", "started", "Reading connected repository evidence.");
  const repositories = [];
  for (const repo of repos.rows) {
    report("repositories", "info", `Reading ${repo.full_name}.`);
    const evidence = await collectRepositoryEvidence(repo.full_name, githubToken, fetch, (path) =>
      report("repositories", "info", `Read ${repo.full_name}: ${path}.`),
    );
    report(
      "repositories",
      "info",
      evidence.files.length
        ? `Waiting for Muse to summarize ${repo.full_name}.`
        : `No accessible evidence found for ${repo.full_name}.`,
    );
    repositories.push({
      fullName: repo.full_name,
      inspected: evidence.inspected,
      commitSha: evidence.commitSha,
      truncated: evidence.truncated,
      totalCandidates: evidence.totalCandidates,
      summary: evidence.files.length
        ? await summarize(model, {
            kind: "repository",
            repository: repo.full_name,
            commitSha: evidence.commitSha,
            coverage: "Representative source files only, not an exhaustive audit",
            files: evidence.files,
          })
        : null,
    });
  }
  report("repositories", "completed", "Repository evidence collection complete.");
  report("summary", "started", "Waiting for Muse to draft the project context summary.");
  const summary = await summarize(model, {
    kind: "project",
    originalIntent: intents.rows[0]?.statement ?? "",
    documents: documents.map(({ filename, summary }) => ({ filename, summary })),
    repositories,
  });
  report("summary", "completed", "Muse returned the project context summary.");
  report("saving", "started", "Saving a reviewable context proposal.");
  const content = { summary, documents, repositories, ...(origin ? { origin } : {}) };
  const stored = await db.query<Record<string, unknown>>(
    `INSERT INTO project_knowledge_snapshots (id,organization_id,project_id,revision,content,created_by_principal_id,base_approved_revision)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(revision),0)+1 FROM project_knowledge_snapshots WHERE organization_id=$2 AND project_id=$3),$4::jsonb,$5,(SELECT COALESCE(MAX(approved_revision),0) FROM project_knowledge_heads WHERE organization_id=$2 AND project_id=$3))
       RETURNING id,revision,content,created_at`,
    [randomUUID(), organizationId, projectId, JSON.stringify(content), principalId],
  );

  if (!stored.rows[0])
    throw new DomainError("invalid_state", "Knowledge snapshot was not created.");
  report("saving", "completed", "Context proposal saved. Human approval is required.");
  return stored.rows[0];
}

export async function registerProjectKnowledgeRoutes(
  app: FastifyInstance,
  { db, auth, authorization, storage, model, githubToken }: KnowledgeOptions,
) {
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/knowledge", async (req) => {
    const principal = auth.verify(req.headers.authorization);
    const actor = await authorization.authorize(principal.id, req.params.projectId, "read");
    const found = await db.query<Record<string, unknown>>(
      "SELECT id,revision,content,created_at,review_status,review_note,base_approved_revision,reviewed_at FROM project_knowledge_snapshots WHERE organization_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 20",
      [actor.organizationId, actor.projectId],
    );
    return { snapshots: found.rows };
  });
  app.post<{
    Params: { projectId: string; snapshotId: string };
    Body: { expectedRevision?: number; decision?: "approve" | "request_changes"; note?: string };
  }>("/projects/:projectId/knowledge/:snapshotId/review", async (req) => {
    const principal = auth.verify(req.headers.authorization);
    const actor = await authorization.authorize(principal.id, req.params.projectId, "review");
    const { expectedRevision, decision, note } = req.body ?? {};
    if (!Number.isSafeInteger(expectedRevision) || !expectedRevision || expectedRevision < 1)
      throw new DomainError("validation", "An expected knowledge revision is required.");
    if (decision !== "approve" && decision !== "request_changes")
      throw new DomainError("validation", "Choose approve or request_changes.");
    if (note !== undefined && (typeof note !== "string" || note.length > 2000))
      throw new DomainError("validation", "Review note must be at most 2000 characters.");
    if (decision === "request_changes" && !note?.trim())
      throw new DomainError("validation", "Review feedback is required.");
    return db.transaction(async (tx) => {
      await tx.query("SELECT id FROM projects WHERE organization_id=$1 AND id=$2 FOR UPDATE", [
        actor.organizationId,
        actor.projectId,
      ]);
      const current = await tx.query<
        {
          id: string;
          revision: number;
          base_approved_revision: number;
        } & Record<string, unknown>
      >(
        "SELECT id,revision,base_approved_revision FROM project_knowledge_snapshots WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND review_status='PROPOSED' FOR UPDATE",
        [actor.organizationId, actor.projectId, req.params.snapshotId, expectedRevision],
      );
      const candidate = current.rows[0];
      if (!candidate)
        throw new DomainError(
          "stale_context_version",
          "Knowledge proposal changed or was already reviewed.",
        );
      const head = await tx.query<{ approved_revision: number } & Record<string, unknown>>(
        "SELECT approved_revision FROM project_knowledge_heads WHERE organization_id=$1 AND project_id=$2",
        [actor.organizationId, actor.projectId],
      );
      if (
        decision === "approve" &&
        candidate.base_approved_revision !== (head.rows[0]?.approved_revision ?? 0)
      )
        throw new DomainError(
          "stale_context_version",
          "Approved knowledge changed. Refresh and review a new proposal.",
        );
      const updated = await tx.query<Record<string, unknown>>(
        "UPDATE project_knowledge_snapshots SET review_status=$4,review_note=$5,reviewed_by_principal_id=$6,reviewed_at=now() WHERE organization_id=$1 AND project_id=$2 AND id=$3 RETURNING id,revision,content,created_at,review_status,review_note,base_approved_revision,reviewed_at",
        [
          actor.organizationId,
          actor.projectId,
          candidate.id,
          decision === "approve" ? "APPROVED" : "CHANGES_REQUESTED",
          note?.trim() ?? null,
          principal.id,
        ],
      );
      if (decision === "approve") {
        await promoteApprovedKnowledge(
          tx,
          actor.organizationId,
          actor.projectId,
          candidate.id,
          candidate.revision,
        );
        await tx.query(
          "INSERT INTO project_knowledge_heads (organization_id,project_id,approved_snapshot_id,approved_revision) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,project_id) DO UPDATE SET approved_snapshot_id=EXCLUDED.approved_snapshot_id,approved_revision=EXCLUDED.approved_revision",
          [actor.organizationId, actor.projectId, candidate.id, candidate.revision],
        );
      }
      return { snapshot: updated.rows[0] };
    });
  });
  app.post<{ Params: { projectId: string }; Querystring: { stream?: string } }>(
    "/projects/:projectId/knowledge/refresh",
    async (req, reply) => {
      const principal = auth.verify(req.headers.authorization);
      const actor = await authorization.authorize(principal.id, req.params.projectId, "review");
      if (!model) throw new DomainError("promotion_unavailable", "Muse Spark is not configured.");
      if (req.query.stream === "1") {
        const activityStream = new PassThrough();
        reply
          .type("application/x-ndjson; charset=utf-8")
          .header("Cache-Control", "no-store")
          .header("X-Accel-Buffering", "no");
        const write = (event: unknown) => {
          if (!activityStream.destroyed) activityStream.write(JSON.stringify(event) + "\n");
        };
        void generateProjectKnowledgeSnapshot(
          { db, storage, model, githubToken },
          actor.organizationId,
          actor.projectId,
          principal.id,
          undefined,
          (activity) => write({ type: "activity", activity }),
        )
          .then((snapshot) => write({ type: "result", snapshot }))
          .catch(() =>
            write({
              type: "error",
              message:
                "Context generation failed. Please retry. Your approved context is unchanged.",
            }),
          )
          .finally(() => activityStream.end());
        return reply.send(activityStream);
      }
      const snapshot = await generateProjectKnowledgeSnapshot(
        { db, storage, model, githubToken },
        actor.organizationId,
        actor.projectId,
        principal.id,
      );
      return reply.code(201).send({ snapshot });
    },
  );
}
