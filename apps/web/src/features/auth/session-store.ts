/**
 * Trusted identity integration provides the access token. This module never
 * mints tokens, stores credentials, or assumes that a backend login exists.
 */
export interface AuthenticatedSession {
  readonly accessToken: string;
  readonly principalId: string;
  readonly organizationId: string;
  readonly expiresAt: number;
}

export type SessionListener = (session: AuthenticatedSession | null) => void;

export interface SessionStore {
  getSession(): AuthenticatedSession | null;
  setSession(session: AuthenticatedSession | null): void;
  subscribe(listener: SessionListener): () => void;
  getAuthorizationHeader(): string | undefined;
}

/** In-memory session state; signing out removes the token from memory. */
export function createSessionStore(
  currentTime: () => number = Date.now,
  options: { readonly retainIdentityDuringRenewal?: boolean } = {},
): SessionStore {
  let activeSession: AuthenticatedSession | null = null;
  const listeners = new Set<SessionListener>();

  function readSession(): AuthenticatedSession | null {
    if (
      !options.retainIdentityDuringRenewal &&
      activeSession &&
      activeSession.expiresAt <= currentTime()
    ) {
      activeSession = null;
      listeners.forEach((listener) => listener(null));
    }

    return activeSession;
  }

  function updateSession(nextSession: AuthenticatedSession | null): void {
    activeSession = nextSession && nextSession.expiresAt > currentTime() ? nextSession : null;

    listeners.forEach((listener) => listener(activeSession));
  }

  return {
    getSession: readSession,
    setSession: updateSession,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getAuthorizationHeader() {
      const session = readSession();
      return session && session.expiresAt > currentTime()
        ? `Bearer ${session.accessToken}`
        : undefined;
    },
  };
}
