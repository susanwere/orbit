import { TaskAutomationService } from "../src/modules/tasks/task-automation-service.js";
import { GithubCiMonitor } from "../src/modules/execution/github-ci-monitor.js";
import { GithubCiEvidenceService } from "../src/modules/execution/github-ci-evidence-service.js";
import { MuseCiRepairService } from "../src/modules/execution/muse-ci-repair-service.js";
import { createExecutionActivityRecorder } from "../src/modules/execution/muse-execution-activity.js";
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
    await database.query("DELETE FROM evidence WHERE project_id=$1", [projectId]);
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
    expect(snapshot.rows[0]?.mission).toContain("fenced code blocks with a language label");
    expect(snapshot.rows[0]?.mission).toContain(
      "commands that were actually run versus suggested commands",
    );
    expect(edited.revision).toBe(jobsTask.revision + 1);
    const job = await database.query<{ local_execution_state: string } & Record<string, unknown>>(
      "SELECT local_execution_state FROM muse_execution_jobs WHERE id=$1",
      [started.jobId],
    );
    expect(job.rows[0]?.local_execution_state).toBe("REQUESTED");
    await database.query(
      "UPDATE muse_execution_jobs SET status='RUNNING',attempts=1,lease_expires_at=now()+interval '10 minutes' WHERE id=$1",
      [started.jobId],
    );
    const recordActivity = createExecutionActivityRecorder(database, {
      jobId: started.jobId,
      projectId,
      organizationId,
      attempt: 1,
    });
    await recordActivity({ stage: "execution", status: "started", message: "Execution began." });
    const wrongScopeRecorder = createExecutionActivityRecorder(database, {
      jobId: started.jobId,
      projectId: randomUUID(),
      organizationId,
      attempt: 1,
    });
    await wrongScopeRecorder({ stage: "tools", status: "info", message: "Must not be recorded." });
    const staleRecorder = createExecutionActivityRecorder(database, {
      jobId: started.jobId,
      projectId,
      organizationId,
      attempt: 0,
    });
    await staleRecorder({ stage: "tools", status: "info", message: "Stale attempt." });
    const scopedActivity = await database.query(
      "SELECT message FROM muse_execution_activity WHERE job_id=$1",
      [started.jobId],
    );
    expect(scopedActivity.rows).toEqual([{ message: "Execution began." }]);
    await database.query(
      `INSERT INTO muse_execution_activity(job_id,project_id,organization_id,stage,status,message)
      SELECT $1,$2,$3,'tools','info','Event ' || series FROM generate_series(1,205) series ORDER BY series`,
      [started.jobId, projectId, organizationId],
    );
    const activeSession = await database.query<
      { agent_session_id: string } & Record<string, unknown>
    >("SELECT agent_session_id FROM muse_execution_jobs WHERE id=$1", [started.jobId]);
    const statusService = new MuseExecutionJobService(database, authorization);
    const activityStatus = await statusService.getStatus({
      projectId,
      principalId,
      sessionId: activeSession.rows[0]!.agent_session_id,
    });
    const activity = activityStatus?.activity as { id: string; message: string }[];
    expect(activity).toHaveLength(200);
    expect(activity[0]?.message).toBe("Event 6");
    expect(activity.at(-1)?.message).toBe("Event 205");
    const otherProjectId = randomUUID();
    await database.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Other activity project')",
      [otherProjectId, organizationId],
    );
    expect(
      await statusService.getStatus({
        projectId: otherProjectId,
        principalId,
        sessionId: activeSession.rows[0]!.agent_session_id,
      }),
    ).toBeNull();
    await expect(
      statusService.getStatus({
        projectId,
        principalId: randomUUID(),
        sessionId: activeSession.rows[0]!.agent_session_id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const otherOrganizationId = randomUUID();
    const otherPrincipalId = randomUUID();
    await database.query("INSERT INTO organizations(id,name) VALUES($1,'Other execution tenant')", [
      otherOrganizationId,
    ]);
    try {
      await database.query(
        "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Other owner','admin')",
        [otherPrincipalId, otherOrganizationId],
      );
      await expect(
        statusService.getStatus({
          projectId,
          principalId: otherPrincipalId,
          sessionId: activeSession.rows[0]!.agent_session_id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await database.query("DELETE FROM organizations WHERE id=$1", [otherOrganizationId]);
    }

    await database.query(
      "UPDATE muse_execution_jobs SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [started.jobId],
    );
    await recordActivity({ stage: "tools", status: "info", message: "Expired lease." });
    const expiredEvents = await database.query(
      "SELECT id FROM muse_execution_activity WHERE job_id=$1 AND message='Expired lease.'",
      [started.jobId],
    );
    expect(expiredEvents.rows).toHaveLength(0);

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
  it("pauses after CI passes, rejects stale heads, and completes the merged run without another execution", async () => {
    const jobs = await database.query<
      { id: string; agent_session_id: string; workflow_step_id: string } & Record<string, unknown>
    >(
      "SELECT id,agent_session_id,workflow_step_id FROM muse_execution_jobs WHERE project_id=$1 LIMIT 1",
      [projectId],
    );
    const job = jobs.rows[0]!;
    const headSha = "a".repeat(40);
    const runHeadSha = "b".repeat(40);
    await database.query(
      "UPDATE muse_execution_jobs SET status='TURN_FINISHED',finished_at=now(),github_repository='susanwere/private-test',github_pull_number=123,github_head_sha=$2,github_ci_state='PENDING',github_review_state='READY',local_execution_state='FINISHED' WHERE id=$1",
      [job.id, headSha],
    );
    let merged = false;
    let moved = false;
    let networkCalls = 0;
    const ciRun = {
      id: 987,
      name: "CI",
      workflow_id: 10,
      run_number: 1,
      status: "completed",
      conclusion: "success",
      event: "pull_request",
      head_sha: runHeadSha,
      repository: { full_name: "susanwere/private-test" },
      pull_requests: [{ number: 123, head: { sha: headSha } }],
    };
    const github: typeof fetch = async (url) => {
      networkCalls++;
      const response = String(url).includes("/pulls/")
        ? {
            number: 123,
            state: merged ? "closed" : "open",
            merged_at: merged ? "2026-11-03T12:00:00Z" : null,
            head: {
              sha: moved ? "c".repeat(40) : headSha,
              ref: "orbit/test",
              repo: { full_name: "susanwere/private-test" },
            },
            base: { repo: { full_name: "susanwere/private-test" } },
          }
        : String(url).includes("/actions/runs?")
          ? {
              total_count: 1,
              workflow_runs: [
                merged
                  ? { ...ciRun, head_sha: headSha, head_branch: "orbit/test", pull_requests: [] }
                  : ciRun,
              ],
            }
          : merged
            ? { ...ciRun, head_sha: headSha, head_branch: "orbit/test", pull_requests: [] }
            : ciRun;
      return new Response(JSON.stringify(response));
    };
    const automation = new TaskAutomationService(
      database,
      authorization,
      new GithubCiMonitor(database, "test-token", github),
      new MuseCiRepairService(database, authorization),
      new WorkflowStepExecutionService(database, authorization),
      sessions,
      new StepSessionBindingService(database, authorization),
      new MuseExecutionJobService(database, authorization),
      new GithubCiEvidenceService(database, authorization, "test-token", github),
    );
    expect(await automation.advanceNext(projectId)).toMatch(/^ci-passed:/);
    const stepState = async () =>
      (
        await database.query("SELECT state FROM workflow_step_executions WHERE id=$1", [
          job.workflow_step_id,
        ])
      ).rows[0]?.state;
    expect(await stepState()).toBe("WAITING");
    expect(
      (await database.query("SELECT state FROM agent_sessions WHERE id=$1", [job.agent_session_id]))
        .rows[0]?.state,
    ).toBe("WAITING");
    expect(
      (
        await database.query("SELECT state FROM project_tasks WHERE step_id=$1", [
          job.workflow_step_id,
        ])
      ).rows[0]?.state,
    ).toBe("IN_REVIEW");
    expect(await automation.advanceNext(projectId)).toBeNull();
    expect(
      (
        await database.query(
          "SELECT id FROM muse_execution_activity WHERE job_id=$1 AND message LIKE 'CI passed.%'",
          [job.id],
        )
      ).rows,
    ).toHaveLength(1);
    moved = true;
    expect(await automation.advanceNext(projectId)).toMatch(/^blocked:/);
    expect(await stepState()).toBe("WAITING");
    moved = false;
    merged = true;
    expect(await automation.advanceNext(projectId)).toMatch(/^pr-merged:/);
    expect(await stepState()).toBe("COMPLETED");
    expect(
      (await database.query("SELECT state FROM agent_sessions WHERE id=$1", [job.agent_session_id]))
        .rows[0]?.state,
    ).toBe("COMPLETED");
    expect(
      (
        await database.query("SELECT state FROM project_tasks WHERE step_id=$1", [
          job.workflow_step_id,
        ])
      ).rows[0]?.state,
    ).toBe("DONE");
    const evidence = await database.query<
      { metadata: { headSha: string; runHeadSha: string } } & Record<string, unknown>
    >("SELECT metadata FROM evidence WHERE project_id=$1 AND scope_id=$2 AND category='ci'", [
      projectId,
      job.workflow_step_id,
    ]);
    expect(evidence.rows[0]?.metadata).toMatchObject({ headSha, runHeadSha: headSha });
    // A stale CI cache must not contradict the exact head-bound verified completion evidence.
    await database.query(
      'UPDATE muse_execution_jobs SET github_ci_state=\'WAITING\',github_ci_report=\'{"summary":"Waiting for CI","runs":[]}\'::jsonb WHERE id=$1',
      [job.id],
    );
    const verifiedJob = await new MuseExecutionJobService(database, authorization).getStatus({
      projectId,
      principalId,
      sessionId: job.agent_session_id,
    });
    expect(verifiedJob?.github_ci_state).toBe("PASSED");
    expect(verifiedJob?.github_ci_report).toMatchObject({
      runs: [{ id: 987, conclusion: "success" }],
    });
    // The final evidence belongs to this delivered head, not a future changed delivery.
    await database.query("UPDATE muse_execution_jobs SET github_head_sha=$2 WHERE id=$1", [
      job.id,
      "d".repeat(40),
    ]);
    expect(
      (
        await new MuseExecutionJobService(database, authorization).getStatus({
          projectId,
          principalId,
          sessionId: job.agent_session_id,
        })
      )?.github_ci_state,
    ).toBe("WAITING");
    await database.query("UPDATE muse_execution_jobs SET github_head_sha=$2 WHERE id=$1", [
      job.id,
      headSha,
    ]);

    const callsAfterCompletion = networkCalls;
    expect(await automation.advanceNext(projectId)).toBeNull();
    expect(networkCalls).toBe(callsAfterCompletion);
  });
});
