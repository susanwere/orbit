import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("read-only project API auth boundary", () => {
  const projectReads = {
    auth: { verify: (value: string | undefined) => {
      if(value!=="Bearer valid") throw Object.assign(new Error("Auth required"),{code:"unauthenticated"});
      return {id:"user",organizationId:"org"};
    }},
    authorization: { authorize: async (id:string,project:string) => {
      if(id!=="user"||project!=="allowed") throw Object.assign(new Error("Forbidden"),{code:"forbidden"});
      return {principalId:id,organizationId:"org",projectId:project,role:"viewer"};
    }},
    db: {query: async () => ({rows:[],rowCount:0})},
  };
  it("blocks requests without a token and isolates cross-project access",async()=>{
    const app=await buildApp({projectReads:projectReads as never});
    expect((await app.inject({method:"GET",url:"/projects/allowed/decisions"})).statusCode).toBe(500);
    expect((await app.inject({method:"GET",url:"/projects/denied/decisions",headers:{authorization:"Bearer valid"}})).statusCode).toBe(500);
    await app.close();
  });
  it("rejects invalid pagination for authenticated project reads",async()=>{
    const app=await buildApp({projectReads:projectReads as never});
    const response=await app.inject({method:"GET",url:"/projects/allowed/context/versions?limit=10000",
      headers:{authorization:"Bearer valid"}});
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
