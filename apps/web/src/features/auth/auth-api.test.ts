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

describe("refresh and logout transport", () => {
  it("shares simultaneous refreshes and restores only backend-issued credentials", async () => {
    const { refreshSession, logoutSession } = await import("./auth-api.js");
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "renewed",
          principalId: "person",
          organizationId: "organization",
          expiresAt,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const firstRefresh = refreshSession("http://localhost:4000");
      const duplicateRefresh = refreshSession("http://localhost:4000");
      expect(firstRefresh).toBe(duplicateRefresh);
      expect(await firstRefresh).toMatchObject({
        accessToken: "renewed",
        expiresAt: expiresAt * 1000,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("http://localhost:4000/auth/refresh"),
        expect.objectContaining({ credentials: "include", headers: { "X-Orbit-Session": "1" } }),
      );
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await logoutSession("http://localhost:4000");
      expect(fetchMock).toHaveBeenLastCalledWith(
        new URL("http://localhost:4000/auth/logout"),
        expect.objectContaining({ method: "POST", credentials: "include" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("treats revoked sessions as signed out and surfaces transient failures for retry", async () => {
    const { refreshSession, logoutSession } = await import("./auth-api.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await refreshSession("http://localhost:4000")).toBeNull();
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(refreshSession("http://localhost:4000")).rejects.toThrow("retry");
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(logoutSession("http://localhost:4000")).rejects.toThrow("retry");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
