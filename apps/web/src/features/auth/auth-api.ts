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
  const response = await fetchImplementation(new URL("/auth/exchange", apiBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: providerIdToken }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "This Google account has not been granted access to Orbit."
        : "Unable to verify your Google sign-in. Please try again.",
    );
  }

  const payload: unknown = await response.json();
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
