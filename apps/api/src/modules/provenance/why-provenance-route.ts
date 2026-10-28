import type { FastifyInstance } from "fastify";
import { verifyEventToken } from "../events/verify-event-token.js";
import type { WhyProvenanceQuery } from "./why-provenance-query.js";

export interface WhyProvenanceRouteOptions {
  query: WhyProvenanceQuery;
  tokenSecret: string;
}
export async function registerWhyProvenanceRoutes(
  app: FastifyInstance,
  options: WhyProvenanceRouteOptions,
): Promise<void> {
  app.get<{ Params: { projectId: string; decisionId: string } }>(
    "/projects/:projectId/decisions/:decisionId/why",
    async (request) => {
      const principalId = verifyEventToken(
        request.headers.authorization,
        options.tokenSecret,
        Math.floor(Date.now() / 1000),
        "orbit-provenance",
      );
      return options.query.get(principalId, request.params.projectId, request.params.decisionId);
    },
  );
}
