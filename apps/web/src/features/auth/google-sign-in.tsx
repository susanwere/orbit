import { useEffect, useRef, useState } from "react";
import type { SessionStore } from "./session-store.js";

interface IdentityCredential {
  readonly credential: string;
}

interface GoogleIdentityClient {
  readonly accounts: {
    readonly id: {
      initialize(options: {
        client_id: string;
        callback: (credential: IdentityCredential) => void;
      }): void;
      renderButton(container: HTMLElement, options: { theme: string; size: string }): void;
      disableAutoSelect(): void;
    };
  };
}

interface GoogleIdentityWindow extends Window {
  google?: GoogleIdentityClient;
}

export interface GoogleSignInProps {
  readonly clientId: string;
  readonly apiBaseUrl: string;
  readonly sessionStore: SessionStore;
}

/** Google's browser identity widget supplies a signed provider ID token. */
export function GoogleSignIn({ clientId, apiBaseUrl, sessionStore }: GoogleSignInProps) {
  const buttonContainer = useRef<HTMLDivElement>(null);
  const [authenticationError, setAuthenticationError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const browserWindow = window as GoogleIdentityWindow;
    const scriptElement = document.createElement("script");
    scriptElement.src = "https://accounts.google.com/gsi/client";
    scriptElement.async = true;
    scriptElement.defer = true;

    const handleCredential = async ({ credential }: IdentityCredential) => {
      if (!isMounted) return;
      setAuthenticationError(null);
      setIsAuthenticating(true);

      try {
        const exchangeResponse = await fetch(new URL("/auth/exchange", apiBaseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: credential }),
        });
        if (!exchangeResponse.ok) {
          throw new Error(
            exchangeResponse.status === 403
              ? "This Google account has not been granted access to Orbit."
              : "Unable to verify your Google sign-in. Please try again.",
          );
        }

        const exchangePayload: unknown = await exchangeResponse.json();
        if (
          !exchangePayload ||
          typeof exchangePayload !== "object" ||
          !("accessToken" in exchangePayload) ||
          typeof exchangePayload.accessToken !== "string" ||
          !("principalId" in exchangePayload) ||
          typeof exchangePayload.principalId !== "string" ||
          !("organizationId" in exchangePayload) ||
          typeof exchangePayload.organizationId !== "string" ||
          !("expiresAt" in exchangePayload) ||
          typeof exchangePayload.expiresAt !== "number"
        ) {
          throw new Error("Orbit returned an invalid authentication response.");
        }

        if (isMounted) {
          sessionStore.setSession({
            accessToken: exchangePayload.accessToken,
            principalId: exchangePayload.principalId,
            organizationId: exchangePayload.organizationId,
            expiresAt: exchangePayload.expiresAt * 1000,
          });
        }
      } catch (authenticationFailure) {
        if (isMounted) {
          setAuthenticationError(
            authenticationFailure instanceof Error
              ? authenticationFailure.message
              : "Authentication failed. Please try again.",
          );
        }
      } finally {
        if (isMounted) setIsAuthenticating(false);
      }
    };

    const initializeGoogleSignIn = () => {
      if (!isMounted || !browserWindow.google || !buttonContainer.current) return;
      browserWindow.google.accounts.id.initialize({
        client_id: clientId,
        callback: (credential) => {
          void handleCredential(credential);
        },
      });
      browserWindow.google.accounts.id.renderButton(buttonContainer.current, {
        theme: "outline",
        size: "large",
      });
    };

    scriptElement.addEventListener("load", initializeGoogleSignIn);
    scriptElement.addEventListener("error", () => {
      if (isMounted) setAuthenticationError("Google sign-in could not load.");
    });
    document.head.appendChild(scriptElement);

    return () => {
      isMounted = false;
      scriptElement.remove();
    };
  }, [apiBaseUrl, clientId, sessionStore]);

  return (
    <main aria-labelledby="orbit-sign-in-heading">
      <h1 id="orbit-sign-in-heading">Sign in to Orbit</h1>
      <p>Use an approved Google account to access your organization's projects.</p>
      <div ref={buttonContainer} aria-label="Google sign-in" />
      {isAuthenticating && <p role="status">Verifying your identity…</p>}
      {authenticationError && <p role="alert">{authenticationError}</p>}
    </main>
  );
}

export function disableGoogleAutomaticSignIn(): void {
  (window as GoogleIdentityWindow).google?.accounts.id.disableAutoSelect();
}
