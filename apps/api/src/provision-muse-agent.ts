import { PgDatabase } from "@orbit/db";
import { ProjectAuthorizationService } from "./modules/projects/project-authorization.js";

/** Local developer provisioner. Never loads or prints provider credentials. */
async function main() {
  const projectId = process.env.ORBIT_PROJECT_ID;
  const principalId = process.env.ORBIT_APPROVER_PRINCIPAL_ID;
  const repository = process.env.ORBIT_AGENT_REPOSITORY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!projectId || !principalId || !repository || !databaseUrl) {
    throw new Error("Set DATABASE_URL, ORBIT_PROJECT_ID, ORBIT_APPROVER_PRINCIPAL_ID and ORBIT_AGENT_REPOSITORY.");
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must be the exact owner/name registered with the project.");
  }
  const db = new PgDatabase(databaseUrl);
  try {
    const actor = await new ProjectAuthorizationService(db).authorize(principalId, projectId, "review");
    if (actor.role !== "admin") throw new Error("An organization admin must approve an agent definition.");
    const registered = await db.query<{ full_name: string } & Record<string, unknown>>(
      "SELECT full_name FROM project_repositories WHERE project_id=$1 AND organization_id=$2 AND full_name=$3",
      [projectId, actor.organizationId, repository],
    );
    if (!registered.rows.length) throw new Error("Repository is not registered with this project.");
    const id = `muse_code_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const definition = {
      id, organizationId: actor.organizationId,
      name: "Meta Muse Code", purpose: "Execute approved engineering steps in a disposable test repository",
      provider: "meta", model: "muse-code",
      capabilities: ["read", "write"], approvedTools: ["code"],
      maxContextClassification: "PUBLIC", allowedContextScopes: [],
      allowedRepositories: [repository],
      allowedPaths: ["src/**", "index.html", "package.json", "package-lock.json", "tsconfig*.json", "vite.config.*"],
      approvalRequiredActions: ["github-push", "deploy"],
      forbiddenActions: ["access-secrets", "production-deploy"],
      networkPolicy: "none", networkAllowlist: [],
      status: "approved", version: 1,
      createdByPrincipalId: principalId, createdAt: new Date().toISOString(),
    };
    const result = await db.transaction(async (tx) => {
      const latest = await tx.query<{ definition: unknown; version: number; status: string } & Record<string, unknown>>(
        "SELECT definition,version,status FROM orbit_agent_definition_versions WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [actor.organizationId, id],
      );
      if (latest.rows.length) {
        const current = latest.rows[0]!;
        if (current.status !== "approved") throw new Error("Existing agent is not approved; explicit review required.");
        const existing = current.definition as { allowedRepositories?: string[] };
        if (existing.allowedRepositories?.length !== 1 || existing.allowedRepositories[0] !== repository) {
          throw new Error("Existing agent has a different repository scope; refusing automatic changes.");
        }
        return { id, version: current.version, reused: true };
      }
      await tx.query(
        "INSERT INTO orbit_agent_definition_versions (id,organization_id,version,status,definition,approved_by_principal_id) VALUES ($1,$2,1,'approved',$3::jsonb,$4)",
        [id, actor.organizationId, JSON.stringify(definition), principalId],
      );
      return { id, version: 1, reused: false };
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await db.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + "\n" : "Provisioning failed\n");
  process.exitCode = 1;
});
