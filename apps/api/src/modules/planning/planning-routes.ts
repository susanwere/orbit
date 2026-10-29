import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import {
  validateProposedWorkGraph,
  type WorkGraphPlanner,
} from "./muse-work-graph-planner.js";

export interface PlanningRouteOptions {
  readonly db: SqlDatabase;
  readonly auth: AuthVerifier;
  readonly authorization: ProjectAuthorizationService;
  readonly planner?: WorkGraphPlanner;
}

interface DecisionRow extends Record<string, unknown> {
  title: string;
  rationale: string;
}
interface ContextRow extends Record<string, unknown> {
  content: unknown;
}
interface IntentRow extends Record<string, unknown> {
  id: string;
  statement: string;
}
interface PlanRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  original_intent_id: string;
  status: "GENERATING" | "FAILED" | "READY_FOR_REVIEW" | "APPROVED";
  revision: number;
  content: unknown;
  failure_reason: string | null;
  created_by_principal_id: string;
  approved_by_principal_id: string | null;
}

const conflict = (message: string): never => {
  throw new DomainError("stale_context_version", message);
};
const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export async function registerPlanningRoutes(
  app: FastifyInstance,
  { db, auth, authorization, planner }: PlanningRouteOptions,
) {
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/plan", async (request) => {
    const principal = auth.verify(request.headers.authorization);
    const actor = await authorization.authorize(principal.id, request.params.projectId, "read");
    const result = await db.query<PlanRow>(
      "SELECT * FROM plan_proposals WHERE organization_id=$1 AND project_id=$2",
      [actor.organizationId, actor.projectId],
    );
    return { plan: result.rows[0] ?? null };
  });

  app.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/plan",
    async (request, reply) => {
      const principal = auth.verify(request.headers.authorization);
      const actor = await authorization.authorize(principal.id, request.params.projectId, "review");
      if (!planner) {
        throw new DomainError("promotion_unavailable", "Muse planning is not configured.");
      }
      const intents = await db.query<IntentRow>(
        "SELECT id,statement FROM intents WHERE organization_id=$1 AND project_id=$2",
        [actor.organizationId, actor.projectId],
      );
      const intent = intents.rows[0];
      if (!intent) {
        throw new DomainError("validation", "Submit original intent before requesting a plan.");
      }

      const reserved = await db.query<PlanRow>(
        `INSERT INTO plan_proposals
           (id,organization_id,project_id,original_intent_id,status,created_by_principal_id)
         VALUES($1,$2,$3,$4,'GENERATING',$5)
         ON CONFLICT (project_id) DO UPDATE
           SET status='GENERATING',
               revision=plan_proposals.revision+1,
               content=NULL,
               failure_reason=NULL,
               updated_at=now()
         WHERE plan_proposals.status='FAILED'
         RETURNING *`,
        [randomUUID(), actor.organizationId, actor.projectId, intent.id, principal.id],
      );
      const row = reserved.rows[0];
      if (!row) {
        return reply.code(409).send({
          error: "plan_already_exists",
          message: "A proposal already exists or planning is in progress. Read the existing plan.",
        });
      }

      try {
        const [decisions, context] = await Promise.all([
          db.query<DecisionRow>(
            "SELECT title,rationale FROM decisions WHERE organization_id=$1 AND project_id=$2 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 20",
            [actor.organizationId, actor.projectId],
          ),
          db.query<ContextRow>(
            "SELECT v.content FROM context_versions v JOIN project_context_heads h ON h.current_context_version_id=v.id WHERE h.organization_id=$1 AND h.project_id=$2",
            [actor.organizationId, actor.projectId],
          ),
        ]);
        const rawContext = context.rows[0]?.content;
        const contextValue =
          rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
            ? (rawContext as Record<string, unknown>)
            : {};
        const constraints = Array.isArray(contextValue.constraints)
          ? contextValue.constraints.slice(0, 20).flatMap((item: unknown) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return [];
              const statement = (item as Record<string, unknown>).statement;
              return typeof statement === "string" ? [statement] : [];
            })
          : [];
        const proposed = await planner.propose({
          originalIntent: intent.statement,
          knownDecisions: decisions.rows.map((row) => row.title + ": " + row.rationale),
          knownConstraints: constraints,
        });
        const saved = await db.query<PlanRow>(
          `UPDATE plan_proposals
             SET status='READY_FOR_REVIEW',content=$3::jsonb,updated_at=now()
           WHERE id=$1 AND revision=$2 AND status='GENERATING'
           RETURNING *`,
          [row.id, row.revision, JSON.stringify(proposed)],
        );
        if (!saved.rows[0]) return conflict("Planning proposal changed while generating.");
        return reply.code(201).send({ plan: saved.rows[0] });
      } catch (error) {
        await db.query(
          `UPDATE plan_proposals
             SET status='FAILED',content=NULL,failure_reason='Planning failed; retry allowed',
                 updated_at=now()
           WHERE id=$1 AND revision=$2 AND status='GENERATING'`,
          [row.id, row.revision],
        );
        if (error instanceof DomainError && error.code === "stale_context_version") throw error;
        throw new DomainError("promotion_unavailable", "Muse planning failed. Please retry.");
      }
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: { expectedRevision?: unknown; content?: unknown };
  }>("/projects/:projectId/plan", async (request) => {
    const principal = auth.verify(request.headers.authorization);
    const actor = await authorization.authorize(principal.id, request.params.projectId, "review");
    const revision = request.body?.expectedRevision;
    if (!validRevision(revision)) {
      throw new DomainError("validation", "expectedRevision must be a positive integer.");
    }
    const plan = validateProposedWorkGraph(request.body?.content);
    const saved = await db.query<PlanRow>(
      `UPDATE plan_proposals
         SET content=$4::jsonb,revision=revision+1,updated_at=now()
       WHERE organization_id=$1 AND project_id=$2
         AND revision=$3 AND status='READY_FOR_REVIEW'
       RETURNING *`,
      [actor.organizationId, actor.projectId, revision, JSON.stringify(plan)],
    );
    if (!saved.rows[0]) return conflict("Plan has changed or is no longer editable.");
    return { plan: saved.rows[0] };
  });

  app.post<{
    Params: { projectId: string };
    Body: { expectedRevision?: unknown };
  }>("/projects/:projectId/plan/approve", async (request) => {
    const principal = auth.verify(request.headers.authorization);
    const actor = await authorization.authorize(principal.id, request.params.projectId, "review");
    const revision = request.body?.expectedRevision;
    if (!validRevision(revision)) {
      throw new DomainError("validation", "expectedRevision must be a positive integer.");
    }

    const accepted = await db.transaction(async (transaction) => {
      const updated = await transaction.query<PlanRow>(
        `UPDATE plan_proposals
           SET status='APPROVED',revision=revision+1,
               approved_by_principal_id=$4,updated_at=now()
         WHERE organization_id=$1 AND project_id=$2
           AND revision=$3 AND status='READY_FOR_REVIEW'
         RETURNING *`,
        [actor.organizationId, actor.projectId, revision, principal.id],
      );
      const row = updated.rows[0];
      if (!row) return conflict("Plan has changed or is not ready for approval.");
      await transaction.query(
        `INSERT INTO approvals
          (id,organization_id,project_id,subject_type,subject_id,decision,decided_by_principal_id)
         VALUES($1,$2,$3,'plan',$4,'APPROVED',$5)`,
        [randomUUID(), actor.organizationId, actor.projectId, row.id, principal.id],
      );
      return row;
    });

    // Plan approval never triggers agents or external provider calls.
    return { plan: accepted };
  });
}
