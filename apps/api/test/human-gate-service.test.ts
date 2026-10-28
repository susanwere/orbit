import {describe,expect,it} from "vitest";
import {HumanGateService} from "../src/modules/execution/human-gate-service.js";
describe("Human Gate",()=>{
  it("records an authorized human resolution with immutable snapshot",async()=>{
    const sql:string[]=[];
    const db={transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({
      query:async(q:string)=>{
        sql.push(q);
        if(q.includes("SELECT * FROM human_gates"))return {rows:[{
          id:"gate",organization_id:"org",project_id:"project",
          agent_session_id:"session",assigned_human_principal_id:"owner",
          status:"OPEN",trigger_context_version_id:"v4"}]};
        if(q.includes("UPDATE agent_sessions"))return {rows:[{id:"session"}]};
        return {rows:[]};
      },
    })};
    const auth={authorize:async()=>({organizationId:"org",role:"member"})};
    const result=await new HumanGateService(db as never,auth as never).resolve({
      projectId:"project",gateId:"gate",principalId:"owner",action:"approve",
    });
    expect(result).toMatchObject({status:"APPROVED",sessionState:"RUNNING"});
    expect(sql.some(s=>s.includes("human_gate.resolved"))).toBe(true);
    expect(sql.some(s=>s.includes("context_snapshots"))).toBe(false);
  });
  it("rejects agent impersonation of owner",async()=>{
    const db={transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({
      query:async(q:string)=>q.includes("SELECT * FROM human_gates")
        ?{rows:[{id:"gate",organization_id:"org",project_id:"p",
          agent_session_id:"s",assigned_human_principal_id:"owner",
          status:"OPEN",trigger_context_version_id:"v4"}]}:{rows:[]},
    })};
    const auth={authorize:async()=>({organizationId:"org",role:"member"})};
    await expect(new HumanGateService(db as never,auth as never).resolve({
      projectId:"p",gateId:"gate",principalId:"impostor",action:"approve",
    })).rejects.toMatchObject({code:"forbidden"});
  });
});
