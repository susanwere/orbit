import {describe,expect,it} from "vitest";
import {DomainError} from "@orbit/domain";
import {AgentSessionService} from "../src/modules/agents/agent-session-service.js";
const agent={id:"agent",organizationId:"org",status:"approved",version:1,
  capabilities:["read"],approvalRequiredActions:["change-auth"],forbiddenActions:["secrets"],
  allowedRepositories:["org/repo"],allowedPaths:["src/**"],networkPolicy:"none",
  networkAllowlist:[]};
describe("scoped agent session creation",()=>{
  it("creates snapshot, contract, and authorized session in one transaction",async()=>{
    const statements:string[]=[];
    const tx={query:async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("FROM orbit_work_items"))return {rows:[{id:"work"}]};
      if(sql.includes("FROM principals"))return {rows:[{id:"owner"}]};
      if(sql.includes("FROM orbit_agent_definition_versions"))return {rows:[{definition:agent,status:"approved",version:1}]};
      if(sql.includes("INSERT INTO agent_sessions"))return {rows:[{id:"session_3",state:"AUTHORIZED"}]};
      return {rows:[]};
    }};
    const db={transaction:async(fn:(x:typeof tx)=>Promise<unknown>)=>fn(tx)};
    const auth={authorize:async()=>({organizationId:"org",role:"member"})};
    const snapshots={createWithinTransaction:async()=>({id:"snapshot",sourceContextVersionId:"v4"})};
    const svc=new AgentSessionService(db as never,auth as never,snapshots as never,
      (()=>{let i=0;return()=>String(++i)})());
    const result=await svc.create({projectId:"project",requestedBy:"requester",
      humanOwner:"owner",agentDefinitionId:"agent",workItemId:"work",mission:"Implement job pagination"});
    expect(result.executionContractId).toBe("contract_1");
    expect(statements.some(s=>s.includes("INSERT INTO execution_contracts"))).toBe(true);
    expect(statements.some(s=>s.includes("INSERT INTO agent_sessions"))).toBe(true);
  });
  it("denies unapproved agent definitions",async()=>{
    const tx={query:async(sql:string)=>{
      if(sql.includes("FROM orbit_work_items"))return {rows:[{id:"work"}]};
      if(sql.includes("FROM principals"))return {rows:[{id:"owner"}]};
      if(sql.includes("FROM orbit_agent_definition_versions"))
        return {rows:[{definition:{...agent,status:"suspended"},status:"suspended",version:1}]};
      return {rows:[]};
    }};
    const svc=new AgentSessionService({transaction:async(fn:(x:typeof tx)=>Promise<unknown>)=>fn(tx)} as never,
      {authorize:async()=>({organizationId:"org",role:"member"})} as never,
      {createWithinTransaction:async()=>({id:"snapshot"})} as never);
    await expect(svc.create({projectId:"project",requestedBy:"requester",humanOwner:"owner",
      agentDefinitionId:"agent",workItemId:"work",mission:"Build UI"}))
      .rejects.toMatchObject({code:"forbidden"});
  });
});
