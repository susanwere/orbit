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
        options: { theme: string; size: string; width?: number; shape?: string; text?: string },
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
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signup" | "login" | "forgot" | "reset" | "verify">(() => {
    const action = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    ).get("auth_action");
    return action === "verify-email" ? "verify" : action === "reset-password" ? "reset" : "login";
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

    let buttonResizeObserver: ResizeObserver | undefined;
    const initializeGoogleSignIn = () => {
      if (!isMounted || !browserWindow.google || !buttonContainer.current) return;
      browserWindow.google.accounts.id.initialize({
        client_id: clientId,
        callback: (credential) => {
          void handleCredential(credential);
        },
      });
      const googleIdentity = browserWindow.google.accounts.id;
      const container = buttonContainer.current;
      let renderedWidth = 0;
      const renderGoogleButton = () => {
        const buttonWidth = Math.min(400, Math.floor(container.clientWidth));
        if (buttonWidth <= 0 || buttonWidth === renderedWidth) return;
        renderedWidth = buttonWidth;
        container.replaceChildren();
        googleIdentity.renderButton(container, {
          theme: "outline",
          text: "continue_with",
          size: "large",
          width: buttonWidth,
          shape: "rectangular",
        });
      };
      renderGoogleButton();
      buttonResizeObserver = new ResizeObserver(renderGoogleButton);
      buttonResizeObserver.observe(container);
      setIsGoogleReady(true);
    };

    scriptElement.addEventListener("load", initializeGoogleSignIn);
    scriptElement.addEventListener("error", () => {
      if (isMounted) setAuthenticationError("Google sign-in could not load.");
    });
    document.head.appendChild(scriptElement);

    return () => {
      isMounted = false;
      buttonResizeObserver?.disconnect();
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
      <div className="sign-in-shell">
        <section className="sign-in-story" aria-label="About Orbit">
          <div className="sign-in-brand">
            <span className="sign-in-mark" aria-hidden="true" />
            Orbit
          </div>
          <h2>Plan, build, and ship software with AI agents</h2>
          <p className="sign-in-subtitle">
            Turn ideas into plans, execute work, and keep your projects moving — with a human in the
            loop.
          </p>
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
                <p>Break complex goals into clear, connected work.</p>
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
                <p>Review proposals, approve work, and see real progress.</p>
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
                <p>Keep humans in the loop with audit trails and evidence.</p>
              </div>
            </li>
          </ul>
          <div className="sign-in-planet" aria-hidden="true" />
        </section>
        <section className="sign-in-card">
          <div className="sign-in-card-content">
            <h1 id="orbit-sign-in-heading">
              {mode === "signup"
                ? "Create your account"
                : mode === "forgot"
                  ? "Forgot password?"
                  : mode === "reset"
                    ? "Set a new password"
                    : mode === "verify"
                      ? "Verify your email"
                      : "Welcome back"}
            </h1>
            <p className="sign-in-subtitle">
              {mode === "signup"
                ? "Start building in your Orbit workspace."
                : mode === "forgot"
                  ? "We’ll email you a password reset link."
                  : mode === "reset"
                    ? "Choose a new password for your workspace."
                    : mode === "verify"
                      ? "Confirm your email to access your workspace."
                      : "Sign in to your Orbit workspace."}
            </p>
            {clientId && (
              <div className="sign-in-action" aria-busy={isAuthenticating}>
                <div
                  ref={buttonContainer}
                  aria-label="Google sign-in"
                  {...{ inert: isAuthenticating ? "" : undefined }}
                />
                {!isGoogleReady && !authenticationError && (
                  <p role="status">Loading Google sign-in…</p>
                )}
              </div>
            )}
            {clientId && (
              <div className="sign-in-divider" aria-hidden="true">
                <span />
                or
                <span />
              </div>
            )}
            <form
              className="sign-in-action"
              data-auth-mode={mode}
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
                        ? emailAccountAction(apiBaseUrl, "verify", { token: linkToken }).then(
                            () => {
                              setNotice("Email verified. You can now sign in.");
                              setMode("login");
                              window.history.replaceState(null, "", window.location.pathname);
                            },
                          )
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
                    setAuthenticationError(
                      error instanceof Error ? error.message : "Sign-in failed.",
                    ),
                  )
                  .finally(() => setIsAuthenticating(false));
              }}
            >
              {(mode === "signup" || mode === "login" || mode === "forgot") && (
                <>
                  <label htmlFor="orbit-email">Email</label>
                  <input
                    id="orbit-email"
                    placeholder="you@example.com"
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
                  <div className="sign-in-password-field">
                    <input
                      id="orbit-password"
                      type={isPasswordVisible ? "text" : "password"}
                      required
                      minLength={mode === "signup" || mode === "reset" ? 12 : undefined}
                      placeholder={
                        mode === "signup" || mode === "reset"
                          ? "At least 12 characters"
                          : "Enter your password"
                      }
                      autoComplete={
                        mode === "signup" || mode === "reset" ? "new-password" : "current-password"
                      }
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      className="sign-in-password-toggle"
                      aria-label={isPasswordVisible ? "Hide password" : "Show password"}
                      aria-pressed={isPasswordVisible}
                      onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
              <div className="sign-in-help">
                {mode === "login" && authenticationError?.toLowerCase().includes("verif") && (
                  <button
                    type="button"
                    disabled={isAuthenticating || !email.trim()}
                    onClick={() => {
                      setAuthenticationError(null);
                      void emailAccountAction(apiBaseUrl, "resend-verification", { email })
                        .then(() =>
                          setNotice("If verification is pending, a new link has been sent."),
                        )
                        .catch((error: unknown) =>
                          setAuthenticationError(
                            error instanceof Error
                              ? error.message
                              : "Could not request verification.",
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
              </div>
              {(mode === "signup" || mode === "login" || mode === "reset") && (
                <div
                  className="sign-in-confirm-field"
                  style={mode === "login" ? { visibility: "hidden" } : undefined}
                  aria-hidden={mode === "login" ? true : undefined}
                >
                  <label htmlFor="orbit-confirm-password">Confirm password</label>
                  <input
                    id="orbit-confirm-password"
                    type="password"
                    disabled={mode === "login"}
                    required={mode !== "login"}
                    minLength={12}
                    value={confirmPassword}
                    autoComplete="new-password"
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </div>
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
                className="sign-in-account-switch"
                disabled={isAuthenticating}
                onClick={() => {
                  setMode(mode === "signup" ? "login" : "signup");
                  setNotice(null);
                  setAuthenticationError(null);
                }}
              >
                {mode === "signup" ? (
                  "Already have an account? Sign in"
                ) : (
                  <>
                    Don’t have an account? <span className="sign-in-create-link">Create one</span>
                  </>
                )}
              </button>
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
          </div>
        </section>
      </div>
    </main>
  );
}

export function disableGoogleAutomaticSignIn(): void {
  (window as GoogleIdentityWindow).google?.accounts.id.disableAutoSelect();
}
