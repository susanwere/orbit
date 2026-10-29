import { useEffect, useMemo, useSyncExternalStore } from "react";
import { App } from "../../App.js";
import { createProjectApi } from "../projects/project-api.js";
import type { SessionStore } from "./session-store.js";

interface AuthenticatedProjectAppProps {
  readonly sessionStore: SessionStore;
  readonly apiBaseUrl: string;
  readonly onSignOut?: () => void;
}

/**
 * Project state exists only while a session is valid. Remounting the app on
 * identity changes discards project-specific UI state before another user enters.
 */
export function AuthenticatedProjectApp({
  sessionStore,
  apiBaseUrl,
  onSignOut,
}: AuthenticatedProjectAppProps) {
  const authenticatedSession = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSession,
    () => null,
  );

  useEffect(() => {
    if (!authenticatedSession) {
      return;
    }

    const remainingSessionMilliseconds = authenticatedSession.expiresAt - Date.now();
    if (remainingSessionMilliseconds <= 0) {
      sessionStore.getSession();
      return;
    }

    const expirationTimer = window.setTimeout(
      () => {
        sessionStore.getSession();
      },
      Math.min(remainingSessionMilliseconds, 2_147_483_647),
    );

    return () => window.clearTimeout(expirationTimer);
  }, [authenticatedSession, sessionStore]);

  const projectApi = useMemo(
    () =>
      createProjectApi(apiBaseUrl, () => sessionStore.getAuthorizationHeader(), fetch, {
        onUnauthorized: (failedAuthorizationHeader) => {
          // Do not sign out a replacement account after a stale request fails.
          if (sessionStore.getAuthorizationHeader() === failedAuthorizationHeader) {
            sessionStore.setSession(null);
          }
        },
      }),
    [apiBaseUrl, sessionStore],
  );

  if (!authenticatedSession) {
    return (
      <main>
        <h1>Sign in required</h1>
        <p>Sign in through the configured identity provider to access projects.</p>
      </main>
    );
  }

  return (
    <>
      <nav aria-label="Account">
        <button
          type="button"
          onClick={() => {
            onSignOut?.();
            sessionStore.setSession(null);
          }}
        >
          Sign out
        </button>
      </nav>
      <App
        key={`${authenticatedSession.organizationId}:${authenticatedSession.principalId}`}
        projectApi={projectApi}
      />
    </>
  );
}
