import "./sign-in.css";
import { useEffect, useRef, useState } from "react";
import type { SessionStore } from "./session-store.js";
import { exchangeIdentityToken, exchangeEmailPassword, emailAccountAction } from "./auth-api.js";

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
      renderButton(
        container: HTMLElement,
        options: { theme: string; size: string; width?: number; shape?: string },
      ): void;
      disableAutoSelect(): void;
    };
  };
}

interface GoogleIdentityWindow extends Window {
  google?: GoogleIdentityClient;
}

export interface GoogleSignInProps {
  readonly clientId?: string;
  readonly apiBaseUrl: string;
  readonly sessionStore: SessionStore;
}

/** Google's browser identity widget supplies a signed provider ID token. */
export function GoogleSignIn({ clientId, apiBaseUrl, sessionStore }: GoogleSignInProps) {
  const buttonContainer = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signup" | "login" | "forgot" | "reset" | "verify">(() => {
    const action = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    ).get("auth_action");
    return action === "verify-email" ? "verify" : action === "reset-password" ? "reset" : "signup";
  });
  const [linkToken] = useState(
    () =>
      new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get(
        "token",
      ) ?? "",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authenticationError, setAuthenticationError] = useState<string | null>(null);
  const [isGoogleReady, setIsGoogleReady] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (!clientId) return;
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
        const authenticatedSession = await exchangeIdentityToken(apiBaseUrl, credential);
        if (isMounted) {
          sessionStore.setSession(authenticatedSession);
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
        theme: "filled_blue",
        size: "large",
        width: Math.min(400, buttonContainer.current.clientWidth),
        shape: "rectangular",
      });
      setIsGoogleReady(true);
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
    <main className="orbit-sign-in" aria-labelledby="orbit-sign-in-heading">
      <div className="sign-in-orbit sign-in-orbit-left" aria-hidden="true">
        <i />
        <i />
      </div>
      <div className="sign-in-orbit sign-in-orbit-right" aria-hidden="true">
        <i />
      </div>
      <section className="sign-in-card">
        <div className="sign-in-brand">
          <span className="sign-in-mark" aria-hidden="true" />
          Orbit
        </div>
        <h1 id="orbit-sign-in-heading">Welcome to Orbit</h1>
        <p className="sign-in-subtitle">
          Plan, review, and execute software projects
          <br className="sign-in-desktop-break" /> with AI agents and your team.
        </p>
        {clientId && (
          <div className="sign-in-action" aria-busy={isAuthenticating}>
            <div
              ref={buttonContainer}
              aria-label="Google sign-in"
              {...{ inert: isAuthenticating ? "" : undefined }}
            />
            {!isGoogleReady && !authenticationError && <p role="status">Loading Google sign-in…</p>}
          </div>
        )}
        <form
          className="sign-in-action"
          onSubmit={(event) => {
            event.preventDefault();
            setAuthenticationError(null);
            setIsAuthenticating(true);
            const operation =
              mode === "signup" || mode === "login"
                ? exchangeEmailPassword(apiBaseUrl, mode, email, password).then((session) => {
                    sessionStore.setSession(session);
                  })
                : mode === "forgot"
                  ? emailAccountAction(apiBaseUrl, "forgot-password", { email }).then(() =>
                      setNotice("If the account exists, a reset email has been sent."),
                    )
                  : mode === "verify"
                    ? emailAccountAction(apiBaseUrl, "verify", { token: linkToken }).then(() => {
                        setNotice("Email verified. You can now sign in.");
                        setMode("login");
                        window.history.replaceState(null, "", window.location.pathname);
                      })
                    : emailAccountAction(apiBaseUrl, "reset-password", {
                        token: linkToken,
                        password,
                      }).then(() => {
                        setNotice("Password updated. Sign in with your new password.");
                        setMode("login");
                        window.history.replaceState(null, "", window.location.pathname);
                      });
            void operation
              .catch((error: unknown) =>
                setAuthenticationError(error instanceof Error ? error.message : "Sign-in failed."),
              )
              .finally(() => setIsAuthenticating(false));
          }}
        >
          {(mode === "signup" || mode === "login" || mode === "forgot") && (
            <>
              <label htmlFor="orbit-email">Email</label>
              <input
                id="orbit-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </>
          )}
          {(mode === "signup" || mode === "login" || mode === "reset") && (
            <>
              <label htmlFor="orbit-password">
                {mode === "reset" ? "New password" : "Password"}
              </label>
              <input
                id="orbit-password"
                type="password"
                required
                minLength={mode === "signup" || mode === "reset" ? 12 : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}
          {(mode === "signup" || mode === "reset") && (
            <>
              <label htmlFor="orbit-confirm-password">Confirm password</label>
              <input
                id="orbit-confirm-password"
                type="password"
                required
                minLength={12}
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </>
          )}
          <button
            type="submit"
            className="cta-primary"
            disabled={
              isAuthenticating ||
              ((mode === "signup" || mode === "reset") && password !== confirmPassword)
            }
          >
            {mode === "signup"
              ? "Create account"
              : mode === "login"
                ? "Sign in"
                : mode === "forgot"
                  ? "Send reset link"
                  : mode === "verify"
                    ? "Verify email"
                    : "Reset password"}
          </button>
          <button
            type="button"
            disabled={isAuthenticating}
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setNotice(null);
              setAuthenticationError(null);
            }}
          >
            {mode === "signup"
              ? "Already have an account? Sign in"
              : "New to Orbit? Create an account"}
          </button>
          {mode === "login" && (
            <button
              type="button"
              disabled={isAuthenticating || !email.trim()}
              onClick={() => {
                setAuthenticationError(null);
                void emailAccountAction(apiBaseUrl, "resend-verification", { email })
                  .then(() => setNotice("If verification is pending, a new link has been sent."))
                  .catch((error: unknown) =>
                    setAuthenticationError(
                      error instanceof Error ? error.message : "Could not request verification.",
                    ),
                  );
              }}
            >
              Resend verification email
            </button>
          )}
          {mode === "login" && (
            <button
              type="button"
              onClick={() => {
                setMode("forgot");
                setNotice(null);
              }}
            >
              Forgot password?
            </button>
          )}
          {(mode === "forgot" || mode === "reset" || mode === "verify") && (
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setNotice(null);
              }}
            >
              Back to sign in
            </button>
          )}
        </form>
        {notice && <p role="status">{notice}</p>}
        {isAuthenticating && <p role="status">Verifying your identity…</p>}
        {authenticationError && (
          <p className="sign-in-error" role="alert">
            {authenticationError}
          </p>
        )}
        <div className="sign-in-divider" aria-hidden="true">
          <span />
          or
          <span />
        </div>
        <p className="sign-in-explanation">
          Sign in with email and password, or continue with your approved Google account.
        </p>
      </section>
      <ul className="sign-in-benefits" aria-label="What you can do with Orbit">
        <li>
          <span className="sign-in-benefit-icon" aria-hidden="true">
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            >
              <path d="m3 10 13-7 13 7-13 7-13-7Zm0 6 13 7 13-7M3 22l13 7 13-7" />
            </svg>
          </span>
          <div>
            <h2>Turn ideas into plans</h2>
            <p>
              Break complex goals into
              <br /> clear, connected work.
            </p>
          </div>
        </li>
        <li>
          <span className="sign-in-benefit-icon" aria-hidden="true">
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            >
              <path d="M18 2 4 19h10l-1 11 15-18H18l2-10Z" />
            </svg>
          </span>
          <div>
            <h2>Collaborate with AI agents</h2>
            <p>
              Review proposals, approve
              <br /> work, and see real progress.
            </p>
          </div>
        </li>
        <li>
          <span className="sign-in-benefit-icon" aria-hidden="true">
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 29V16h5v13m5 0V10h5v19m5 0V3h5v26H2" />
            </svg>
          </span>
          <div>
            <h2>Ship with confidence</h2>
            <p>
              Keep humans in the loop with
              <br /> audit trails and evidence.
            </p>
          </div>
        </li>
      </ul>
    </main>
  );
}

export function disableGoogleAutomaticSignIn(): void {
  (window as GoogleIdentityWindow).google?.accounts.id.disableAutoSelect();
}
