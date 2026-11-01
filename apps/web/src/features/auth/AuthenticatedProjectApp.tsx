import { useMemo, useState, useSyncExternalStore } from "react";
import { App } from "../../App.js";
import { createProjectApi } from "../projects/project-api.js";
import { createIntentApi } from "../intent/intent-api.js";
import type { SessionStore } from "./session-store.js";

interface AuthenticatedProjectAppProps {
  readonly sessionStore: SessionStore;
  readonly apiBaseUrl: string;
  readonly onSignOut?: () => void | Promise<void>;
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
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const authenticatedSession = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSession,
    () => null,
  );

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

  const intentApi = useMemo(
    () =>
      createIntentApi(apiBaseUrl, () => sessionStore.getAuthorizationHeader(), fetch, {
        onUnauthorized: (failedAuthorizationHeader) => {
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
      <nav aria-label="Account" className="orbit-account-nav"><details className="orbit-account-menu"><summary>Account ▾</summary>
        <button
          type="button"
          disabled={isSigningOut}
          onClick={() => {
            setIsSigningOut(true);
            setSignOutError(null);
            void Promise.resolve()
              .then(() => onSignOut?.())
              .then(() => sessionStore.setSession(null))
              .catch(() => setSignOutError("Sign-out could not finish. Please retry."))
              .finally(() => setIsSigningOut(false));
          }}
        >
          Sign out
        </button></details>
      </nav>
      {signOutError && <p role="alert">{signOutError}</p>}
      <App
        key={`${authenticatedSession.organizationId}:${authenticatedSession.principalId}`}
        projectApi={projectApi}
        intentApi={intentApi}
      />
    </>
  );
}
