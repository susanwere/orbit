import { useMemo, useSyncExternalStore } from "react";
import { App } from "../../App.js";
import { AuthenticatedProjectApp } from "./AuthenticatedProjectApp.js";
import { disableGoogleAutomaticSignIn, GoogleSignIn } from "./google-sign-in.js";
import { createSessionStore } from "./session-store.js";

export interface AuthGatewayProps {
  readonly googleClientId?: string;
  readonly apiBaseUrl: string;
}

/** A missing provider configuration must never expose authenticated project APIs. */
export function AuthGateway({ googleClientId, apiBaseUrl }: AuthGatewayProps) {
  const sessionStore = useMemo(() => createSessionStore(), []);
  const authenticatedSession = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSession,
    () => null,
  );

  if (!googleClientId) {
    return <App />;
  }

  if (!authenticatedSession) {
    return (
      <GoogleSignIn
        clientId={googleClientId}
        apiBaseUrl={apiBaseUrl}
        sessionStore={sessionStore}
      />
    );
  }

  return (
    <AuthenticatedProjectApp
      sessionStore={sessionStore}
      apiBaseUrl={apiBaseUrl}
      onSignOut={disableGoogleAutomaticSignIn}
    />
  );
}
