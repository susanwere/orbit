import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyEventToken } from "../src/modules/events/verify-event-token.js";

const secret = "this-is-a-development-only-test-secret-12345";
function sign(claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `Bearer ${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
describe("event stream token verification", () => {
  it("accepts signed, scoped, unexpired identity", () => {
    expect(verifyEventToken(sign({ sub: "user1", aud: "orbit-events", exp: 1100 }), secret, 1000)).toBe("user1");
  });
  it("rejects forged identities", () => {
    const token = sign({ sub: "user1", aud: "orbit-events", exp: 1100 });
    expect(() => verifyEventToken(token.replace("Bearer ", "Bearer hacked"), secret, 1000))
      .toThrowError(expect.objectContaining({ code: "unauthenticated" }));
  });
  it("rejects expired and wrong-audience credentials", () => {
    for (const claims of [
      { sub: "user1", aud: "orbit-events", exp: 1000 },
      { sub: "user1", aud: "other", exp: 1100 },
      { sub: "user1", aud: "orbit-events", exp: 99999 },
    ]) {
      expect(() => verifyEventToken(sign(claims), secret, 1000)).toThrowError(
        expect.objectContaining({ code: "unauthenticated" }),
      );
    }
  });
});
