import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { AgentSessionService } from "../src/modules/agents/agent-session-service.js";
import { ApprovedStepMaterializer } from "../src/modules/execution/approved-step-materializer.js";
import { StepSessionBindingService } from "../src/modules/execution/step-session-binding-service.js";
import { WorkflowStepExecutionService } from "../src/modules/execution/workflow-step-execution-service.js";
import { MuseExecutionJobService } from "../src/modules/execution/muse-execution-worker.js";
import { MuseDeliveryRequestService } from "../src/modules/execution/muse-delivery-request-service.js";
import { TaskService } from "../src/modules/tasks/task-service.js";
import { TaskExecutionService } from "../src/modules/tasks/task-execution-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("prompt-first task execution (PostgreSQL)", () => {
  let database: PgDatabase;
  let authorization: ProjectAuthorizationService;
  let sessions: AgentSessionService;
  let execution: TaskExecutionService;
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const principalId = randomUUID();
  const planId = randomUUID();
  const intentId = randomUUID();
  let agentDefinitionId: string;

  beforeAll(async () => {
    database = new PgDatabase(databaseUrl!);
    authorization = new ProjectAuthorizationService(database);
    sessions = new AgentSessionService(
      database,
      authorization,
      new AgentContextSnapshotService(database, authorization),
    );
    execution = new TaskExecutionService(
      database,
      authorization,
      new ApprovedStepMaterializer(database, authorization),
      sessions,
      new StepSessionBindingService(database, authorization),
      new WorkflowStepExecutionService(database, authorization),
      new MuseExecutionJobService(database, authorization),
      new MuseDeliveryRequestService(database, authorization),
    );
    await database.query("INSERT INTO organizations(id,name) VALUES($1,'Task test')", [
      organizationId,
    ]);
    await database.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Tasks')", [
      projectId,
      organizationId,
    ]);
    await database.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Owner','admin')",
      [principalId, organizationId],
    );
    await database.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,'Build the jobs list',$4)",
      [intentId, organizationId, projectId, principalId],
    );
    await database.query(
      "INSERT INTO project_repositories(project_id,organization_id,owner,repo,full_name,html_url) VALUES($1,$2,'susanwere','private-test','susanwere/private-test','https://github.com/susanwere/private-test')",
      [projectId, organizationId],
    );
    const content = {
      summary: "Jobs list",
      workItems: [
        {
          key: "jobs-list",
          title: "Jobs list",
          description: "Render job postings",
          dependsOn: [],
          workflows: [
            {
              name: "Implementation",
              steps: [
                { title: "Build list", executor: "agent", requiresApproval: true },
                { title: "Polish", executor: "agent", requiresApproval: false },
              ],
            },
          ],
        },
        {
          key: "filters",
          title: "Filters",
          description: "Filter postings",
          dependsOn: ["jobs-list"],
          workflows: [
            {
              name: "Implementation",
              steps: [{ title: "Add filters", executor: "agent", requiresApproval: false }],
            },
          ],
        },
      ],
      guardrails: [],
      decisionsToReview: [],
      assumptions: [],
    };
    await database.query(
      "INSERT INTO plan_proposals(id,organization_id,project_id,original_intent_id,status,revision,content,created_by_principal_id) VALUES($1,$2,$3,$4,'READY_FOR_REVIEW',1,$5::jsonb,$6)",
      [planId, organizationId, projectId, intentId, JSON.stringify(content), principalId],
    );
    const agent = await sessions.onboardMuse(projectId, principalId, "susanwere/private-test");
    agentDefinitionId = agent.id;
  });

  afterAll(async () => {
    await database.query("DELETE FROM muse_job_outputs WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM muse_execution_jobs WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM workflow_step_prerequisites WHERE project_id=$1", [
      projectId,
    ]);
    await database.query("DELETE FROM workflow_step_executions WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM project_tasks WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM agent_sessions WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM execution_contracts WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM context_snapshots WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM approvals WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await database.close();
  });

  it("initializes editable tasks from the plan and blocks dependents", async () => {
    const taskService = new TaskService(database, authorization);
    const tasks = await taskService.initialize(projectId, principalId);
    expect(tasks.map((task) => task.task_key).sort()).toEqual(["filters", "jobs-list"]);
    const filtersTask = tasks.find((task) => task.task_key === "filters")!;
    await expect(
      execution.execute({
        projectId,
        principalId,
        taskId: filtersTask.id,
        agentDefinitionId,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("Execute approves the plan, collapses steps, and queues one local Muse run with the edited prompt", async () => {
    const taskService = new TaskService(database, authorization);
    const tasks = await taskService.initialize(projectId, principalId);
    const jobsTask = tasks.find((task) => task.task_key === "jobs-list")!;
    const edited = await taskService.update({
      projectId,
      principalId,
      taskId: jobsTask.id,
      revision: jobsTask.revision,
      title: jobsTask.title,
      prompt: "Render exactly 20 job postings with a Load More button.",
    });
    const started = await execution.execute({
      projectId,
      principalId,
      taskId: jobsTask.id,
      agentDefinitionId,
    });
    expect(started.state).toBe("ACTIVE");
    const plan = await database.query<{ status: string } & Record<string, unknown>>(
      "SELECT status FROM plan_proposals WHERE id=$1",
      [planId],
    );
    expect(plan.rows[0]?.status).toBe("APPROVED");
    const steps = await database.query<{ id: string; state: string } & Record<string, unknown>>(
      "SELECT id,state FROM workflow_step_executions WHERE project_id=$1 ORDER BY id",
      [projectId],
    );
    expect(steps.rows.find((step) => step.id === started.stepId)?.state).toBe("RUNNING");
    expect(steps.rows.filter((step) => step.state === "CANCELED").length).toBeGreaterThanOrEqual(1);
    const snapshot = await database.query<{ mission: string } & Record<string, unknown>>(
      "SELECT mission FROM context_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    expect(snapshot.rows[0]?.mission).toContain("Render exactly 20 job postings");
    expect(edited.revision).toBe(jobsTask.revision + 1);
    const job = await database.query<{ local_execution_state: string } & Record<string, unknown>>(
      "SELECT local_execution_state FROM muse_execution_jobs WHERE id=$1",
      [started.jobId],
    );
    expect(job.rows[0]?.local_execution_state).toBe("REQUESTED");
    const storedTask = await database.query<
      { state: string; github_authorized: boolean; approved_revision: number } & Record<
        string,
        unknown
      >
    >("SELECT state,github_authorized,approved_revision FROM project_tasks WHERE id=$1", [
      jobsTask.id,
    ]);
    expect(storedTask.rows[0]).toMatchObject({
      state: "ACTIVE",
      github_authorized: true,
      approved_revision: edited.revision,
    });
  });
});
