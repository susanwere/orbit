import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { WhyProvenanceQuery } from "./why-provenance-query.js";

export interface WhyProvenanceRouteOptions {
  query: WhyProvenanceQuery;
  auth: AuthVerifier;
}
export async function registerWhyProvenanceRoutes(
  app: FastifyInstance,
  options: WhyProvenanceRouteOptions,
): Promise<void> {
  app.get<{ Params: { projectId: string; decisionId: string } }>(
    "/projects/:projectId/decisions/:decisionId/why",
    async (request) => {
      const principalId = options.auth.verify(request.headers.authorization).id;
      return options.query.get(principalId, request.params.projectId, request.params.decisionId);
    },
  );
}
