import {describe,expect,it} from "vitest";
import {buildApp} from "../src/app.js";
import {DomainError} from "@orbit/domain";
describe("admin operational controls",()=>{
  const calls:string[]=[];
  const db={
    query:async(sql:string)=>{calls.push(sql);return {rows:[],rowCount:0}},
    transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({
      query:async(sql:string)=>{calls.push(sql);return {rows:[{id:"job"}],rowCount:1}},
    }),
  };
  const auth={verify:(header:string|undefined)=>{
    if(header!=="Bearer valid")throw new DomainError("unauthenticated","Sign in");
    return {id:"admin",organizationId:"org"};
  }};
  const authorization={authorize:async()=>({role:"admin",organizationId:"org",principalId:"admin"})};
  it("rejects anonymous access and returns no sensitive job payload",async()=>{
    const app=await buildApp({operations:{db,auth,authorization} as never});
    expect((await app.inject({method:"GET",url:"/projects/p/operations"})).statusCode).toBe(401);
    const res=await app.inject({method:"GET",url:"/projects/p/operations",headers:{authorization:"Bearer valid"}});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({database:"ready",queueCounts:{webhook:{},analysis:{},effects:{}}});
    await app.close();
  });
  it("rejects invalid queue names and audits allowed retries",async()=>{
    const app=await buildApp({operations:{db,auth,authorization} as never});
    const url="/projects/p/operations/retry";
    const headers={authorization:"Bearer valid"};
    expect((await app.inject({method:"POST",url,headers,payload:{queue:"secret",jobId:"1"}})).statusCode).toBe(400);
    const response=await app.inject({method:"POST",url,headers,payload:{queue:"effects",jobId:"evt1"}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({retried:true,queue:"effects"});
    expect(calls.some(q=>q.includes("operations.job_retried"))).toBe(true);
    await app.close();
  });
});
