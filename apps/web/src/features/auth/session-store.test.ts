import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./session-store.js";

describe("session store", () => {
  const verifiedSession = {
    accessToken: "test-token",
    principalId: "principal-1",
    organizationId: "organization-1",
    expiresAt: 60_000,
  };

  it("returns no authorization for unsigned-in users", () => {
    const sessionStore = createSessionStore(() => 0);
    expect(sessionStore.getAuthorizationHeader()).toBeUndefined();
  });

  it("clears credentials and notifies subscribers on signout", () => {
    const sessionStore = createSessionStore(() => 0);
    const subscriber = vi.fn();
    sessionStore.subscribe(subscriber);
    sessionStore.setSession(verifiedSession);
    sessionStore.setSession(null);

    expect(sessionStore.getAuthorizationHeader()).toBeUndefined();
    expect(subscriber).toHaveBeenLastCalledWith(null);
  });

  it("invalidates an expired session before returning credentials", () => {
    let currentTime = 0;
    const sessionStore = createSessionStore(() => currentTime);
    sessionStore.setSession(verifiedSession);
    expect(sessionStore.getAuthorizationHeader()).toBe("Bearer test-token");

    currentTime = 60_000;
    expect(sessionStore.getSession()).toBeNull();
    expect(sessionStore.getAuthorizationHeader()).toBeUndefined();
  });

  it("removes subscriptions without receiving future session updates", () => {
    const sessionStore = createSessionStore(() => 0);
    const subscriber = vi.fn();
    const unsubscribe = sessionStore.subscribe(subscriber);
    unsubscribe();

    sessionStore.setSession(verifiedSession);
    expect(subscriber).not.toHaveBeenCalled();
  });
});
