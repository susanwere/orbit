import { describe, expect, it, vi } from "vitest";
import { exchangeIdentityToken } from "./auth-api.js";

describe("trusted identity exchange client", () => {
  it("converts the verified Orbit token expiry into milliseconds", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 900;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "orbit-token",
          principalId: "principal-1",
          organizationId: "organization-1",
          expiresAt: expiresAtSeconds,
        }),
        { status: 200 },
      ),
    );

    const session = await exchangeIdentityToken(
      "http://localhost:4000",
      "provider-credential",
      fetchImplementation,
    );

    expect(session.expiresAt).toBe(expiresAtSeconds * 1000);
    expect(session.principalId).toBe("principal-1");
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("http://localhost:4000/auth/exchange"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "provider-credential" }),
      }),
    );
  });

  it("refuses an unlinked account without storing a token", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      exchangeIdentityToken("http://localhost:4000", "id-token", fetchImplementation),
    ).rejects.toThrow("not been granted access");
  });

  it("rejects malformed or expired session responses", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "token",
          principalId: "person",
          organizationId: "organization",
          expiresAt: 1,
        }),
        { status: 200 },
      ),
    );
    await expect(
      exchangeIdentityToken("http://localhost:4000", "id-token", fetchImplementation),
    ).rejects.toThrow("invalid authentication response");
  });
});
