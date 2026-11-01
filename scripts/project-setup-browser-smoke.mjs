/** Project setup UI regression with mocked authenticated API responses. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const frontendOrigin = process.env.PROJECT_SMOKE_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:4000";
const browser = await chromium.launch({ headless: true });
await mkdir("/tmp/orbit-project-setup", { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1665, height: 944 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  let createRequests = 0;
  let repositoryRequests = 0;
  let releaseCreation;
  const creationGate = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  let latestProject;
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": frontendOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-orbit-session",
    };
    const respond = (status, payload) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/auth/refresh")
      return respond(200, {
        accessToken: "fixture-access-token",
        principalId: "human",
        organizationId: "org",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      });
    assert.equal(request.headers().authorization, "Bearer fixture-access-token");
    if (path === "/projects" && request.method() === "GET")
      return respond(200, { projects: [], nextCursor: null });
    if (path === "/projects" && request.method() === "POST") {
      createRequests++;
      if (createRequests === 1)
        return respond(503, { message: "Creation temporarily unavailable." });
      if (createRequests === 2) await creationGate;
      latestProject = {
        id: `project-${createRequests}`,
        name: request.postDataJSON().name,
        organization_id: "org",
        created_at: new Date().toISOString(),
      };
      return respond(201, latestProject);
    }
    if (path.endsWith("/repositories") && request.method() === "POST") {
      repositoryRequests++;
      assert.equal(request.postDataJSON().repository, "example/project");
      assert.equal(path, "/projects/project-2/repositories");
      if (repositoryRequests === 1)
        return respond(503, { message: "Repository temporarily unavailable." });
      return respond(201, {
        id: "repository-1",
        project_id: "project-2",
        owner: "example",
        repo: "project",
        full_name: "example/project",
        html_url: "https://github.com/example/project",
        created_at: new Date().toISOString(),
      });
    }
    if (path.endsWith("/intent")) return respond(200, { intent: null });
    if (path.endsWith("/repositories")) return respond(200, { repositories: [] });
    if (path.endsWith("/plan")) return respond(200, { plan: null });
    return respond(404, {});
  });
  await page.goto(frontendOrigin);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("heading", { name: "Start with intent." }).waitFor();
  await page.getByLabel("Project name", { exact: true }).focus();
  await page.screenshot({ path: "/tmp/orbit-project-setup/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  assert.equal(createRequests, 0, "Native validation must reject an empty name");
  await page.getByLabel("Project name", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Enter a project name" }).waitFor();
  await page.getByLabel("Project name", { exact: true }).fill("Open Jobs Viewer");
  await page.getByLabel("GitHub repository", { exact: false }).fill("example/project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Creation temporarily unavailable" }).waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Open Jobs Viewer",
  );
  assert.equal(
    await page.getByLabel("GitHub repository", { exact: false }).inputValue(),
    "example/project",
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("button", { name: "Creating…", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Project name", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
  releaseCreation();
  await page.getByRole("alert").filter({ hasText: "Your project was saved" }).waitFor();
  assert.equal(await page.getByLabel("Project name", { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByLabel("GitHub repository", { exact: false }).inputValue(),
    "example/project",
  );
  await page.screenshot({ path: "/tmp/orbit-project-setup/repository-error.png", fullPage: true });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  assert.equal(createRequests, 2, "Retrying repository connection must not create another project");
  assert.equal(repositoryRequests, 2);
  await page.reload();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  assert.equal(createRequests, 2);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: "/tmp/orbit-project-setup/mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel("Project name", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByLabel("GitHub repository", { exact: false })
      .evaluate((input) => input === document.activeElement),
    true,
  );
  await page.getByLabel("Project name", { exact: true }).fill("Empty project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  assert.equal(createRequests, 3);
  assert.equal(repositoryRequests, 2, "Repository is optional");
  assert.equal(latestProject.name, "Empty project");
  console.log(
    "Project setup: validation, preserved errors, loading/disabled states, optional repository, repository retry without duplicate project, cancel, desktop/mobile and keyboard checks passed.",
  );
} finally {
  await browser.close();
}
