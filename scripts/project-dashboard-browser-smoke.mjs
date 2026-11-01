/** Deterministic browser fixtures; no live-account or live-project claims. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const frontendOrigin = process.env.PROJECT_SMOKE_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:4000";
const projectNames = [
  "HN Jobs",
  "Open Jobs",
  "Hello World",
  "private-test",
  "HN Jobs Viewer",
  "private-7",
  "Orbit docs",
  "Release planning",
  "Design system",
  "API workspace",
  "Website",
  "Research",
  ...Array.from({ length: 18 }, (_, projectIndex) => `Additional project ${projectIndex + 1}`),
  "Final project",
];
const projects = projectNames.map((name, projectIndex) => ({
  id: `project-${projectIndex + 1}`,
  organization_id: "organization-1",
  name,
  created_at: "2026-10-30T12:00:00Z",
}));
const browser = await chromium.launch({ headless: true });
await mkdir("/tmp/orbit-project-dashboard", { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1670, height: 941 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  let failInitialLoad = true;
  let failNextPage = true;
  let returnEmptyProjects = false;
  const pageRequests = [];
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
    if (url.pathname === "/auth/refresh")
      return respond(200, {
        accessToken: "fixture-access-token",
        principalId: "human",
        organizationId: "organization-1",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      });
    assert.equal(request.headers().authorization, "Bearer fixture-access-token");
    if (url.pathname === "/projects") {
      const cursor = url.searchParams.get("before");
      pageRequests.push(cursor);
      assert.equal(url.searchParams.get("limit"), "24");
      if (!cursor && failInitialLoad) {
        return respond(503, {});
      }
      if (cursor && failNextPage) {
        failNextPage = false;
        return respond(503, {});
      }
      if (returnEmptyProjects) return respond(200, { projects: [], nextCursor: null });
      const startIndex = cursor ? Number(cursor) : 0;
      const nextIndex = startIndex + 24;
      return respond(200, {
        projects: projects.slice(startIndex, nextIndex),
        nextCursor: nextIndex < projects.length ? String(nextIndex) : null,
      });
    }
    if (url.pathname.endsWith("/intent")) return respond(200, { intent: null });
    if (url.pathname.endsWith("/repositories")) return respond(200, { repositories: [] });
    if (url.pathname.endsWith("/plan")) return respond(200, { plan: null });
    return respond(404, {});
  });
  await page.goto(frontendOrigin);
  await page.getByRole("alert").filter({ hasText: "Could not load projects" }).waitFor();
  failInitialLoad = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: /HN Jobs Created/ }).waitFor();
  assert.equal(await page.locator(".project-dashboard-card").count(), 6);
  await page.screenshot({ path: "/tmp/orbit-project-dashboard/desktop.png", fullPage: true });
  assert.equal(await page.getByRole("button", { name: /^Page \d+$/ }).count(), 4);
  assert.equal(
    await page.getByRole("button", { name: "Page 1", exact: true }).getAttribute("aria-current"),
    "page",
  );
  const requestsBeforeCachedNavigation = pageRequests.length;
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await page.getByRole("button", { name: /Orbit docs Created/ }).waitFor();
  assert.equal(
    pageRequests.length,
    requestsBeforeCachedNavigation,
    "Visible page buttons should use prefetched projects",
  );
  assert.equal(
    await page.getByRole("button", { name: "Page 2", exact: true }).getAttribute("aria-current"),
    "page",
  );
  await page.getByLabel("Search projects", { exact: true }).fill("Final");
  await page.getByRole("status").filter({ hasText: "No matching projects" }).waitFor();
  await page.getByLabel("Search projects", { exact: true }).fill("");
  await page.getByRole("button", { name: "Page 4", exact: true }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.locator(".project-dashboard-card").count(),
    6,
    "Failed pagination must preserve projects",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Page 5", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Page 5", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(await page.getByRole("button", { name: /^Page \d+$/ }).count(), 4);
  const fullPagePaginationTop = await page
    .getByLabel("Project pages", { exact: true })
    .evaluate((pagination) => pagination.getBoundingClientRect().top);
  await page.getByRole("button", { name: "Page 6", exact: true }).click();
  await page.getByRole("button", { name: /Final project Created/ }).waitFor();
  await page.getByRole("status").filter({ hasText: "Page 6 of 6" }).waitFor();
  const partialPagePaginationTop = await page
    .getByLabel("Project pages", { exact: true })
    .evaluate((pagination) => pagination.getBoundingClientRect().top);
  assert.ok(
    Math.abs(fullPagePaginationTop - partialPagePaginationTop) < 1,
    "Pagination must stay at the same position on a partial page",
  );
  assert.equal(await page.getByRole("button", { name: "Next page" }).isDisabled(), true);
  await page.getByLabel("Search projects", { exact: true }).fill("HN JOBS");
  assert.equal(await page.locator(".project-dashboard-card").count(), 2);
  await page.getByLabel("Search projects", { exact: true }).fill("no matches");
  await page.getByRole("status").filter({ hasText: "No matching projects" }).waitFor();
  await page.getByLabel("Search projects", { exact: true }).fill("");
  await page.getByRole("button", { name: /HN Jobs Created/ }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: /HN Jobs Created/ }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: "/tmp/orbit-project-dashboard/mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page
      .locator(".project-dashboard-orbit-left i")
      .first()
      .evaluate((sphere) => getComputedStyle(sphere).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const initialSpherePosition = await page
    .locator(".project-dashboard-orbit-left i")
    .first()
    .evaluate((sphere) => sphere.getBoundingClientRect().x);
  await page.waitForFunction(
    (initialPosition) =>
      Math.abs(
        document.querySelector(".project-dashboard-orbit-left i").getBoundingClientRect().x -
          initialPosition,
      ) > 1,
    initialSpherePosition,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Search projects", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "New project", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("heading", { name: "Start with intent." }).waitFor();
  returnEmptyProjects = true;
  await page.reload();
  await page.getByRole("heading", { name: "No projects yet" }).waitFor();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("heading", { name: "Start with intent." }).waitFor();
  console.log(
    "Projects dashboard: initial error/retry, cursor pagination, pagination retry, cached navigation, search, empty state, project opening, creation, reload, mobile and keyboard checks passed.",
  );
} finally {
  await browser.close();
}
