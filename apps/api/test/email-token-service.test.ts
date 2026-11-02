import { describe, expect, it } from "vitest";
import {
  hashEmailToken,
  newEmailToken,
  validEmailToken,
  hashNewPassword,
} from "../src/modules/auth/email-token-service.js";

describe("email verification and password recovery primitives", () => {
  it("creates unpredictable opaque tokens and stores only hashes", () => {
    const token = newEmailToken();
    expect(validEmailToken(token)).toBe(true);
    expect(hashEmailToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmailToken(token)).not.toContain(token);
    expect(newEmailToken()).not.toBe(token);
  });

  it("rejects malformed tokens", () => {
    expect(validEmailToken("")).toBe(false);
    expect(validEmailToken("x".repeat(100))).toBe(false);
  });

  it("requires strong reset passwords and hashes the replacement", async () => {
    await expect(hashNewPassword("short")).rejects.toThrow();
    const hash = await hashNewPassword("strong-password-value-123");
    expect(hash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(hash).not.toContain("strong-password-value-123");
  });
});
