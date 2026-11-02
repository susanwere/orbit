import { RefreshSessionService, refreshLifetimeSeconds } from "./refresh-session-service.js";
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
  readonly allowedOrigins?: readonly string[];
  readonly secureCookies?: boolean;
  readonly database: SqlDatabase;
  readonly identityVerifier?: { verify(idToken: string): Promise<TrustedIdentity> };
  readonly tokenIssuer: OrbitAccessTokenIssuer;
}

export async function registerAuthExchangeRoutes(
  application: FastifyInstance,
  options: AuthExchangeOptions,
): Promise<void> {
  const refreshSessions = new RefreshSessionService(options.database);
  const cookieName = options.secureCookies === false ? "orbit_refresh" : "__Secure-orbit_refresh";
  const cookie = (token: string, maxAge = refreshLifetimeSeconds) =>
    `${cookieName}=${token}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.secureCookies === false ? "" : "; Secure"}`;
  const readCookie = (header?: string) =>
    header
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  application.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins?.includes(origin)) {
      throw new DomainError("forbidden", "Untrusted authentication origin.");
    }
    if (request.url !== "/auth/exchange" && request.headers["x-orbit-session"] !== "1") {
      throw new DomainError("forbidden", "Session request header required.");
    }
  });
  application.post("/auth/refresh", async (request, reply) => {
    const refreshToken = readCookie(request.headers.cookie);
    if (!refreshToken || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) {
      throw new DomainError("unauthenticated", "Session required.");
    }
    const refreshed = await refreshSessions.rotate(refreshToken);
    reply.header("Set-Cookie", cookie(refreshed.token));
    return {
      ...options.tokenIssuer.issue({
        id: refreshed.principal.id,
        organizationId: refreshed.principal.organization_id,
      }),
      principalId: refreshed.principal.id,
      organizationId: refreshed.principal.organization_id,
    };
  });
  application.post("/auth/logout", async (request, reply) => {
    const refreshToken = readCookie(request.headers.cookie);
    if (refreshToken) await refreshSessions.revoke(refreshToken);
    reply.header("Set-Cookie", cookie("", 0));
    return reply.code(204).send();
  });
  application.post<{ Body: { idToken?: unknown } }>("/auth/exchange", async (request, reply) => {
    const idToken = request.body?.idToken;
    if (typeof idToken !== "string" || idToken.length > 8192 || !idToken) {
      throw new DomainError("unauthenticated", "Valid identity provider authentication required.");
    }

    if (!options.identityVerifier)
      throw new DomainError("promotion_unavailable", "Google sign-in is not configured.");
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

    const previousToken = readCookie(request.headers.cookie);
    if (previousToken) await refreshSessions.revoke(previousToken);
    const refreshToken = await refreshSessions.create(linkedPrincipal.id);
    reply.header("Set-Cookie", cookie(refreshToken));
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
