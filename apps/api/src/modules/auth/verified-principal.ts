import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@orbit/domain";

export interface VerifiedPrincipal { readonly id: string; readonly organizationId: string }
export interface AuthVerifier {
  verify(authorization: string | undefined): VerifiedPrincipal;
}
export interface JwtAuthConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly clock?: () => number;
}
const deny = (): never => { throw new DomainError("unauthenticated", "Valid authentication required."); };
const decode = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return deny();
    return parsed as Record<string, unknown>;
  } catch { return deny(); }
};

/** Verifies standard HS256 JWTs minted by an explicitly trusted Orbit issuer. */
export class HmacJwtAuthVerifier implements AuthVerifier {
  constructor(private readonly config: JwtAuthConfig) {
    if (config.secret.length < 32 || !config.issuer || !config.audience) {
      throw new Error("Verified authentication requires a strong secret, issuer and audience.");
    }
  }

  verify(authorization: string | undefined): VerifiedPrincipal {
    if (!authorization?.startsWith("Bearer ")) return deny();
    const token = authorization.slice(7);
    if (token.length > 8192) return deny();
    const parts = token.split(".");
    if (parts.length !== 3) return deny();
    const [header, payload, signature] = parts as [string, string, string];
    const meta = decode(header);
    if (meta.alg !== "HS256" || meta.typ !== "JWT" || meta.kid !== undefined) return deny();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", this.config.secret)
      .update(`${header}.${payload}`).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return deny();

    const claims = decode(payload);
    const now = this.config.clock?.() ?? Math.floor(Date.now() / 1000);
    if (
      claims.iss !== this.config.issuer || claims.aud !== this.config.audience ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 256 ||
      typeof claims.organizationId !== "string" || !claims.organizationId.trim() ||
      typeof claims.exp !== "number" || !Number.isInteger(claims.exp) ||
      claims.exp <= now || claims.exp > now + 3600 ||
      typeof claims.iat !== "number" || !Number.isInteger(claims.iat) ||
      claims.iat > now + 30 || claims.iat > claims.exp ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now))
    ) return deny();

    return { id: claims.sub, organizationId: claims.organizationId };
  }
}
