import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@orbit/domain";

/**
 * Verifies short-lived tokens issued by a trusted identity service.
 * Token format is base64url(JSON claims).base64url(HMAC-SHA256).
 * No token creation or anonymous fallback is exposed by this API.
 */
export function verifyEventToken(
  authorization: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience = "orbit-events",
): string {
  if (!authorization?.startsWith("Bearer ") || secret.length < 32) {
    throw new DomainError("unauthenticated", "A valid bearer token is required.");
  }
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0]!.length > 4096 || parts[1]!.length > 128) {
    throw new DomainError("unauthenticated", "Invalid bearer token.");
  }
  const [payload, signature] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new DomainError("unauthenticated", "Invalid bearer token.");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new DomainError("unauthenticated", "Invalid bearer token.");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw new DomainError("unauthenticated", "Invalid bearer token claims.");
  }
  const { sub, exp, aud } = claims as Record<string, unknown>;
  if (
    typeof sub !== "string" ||
    !sub.trim() ||
    sub.length > 256 ||
    typeof exp !== "number" ||
    !Number.isInteger(exp) ||
    exp <= nowSeconds ||
    exp > nowSeconds + 3600 ||
    aud !== audience
  ) {
    throw new DomainError("unauthenticated", "Expired or invalid bearer token claims.");
  }
  return sub;
}
