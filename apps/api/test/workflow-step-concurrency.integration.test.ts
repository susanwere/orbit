import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { WorkflowStepExecutionService } from "../src/modules/execution/workflow-step-execution-service.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const id = () => randomUUID();

describe.skipIf(!databaseUrl)("workflow step ordering and concurrency (PostgreSQL)", () => {
  let db: PgDatabase;
  let execution: WorkflowStepExecutionService;
  const org = id();
  const project = id();
  const principal = id();
  const intent = id();
  const plan = id();
  const prerequisite = id();
  const dependent = id();

  const start = (stepId: string) =>
    execution.start({ projectId: project, principalId: principal, stepId });

  beforeAll(async () => {
    db = new PgDatabase(databaseUrl!);
    execution = new WorkflowStepExecutionService(db, new ProjectAuthorizationService(db));
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Step concurrency test')", [
      org,
    ]);
    await db.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,$3)", [
      project,
      org,
      project,
    ]);
    await db.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Reviewer','admin')",
      [principal, org],
    );
    await db.query(
      "INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,'Build test app',$4)",
      [intent, org, project, principal],
    );
    await db.query(
      `INSERT INTO plan_proposals
       (id,organization_id,project_id,original_intent_id,status,revision,content,created_by_principal_id,approved_by_principal_id)
       VALUES($1,$2,$3,$4,'APPROVED',1,'{}'::jsonb,$5,$5)`,
      [plan, org, project, intent, principal],
    );
    for (const [step, index] of [[prerequisite, 0], [dependent, 1]] as const) {
      await db.query(
        `INSERT INTO workflow_step_executions
         (id,organization_id,project_id,plan_id,plan_revision,work_item_key,workflow_index,step_index,state,approval_required)
         VALUES($1,$2,$3,$4,1,'TEST-1',0,$5,'BLOCKED',false)`,
        [step, org, project, plan, index],
      );
    }
    await db.query(
      `INSERT INTO workflow_step_prerequisites
       (organization_id,project_id,step_id,prerequisite_step_id)
       VALUES($1,$2,$3,$4)`,
      [org, project, dependent, prerequisite],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("DELETE FROM workflow_step_prerequisites WHERE project_id=$1", [project]);
    await db.query("DELETE FROM workflow_step_executions WHERE project_id=$1", [project]);
    await db.query("DELETE FROM organizations WHERE id=$1", [org]);
    await db.close();
  });

  it("refuses a dependent step before its prerequisite completes", async () => {
    await expect(start(dependent)).rejects.toMatchObject({ code: "invalid_state" });
    const result = await db.query<{ state: string }>(
      "SELECT state FROM workflow_step_executions WHERE id=$1",
      [dependent],
    );
    expect(result.rows[0]?.state).toBe("BLOCKED");
  });

  it("serializes simultaneous starts and refuses a duplicate", async () => {
    const results = await Promise.allSettled([start(prerequisite), start(prerequisite)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const result = await db.query<{ state: string }>(
      "SELECT state FROM workflow_step_executions WHERE id=$1",
      [prerequisite],
    );
    expect(result.rows[0]?.state).toBe("RUNNING");
  });

  it("permits a dependent step only after persisted prerequisite completion", async () => {
    // This test isolates prerequisite ordering. The production completion API
    // separately requires a completed session and passing evidence.
    await db.query(
      "UPDATE workflow_step_executions SET state='COMPLETED',completed_at=now() WHERE id=$1",
      [prerequisite],
    );
    await expect(start(dependent)).resolves.toMatchObject({ state: "RUNNING" });
  });
});
