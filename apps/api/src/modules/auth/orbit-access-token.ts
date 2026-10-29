import { createHmac } from "node:crypto";
import type { VerifiedPrincipal } from "./verified-principal.js";

export interface AccessTokenIssuerConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly lifetimeSeconds?: number;
  readonly currentTimeSeconds?: () => number;
}

export class OrbitAccessTokenIssuer {
  constructor(private readonly config: AccessTokenIssuerConfig) {
    if (config.secret.length < 32 || !config.issuer || !config.audience) {
      throw new Error("Orbit signing requires a strong secret, issuer, and audience.");
    }
  }

  issue(principal: VerifiedPrincipal): { accessToken: string; expiresAt: number } {
    const issuedAt = this.config.currentTimeSeconds?.() ?? Math.floor(Date.now() / 1000);
    const lifetimeSeconds = Math.min(Math.max(this.config.lifetimeSeconds ?? 900, 1), 3600);
    const expiresAt = issuedAt + lifetimeSeconds;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.config.issuer,
        aud: this.config.audience,
        sub: principal.id,
        organizationId: principal.organizationId,
        iat: issuedAt,
        exp: expiresAt,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.config.secret)
      .update(`${header}.${payload}`)
      .digest("base64url");

    return { accessToken: `${header}.${payload}.${signature}`, expiresAt };
  }
}
