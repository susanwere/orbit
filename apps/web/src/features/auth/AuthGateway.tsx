import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { refreshSession, logoutSession } from "./auth-api.js";
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
  const sessionStore = useMemo(
    () => createSessionStore(Date.now, { retainIdentityDuringRenewal: true }),
    [],
  );
  const authenticatedSession = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSession,
    () => null,
  );

  const [isRestoring, setIsRestoring] = useState(Boolean(googleClientId));
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    if (!googleClientId) return;
    let active = true;
    setIsRestoring(true);
    setSessionError(null);
    void refreshSession(apiBaseUrl)
      .then((session) => {
        if (active) sessionStore.setSession(session);
      })
      .catch((error: unknown) => {
        if (active)
          setSessionError(error instanceof Error ? error.message : "Session restoration failed.");
      })
      .finally(() => {
        if (active) setIsRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [apiBaseUrl, googleClientId, sessionStore, restoreAttempt]);

  useEffect(() => {
    if (!authenticatedSession) return;
    let active = true;
    let timer: number;
    const renew = () => {
      void refreshSession(apiBaseUrl)
        .then((session) => {
          if (active) sessionStore.setSession(session);
        })
        .catch(() => {
          if (active) timer = window.setTimeout(renew, 10000);
        });
    };
    const resume = () => {
      if (document.visibilityState === "visible") renew();
    };
    timer = window.setTimeout(
      renew,
      Math.max(1000, authenticatedSession.expiresAt - Date.now() - 60000),
    );
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [apiBaseUrl, authenticatedSession, sessionStore]);

  if (!googleClientId) {
    return <App />;
  }

  if (isRestoring && !authenticatedSession)
    return (
      <main className="orbit-sign-in">
        <p role="status">Restoring your Orbit session…</p>
      </main>
    );
  if (sessionError)
    return (
      <main className="orbit-sign-in">
        <div>
          <p role="alert">{sessionError}</p>
          <button onClick={() => setRestoreAttempt((attempt) => attempt + 1)}>Retry</button>
        </div>
      </main>
    );
  if (!authenticatedSession) {
    return (
      <GoogleSignIn clientId={googleClientId} apiBaseUrl={apiBaseUrl} sessionStore={sessionStore} />
    );
  }

  return (
    <AuthenticatedProjectApp
      sessionStore={sessionStore}
      apiBaseUrl={apiBaseUrl}
      onSignOut={async () => {
        await logoutSession(apiBaseUrl);
        disableGoogleAutomaticSignIn();
      }}
    />
  );
}
