import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { TrustedIdentity } from "./oidc-token-verifier.js";
import { OrbitAccessTokenIssuer } from "./orbit-access-token.js";

interface LinkedPrincipalRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
}

export interface AuthExchangeOptions {
  readonly database: SqlDatabase;
  readonly identityVerifier: { verify(idToken: string): Promise<TrustedIdentity> };
  readonly tokenIssuer: OrbitAccessTokenIssuer;
}

export async function registerAuthExchangeRoutes(
  application: FastifyInstance,
  options: AuthExchangeOptions,
): Promise<void> {
  application.post<{ Body: { idToken?: unknown } }>("/auth/exchange", async (request) => {
    const idToken = request.body?.idToken;
    if (typeof idToken !== "string" || idToken.length > 8192 || !idToken) {
      throw new DomainError("unauthenticated", "Valid identity provider authentication required.");
    }

    const trustedIdentity = await options.identityVerifier.verify(idToken);
    const linkedPrincipalResult = await options.database.query<LinkedPrincipalRow>(
      `SELECT principal.id, principal.organization_id
       FROM principal_oidc_identities identity_link
       JOIN principals principal ON principal.id = identity_link.principal_id
       WHERE identity_link.issuer = $1 AND identity_link.subject = $2
         AND principal.type = 'human' AND principal.role IN ('admin', 'member', 'viewer')`,
      [trustedIdentity.issuer, trustedIdentity.subject],
    );
    const linkedPrincipal = linkedPrincipalResult.rows[0];
    if (!linkedPrincipal) {
      throw new DomainError("forbidden", "This identity has not been granted Orbit access.");
    }

    const issuedToken = options.tokenIssuer.issue({
      id: linkedPrincipal.id,
      organizationId: linkedPrincipal.organization_id,
    });
    return {
      ...issuedToken,
      principalId: linkedPrincipal.id,
      organizationId: linkedPrincipal.organization_id,
    };
  });
}
