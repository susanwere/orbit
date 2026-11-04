import { DomainError } from "@orbit/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { AgentSessionService } from "../src/modules/agents/agent-session-service.js";
import { ApprovedStepMaterializer } from "../src/modules/execution/approved-step-materializer.js";
import { StepSessionBindingService } from "../src/modules/execution/step-session-binding-service.js";
import {
  MuseExecutionJobService,
  MuseExecutionWorker,
} from "../src/modules/execution/muse-execution-worker.js";
import { WorkflowReviewService } from "../src/modules/execution/workflow-review-service.js";
import { GithubCiMonitor } from "../src/modules/execution/github-ci-monitor.js";
import { MuseCiRepairService } from "../src/modules/execution/muse-ci-repair-service.js";
import { GithubCiEvidenceService } from "../src/modules/execution/github-ci-evidence-service.js";
import { MuseGithubDeliveryService } from "../src/modules/execution/muse-github-delivery.js";
import { hashMuseReviewOutput } from "../src/modules/execution/muse-review-output.js";
import { LocalMuseQueueConsumer } from "../src/modules/execution/local-muse-queue-consumer.js";
import {
  MuseDeliveryRequestService,
  LocalMuseDeliveryConsumer,
} from "../src/modules/execution/muse-delivery-request-service.js";
import { buildApp } from "../src/app.js";
import { WorkflowStepExecutionService } from "../src/modules/execution/workflow-step-execution-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("proposal and human workflow review (PostgreSQL)", () => {
  let database: PgDatabase;
  let reviews: WorkflowReviewService;
  let sessions: AgentSessionService;
  let authorization: ProjectAuthorizationService;
  let jobId: string;
  let sessionId: string;
  const organizationId = randomUUID(),
    projectId = randomUUID(),
    principalId = randomUUID(),
    viewerId = randomUUID(),
    memberId = randomUUID(),
    planId = randomUUID(),
    intentId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const outsiderId = randomUUID();
  const proposalStep = `step:${planId}:proposal:0:0`,
    humanStep = `step:${planId}:proposal:0:1`,
    codeStep = `step:${planId}:implementation:0:0`;
  const output =
    "Draft: English Hello World; German Hallo Welt; Kiswahili Habari Dunia. Choose simultaneous display or a selector.";
  const note =
    "Show all three greetings simultaneously in src/App.tsx: Hello World, Hallo Welt, Habari Dunia.";
  const reference = (stepId = proposalStep, actorId = principalId) => ({
    projectId,
    stepId,
    principalId: actorId,
  });
  beforeAll(async () => {
    database = new PgDatabase(databaseUrl!);
    authorization = new ProjectAuthorizationService(database);
    reviews = new WorkflowReviewService(database, authorization);
    sessions = new AgentSessionService(
      database,
      authorization,
      new AgentContextSnapshotService(database, authorization),
    );
    await database.query("INSERT INTO organizations(id,name) VALUES($1,'Review test')", [
      organizationId,
    ]);
    await database.query("INSERT INTO organizations(id,name) VALUES($1,'Other tenant')", [
      foreignOrganizationId,
    ]);
    await database.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Other admin','admin')",
      [outsiderId, foreignOrganizationId],
    );
    await database.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Review project')",
      [projectId, organizationId],
    );
    for (const [actorId, role] of [
      [principalId, "admin"],
      [viewerId, "viewer"],
      [memberId, "member"],
    ])
      await database.query(
        "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Reviewer',$3)",
        [actorId, organizationId, role],
      );
    await database.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,'Trilingual greeting',$4)",
      [intentId, organizationId, projectId, principalId],
    );
    const content = {
      summary: "Review before implementation",
      workItems: [
        {
          key: "proposal",
          title: "Draft greetings",
          description: "Prepare wording",
          dependsOn: [],
          workflows: [
            {
              name: "Review",
              steps: [
                { title: "Draft wording", executor: "agent", requiresApproval: false },
                { title: "Approve wording", executor: "human", requiresApproval: true },
              ],
            },
          ],
        },
        {
          key: "implementation",
          title: "Implement greetings",
          description: "Render approved wording",
          dependsOn: ["proposal"],
          workflows: [
            {
              name: "Code",
              steps: [
                { title: "Edit React component", executor: "agent", requiresApproval: false },
              ],
            },
          ],
        },
        {
          key: "revision",
          title: "Alternative proposal",
          description: "Draft a proposal that may need revision",
          dependsOn: [],
          workflows: [
            {
              name: "Draft",
              steps: [
                { title: "Prepare an alternative", executor: "agent", requiresApproval: false },
              ],
            },
          ],
        },
      ],
      guardrails: [],
      decisionsToReview: [],
      assumptions: [],
    };
    await database.query(
      "INSERT INTO plan_proposals(id,organization_id,project_id,original_intent_id,status,revision,content,created_by_principal_id,approved_by_principal_id) VALUES($1,$2,$3,$4,'APPROVED',1,$5::jsonb,$6,$6)",
      [planId, organizationId, projectId, intentId, JSON.stringify(content), principalId],
    );
    await database.query(
      "INSERT INTO project_repositories(project_id,organization_id,owner,repo,full_name,html_url) VALUES($1,$2,'susanwere','private-test','susanwere/private-test','https://github.com/susanwere/private-test')",
      [projectId, organizationId],
    );
    await new ApprovedStepMaterializer(database, authorization).materialize(projectId, principalId);
    const agent = await sessions.onboardMuse(projectId, principalId, "susanwere/private-test");
    const session = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:proposal`,
      mission: "Draft greeting options",
    });
    if (!session.session) throw new Error("Expected the test session to be created.");
    sessionId = String(session.session.id);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(),
      sessionId,
    });
    await sessions.start(projectId, principalId, sessionId);
    const job = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId,
    });
    jobId = String(job.id);
  });
  afterAll(async () => {
    if (!database) return;
    await database.query("DELETE FROM evidence WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM muse_job_outputs WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM muse_execution_jobs WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM workflow_step_prerequisites WHERE project_id=$1", [
      projectId,
    ]);
    await database.query("DELETE FROM workflow_step_executions WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM agent_sessions WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM execution_contracts WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM context_snapshots WHERE project_id=$1", [projectId]);
    await database.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await database.query("DELETE FROM organizations WHERE id=$1", [foreignOrganizationId]);
    await database.close();
  });
  it("defaults implementation to CI and prevents declaring agent work completed as a human task", async () => {
    expect(
      (
        await database.query("SELECT completion_kind FROM workflow_step_executions WHERE id=$1", [
          codeStep,
        ])
      ).rows[0]?.completion_kind,
    ).toBe("github_ci");
    await expect(reviews.completeHumanStep({ ...reference(codeStep), note })).rejects.toMatchObject(
      { code: "invalid_state" },
    );
    await expect(
      reviews.completeHumanStep({ ...reference(humanStep), note }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      reviews.authorizeProposal({
        ...reference(proposalStep, memberId),
        acknowledgeNonCodeStep: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      reviews.authorizeProposal({
        ...reference(proposalStep, viewerId),
        acknowledgeNonCodeStep: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      reviews.authorizeProposal({
        ...reference(proposalStep, outsiderId),
        acknowledgeNonCodeStep: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("retains real worker-finalization output under the exact scoped claim without completing the step", async () => {
    const previous = process.env.ORBIT_MUSE_ISOLATED_WORKER;
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    try {
      // Deterministic executor, isolated test records: not live Muse evidence.
      const worker = new MuseExecutionWorker(database, {
        execute: async () => ({
          provider: "test",
          exitCode: 0,
          events: [],
          outputTruncated: false,
          reviewOutput: output,
          changedPaths: [],
        }),
      });
      expect(
        await worker.runNext("/unused-test-workspace", {
          jobId,
          projectId,
          repository: "susanwere/private-test",
          allowedPaths: [
            "src/**",
            "index.html",
            "package.json",
            "package-lock.json",
            "tsconfig*.json",
            "vite.config.*",
          ],
        }),
      ).toEqual({ jobId, status: "TURN_FINISHED" });
    } finally {
      if (previous === undefined) delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
      else process.env.ORBIT_MUSE_ISOLATED_WORKER = previous;
    }
    const stored = await new MuseExecutionJobService(database, authorization).getStatus({
      projectId,
      principalId,
      sessionId,
    });
    expect(stored).toMatchObject({
      review_output: output,
      output_hash: hashMuseReviewOutput(output),
      changed_paths: [],
      status: "TURN_FINISHED",
    });
    expect(
      (
        await database.query("SELECT state FROM workflow_step_executions WHERE id=$1", [
          proposalStep,
        ])
      ).rows[0]?.state,
    ).toBe("RUNNING");
  });
  it("requires explicit policy, exact output hash, owner authorization and no code changes", async () => {
    await expect(
      reviews.reviewOutput({ ...reference(), note, outputHash: hashMuseReviewOutput(output) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await reviews.authorizeProposal({ ...reference(), acknowledgeNonCodeStep: true });
    await expect(
      reviews.reviewOutput({ ...reference(), note, outputHash: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      reviews.reviewOutput({
        ...reference(proposalStep, memberId),
        note,
        outputHash: hashMuseReviewOutput(output),
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await database.query(
      "UPDATE muse_job_outputs SET changed_paths='[\"src/App.tsx\"]'::jsonb WHERE job_id=$1",
      [jobId],
    );
    await expect(
      reviews.reviewOutput({ ...reference(), note, outputHash: hashMuseReviewOutput(output) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      reviews.authorizeProposal({ ...reference(), acknowledgeNonCodeStep: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await database.query("UPDATE muse_job_outputs SET changed_paths='[]'::jsonb WHERE job_id=$1", [
      jobId,
    ]);
    await expect(
      reviews.reviewOutput({ ...reference(), outputHash: hashMuseReviewOutput(output) }),
    ).resolves.toMatchObject({ state: "COMPLETED", evidenceKind: "human_review" });
    await expect(
      reviews.reviewOutput({ ...reference(), note, outputHash: hashMuseReviewOutput(output) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("completes the declared human gate and passes approved decisions into the implementation mission", async () => {
    await expect(reviews.completeHumanStep({ ...reference(humanStep) })).resolves.toMatchObject({
      state: "COMPLETED",
    });
    const agent = await sessions.onboardMuse(projectId, principalId, "susanwere/private-test");
    const created = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:implementation`,
      mission: "Render greeting",
    });
    if (!created.session) throw new Error("Expected the implementation session to be created.");
    expect(created.session.mission).toContain(output);
    expect(created.snapshot.authorizationBasis.workflowReviewEvidenceIds).toHaveLength(2);
    const contextVersions = await database.query<
      {
        content: { workflowReviews: { comment: string; proposal?: { content: string } }[] };
      } & Record<string, unknown>
    >(
      "SELECT version.content FROM context_versions version JOIN project_context_heads head ON head.current_context_version_id=version.id WHERE head.project_id=$1",
      [projectId],
    );
    expect(contextVersions.rows[0]?.content.workflowReviews).toHaveLength(2);
    expect(
      contextVersions.rows[0]?.content.workflowReviews.every((review) => review.comment === ""),
    ).toBe(true);
    expect(
      contextVersions.rows[0]?.content.workflowReviews.some(
        (review) => review.proposal?.content === output,
      ),
    ).toBe(true);
    const evidence = await database.query(
      "SELECT category,result FROM evidence WHERE project_id=$1",
      [projectId],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(
      evidence.rows.every(
        (record) => record.category === "human_review" && record.result === "PASSED",
      ),
    ).toBe(true);
  });
  it("preserves rejected output and requires explicit authorization before retrying", async () => {
    const stepId = `step:${planId}:revision:0:0`;
    const agent = await sessions.onboardMuse(projectId, principalId, "susanwere/private-test");
    const created = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:revision`,
      mission: "Draft an alternative",
    });
    if (!created.session) throw new Error("Expected revision session.");
    const revisionSessionId = String(created.session.id);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(stepId),
      sessionId: revisionSessionId,
    });
    await sessions.start(projectId, principalId, revisionSessionId);
    const revisionJob = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: revisionSessionId,
    });
    await database.query("UPDATE muse_execution_jobs SET status='TURN_FINISHED' WHERE id=$1", [
      revisionJob.id,
    ]);
    // An explicit retained fixture, not claimed live model output.
    await database.query(
      "INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source) VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'execution')",
      [revisionJob.id, organizationId, projectId, output, hashMuseReviewOutput(output)],
    );
    await reviews.authorizeProposal({ ...reference(stepId), acknowledgeNonCodeStep: true });
    await expect(
      reviews.reviewOutput({
        ...reference(stepId),
        outputHash: hashMuseReviewOutput(output),
        decision: "reject",
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      reviews.reviewOutput({
        ...reference(stepId),
        note: "Revise the wording; no implementation authorized.",
        outputHash: hashMuseReviewOutput(output),
        decision: "reject",
      }),
    ).resolves.toMatchObject({ state: "FAILED" });
    expect(
      (
        await database.query("SELECT content FROM muse_job_outputs WHERE job_id=$1", [
          revisionJob.id,
        ])
      ).rows[0]?.content,
    ).toBe(output);
    const execution = new WorkflowStepExecutionService(database, authorization);
    await expect(execution.authorizeRetry(reference(stepId))).resolves.toMatchObject({
      state: "BLOCKED",
      agent_session_id: null,
    });
    expect(
      (await database.query("SELECT status FROM muse_execution_jobs WHERE id=$1", [revisionJob.id]))
        .rows[0]?.status,
    ).toBe("FAILED");
    const revised = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:revision`,
      mission: "Prepare revised options",
    });
    if (!revised.session) throw new Error("Expected revised session.");
    expect(revised.session.mission).toContain(
      "Requested human revision (not approval): Revise the wording; no implementation authorized.",
    );
    expect(revised.snapshot.mission).toBe(revised.session.mission);
    const revisedSessionId = String(revised.session.id);
    const preservedSnapshot = (
      await database.query("SELECT * FROM context_snapshots WHERE id=$1", [revised.snapshot.id])
    ).rows[0];
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(stepId),
      sessionId: revisedSessionId,
    });
    await sessions.start(projectId, principalId, revisedSessionId);
    const queued = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: revisedSessionId,
    });
    const queuedJobId = String(queued.id);
    expect(
      await new MuseExecutionJobService(database, authorization).getStatus({
        projectId,
        principalId,
        sessionId: revisedSessionId,
      }),
    ).toMatchObject({ needs_revision_replacement: false });
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId), jobId: queuedJobId }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    await expect(
      execution.retireUnstartedJob({ ...reference(stepId, memberId), jobId: queuedJobId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId, outsiderId), jobId: queuedJobId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await database.query(
      "UPDATE muse_execution_jobs SET status='RUNNING',attempts=1,started_at=now() WHERE id=$1",
      [queuedJobId],
    );
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId), jobId: queuedJobId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await database.query(
      "UPDATE muse_execution_jobs SET status='QUEUED',attempts=0,started_at=NULL WHERE id=$1",
      [queuedJobId],
    );
    // Emulate the execution mission of a pre-fix queued session; snapshots stay untouched.
    await database.query(
      "UPDATE agent_sessions SET mission='Legacy mission without revision feedback' WHERE id=$1",
      [revisedSessionId],
    );
    expect(
      await new MuseExecutionJobService(database, authorization).getStatus({
        projectId,
        principalId,
        sessionId: revisedSessionId,
      }),
    ).toMatchObject({ needs_revision_replacement: true });
    await expect(
      new MuseExecutionJobService(database, authorization).enqueue({
        projectId,
        principalId,
        sessionId: revisedSessionId,
        executeLocally: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const previousIsolation = process.env.ORBIT_MUSE_ISOLATED_WORKER;
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    try {
      const worker = new MuseExecutionWorker(database, {
        execute: async () => {
          throw new Error("Stale session must not execute");
        },
      });
      expect(
        await worker.runNext("/unused", {
          jobId: queuedJobId,
          projectId,
          repository: "susanwere/private-test",
          allowedPaths: [
            "src/**",
            "index.html",
            "package.json",
            "package-lock.json",
            "tsconfig*.json",
            "vite.config.*",
          ],
        }),
      ).toBeNull();
    } finally {
      if (previousIsolation === undefined) delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
      else process.env.ORBIT_MUSE_ISOLATED_WORKER = previousIsolation;
    }
    expect(
      (await database.query("SELECT attempts FROM muse_execution_jobs WHERE id=$1", [queuedJobId]))
        .rows[0]?.attempts,
    ).toBe(0);
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId), jobId: queuedJobId }),
    ).resolves.toMatchObject({ state: "FAILED", previousAgentSessionId: revisedSessionId });
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId), jobId: queuedJobId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await execution.authorizeRetry(reference(stepId));
    expect(
      (await database.query("SELECT * FROM context_snapshots WHERE id=$1", [revised.snapshot.id]))
        .rows[0],
    ).toEqual(preservedSnapshot);
    expect(
      (await database.query("SELECT state FROM agent_sessions WHERE id=$1", [revisedSessionId]))
        .rows[0]?.state,
    ).toBe("TERMINATED");
    const replacement = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:revision`,
      mission: "Prepare revised options",
    });
    expect(replacement.snapshot.id).not.toBe(revised.snapshot.id);
    expect(replacement.snapshot.mission).toContain(
      "Requested human revision (not approval): Revise the wording; no implementation authorized.",
    );
    if (!replacement.session) throw new Error("Expected replacement session.");
    const replacementSessionId = String(replacement.session.id);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(stepId),
      sessionId: replacementSessionId,
    });
    await sessions.start(projectId, principalId, replacementSessionId);
    const replacementJob = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: replacementSessionId,
    });
    expect(
      await new MuseExecutionJobService(database, authorization).getStatus({
        projectId,
        principalId,
        sessionId: replacementSessionId,
      }),
    ).toMatchObject({ status: "QUEUED", needs_revision_replacement: false });
    await expect(
      execution.retireUnstartedJob({ ...reference(stepId), jobId: String(replacementJob.id) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("runs only explicit browser requests once, reports setup errors safely and leaves CI unverified", async () => {
    const stepId = `step:${planId}:revision:0:0`;
    const sessionRows = await database.query<
      { agent_session_id: string } & Record<string, unknown>
    >("SELECT agent_session_id FROM workflow_step_executions WHERE id=$1", [stepId]);
    const currentSessionId = sessionRows.rows[0]!.agent_session_id;
    const jobs = new MuseExecutionJobService(database, authorization);
    let executionCalls = 0;
    const setupFailure = new LocalMuseQueueConsumer(database, {
      prepare: async () => {
        throw new Error("private-token-must-not-be-persisted");
      },
      execute: async () => {
        executionCalls++;
      },
    });
    expect(await setupFailure.runNext(projectId)).toBeNull();
    await expect(
      jobs.enqueue({
        projectId,
        principalId: outsiderId,
        sessionId: currentSessionId,
        executeLocally: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      jobs.enqueue({
        projectId,
        principalId: viewerId,
        sessionId: currentSessionId,
        executeLocally: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const requested = await jobs.enqueue({
      projectId,
      principalId,
      sessionId: currentSessionId,
      executeLocally: true,
    });
    expect(
      await jobs.enqueue({
        projectId,
        principalId,
        sessionId: currentSessionId,
        executeLocally: true,
      }),
    ).toMatchObject({ id: requested.id, local_execution_state: "REQUESTED" });
    expect(await setupFailure.runNext(projectId)).toBe(requested.id);
    expect(executionCalls).toBe(0);
    const failure = await jobs.getStatus({ projectId, principalId, sessionId: currentSessionId });
    expect(failure).toMatchObject({
      status: "QUEUED",
      attempts: 0,
      local_execution_state: "ERROR",
    });
    expect(String(failure?.local_execution_error)).not.toContain("private-token");
    await jobs.enqueue({
      projectId,
      principalId,
      sessionId: currentSessionId,
      executeLocally: true,
    });
    await database.query(
      "UPDATE muse_execution_jobs SET local_execution_state='PREPARING' WHERE id=$1",
      [requested.id],
    );
    await setupFailure.recoverInterruptedRequests(projectId);
    expect(
      await jobs.getStatus({ projectId, principalId, sessionId: currentSessionId }),
    ).toMatchObject({ local_execution_state: "ERROR", attempts: 0 });
    await jobs.enqueue({
      projectId,
      principalId,
      sessionId: currentSessionId,
      executeLocally: true,
    });
    const previous = process.env.ORBIT_MUSE_ISOLATED_WORKER;
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    try {
      const consumer = new LocalMuseQueueConsumer(database, {
        prepare: async () => {
          expect(
            await jobs.enqueue({
              projectId,
              principalId,
              sessionId: currentSessionId,
              executeLocally: true,
            }),
          ).toMatchObject({ id: requested.id, local_execution_state: "PREPARING" });
        },
        execute: async (jobId) => {
          executionCalls++;
          const worker = new MuseExecutionWorker(database, {
            execute: async () => ({
              provider: "test",
              exitCode: 0,
              events: [],
              outputTruncated: false,
              reviewOutput: output,
              changedPaths: [],
            }),
          });
          expect(
            await worker.runNext("/unused", {
              jobId,
              projectId,
              repository: "susanwere/private-test",
              allowedPaths: [
                "src/**",
                "index.html",
                "package.json",
                "package-lock.json",
                "tsconfig*.json",
                "vite.config.*",
              ],
            }),
          ).toMatchObject({ status: "TURN_FINISHED" });
        },
      });
      const concurrent = await Promise.all([
        consumer.runNext(projectId),
        consumer.runNext(projectId),
      ]);
      expect(concurrent.filter((jobId) => jobId === requested.id)).toHaveLength(1);
      expect(concurrent.filter((jobId) => jobId === null)).toHaveLength(1);
      expect(await consumer.runNext(projectId)).toBeNull();
      expect(executionCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
      else process.env.ORBIT_MUSE_ISOLATED_WORKER = previous;
    }
    expect(
      await jobs.getStatus({ projectId, principalId, sessionId: currentSessionId }),
    ).toMatchObject({
      status: "TURN_FINISHED",
      local_execution_state: "FINISHED",
      attempts: 1,
      github_pull_number: null,
    });
    await expect(
      jobs.enqueue({ projectId, principalId, sessionId: currentSessionId, executeLocally: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(
      (await database.query("SELECT state FROM workflow_step_executions WHERE id=$1", [stepId]))
        .rows[0]?.state,
    ).toBe("RUNNING");
  });

  it("authorizes exact code output delivery once and keeps workflow completion separate from the PR", async () => {
    const agent = await sessions.onboardMuse(projectId, principalId, "susanwere/private-test");
    const created = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:implementation`,
      mission: "Implement approved wording",
    });
    if (!created.session) throw new Error("Expected a delivery test session.");
    const implementationSessionId = String(created.session.id);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(codeStep),
      sessionId: implementationSessionId,
    });
    await sessions.start(projectId, principalId, implementationSessionId);
    const job = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: implementationSessionId,
    });
    await database.query("UPDATE muse_execution_jobs SET status='TURN_FINISHED' WHERE id=$1", [
      job.id,
    ]);
    await database.query(
      "INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source) VALUES($1,$2,$3,$4,$5,'[\"src/App.tsx\"]'::jsonb,'execution')",
      [job.id, organizationId, projectId, output, hashMuseReviewOutput(output)],
    );
    const deliveryRequests = new MuseDeliveryRequestService(database, authorization);
    const input = {
      ...reference(codeStep),
      jobId: String(job.id),
      outputHash: hashMuseReviewOutput(output),
    };
    for (const actorId of [viewerId, outsiderId])
      await expect(
        deliveryRequests.request({ ...input, principalId: actorId }),
      ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      deliveryRequests.request({ ...input, principalId: memberId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      deliveryRequests.request({ ...input, outputHash: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      deliveryRequests.request({ ...input, stepId: proposalStep }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const pendingConsumer = new LocalMuseDeliveryConsumer(database, async () => {
      throw new Error("No delivery without consent");
    });
    expect(await pendingConsumer.runNext(projectId)).toBeNull();
    await database.query("UPDATE plan_proposals SET revision=2 WHERE id=$1", [planId]);
    await expect(deliveryRequests.request(input)).rejects.toMatchObject({ code: "invalid_state" });
    await database.query("UPDATE plan_proposals SET revision=1 WHERE id=$1", [planId]);
    await expect(deliveryRequests.request(input)).resolves.toMatchObject({
      id: job.id,
      delivery_state: "REQUESTED",
    });
    await expect(deliveryRequests.request(input)).resolves.toMatchObject({
      id: job.id,
      delivery_state: "REQUESTED",
    });
    let deliveryCalls = 0;
    // Stub-only delivery evidence on disposable test rows, never presented as a live GitHub result.
    const consumer = new LocalMuseDeliveryConsumer(database, async (jobId) => {
      deliveryCalls++;
      const previousIsolation = process.env.ORBIT_MUSE_ISOLATED_WORKER;
      process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
      try {
        // Exercise the real tenant/plan/contract delivery query; deliberately stop at origin validation before Git writes/network.
        await expect(
          new MuseGithubDeliveryService(
            database,
            "test-token",
            async () => "https://github.com/other/denied.git",
          ).deliver({
            jobId,
            projectId,
            workspace: "/tmp/test-delivery-checkout",
            baseBranch: "main",
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Checkout origin does not match the execution contract.",
        });
      } finally {
        if (previousIsolation === undefined) delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
        else process.env.ORBIT_MUSE_ISOLATED_WORKER = previousIsolation;
      }
      await database.query(
        "UPDATE muse_execution_jobs SET github_repository='susanwere/private-test',github_pull_number=123,github_head_sha=$2 WHERE id=$1",
        [jobId, "a".repeat(40)],
      );
    });
    const concurrent = await Promise.all([
      consumer.runNext(projectId),
      consumer.runNext(projectId),
    ]);
    expect(concurrent.filter((jobId) => jobId === job.id)).toHaveLength(1);
    expect(deliveryCalls).toBe(1);
    expect(await consumer.runNext(projectId)).toBeNull();
    const status = await new MuseExecutionJobService(database, authorization).getStatus({
      projectId,
      principalId,
      sessionId: implementationSessionId,
    });
    expect(status).toMatchObject({
      delivery_state: "FINISHED",
      github_pull_number: 123,
      github_head_sha: "a".repeat(40),
      status: "TURN_FINISHED",
    });
    expect(
      (await database.query("SELECT state FROM workflow_step_executions WHERE id=$1", [codeStep]))
        .rows[0]?.state,
    ).toBe("RUNNING");
    expect(
      (
        await database.query("SELECT id FROM evidence WHERE scope_id=$1 AND category='ci'", [
          codeStep,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(deliveryRequests.request(input)).resolves.toMatchObject({
      delivery_state: "FINISHED",
    });
    expect(status?.github_ci_url).toBeNull();

    // Failure -> human repair authorization -> fresh pinned session, all test-only data.
    const preservedOriginalSnapshot = (
      await database.query("SELECT * FROM context_snapshots WHERE id=$1", [created.snapshot.id])
    ).rows[0];
    const failureMonitor = new GithubCiMonitor(
      database,
      "test-read-token",
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("/pulls/")
              ? {
                  number: 123,
                  head: {
                    sha: "a".repeat(40),
                    ref: `orbit/muse-${job.id}`,
                    repo: { full_name: "susanwere/private-test" },
                  },
                  base: { repo: { full_name: "susanwere/private-test" } },
                }
              : String(url).includes("/jobs?")
                ? {
                    jobs: [
                      {
                        name: "build",
                        conclusion: "failure",
                        steps: [{ name: "npm run build", conclusion: "failure" }],
                      },
                    ],
                  }
                : {
                    total_count: 1,
                    workflow_runs: [
                      {
                        id: 986,
                        name: "CI",
                        workflow_id: 1,
                        run_number: 1,
                        status: "completed",
                        conclusion: "failure",
                        event: "pull_request",
                        repository: { full_name: "susanwere/private-test" },
                        pull_requests: [{ number: 123, head: { sha: "a".repeat(40) } }],
                      },
                    ],
                  },
          ),
        ),
    );
    expect(
      (await failureMonitor.inspect({ jobId: String(job.id), projectId, organizationId })).state,
    ).toBe("FAILED");
    const repairs = new MuseCiRepairService(database, authorization);
    await expect(
      repairs.prepare({ ...reference(codeStep, viewerId), jobId: String(job.id) }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      repairs.prepare({ ...reference(codeStep, memberId), jobId: String(job.id) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const originalJobIdentity = (
      await database.query(
        "SELECT id,agent_session_id,created_at,started_at,finished_at,attempts FROM muse_execution_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    const jobCountBeforeAuthorization = (
      await database.query(
        "SELECT count(*)::int AS count FROM muse_execution_jobs WHERE project_id=$1 AND workflow_step_id=$2",
        [projectId, codeStep],
      )
    ).rows[0]?.count;
    await expect(
      repairs.prepare({ ...reference(codeStep), jobId: String(job.id) }),
    ).resolves.toMatchObject({ state: "FAILED" });
    await new WorkflowStepExecutionService(database, authorization).authorizeRetry(
      reference(codeStep),
    );
    expect(
      (
        await database.query(
          "SELECT id,agent_session_id,created_at,started_at,finished_at,attempts FROM muse_execution_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0],
    ).toEqual(originalJobIdentity);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM muse_execution_jobs WHERE project_id=$1 AND workflow_step_id=$2",
          [projectId, codeStep],
        )
      ).rows[0]?.count,
    ).toBe(jobCountBeforeAuthorization);
    expect(
      (
        await database.query(
          "SELECT state,agent_session_id FROM workflow_step_executions WHERE id=$1",
          [codeStep],
        )
      ).rows[0],
    ).toMatchObject({ state: "BLOCKED", agent_session_id: null });
    let repair = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:implementation`,
      mission: "Repair the reported build failure without changing approved greeting choices",
      repairSourceJobId: String(job.id),
    });
    if (!repair.session) throw new Error("Expected a fresh CI repair session.");
    let repairSessionId = String(repair.session.id);
    expect(repair.session.repair_source_job_id).toBe(job.id);
    expect(repairSessionId).not.toBe(implementationSessionId);
    expect(repair.snapshot.mission).toContain("npm run build");
    expect(repair.snapshot.mission).toContain("UNTRUSTED CI DIAGNOSTIC DATA");
    expect(repair.snapshot.mission).toContain("CI REPAIR EXECUTION IS AUTHORIZED");
    expect(repair.snapshot.mission).toContain(
      "Repair the reported build failure without changing approved greeting choices",
    );
    expect(repair.snapshot.mission).toContain("Do not revert feature code");
    expect(repair.snapshot.mission).toContain("Human-authorized CI repair:");
    expect(repair.snapshot.id).not.toBe(created.snapshot.id);
    expect(
      (await database.query("SELECT * FROM context_snapshots WHERE id=$1", [created.snapshot.id]))
        .rows[0],
    ).toEqual(preservedOriginalSnapshot);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(codeStep),
      sessionId: repairSessionId,
    });
    await sessions.start(projectId, principalId, repairSessionId);
    let repairJob = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: repairSessionId,
    });
    expect(
      (
        await database.query("SELECT repair_source_job_id FROM muse_execution_jobs WHERE id=$1", [
          repairJob.id,
        ])
      ).rows[0]?.repair_source_job_id,
    ).toBe(job.id);

    expect(repairJob.id).not.toBe(job.id);
    expect(
      (
        await database.query(
          "SELECT status,attempts,local_execution_state FROM muse_execution_jobs WHERE id=$1",
          [repairJob.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "QUEUED", attempts: 0, local_execution_state: null });
    // An unproductive turn must never masquerade as a delivered fix; authorize a fresh session instead.
    await database.query("UPDATE muse_execution_jobs SET status='TURN_FINISHED' WHERE id=$1", [
      repairJob.id,
    ]);
    await database.query(
      "INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source) VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'execution')",
      [repairJob.id, organizationId, projectId, output, hashMuseReviewOutput(output)],
    );
    expect(
      await new MuseExecutionJobService(database, authorization).getStatus({
        projectId,
        principalId,
        sessionId: repairSessionId,
      }),
    ).toMatchObject({ needs_ci_repair_retry: true });
    const preservedNoopSnapshot = (
      await database.query("SELECT * FROM context_snapshots WHERE id=$1", [repair.snapshot.id])
    ).rows[0];
    const noopSnapshotId = repair.snapshot.id;
    await expect(
      repairs.prepare({ ...reference(codeStep), jobId: String(repairJob.id) }),
    ).resolves.toMatchObject({ repairSourceJobId: job.id, state: "FAILED" });
    await new WorkflowStepExecutionService(database, authorization).authorizeRetry(
      reference(codeStep),
    );
    repair = await sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: agent.id,
      workItemId: `work:${planId}:implementation`,
      mission: "Execute the authorized CI repair now",
      repairSourceJobId: String(job.id),
    });
    if (!repair.session) throw new Error("Expected replacement repair session.");
    repairSessionId = String(repair.session.id);
    await new StepSessionBindingService(database, authorization).bind({
      ...reference(codeStep),
      sessionId: repairSessionId,
    });
    await sessions.start(projectId, principalId, repairSessionId);
    repairJob = await new MuseExecutionJobService(database, authorization).enqueue({
      projectId,
      principalId,
      sessionId: repairSessionId,
    });
    expect(
      (await database.query("SELECT * FROM context_snapshots WHERE id=$1", [noopSnapshotId]))
        .rows[0],
    ).toEqual(preservedNoopSnapshot);
    const repairHeadSha = "b".repeat(40);
    // Explicit replacement-turn/delivery fixture. No model or network execution.
    await database.query(
      "UPDATE muse_execution_jobs SET status='TURN_FINISHED',github_repository='susanwere/private-test',github_pull_number=123,github_head_sha=$2,delivery_state='FINISHED',github_review_state='DRAFT' WHERE id=$1",
      [repairJob.id, repairHeadSha],
    );
    await database.query(
      "INSERT INTO muse_job_outputs(job_id,organization_id,project_id,content,content_hash,changed_paths,source) VALUES($1,$2,$3,$4,$5,'[\"src/App.tsx\"]'::jsonb,'execution')",
      [repairJob.id, organizationId, projectId, output, hashMuseReviewOutput(output)],
    );
    // Independent GitHub API fixtures on test-only rows. This is not a live CI claim.
    const evidenceService = new GithubCiEvidenceService(
      database,
      authorization,
      "test-read-token",
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("/actions/runs/")
              ? {
                  status: "completed",
                  conclusion: "success",
                  event: "pull_request",
                  name: "CI",
                  head_sha: repairHeadSha,
                  repository: { full_name: "susanwere/private-test" },
                  pull_requests: [{ number: 123, head: { sha: repairHeadSha } }],
                }
              : {
                  number: 123,
                  head: { sha: repairHeadSha },
                  base: { repo: { full_name: "susanwere/private-test" } },
                  merged_at: "2026-11-01T01:00:00Z",
                },
          ),
        ),
    );
    await expect(
      evidenceService.verify({
        ...reference(codeStep),
        repository: "susanwere/private-test",
        pullNumber: 123,
        runId: 987,
      }),
    ).resolves.toMatchObject({ state: "COMPLETED" });
    const verifiedStatus = await new MuseExecutionJobService(database, authorization).getStatus({
      projectId,
      principalId,
      sessionId: repairSessionId,
    });
    expect(verifiedStatus).toMatchObject({
      github_ci_run_id: "987",
      github_ci_url: "https://github.com/susanwere/private-test/actions/runs/987",
    });
  });

  it("sanitizes delivery errors and never replays failed or interrupted pushes", async () => {
    const stepId = `step:${planId}:revision:0:0`;
    const job = (
      await database.query<{ id: string } & Record<string, unknown>>(
        "SELECT id FROM muse_execution_jobs WHERE workflow_step_id=$1 AND status='TURN_FINISHED'",
        [stepId],
      )
    ).rows[0];
    if (!job) throw new Error("Expected a retained revision job.");
    // Explicit fixture of a pending request: no real GitHub call.
    await database.query(
      "UPDATE muse_execution_jobs SET delivery_state='REQUESTED',delivery_requested_at=now() WHERE id=$1",
      [job.id],
    );
    let calls = 0;
    const consumer = new LocalMuseDeliveryConsumer(database, async () => {
      calls++;
      throw new Error("secret-token-never-persist");
    });
    expect(await consumer.runNext(projectId)).toBe(job.id);
    const failure = (
      await database.query(
        "SELECT delivery_state,delivery_error FROM muse_execution_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    expect(failure?.delivery_state).toBe("ERROR");
    expect(failure?.delivery_error).not.toContain("secret-token");
    expect(await consumer.runNext(projectId)).toBeNull();
    expect(calls).toBe(1);
    await database.query("UPDATE muse_execution_jobs SET delivery_state='RUNNING' WHERE id=$1", [
      job.id,
    ]);
    expect(await consumer.runNext(projectId)).toBeNull();
    expect(calls).toBe(1);
    expect(
      (await database.query("SELECT delivery_state FROM muse_execution_jobs WHERE id=$1", [job.id]))
        .rows[0]?.delivery_state,
    ).toBe("ERROR");
  });

  it("exposes declared executor and review kind through the authenticated existing step read", async () => {
    const app = await buildApp({
      workflowSteps: {
        db: database,
        authorization,
        auth: {
          verify: (header) => {
            if (header !== "Bearer test") throw new DomainError("unauthenticated", "Auth required");
            return { id: principalId, organizationId };
          },
        },
        materializer: new ApprovedStepMaterializer(database, authorization),
        execution: new WorkflowStepExecutionService(database, authorization),
        binding: new StepSessionBindingService(database, authorization),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/execution/steps`,
      headers: { authorization: "Bearer test" },
    });
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/execution/steps/${humanStep}/complete-human-review`,
      payload: { note },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    expect(
      response.json().steps.find((step: { id: string }) => step.id === humanStep),
    ).toMatchObject({ executor: "human", state: "COMPLETED" });
    await app.close();
  });
});
