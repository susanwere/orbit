/** Canvas-only visual regression; authenticated API responses are deterministic fixtures. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const frontendOrigin = process.env.PROJECT_SMOKE_WEB_ORIGIN ?? "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:4000";
const project = {
  id: "canvas-project",
  organization_id: "org",
  name: "private-4",
  created_at: "2026-11-01T10:00:00Z",
};
const intent = {
  id: "canvas-intent",
  organization_id: "org",
  project_id: project.id,
  statement: "Build a jobs viewer with accessible navigation.",
  created_at: "2026-11-01T10:00:00Z",
};
const graph = {
  summary: "Build a jobs viewer",
  workItems: [
    {
      key: "JOBS-1",
      title: "Jobs viewer",
      description: "Display jobs accessibly",
      dependsOn: [],
      workflows: [
        {
          name: "Implementation",
          steps: [
            { title: "Review requirements", executor: "human", requiresApproval: true },
            { title: "Implement viewer", executor: "agent", requiresApproval: false },
          ],
        },
      ],
    },
    {
      key: "JOBS-2",
      title: "Verify accessibility",
      description: "Review keyboard navigation",
      dependsOn: ["JOBS-1"],
      workflows: [
        {
          name: "Review",
          steps: [{ title: "Verify controls", executor: "human", requiresApproval: true }],
        },
      ],
    },
  ],
  guardrails: ["Accessible controls"],
  decisionsToReview: [],
  assumptions: [],
};
let savedPlan = {
  id: "canvas-plan",
  project_id: project.id,
  original_intent_id: intent.id,
  status: "READY_FOR_REVIEW",
  failure_reason: null,
  revision: 1,
  content: graph,
};
const mutations = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl"],
});
await mkdir("/tmp/orbit-plan-canvas", { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1665, height: 945 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": frontendOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
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
        accessToken: "canvas-fixture-token",
        principalId: "human",
        organizationId: "org",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      });
    assert.equal(request.headers().authorization, "Bearer canvas-fixture-token");
    if (request.method() !== "GET") mutations.push(path);
    if (path === "/projects") return respond(200, { projects: [project], nextCursor: null });
    if (path.endsWith("/intent")) return respond(200, { intent });
    if (path.endsWith("/plan/approve")) {
      assert.equal(request.postDataJSON().expectedRevision, 2);
      savedPlan = { ...savedPlan, status: "APPROVED", revision: 3 };
      return respond(200, { plan: savedPlan });
    }
    if (path.endsWith("/plan")) {
      if (request.method() === "PATCH") {
        assert.equal(request.postDataJSON().expectedRevision, 1);
        savedPlan = { ...savedPlan, content: request.postDataJSON().content, revision: 2 };
      }
      return respond(200, { plan: savedPlan });
    }
    if (path.endsWith("/repositories")) return respond(200, { repositories: [] });
    if (path.endsWith("/approved-agents")) return respond(200, { agents: [] });
    if (path.endsWith("/execution/steps")) return respond(200, { steps: [] });
    if (path.endsWith("/tasks")) return respond(200, { tasks: [] });
    return respond(404, {});
  });
  await page.goto(frontendOrigin);
  await page.getByRole("button", { name: /private-4 Created/ }).click();
  await page.getByRole("heading", { name: "What do you want to build?", exact: true }).waitFor();
  assert.equal(
    await page.locator(".intent-page").count(),
    1,
    "Intent page must retain its original surface",
  );
  await page.getByRole("button", { name: "Review proposed plan", exact: true }).click();
  await page.getByRole("heading", { name: "Workflow Canvas", exact: true }).waitFor();
  await page.getByRole("button", { name: "Zoom in", exact: true }).waitFor();
  assert.equal(
    await page.locator(".orbit-workspace-toolbar").count(),
    0,
    "Canvas header must be removed",
  );
  assert.equal(
    await page
      .getByRole("navigation", { name: "Account", exact: true })
      .evaluate((menu) => Boolean(menu.closest(".canvas-sidebar-account"))),
    true,
  );
  await page.getByText("Account ▾", { exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.getByText("Account ▾", { exact: true }).click();

  await page.getByRole("button", { name: /^WORK ITEM Jobs viewer/ }).waitFor();
  assert.equal(mutations.length, 0, "Opening the canvas must remain read-only");
  await page.getByRole("button", { name: "Reset canvas view", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByText("120%", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByText("100%", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Pan canvas", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  await page.getByRole("button", { name: "Fit graph to view", exact: true }).click();
  assert.match(await page.getByLabel("Canvas zoom", { exact: true }).textContent(), /\d+%/);
  await page.getByRole("button", { name: "Composer", exact: true }).click();
  await page.getByLabel("Canvas project idea", { exact: true }).fill("A composer preview draft");
  assert.equal(
    await page.getByRole("button", { name: "Composer", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page.getByRole("button", { name: "Generate plan", exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({ path: "/tmp/orbit-plan-canvas/composer-sidebar.png", fullPage: true });
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  assert.equal(await page.getByLabel("Canvas project idea", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Composer", exact: true }).click();
  assert.equal(
    await page.getByLabel("Canvas project idea", { exact: true }).inputValue(),
    "A composer preview draft",
  );
  assert.equal(mutations.length, 0, "Opening or editing Composer must not change intent or plans");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.mouse.move(1300, 130);
  await page.screenshot({ path: "/tmp/orbit-plan-canvas/desktop.png", fullPage: true });
  await page.getByText("Accessible node list", { exact: true }).click();
  await page.getByRole("button", { name: "Jobs viewer · work", exact: true }).click();
  await page.getByRole("region", { name: "Work item configuration", exact: true }).waitFor();
  assert.equal(mutations.length, 0, "Selecting nodes must not modify or execute the plan");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  assert.equal(
    await page.getByText("Plan details and work item management", { exact: true }).count(),
    0,
  );
  const planDetailsToggle = page.locator(".canvas-sidebar-items > summary");
  assert.equal(
    await page
      .locator(".canvas-sidebar")
      .getByRole("button", { name: /Work Items/ })
      .count(),
    0,
  );
  const sidebarOrder = await page
    .getByRole("navigation", { name: "Canvas sections", exact: true })
    .evaluate((navigation) => {
      const group = navigation.querySelector(".canvas-sidebar-workflow");
      const details = navigation.querySelector(".canvas-sidebar-items");
      return Boolean(details.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  assert.equal(sidebarOrder, true, "Workflow appears below Plan details");
  assert.equal(await planDetailsToggle.textContent(), "Plan details");
  assert.equal(
    await page.locator(".canvas-sidebar-items").getAttribute("open"),
    null,
    "Plan details starts collapsed",
  );
  assert.equal(await page.getByRole("button", { name: "Workflow", exact: true }).isVisible(), true);
  assert.equal(
    await page.getByRole("button", { name: "Proposed Outcome", exact: true }).isVisible(),
    false,
  );
  await planDetailsToggle.click();
  assert.equal(
    await page.getByRole("button", { name: "Proposed Outcome", exact: true }).isVisible(),
    true,
  );
  await planDetailsToggle.press("Enter");
  assert.equal(
    await page.getByRole("button", { name: "Proposed Outcome", exact: true }).isVisible(),
    false,
  );
  await planDetailsToggle.press("Enter");
  assert.equal(
    await page.getByRole("button", { name: "Proposed Outcome", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: "Proposed Outcome", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Proposed Outcome", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(await page.locator(".canvas-plan-section textarea").count(), 0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Proposed outcome", { exact: true }).fill("A discarded edit");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page.locator(".canvas-plan-section-card .canvas-plan-section-text").textContent(),
    graph.summary,
  );
  assert.equal(mutations.length, 0, "Cancel must discard locally without saving");
  await page.screenshot({
    path: "/tmp/orbit-plan-canvas/proposed-outcome-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: "/tmp/orbit-plan-canvas/proposed-outcome-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1665, height: 945 });
  await page
    .locator(".canvas-plan-related")
    .getByRole("button", { name: /Original Intent/ })
    .click();
  await page.getByRole("region", { name: "Original Intent", exact: true }).waitFor();
  assert.equal(
    await page.locator(".canvas-plan-section textarea").count(),
    0,
    "Original intent remains immutable",
  );
  await page
    .locator(".canvas-sidebar")
    .getByRole("button", { name: "Guardrails", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Guardrails (one per line)", { exact: true }).fill("Keep keyboard access");
  await page.getByLabel("Guardrails (one per line)", { exact: true }).press("End");
  await page.getByLabel("Guardrails (one per line)", { exact: true }).press("Enter");
  await page
    .getByLabel("Guardrails (one per line)", { exact: true })
    .pressSequentially("Keep contrast");
  assert.equal(
    await page.getByLabel("Guardrails (one per line)", { exact: true }).inputValue(),
    "Keep keyboard access\nKeep contrast",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "+ Add work item", exact: true }).click();
  await page.getByRole("region", { name: "Work item configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Proposed Outcome", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(mutations.length, 0, "New work items remain local until saved");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Proposed outcome", { exact: true })
    .fill("Build an accessible jobs viewer");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  assert.equal(
    await page.locator(".canvas-plan-section textarea").count(),
    0,
    "Successful save returns to text view",
  );
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await page.getByText("● Approved plan", { exact: true }).waitFor();
  assert.equal(await page.locator(".canvas-plan-section textarea").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  assert.equal(mutations.length, 2, "Plan edits and approval must not start execution");
  assert.equal(
    await page
      .locator(".workgraph-plan-approved")
      .evaluate((badge) => getComputedStyle(badge).color),
    "rgb(100, 230, 142)",
  );
  assert.equal(
    await page.locator(".workgraph-footer, .orbit-plan-footer").count(),
    0,
    "Canvas has no footer bars",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Fit graph to view", exact: true }).click();
  await page.screenshot({ path: "/tmp/orbit-plan-canvas/mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "← Intent", exact: true }).click();
  await page.getByRole("heading", { name: "What do you want to build?", exact: true }).waitFor();
  assert.equal(await page.locator(".intent-page").count(), 1);
  assert.equal(
    await page
      .getByRole("navigation", { name: "Account", exact: true })
      .evaluate((menu) => Boolean(menu.closest(".canvas-sidebar-account"))),
    false,
    "Intent must retain its original Account placement",
  );

  assert.equal(
    await page.getByLabel("Your original intent", { exact: true }).inputValue(),
    intent.statement,
  );
  const emptyPage = await browser.newPage({
    viewport: { width: 1665, height: 945 },
    reducedMotion: "reduce",
  });
  let emptyCanvasApiRequests = 0;
  emptyPage.on("request", (request) => {
    if (request.url().startsWith(apiOrigin)) emptyCanvasApiRequests++;
  });
  await emptyPage.goto(`${frontendOrigin}/canvas-preview.html`);
  await emptyPage.getByLabel("Canvas project idea", { exact: true }).waitFor();
  await emptyPage.screenshot({ path: "/tmp/orbit-plan-canvas/empty-desktop.png", fullPage: true });
  await emptyPage
    .getByLabel("Canvas project idea", { exact: true })
    .fill("An editable canvas idea for later");
  assert.equal(
    await emptyPage.getByLabel("Canvas project idea", { exact: true }).inputValue(),
    "An editable canvas idea for later",
  );
  assert.equal(
    await emptyPage.getByRole("button", { name: "Generate plan", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    emptyCanvasApiRequests,
    0,
    "The future canvas composer must not mutate intent or plans",
  );
  await emptyPage.setViewportSize({ width: 375, height: 812 });
  await emptyPage.screenshot({ path: "/tmp/orbit-plan-canvas/empty-mobile.png", fullPage: true });
  assert.equal(
    await emptyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await emptyPage.close();
  console.log(
    "Canvas-only redesign: unchanged Intent page, real graph nodes, zoom/pan/fit controls, read-only selection, edit/approval, desktop/mobile and return navigation passed.",
  );
} finally {
  await browser.close();
}
