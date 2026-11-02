import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoogleSignIn } from "./google-sign-in.js";
import { createSessionStore } from "./session-store.js";

describe("Orbit sign-in", () => {
  it("renders the approved copy, accessible Google loading state and all three benefits", () => {
    const markup = renderToStaticMarkup(
      <GoogleSignIn
        clientId="public-test-client"
        apiBaseUrl="http://localhost:4000"
        sessionStore={createSessionStore()}
      />,
    );
    expect(markup).toContain('aria-labelledby="orbit-sign-in-heading"');
    expect(markup).toContain("Welcome to Orbit");
    expect(markup).toContain("Turn ideas into plans");
    expect(markup).toContain("Collaborate with AI agents");
    expect(markup).toContain("Ship with confidence");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('Create account');
  });

  it("offers email signup even when Google is not configured", () => {
    const markup = renderToStaticMarkup(
      <GoogleSignIn
        apiBaseUrl="http://localhost:4000"
        sessionStore={createSessionStore()}
      />,
    );
    expect(markup).toContain("Create account");
    expect(markup).toContain("Already have an account? Sign in");
    expect(markup).not.toContain("Loading Google sign-in");
  });
});
