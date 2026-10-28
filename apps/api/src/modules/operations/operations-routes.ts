import {randomUUID} from "node:crypto";
import {DomainError} from "@orbit/domain";
import type {SqlDatabase} from "@orbit/db";
import type {FastifyInstance} from "fastify";
import type {AuthVerifier} from "../auth/verified-principal.js";
import type {ProjectAuthorizationService} from "../projects/project-authorization.js";

export interface OperationsOptions{
  db:SqlDatabase;auth:AuthVerifier;authorization:ProjectAuthorizationService;
}
const allowedQueues={
  webhook:{table:"webhook_inbox",idColumn:"id"},
  analysis:{table:"decision_analysis_jobs",idColumn:"event_id"},
  effects:{table:"domain_effect_jobs",idColumn:"event_id"},
} as const;
type Queue=keyof typeof allowedQueues;
export async function registerOperationsRoutes(app:FastifyInstance,opts:OperationsOptions){
  const admin=async(header:string|undefined,projectId:string)=>{
    const principal=opts.auth.verify(header);
    const actor=await opts.authorization.authorize(principal.id,projectId,"review");
    if(actor.role!=="admin")throw new DomainError("forbidden","Only project administrators may inspect or retry jobs.");
    return actor;
  };
  app.get<{Params:{projectId:string}}>("/projects/:projectId/operations",async(request)=>{
    await admin(request.headers.authorization,request.params.projectId);
    await opts.db.query("SELECT 1");
    const counts:Record<string,Record<string,number>>={};
    for(const [queue,info] of Object.entries(allowedQueues)){
      const result=await opts.db.query<{status:string;count:string}>(`
        SELECT status,count(*)::text AS count FROM ${info.table}
        WHERE project_id=$1 GROUP BY status`,[request.params.projectId]);
      counts[queue]=Object.fromEntries(result.rows.map(r=>[r.status,Number(r.count)]));
    }
    return {service:"orbit-api",database:"ready",queueCounts:counts};
  });
  app.post<{Params:{projectId:string};Body:{queue:Queue;jobId:string}}>(
    "/projects/:projectId/operations/retry",async(req)=>{
      const actor=await admin(req.headers.authorization,req.params.projectId);
      const {queue,jobId}=req.body??{};
      if(!Object.prototype.hasOwnProperty.call(allowedQueues,queue)||
        typeof jobId!=="string"||!jobId||jobId.length>256)
        throw new DomainError("validation","Invalid retry target.");
      const target=allowedQueues[queue];
      return opts.db.transaction(async tx=>{
        const retried=await tx.query<{id:string}>(`UPDATE ${target.table}
          SET status=$3,attempts=0,next_attempt_at=now(),
            failure_reason=NULL,claimed_at=NULL
          WHERE project_id=$1 AND ${target.idColumn}=$2
            AND status='failed' RETURNING ${target.idColumn} AS id`,
          [req.params.projectId,jobId,queue==="webhook"?"received":"pending"]);
        if(!retried.rows[0])throw new DomainError("not_found","Failed job not found.");
        await tx.query(`INSERT INTO events(
          id,organization_id,project_id,type,occurred_at,correlation_id,
          causation_id,actor_type,actor_id,entity_type,entity_id,payload)
          VALUES($1,$2,$3,'operations.job_retried',now(),$4,$5,
            'human',$6,'Operation',$7,$8::jsonb)`,
          [`event_${randomUUID()}`,actor.organizationId,req.params.projectId,
            `operations:${jobId}`,`queue:${queue}`,actor.principalId,jobId,
            JSON.stringify({queue})]);
        return {retried:true,queue,jobId};
      });
    });
}
