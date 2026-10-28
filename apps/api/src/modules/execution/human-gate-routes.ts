import type {FastifyInstance} from "fastify";
import type {AuthVerifier} from "../auth/verified-principal.js";
import type {GateAction,HumanGateService} from "./human-gate-service.js";
export async function registerHumanGateRoutes(app:FastifyInstance,opts:{
  auth:AuthVerifier;service:HumanGateService;
}){
  app.get<{Params:{projectId:string}}>("/projects/:projectId/human-gates",async(req)=>{
    const principal=opts.auth.verify(req.headers.authorization);
    return {gates:await opts.service.list(req.params.projectId,principal.id)};
  });
  app.post<{Params:{projectId:string;gateId:string};Body:{action:GateAction;note?:string}}>(
    "/projects/:projectId/human-gates/:gateId/resolve",async(req)=>{
      const principal=opts.auth.verify(req.headers.authorization);
      return opts.service.resolve({projectId:req.params.projectId,
        gateId:req.params.gateId,principalId:principal.id,
        action:req.body?.action,note:req.body?.note});
    });
}
