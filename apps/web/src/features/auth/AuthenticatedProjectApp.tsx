import { useMemo, useSyncExternalStore } from "react";
import { App } from "../../App.js";
import { createProjectApi } from "../projects/project-api.js";
import type { SessionStore } from "./session-store.js";

interface AuthenticatedProjectAppProps {
  readonly sessionStore: SessionStore;
  readonly apiBaseUrl: string;
}

/**
 * Mount only after a trusted identity integration supplies a session store.
 * A session change remounts the application and discards project-specific UI state.
 */
export function AuthenticatedProjectApp({
  sessionStore,
  apiBaseUrl,
}: AuthenticatedProjectAppProps) {
  const session = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSession,
    () => null,
  );

  const projectApi = useMemo(
    () =>
      createProjectApi(apiBaseUrl, () =>
        sessionStore.getAuthorizationHeader(),
      ),
    [apiBaseUrl, sessionStore],
  );

  if (!session) {
    return (
      <main>
        <h1>Sign in required</h1>
        <p>Sign in through the configured identity provider to access projects.</p>
      </main>
    );
  }

  return (
    <App
      key={`${session.organizationId}:${session.principalId}`}
      projectApi={projectApi}
    />
  );
}
