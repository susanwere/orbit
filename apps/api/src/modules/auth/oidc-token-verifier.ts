import { createPublicKey, verify as verifySignature } from "node:crypto";
import { DomainError } from "@orbit/domain";

export interface TrustedIdentity {
  readonly issuer: string;
  readonly subject: string;
}

interface JsonWebKeySet {
  readonly keys?: JsonWebKey[];
}

export interface OidcTokenVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly fetchImplementation?: typeof fetch;
  readonly currentTimeSeconds?: () => number;
}

/** Validate a trusted RS256 OIDC ID token, never claims supplied separately by the client. */
export class OidcTokenVerifier {
  constructor(private readonly config: OidcTokenVerifierConfig) {
    if (!config.issuer.startsWith("https://") || !config.jwksUrl.startsWith("https://")) {
      throw new Error("OIDC issuer and JWKS endpoint must use HTTPS.");
    }
  }

  async verify(idToken: string): Promise<TrustedIdentity> {
    const unauthenticated = () => {
      throw new DomainError("unauthenticated", "Valid identity provider authentication required.");
    };

    if (!idToken || idToken.length > 8192) return unauthenticated();
    const tokenParts = idToken.split(".");
    if (tokenParts.length !== 3) return unauthenticated();

    try {
      const [encodedHeader, encodedClaims, encodedSignature] = tokenParts as [
        string,
        string,
        string,
      ];
      const header: unknown = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      const claims: unknown = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
      if (!header || typeof header !== "object" || Array.isArray(header)) return unauthenticated();
      if (!claims || typeof claims !== "object" || Array.isArray(claims)) return unauthenticated();

      const jwtHeader = header as Record<string, unknown>;
      const jwtClaims = claims as Record<string, unknown>;
      const now = this.config.currentTimeSeconds?.() ?? Math.floor(Date.now() / 1000);
      if (
        jwtHeader.alg !== "RS256" ||
        typeof jwtHeader.kid !== "string" ||
        !jwtHeader.kid ||
        jwtClaims.iss !== this.config.issuer ||
        jwtClaims.aud !== this.config.audience ||
        typeof jwtClaims.sub !== "string" ||
        !jwtClaims.sub ||
        jwtClaims.sub.length > 256 ||
        typeof jwtClaims.exp !== "number" ||
        !Number.isInteger(jwtClaims.exp) ||
        jwtClaims.exp <= now ||
        typeof jwtClaims.iat !== "number" ||
        !Number.isInteger(jwtClaims.iat) ||
        jwtClaims.iat > now + 30 ||
        (jwtClaims.nbf !== undefined && (typeof jwtClaims.nbf !== "number" || jwtClaims.nbf > now))
      ) {
        return unauthenticated();
      }

      const fetchImplementation = this.config.fetchImplementation ?? fetch;
      const keyResponse = await fetchImplementation(this.config.jwksUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (!keyResponse.ok) return unauthenticated();
      const keySet = (await keyResponse.json()) as JsonWebKeySet;
      if (!Array.isArray(keySet.keys)) return unauthenticated();
      const signingKey = keySet.keys.find(
        (candidate) =>
          candidate.kid === jwtHeader.kid &&
          candidate.kty === "RSA" &&
          candidate.alg === "RS256" &&
          candidate.use === "sig",
      );
      if (!signingKey) return unauthenticated();

      const publicKey = createPublicKey({ key: signingKey, format: "jwk" });
      const isValidSignature = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
      );
      if (!isValidSignature) return unauthenticated();

      return { issuer: this.config.issuer, subject: jwtClaims.sub as string };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return unauthenticated();
    }
  }
}
