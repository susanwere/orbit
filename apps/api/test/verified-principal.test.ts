import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HmacJwtAuthVerifier } from "../src/modules/auth/verified-principal.js";
import { buildApp } from "../src/app.js";
const secret = "test-authentication-secret-longer-than-32-bytes";
const config = { secret, issuer: "orbit-test-issuer", audience: "orbit-api", clock: () => 1000 };
const auth = new HmacJwtAuthVerifier(config);
const sign = (claims: Record<string, unknown>, key = secret) => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
};
const valid = { iss: config.issuer, aud: config.audience, sub: "user_1",
  organizationId: "org_1", exp: 1100, iat: 900 };
describe("verified Orbit principal", () => {
  it("validates a signed subject and organization", () => {
    expect(auth.verify(sign(valid))).toEqual({ id: "user_1", organizationId: "org_1" });
  });
  it("fails closed on forged, expired, missing and invalid issuer/audience tokens", () => {
    for (const token of [
      undefined, "Bearer malformed", sign(valid, "a-different-signing-secret-12345678"),
      sign({ ...valid, exp: 1000 }), sign({ ...valid, aud: "orbit-events" }),
      sign({ ...valid, iss: "untrusted" }), sign({ ...valid, organizationId: "" }),
      sign({ ...valid, nbf: 1100 }), sign({ ...valid, iat: 1200 }),
    ]) expect(() => auth.verify(token)).toThrowError(
      expect.objectContaining({ code: "unauthenticated" }),
    );
  });
  it("rejects creation of unconfigured verification", () => {
    expect(() => new HmacJwtAuthVerifier({ ...config, secret: "short" })).toThrow();
  });
  it("never registers review endpoints without auth middleware", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/projects/p/decision-proposals/x/approve" })).statusCode).toBe(404);
    await app.close();
  });
});
