import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";
import { DecisionAnalysisService } from "../src/modules/decisions/decision-analysis-service.js";
import { DecisionAnalysisWorker } from "../src/modules/decisions/decision-analysis-worker.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("live database Muse proposal orchestration", () => {
  let db: PgDatabase;
  const organizationId = `org_analysis_${randomUUID()}`;
  const projectId = `project_analysis_${randomUUID()}`;
  const principalId = `system_analysis_${randomUUID()}`;
  const versionId = `context_analysis_${randomUUID()}`;
  const eventId = `evt_analysis_${randomUUID()}`;
  const at = "2026-10-28T10:00:00.000Z";
  beforeAll(async () => {
    db = new PgDatabase(url!);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Analysis test')",[organizationId]);
    await db.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Analysis')",[projectId,organizationId]);
    await db.query("INSERT INTO principals(id,organization_id,type,display_name) VALUES($1,$2,'system','Detector')",[principalId,organizationId]);
    const intentId=`intent_${randomUUID()}`;
    const human=`reviewer_${randomUUID()}`;
    await db.query("INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Reviewer','admin')",[human,organizationId]);
    await db.query("INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id) VALUES($1,$2,$3,'Jobs viewer',$4)",[intentId,organizationId,projectId,human]);
    const context={projectId,originalIntentId:intentId,currentIntent:"Jobs viewer",constraints:[],attributes:{}};
    await db.query(`INSERT INTO context_versions(id,organization_id,project_id,version_number,content,content_hash)
      VALUES($1,$2,$3,1,$4::jsonb,$5)`,[versionId,organizationId,projectId,JSON.stringify(context),hashProjectContext(context)]);
    await db.query(`INSERT INTO project_context_heads(project_id,organization_id,current_context_version_id,version_number)
      VALUES($1,$2,$3,1)`,[projectId,organizationId,versionId]);
    await db.query(`INSERT INTO events(
      id,organization_id,project_id,type,occurred_at,correlation_id,causation_id,
      actor_type,actor_id,entity_type,entity_id,payload
    ) VALUES ($1,$2,$3,'pull_request.comment_created',$4,'pr-12','delivery-12',
      'human','github-42','pull_request_comment','repo#12:comment:33',$5::jsonb)`,
      [eventId,organizationId,projectId,at,JSON.stringify({
        body:"Use explicit Load More for jobs",sourceArtifact:{
          provider:"github",type:"issue_comment",externalId:"repo#12:comment:33",
          url:"https://github.com/org/repo/pull/12#issuecomment-33",
        },
      })]);
    await db.query("INSERT INTO decision_analysis_jobs(event_id,organization_id,project_id) VALUES($1,$2,$3)",[eventId,organizationId,projectId]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM organizations WHERE id=$1",[organizationId]);
    await db.close();
  });

  it("stores exactly one grounded review proposal from a committed event",async()=>{
    let calls=0;
    const detector={detect:async()=>{calls++;return {kind:"candidate" as const,candidate:{
      title:"Use explicit Load More",rationale:"Reduce initial render cost",scope:["jobs"],
      alternatives:["Infinite scroll"],confidence:0.95,evidenceQuote:"Use explicit Load More",
    }};}};
    const analysis=new DecisionAnalysisService(db,detector,principalId);
    const worker=new DecisionAnalysisWorker(db,analysis);
    expect(await worker.processBatch()).toBe(1);
    expect(calls).toBe(1);
    const proposals=await db.query<{id:string;status:string}>(
      "SELECT id,status FROM decision_proposals WHERE project_id=$1",[projectId]);
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]?.status).toBe("READY_FOR_REVIEW");
    const changes=await db.query<{base_context_version_id:string;operations:unknown}>(
      "SELECT base_context_version_id,operations FROM context_change_proposals WHERE project_id=$1",[projectId]);
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]?.base_context_version_id).toBe(versionId);
    expect(await worker.processBatch()).toBe(0);
    expect(await analysis.analyze(eventId)).toBe("proposed");
    const repeat=await db.query<{id:string}>("SELECT id FROM decision_proposals WHERE project_id=$1",[projectId]);
    expect(repeat.rows).toHaveLength(1);
    const notifications=await db.query<{id:string;recipient_principal_id:string}>(
      "SELECT id,recipient_principal_id FROM notifications WHERE project_id=$1",[projectId]);
    expect(notifications.rows).toHaveLength(1);
    const reviewEvents=await db.query<{id:string}>(
      "SELECT id FROM events WHERE project_id=$1 AND type='decision.review_required'",[projectId]);
    expect(reviewEvents.rows).toHaveLength(1);
    const head=await db.query<{current_context_version_id:string}>(
      "SELECT current_context_version_id FROM project_context_heads WHERE project_id=$1",[projectId]);
    expect(head.rows[0]?.current_context_version_id).toBe(versionId);
  });
});
