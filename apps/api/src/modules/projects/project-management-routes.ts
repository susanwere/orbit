import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier, VerifiedPrincipal } from "../auth/verified-principal.js";
import { ProjectAuthorizationService } from "./project-authorization.js";

export interface ProjectManagementOptions {
  db: SqlDatabase;
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
}
interface ProjectRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  name: string;
  created_at: string;
}
interface RepositoryRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  owner: string;
  repo: string;
  full_name: string;
  html_url: string;
  created_at: string;
}
const validName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
const stringId = (value: string) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const fail = (message: string): never => {
  throw new DomainError("validation", message);
};
const repoPart = /^[A-Za-z0-9_.-]+$/;
function parseGitHubRepository(value: unknown) {
  if (typeof value !== "string" || value.length > 250)
    return fail("Provide a valid GitHub repository URL or owner/repo.");
  const input = value.trim().replace(/\/$/, "");
  let full = input;
  if (input.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return fail("Invalid GitHub repository URL.");
    }
    if (
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return fail("Only github.com repository URLs are supported.");
    full = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  }
  const parts = full.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) => !part || !repoPart.test(part) || part === "." || part === ".." || part.length > 100,
    )
  )
    return fail("Repository must have an owner and name.");
  const [owner, repo] = parts as [string, string];
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}
const pageLimit = (value: unknown) => {
  const n = Number(value ?? 25);
  if (!Number.isInteger(n) || n < 1 || n > 100) return fail("limit must be 1-100");
  return n;
};
const isUnique = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "23505";
export async function registerProjectManagementRoutes(
  app: FastifyInstance,
  options: ProjectManagementOptions,
) {
  const { db, auth, authorization } = options;
  const principal = (header: string | undefined) => auth.verify(header);
  const membership = async (p: VerifiedPrincipal, required: "read" | "create") => {
    const result = await db.query<
      { organization_id: string; role: string | null; type: string } & Record<string, unknown>
    >("SELECT organization_id, role, type FROM principals WHERE id=$1 AND organization_id=$2", [
      p.id,
      p.organizationId,
    ]);
    const actor = result.rows[0];
    if (
      !actor ||
      actor.type !== "human" ||
      !["admin", "member", "viewer"].includes(actor.role ?? "")
    )
      throw new DomainError("forbidden", "Project access denied.");
    if (required === "create" && actor.role === "viewer")
      throw new DomainError("forbidden", "Viewer cannot create projects.");
    return actor;
  };
  app.post<{ Body: { name?: unknown } }>("/projects", async (req, reply) => {
    const actor = principal(req.headers.authorization);
    await membership(actor, "create");
    if (!validName(req.body?.name)) return fail("Project name is required (1-120 characters).");
    const name = req.body.name.trim();
    try {
      const result = await db.query<ProjectRow>(
        "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,$3) RETURNING id,organization_id,name,created_at",
        [randomUUID(), actor.organizationId, name],
      );
      return reply.status(201).send(result.rows[0]);
    } catch (e) {
      if (isUnique(e))
        throw new DomainError("validation", "A project with this name already exists.");
      throw e;
    }
  });
  app.get<{ Querystring: { limit?: string; before?: string } }>("/projects", async (req) => {
    const actor = principal(req.headers.authorization);
    await membership(actor, "read");
    const limit = pageLimit(req.query.limit);
    const before = req.query.before ?? null;
    if (before !== null && !stringId(before)) return fail("Invalid cursor.");
    const rows = await db.query<ProjectRow>(
      "SELECT id,organization_id,name,created_at FROM projects WHERE organization_id=$1 AND ($2::text IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
      [actor.organizationId, before, limit + 1],
    );
    return {
      projects: rows.rows.slice(0, limit),
      nextCursor: rows.rows.length > limit ? rows.rows[limit - 1]?.id : null,
    };
  });
  app.get<{ Params: { projectName: string } }>(
    "/projects/by-name/:projectName",
    async (request) => {
      const actor = principal(request.headers.authorization);
      await membership(actor, "read");
      if (!validName(request.params.projectName)) return fail("Invalid project name.");
      const projects = await db.query<ProjectRow>(
        "SELECT id,organization_id,name,created_at FROM projects WHERE organization_id=$1 AND name=$2",
        [actor.organizationId, request.params.projectName],
      );
      const project = projects.rows[0];
      if (!project) throw new DomainError("not_found", "Project not found.");
      await authorization.authorize(actor.id, project.id, "read");
      return project;
    },
  );
  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (req) => {
    const actor = principal(req.headers.authorization);
    await authorization.authorize(actor.id, req.params.projectId, "read");
    const r = await db.query<ProjectRow>(
      "SELECT id,organization_id,name,created_at FROM projects WHERE id=$1 AND organization_id=$2",
      [req.params.projectId, actor.organizationId],
    );
    if (!r.rows[0]) throw new DomainError("not_found", "Project not found.");
    return r.rows[0];
  });
  app.post<{ Params: { projectId: string }; Body: { repository?: unknown } }>(
    "/projects/:projectId/repositories",
    async (req, reply) => {
      const actor = principal(req.headers.authorization);
      const access = await authorization.authorize(actor.id, req.params.projectId, "review");
      const git = parseGitHubRepository(req.body?.repository);
      const registration = await db.query<RepositoryRow>(
        `INSERT INTO project_repositories(project_id,organization_id,owner,repo,full_name,html_url)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id,provider,full_name) DO UPDATE
         SET full_name=EXCLUDED.full_name
         RETURNING id,project_id,owner,repo,full_name,html_url,created_at`,
        [
          req.params.projectId,
          access.organizationId,
          git.owner,
          git.repo,
          git.fullName,
          git.htmlUrl,
        ],
      );
      return reply.status(201).send(registration.rows[0]);
    },
  );
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/repositories", async (req) => {
    const actor = principal(req.headers.authorization);
    const access = await authorization.authorize(actor.id, req.params.projectId, "read");
    const r = await db.query<RepositoryRow>(
      "SELECT id,project_id,owner,repo,full_name,html_url,created_at FROM project_repositories WHERE project_id=$1 AND organization_id=$2 ORDER BY created_at,id",
      [req.params.projectId, access.organizationId],
    );
    return { repositories: r.rows };
  });
}
