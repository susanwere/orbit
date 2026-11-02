import type { AuthenticatedSession } from "./session-store.js";

interface AuthExchangeResponse {
  readonly accessToken: string;
  readonly principalId: string;
  readonly organizationId: string;
  readonly expiresAt: number;
}

/** Exchange a provider-signed ID token for a short-lived Orbit API session. */
export async function exchangeIdentityToken(
  apiBaseUrl: string,
  providerIdToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<AuthenticatedSession> {
  const response = await withSessionLock(() =>
    fetchImplementation(new URL("/auth/exchange", apiBaseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: providerIdToken }),
    }),
  );

  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "This Google account has not been granted access to Orbit."
        : "Unable to verify your Google sign-in. Please try again.",
    );
  }

  return parseSession(await response.json());
}

function parseSession(payload: unknown): AuthenticatedSession {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("accessToken" in payload) ||
    typeof payload.accessToken !== "string" ||
    !("principalId" in payload) ||
    typeof payload.principalId !== "string" ||
    !("organizationId" in payload) ||
    typeof payload.organizationId !== "string" ||
    !("expiresAt" in payload) ||
    typeof payload.expiresAt !== "number" ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt * 1000 <= Date.now()
  ) {
    throw new Error("Orbit returned an invalid authentication response.");
  }

  const authenticatedResponse = payload as AuthExchangeResponse;
  return {
    accessToken: authenticatedResponse.accessToken,
    principalId: authenticatedResponse.principalId,
    organizationId: authenticatedResponse.organizationId,
    expiresAt: authenticatedResponse.expiresAt * 1000,
  };
}

let pendingRefresh: Promise<AuthenticatedSession | null> | undefined;
export function refreshSession(apiBaseUrl: string): Promise<AuthenticatedSession | null> {
  pendingRefresh ??= withSessionLock(() => requestRefresh(apiBaseUrl)).finally(() => {
    pendingRefresh = undefined;
  });
  return pendingRefresh;
}
async function requestRefresh(apiBaseUrl: string): Promise<AuthenticatedSession | null> {
  const response = await fetch(new URL("/auth/refresh", apiBaseUrl), {
    method: "POST",
    credentials: "include",
    headers: { "X-Orbit-Session": "1" },
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Unable to restore your session. Please retry.");
  return parseSession(await response.json());
}

export async function logoutSession(apiBaseUrl: string): Promise<void> {
  await pendingRefresh?.catch(() => undefined);
  const response = await withSessionLock(() =>
    fetch(new URL("/auth/logout", apiBaseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "X-Orbit-Session": "1" },
    }),
  );
  if (!response.ok) throw new Error("Sign-out could not finish. Please retry.");
}

/** Serialize cookie rotation across tabs when Web Locks are available. */
async function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("orbit-auth-session", operation);
  }
  return operation();
}

/** Password credentials are sent only over the authenticated origin, never persisted in the browser. */
export async function exchangeEmailPassword(
  apiBaseUrl: string,
  mode: "signup" | "login",
  email: string,
  password: string,
): Promise<AuthenticatedSession> {
  const response = await withSessionLock(() =>
    fetch(new URL(`/auth/email/${mode}`, apiBaseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Orbit-Session": "1" },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "Could not authenticate. Check your details and try again.";
    throw new Error(message);
  }
  return parseSession(await response.json());
}
