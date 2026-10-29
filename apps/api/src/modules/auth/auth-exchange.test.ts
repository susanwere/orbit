import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HmacJwtAuthVerifier } from "./verified-principal.js";
import { OrbitAccessTokenIssuer } from "./orbit-access-token.js";
import { OidcTokenVerifier } from "./oidc-token-verifier.js";
import { buildApp } from "../../app.js";

const signingSecret = "local-test-secret-only-not-for-deployment-123456789";

describe("OIDC identity exchange", () => {
  it("mints an Orbit token only for a verified, linked human identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingKey = publicKey.export({ format: "jwk" });
    const now = 1_800_000_000;
    const jwtHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
    const jwtClaims = Buffer.from(
      JSON.stringify({
        iss: "https://trusted.example",
        aud: "orbit-web",
        sub: "trusted-user",
        iat: now - 10,
        exp: now + 300,
      }),
    ).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${jwtHeader}.${jwtClaims}`),
      privateKey,
    ).toString("base64url");

    const identityToken = `${jwtHeader}.${jwtClaims}.${signature}`;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ keys: [{ ...signingKey, kid: "test-key", alg: "RS256", use: "sig" }] }),
        { status: 200 },
      ),
    );
    const identityVerifier = new OidcTokenVerifier({
      issuer: "https://trusted.example",
      audience: "orbit-web",
      jwksUrl: "https://trusted.example/keys",
      fetchImplementation,
      currentTimeSeconds: () => now,
    });
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ id: "orbit-person", organization_id: "orbit-org" }],
    });
    const application = await buildApp({
      authExchange: {
        database: { query: databaseQuery } as never,
        identityVerifier,
        tokenIssuer: new OrbitAccessTokenIssuer({
          secret: signingSecret,
          issuer: "orbit-issuer",
          audience: "orbit-api",
          currentTimeSeconds: () => now,
        }),
      },
    });

    try {
      const response = await application.inject({
        method: "POST",
        url: "/auth/exchange",
        payload: { idToken: identityToken },
      });
      expect(response.statusCode).toBe(200);
      const session = response.json();
      expect(session.principalId).toBe("orbit-person");
      expect(session.organizationId).toBe("orbit-org");
      expect(databaseQuery).toHaveBeenCalledWith(expect.any(String), [
        "https://trusted.example",
        "trusted-user",
      ]);
      const verifier = new HmacJwtAuthVerifier({
        secret: signingSecret,
        issuer: "orbit-issuer",
        audience: "orbit-api",
        clock: () => now,
      });
      expect(verifier.verify(`Bearer ${session.accessToken}`)).toEqual({
        id: "orbit-person",
        organizationId: "orbit-org",
      });

      const forgedToken = `${identityToken.slice(0, -1)}a`;
      const forgedResponse = await application.inject({
        method: "POST",
        url: "/auth/exchange",
        payload: { idToken: forgedToken },
      });
      expect(forgedResponse.statusCode).toBe(401);
    } finally {
      await application.close();
    }
  });

  it("refuses identities without a linked Orbit principal", async () => {
    const application = await buildApp({
      authExchange: {
        identityVerifier: {
          verify: async () => ({ issuer: "https://trusted.example", subject: "unknown" }),
        },
        database: { query: async () => ({ rows: [] }) } as never,
        tokenIssuer: new OrbitAccessTokenIssuer({
          secret: signingSecret,
          issuer: "orbit-issuer",
          audience: "orbit-api",
        }),
      },
    });
    try {
      const response = await application.inject({
        method: "POST",
        url: "/auth/exchange",
        payload: { idToken: "id-token-placeholder" },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await application.close();
    }
  });
});
