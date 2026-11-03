/** Start once on the developer host. The API and agent never receive Docker access. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PgDatabase } from "@orbit/db";
import {
  LocalMuseDeliveryConsumer,
  MuseDeliveryRequestService,
} from "./modules/execution/muse-delivery-request-service.js";
import { LocalMuseQueueConsumer } from "./modules/execution/local-muse-queue-consumer.js";
import { ProjectAuthorizationService } from "./modules/projects/project-authorization.js";
import { TaskExecutionService } from "./modules/tasks/task-execution-service.js";
import { TaskAutomationService } from "./modules/tasks/task-automation-service.js";
import { ApprovedStepMaterializer } from "./modules/execution/approved-step-materializer.js";
import { AgentSessionService } from "./modules/agents/agent-session-service.js";
import { AgentContextSnapshotService } from "./modules/context/agent-context-snapshot-service.js";
import { StepSessionBindingService } from "./modules/execution/step-session-binding-service.js";
import { WorkflowStepExecutionService } from "./modules/execution/workflow-step-execution-service.js";
import { MuseExecutionJobService } from "./modules/execution/muse-execution-worker.js";
import { GithubCiEvidenceService } from "./modules/execution/github-ci-evidence-service.js";
import { GithubCiMonitor } from "./modules/execution/github-ci-monitor.js";
import { MuseCiRepairService } from "./modules/execution/muse-ci-repair-service.js";

const runCommand = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
async function main() {
  const projectArg = process.argv.find((argument) => argument.startsWith("--project="))?.slice(10);
  if (
    !process.env.DATABASE_URL ||
    !process.env.META_API_KEY ||
    !process.env.ORBIT_WORKER_GITHUB_TOKEN
  )
    throw new Error("Configure the local database and private credentials.");
  if (projectArg !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(projectArg))
    throw new Error("Invalid --project argument.");
  // Verify Docker and the built image before accepting browser requests.
  await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
  await runCommand(
    "docker",
    ["image", "inspect", "orbit-muse-worker:local", "--format", "{{.Id}}"],
    { timeout: 10000 },
  );
  const database = new PgDatabase(process.env.DATABASE_URL);
  const scopeProjectId = projectArg ?? null;
  const runPhase = async (jobId: string, mode: "prepare" | "execute" | "deliver") => {
    await runCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        join(repositoryRoot, "apps/api/src/muse-local-worker.ts"),
        mode,
        `--job=${jobId}`,
      ],
      {
        cwd: repositoryRoot,
        timeout: 900000,
        maxBuffer: 100000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DATABASE_URL: process.env.DATABASE_URL,
          ...(mode !== "execute"
            ? { ORBIT_WORKER_GITHUB_TOKEN: process.env.ORBIT_WORKER_GITHUB_TOKEN }
            : { META_API_KEY: process.env.META_API_KEY }),
        },
      },
    );
  };
  const consumer = new LocalMuseQueueConsumer(database, {
    prepare: async (jobId) => {
      try {
        await access(join(repositoryRoot, ".orbit-local", jobId, "policy.json"));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
        await runPhase(jobId, "prepare");
      }
    },
    execute: async (jobId) => runPhase(jobId, "execute"),
  });
  const deliveries = new LocalMuseDeliveryConsumer(database, async (jobId) =>
    runPhase(jobId, "deliver"),
  );
  const authorization = new ProjectAuthorizationService(database);
  const taskExecution = new TaskExecutionService(
    database,
    authorization,
    new ApprovedStepMaterializer(database, authorization),
    new AgentSessionService(
      database,
      authorization,
      new AgentContextSnapshotService(database, authorization),
    ),
    new StepSessionBindingService(database, authorization),
    new WorkflowStepExecutionService(database, authorization),
    new MuseExecutionJobService(database, authorization),
    new MuseDeliveryRequestService(database, authorization),
  );
  const taskAutomation = process.env.ORBIT_GITHUB_EVIDENCE_TOKEN
    ? new TaskAutomationService(
        database,
        authorization,
        new GithubCiMonitor(database, process.env.ORBIT_GITHUB_EVIDENCE_TOKEN),
        new MuseCiRepairService(database, authorization),
        new WorkflowStepExecutionService(database, authorization),
        new AgentSessionService(
          database,
          authorization,
          new AgentContextSnapshotService(database, authorization),
        ),
        new StepSessionBindingService(database, authorization),
        new MuseExecutionJobService(database, authorization),
        new GithubCiEvidenceService(
          database,
          authorization,
          process.env.ORBIT_GITHUB_EVIDENCE_TOKEN,
        ),
      )
    : undefined;
  const ciTargets = async (): Promise<string[]> => {
    const projects = await database.query<{ project_id: string } & Record<string, unknown>>(
      scopeProjectId
        ? `SELECT DISTINCT project_id FROM project_repositories WHERE project_id=$1 AND full_name='susanwere/private-test' LIMIT 1`
        : `SELECT DISTINCT t.project_id FROM project_tasks t
         JOIN project_repositories repo ON repo.project_id=t.project_id AND repo.full_name='susanwere/private-test'
         WHERE t.state IN ('ACTIVE','IN_REVIEW')
           AND EXISTS (SELECT 1 FROM muse_execution_jobs j WHERE j.project_id=t.project_id AND j.agent_session_id=t.session_id AND j.status='TURN_FINISHED' AND j.github_pull_number IS NOT NULL AND j.github_ci_state IN ('PENDING','WAITING','FAILED','PASSED'))
         UNION SELECT DISTINCT j.project_id FROM muse_execution_jobs j
         JOIN project_repositories repo ON repo.project_id=j.project_id AND repo.full_name='susanwere/private-test'
         WHERE j.status='TURN_FINISHED' AND EXISTS (SELECT 1 FROM workflow_step_executions step WHERE step.id=j.workflow_step_id AND step.project_id=j.project_id AND step.organization_id=j.organization_id AND step.agent_session_id=j.agent_session_id AND step.state IN ('RUNNING','WAITING')) AND j.github_pull_number IS NOT NULL AND j.github_ci_state IN ('PENDING','WAITING','FAILED','PASSED')
         LIMIT 20`,
      scopeProjectId ? [scopeProjectId] : [],
    );
    return projects.rows.map((row) => row.project_id);
  };
  const monitorCi = async () => {
    if (!process.env.ORBIT_GITHUB_EVIDENCE_TOKEN) return;
    for (const trackedProjectId of await ciTargets()) {
      try {
        await runCommand(
          process.execPath,
          [
            "--import",
            "tsx",
            join(repositoryRoot, "apps/api/src/muse-ci-worker.ts"),
            `--project=${trackedProjectId}`,
          ],
          {
            cwd: repositoryRoot,
            timeout: 180000,
            maxBuffer: 10000,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DATABASE_URL: process.env.DATABASE_URL,
              ORBIT_GITHUB_EVIDENCE_TOKEN: process.env.ORBIT_GITHUB_EVIDENCE_TOKEN,
              ORBIT_WORKER_GITHUB_TOKEN: process.env.ORBIT_WORKER_GITHUB_TOKEN,
              ORBIT_MUSE_ISOLATED_WORKER: "true",
            },
          },
        );
      } catch {
        // Keep watching other projects even when one check fails.
      }
    }
  };
  let lastCiCheck = 0;
  let lastAutomationCheck = 0;
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const scopeLabel = scopeProjectId ? scopeProjectId : "all private-test projects";
  process.stdout.write(
    `Local Muse consumer ready for ${scopeLabel}. Tasks executed in Orbit run, deliver a PR, and repair CI automatically; merging stays with you. ORBIT_MUSE_ALLOW_SHELL=${process.env.ORBIT_MUSE_ALLOW_SHELL === "true" ? "true (shell allowed for dependency repair)" : "not set (locked-down)"}.\n`,
  );
  try {
    while (!abort.signal.aborted) {
      try {
        if (Date.now() - lastCiCheck > 15000) {
          lastCiCheck = Date.now();
          await monitorCi();
        }
        const projectsScope = scopeProjectId ?? null;
        const deliveryTargets = await database.query<
          { project_id: string } & Record<string, unknown>
        >(
          projectsScope
            ? `SELECT DISTINCT project_id FROM muse_execution_jobs WHERE project_id=$1 AND delivery_state IN ('REQUESTED','RUNNING') LIMIT 20`
            : `SELECT DISTINCT project_id FROM muse_execution_jobs WHERE delivery_state IN ('REQUESTED','RUNNING') LIMIT 20`,
          projectsScope ? [projectsScope] : [],
        );
        for (const row of deliveryTargets.rows) {
          const deliveredJobId = await deliveries.runNext(row.project_id);
          if (deliveredJobId)
            process.stdout.write(
              `Delivery request processed: ${deliveredJobId} [${row.project_id}]. Check the recorded PR and CI status in ORBIT.\n`,
            );
        }
        const executionTargets = await database.query<
          { project_id: string } & Record<string, unknown>
        >(
          projectsScope
            ? `SELECT DISTINCT project_id FROM muse_execution_jobs WHERE project_id=$1 AND status='QUEUED' AND attempts=0 AND local_execution_state='REQUESTED' LIMIT 20`
            : `SELECT DISTINCT project_id FROM muse_execution_jobs WHERE status='QUEUED' AND attempts=0 AND local_execution_state='REQUESTED' LIMIT 20`,
        );
        for (const row of executionTargets.rows) {
          const jobId = await consumer.runNext(row.project_id);
          if (jobId) {
            process.stdout.write(`Local request processed: ${jobId} [${row.project_id}].\n`);
            try {
              const delivered = await taskExecution.requestDeliveryIfAuthorized({
                projectId: row.project_id,
                jobId,
              });
              if (delivered)
                process.stdout.write(`PR delivery requested for finished task job ${jobId}.\n`);
            } catch {
              process.stderr.write(
                `Automatic PR delivery was not authorized for ${jobId}; check its task status in Orbit.\n`,
              );
            }
          }
        }
        if (taskAutomation) {
          if (Date.now() - lastAutomationCheck > 15000) {
            lastAutomationCheck = Date.now();
            const automationTargets = await database.query<
              { project_id: string } & Record<string, unknown>
            >(
              projectsScope
                ? `SELECT DISTINCT project_id FROM project_tasks WHERE project_id=$1 AND state IN ('ACTIVE','IN_REVIEW') AND github_authorized=true LIMIT 20`
                : `SELECT DISTINCT project_id FROM project_tasks WHERE state IN ('ACTIVE','IN_REVIEW') AND github_authorized=true LIMIT 20`,
              projectsScope ? [projectsScope] : [],
            );
            // When no task is ACTIVE but delivery already pinged CI, still scan
            // every project with a recent pending CI result so a failed repair
            // does not stall.
            const ciRepairTargets = taskAutomation
              ? await ciTargets().then((ids) => ids.map((projectId) => ({ project_id: projectId })))
              : [];
            const all = new Map<string, true>();
            for (const row of [...automationTargets.rows, ...ciRepairTargets])
              all.set(row.project_id, true);
            for (const trackedProjectId of [...all.keys()]) {
              try {
                const automationAction = await taskAutomation.advanceNext(trackedProjectId);
                if (automationAction)
                  process.stdout.write(
                    `Task automation [${trackedProjectId}]: ${automationAction}.\n`,
                  );
              } catch {
                // Keep watching other projects.
              }
            }
          }
        }
      } catch {
        process.stderr.write("Local queue check failed; retrying. No automatic job replay.\n");
      }
      await delay(1500, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    await database.close();
  }
}
main().catch(() => {
  process.stderr.write(
    "Local consumer could not start. Check the project ID, private configuration, Docker and orbit-muse-worker:local image.\n",
  );
  process.exitCode = 1;
});
