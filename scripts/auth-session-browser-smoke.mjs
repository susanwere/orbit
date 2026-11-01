/** Mock provider/API browser regression. Does not verify live Google credentials. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const frontendOrigin = process.env.AUTH_SMOKE_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:4000";
const browser = await chromium.launch({ headless: true });
await mkdir("/tmp/orbit-auth-smoke", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1662, height: 946 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  let authenticated = false;
  let denyAccount = true;
  let refreshCount = 0;
  let exchangeCount = 0;
  let logoutFails = false;
  let releaseExchange;
  let markExchangeStarted;
  const exchangeStarted = new Promise((resolve) => {
    markExchangeStarted = resolve;
  });
  const session = (expiresIn = 900) => ({
    accessToken: "mock-orbit-access-token",
    principalId: "human-principal",
    organizationId: "organization-1",
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  });
  const project = {
    id: "project-1",
    organization_id: "organization-1",
    name: "Existing Orbit project",
    created_at: "2026-10-30T10:00:00Z",
  };
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.google = { accounts: { id: {
    initialize(configuration) { window.testCredentialCallback = configuration.callback; },
    renderButton(container) { const button = document.createElement('button'); button.textContent = 'Sign in with Google'; button.style.cssText = 'background:#1a73e8;color:white;border:0;border-radius:4px;padding:8px;font-size:20px;width:100%;min-height:40px'; button.onclick = () => window.testCredentialCallback({credential:'mock-provider-credential'}); container.append(button); },
    disableAutoSelect() {}
  } } };`,
    }),
  );
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": frontendOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-orbit-session",
    };
    const respond = (status, payload, extraHeaders = {}) =>
      route.fulfill({
        status,
        headers: { ...headers, ...extraHeaders },
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/auth/exchange") {
      exchangeCount++;
      if (denyAccount) return respond(403, {});
      await new Promise((resolve) => {
        releaseExchange = resolve;
        markExchangeStarted();
      });
      authenticated = true;
      return respond(200, session(62));
    }
    if (path === "/auth/refresh") {
      refreshCount++;
      assert.equal(request.headers()["x-orbit-session"], "1");
      return respond(authenticated ? 200 : 401, authenticated ? session() : {});
    }
    if (path === "/auth/logout") {
      if (logoutFails) return respond(503, {});
      authenticated = false;
      return route.fulfill({ status: 204, headers });
    }
    assert.equal(authenticated, true, "Protected request after logout");
    assert.equal(request.headers().authorization, "Bearer mock-orbit-access-token");
    if (path === "/projects") return respond(200, { projects: [project], nextCursor: null });
    if (path === "/projects/project-1/intent") return respond(200, { intent: null });
    if (path.endsWith("/repositories")) return respond(200, { repositories: [] });
    if (path.endsWith("/plan")) return respond(200, { plan: null });
    return respond(404, {});
  });
  await page.goto(frontendOrigin);
  await page.getByRole("heading", { name: "Welcome to Orbit" }).waitFor();
  await page.screenshot({ path: "/tmp/orbit-auth-smoke/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByRole("alert").filter({ hasText: "not been granted access" }).waitFor();
  denyAccount = false;
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByRole("status").filter({ hasText: "Verifying your identity" }).waitFor();
  assert.equal(await page.getByLabel("Google sign-in", { exact: true }).getAttribute("inert"), "");
  await exchangeStarted;
  releaseExchange();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  // Token renewal is scheduled one minute before the 62-second test expiry.
  await page.waitForResponse(
    (response) => response.url().endsWith("/auth/refresh") && response.status() === 200,
  );
  await page.getByRole("button", { name: /Existing Orbit project/ }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("button", { name: /Existing Orbit project/ }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  assert.equal(exchangeCount, 2, "Reload must not prompt for Google again");
  assert.ok(refreshCount >= 3);
  logoutFails = true;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alert").filter({ hasText: "Sign-out could not finish" }).waitFor();
  logoutFails = false;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Welcome to Orbit" }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Welcome to Orbit" }).waitFor();
  assert.equal(await page.getByLabel("Workspace navigation").count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: "/tmp/orbit-auth-smoke/mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.getByRole("button", { name: "Sign in with Google" }).focus();
  assert.equal(
    await page
      .getByRole("button", { name: "Sign in with Google" })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  await page.route("https://accounts.google.com/gsi/client", (route) => route.abort());
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "Google sign-in could not load" }).waitFor();
  console.log(
    "Mocked Google error/sign-in → renewal → existing project → reload → navigation → logout failure/retry → protected content inaccessible: passed. Desktop/mobile screenshots: /tmp/orbit-auth-smoke",
  );
} finally {
  await browser.close();
}
