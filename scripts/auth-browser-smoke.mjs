import assert from "node:assert/strict";
import { chromium } from "playwright";

const apiOrigin = "http://127.0.0.1:4000";
const frontendOrigin = "http://127.0.0.1:5174";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl"],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });

  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };

  await page.route("https://accounts.google.com/gsi/client", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.google = {
          accounts: {
            id: {
              initialize(configuration) {
                window.googleSignInCallback = configuration.callback;
              },
              renderButton(container) {
                const signInButton = document.createElement("button");
                signInButton.textContent = "Continue with Google";
                signInButton.addEventListener("click", () => {
                  window.googleSignInCallback({ credential: "provider-signed-test-token" });
                });
                container.appendChild(signInButton);
              },
              disableAutoSelect() {},
            },
          },
        };
      `,
    });
  });

  await page.route(`${apiOrigin}/auth/exchange`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    const requestBody = route.request().postDataJSON();
    assert.equal(requestBody.idToken, "provider-signed-test-token");

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        accessToken: "ci-orbit-access-token",
        principalId: "human-principal",
        organizationId: "organization-1",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      }),
    });
  });

  await page.route(`${apiOrigin}/projects`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    assert.equal(route.request().headers().authorization, "Bearer ci-orbit-access-token");
    assert.equal(route.request().postDataJSON().name, "HN Jobs Viewer");

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        id: "project-1",
        organization_id: "organization-1",
        name: "HN Jobs Viewer",
        created_at: new Date().toISOString(),
      }),
    });
  });

  await page.goto(frontendOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Sign in to Orbit" }).waitFor();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  await page.getByRole("button", { name: "View projects" }).click();
  await page.getByRole("heading", { name: "Start with intent." }).waitFor();

  await page.screenshot({
    path: "docs/images/orbit-authenticated-project-creation.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.getByLabel("Project name").fill("HN Jobs Viewer");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Everything revolves around intent." }).waitFor();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to Orbit" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "View projects" }).count(), 0);

  console.log("Mocked browser sign-in, protected project creation, and sign-out passed.");
} finally {
  await browser.close();
}
