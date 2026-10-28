import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { AgentSessionService } from "./agent-session-service.js";
export async function registerAgentSessionRoutes(app:FastifyInstance,opts:{
  auth:AuthVerifier;service:AgentSessionService;
}){
  app.post<{Params:{projectId:string};Body:{
    agentDefinitionId:string;workItemId:string;mission:string;humanOwnerPrincipalId:string;
  }}>("/projects/:projectId/agent-sessions",async(req,reply)=>{
    const principal=opts.auth.verify(req.headers.authorization);
    const body=req.body;
    const result=await opts.service.create({
      projectId:req.params.projectId,requestedBy:principal.id,
      humanOwner:body?.humanOwnerPrincipalId,
      agentDefinitionId:body?.agentDefinitionId,workItemId:body?.workItemId,
      mission:body?.mission??"",
    });
    return reply.status(201).send(result);
  });
  app.get<{Params:{projectId:string;sessionId:string}}>(
    "/projects/:projectId/agent-sessions/:sessionId",async(req)=>{
      const principal=opts.auth.verify(req.headers.authorization);
      return opts.service.get(req.params.projectId,principal.id,req.params.sessionId);
    });
  app.post<{Params:{projectId:string;sessionId:string}}>(
    "/projects/:projectId/agent-sessions/:sessionId/start",async(req)=>{
      const principal=opts.auth.verify(req.headers.authorization);
      return opts.service.start(req.params.projectId,principal.id,req.params.sessionId);
    });
}
