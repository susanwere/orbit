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
  workItems: ["build", "design", "test", "ship"].map((key, index) => ({
    key,
    title:
      index === 0
        ? "Build an accessible viewer with a deliberately long title that wraps across many lines while retaining every word"
        : `Work ${key}`,
    description: `Deliver ${key}`,
    dependsOn: index === 0 ? [] : index === 3 ? ["design", "test"] : ["build"],
    workflows: ["Engineering", "Review"].map((name) => ({
      name,
      steps: Array.from({ length: 3 }, (_, stepIndex) => ({
        title: `Perform ${name} step ${stepIndex + 1}`,
        executor: "agent",
        requiresApproval: stepIndex === 0,
      })),
    })),
  })),
  guardrails: ["Accessible controls"],
  decisionsToReview: [],
  assumptions: [],
};
let savedPlan = {
  id: "canvas-plan",
  project_id: project.id,
  original_intent_id: intent.id,
  status: "APPROVED",
  failure_reason: null,
  revision: 3,
  content: graph,
};
const mutations = [];
let executionState = "RUNNING";
let historicalSessionReads = 0;
let executionReads = 0;
const executionStep = () => ({
  id: "step-1",
  plan_id: savedPlan.id,
  plan_revision: savedPlan.revision,
  work_item_key: "build",
  workflow_index: 0,
  step_index: 0,
  state: executionState,
  approval_required: true,
  approved_at: null,
  blocker_reason: "waiting_for_human_approval",
  agent_session_id: "session-1",
});
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
    if (path.endsWith("/execution/steps")) {
      executionReads++;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return respond(200, {
        steps: [
          {
            ...executionStep(),
            id: "old-plan-step",
            plan_id: "old-plan",
            state: "CANCELED",
            agent_session_id: "old-session",
          },
          {
            ...executionStep(),
            id: "old-revision-step",
            plan_revision: 2,
            state: "CANCELED",
            agent_session_id: "old-session",
          },
          {
            ...executionStep(),
            id: "current-canceled-step",
            workflow_index: 1,
            state: "CANCELED",
            agent_session_id: null,
          },
          executionStep(),
        ],
      });
    }
    if (path.endsWith("/muse-job")) {
      if (path.includes("/old-session/")) historicalSessionReads++;
      return respond(200, {
        job: {
          id: "job-1",
          workflow_step_id: "step-1",
          status: "TURN_FINISHED",
          attempts: 1,
          started_at: null,
          finished_at: null,
          failure_reason: null,
          github_repository: null,
          github_pull_number: null,
        },
      });
    }
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
  await page.getByRole("button", { name: "View approved plan", exact: true }).click();
  await page.getByRole("heading", { name: "Workflow Canvas", exact: true }).waitFor();
  await page.getByRole("button", { name: "Zoom in", exact: true }).waitFor();

  const scene = page.getByRole("region", { name: "Connected plan graph", exact: true });
  const nodes = page.locator(".workgraph-node");
  assert.equal(await page.getByText("PROJECT WORK GRAPH", { exact: true }).count(), 0);
  assert.equal(await page.getByText(/of \d+ steps completed/).count(), 0);
  await page.getByText("4 approved work items", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reload latest", exact: true }).count(), 0);
  assert.equal(await page.locator(".workgraph-footer, .orbit-plan-footer").count(), 0);
  await page
    .locator('[data-node-id="work:build"][data-execution-state="RUNNING"]')
    .waitFor({ state: "attached" });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".workgraph-node").length === 5 &&
      [...document.querySelectorAll(".workgraph-node")].every(
        (node) => getComputedStyle(node.parentElement).visibility === "visible",
      ),
  );
  async function rectangles() {
    return nodes.evaluateAll((cards) =>
      cards.map((card) => {
        const bounds = card.getBoundingClientRect();
        return {
          id: card.dataset.nodeId,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      }),
    );
  }
  async function assertNoOverlap() {
    const boxes = await rectangles();
    for (const [index, left] of boxes.entries())
      for (const right of boxes.slice(index + 1)) {
        assert.ok(
          left.x + left.width <= right.x + 1 ||
            right.x + right.width <= left.x + 1 ||
            left.y + left.height <= right.y + 1 ||
            right.y + right.height <= left.y + 1,
          `${left.id} overlaps ${right.id}`,
        );
      }
  }
  async function view() {
    return scene.evaluate((element) => ({
      x: Number(element.dataset.viewCenterX),
      y: Number(element.dataset.viewCenterY),
      scale: Number(element.dataset.viewScale),
    }));
  }
  async function settle() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  await settle();
  assert.equal(
    await page.locator('[data-node-id="work:build"] .workgraph-status').textContent(),
    "RUNNING",
    "One overall workflow status is shown even with current canceled steps",
  );
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Fit graph to view", exact: true }).click();
    await settle();
    await assertNoOverlap();
    const bounds = await scene.boundingBox();
    for (const box of await rectangles()) {
      assert.ok(box.x >= bounds.x && box.y >= bounds.y, "Fit includes the entire measured card");
      assert.ok(
        box.x + box.width <= bounds.x + bounds.width + 1 &&
          box.y + box.height <= bounds.y + bounds.height + 1,
      );
    }
    await page.screenshot({
      path: `/tmp/orbit-plan-canvas/graph-${viewport.width}.png`,
      fullPage: true,
    });
  }
  await scene.focus();
  const beforeKeyboard = await view();
  await scene.press("ArrowRight");
  await scene.press("ArrowDown");
  let after = await view();
  assert.ok(after.x > beforeKeyboard.x && after.y > beforeKeyboard.y);
  const bounds = await scene.boundingBox();
  await page.mouse.move(bounds.x + 15, bounds.y + 90);
  const beforeWheel = await view();
  await page.mouse.wheel(120, 90);
  await page.waitForFunction(
    (previous) =>
      Number(document.querySelector(".workgraph-scene").dataset.viewCenterX) !== previous,
    beforeWheel.x,
  );
  after = await view();
  assert.ok(
    after.x > beforeWheel.x && after.y > beforeWheel.y,
    "Two-axis trackpad scrolling pans the camera",
  );
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Shift");
  await page.waitForFunction(
    (previous) =>
      Number(document.querySelector(".workgraph-scene").dataset.viewCenterX) !== previous,
    after.x,
  );
  const shifted = await view();
  assert.equal(shifted.y, after.y, "Shift-wheel only pans horizontally");
  const previousZoom = shifted.scale;
  await scene.dispatchEvent("wheel", {
    deltaY: -30,
    ctrlKey: true,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
    bubbles: true,
    cancelable: true,
  });
  assert.ok((await view()).scale > previousZoom, "Trackpad pinch zoom changes scale");
  await assertNoOverlap();
  await page.getByRole("button", { name: "Reset canvas view", exact: true }).click();
  assert.equal((await view()).scale, 1);
  // Find empty canvas space rather than starting a gesture over a node or toolbar.
  const empty = await scene.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (let y = bounds.y + 90; y < bounds.bottom - 30; y += 40)
      for (let x = bounds.x + 30; x < bounds.right - 100; x += 50) {
        const target = document.elementFromPoint(x, y);
        if (target?.tagName === "CANVAS") return { x, y };
      }
    throw new Error("No empty canvas space found");
  });
  const beforeDrag = await view();
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 70, empty.y + 50, { steps: 8 });
  await page.mouse.up();
  const dragged = await view();
  assert.ok(
    dragged.x < beforeDrag.x && dragged.y < beforeDrag.y,
    "Dragging empty space pans both axes",
  );
  const stableCards = await rectangles();
  executionState = "CANCELED";
  const previousReads = executionReads;
  const previousHistoricalSessionReads = historicalSessionReads;
  await page.getByRole("button", { name: "Refresh execution status", exact: true }).click();
  assert.equal(await nodes.count(), 5, "Refresh retains the current graph while awaiting evidence");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-node-id="work:build"]')?.dataset.executionState === "CANCELED",
  );
  assert.ok(executionReads > previousReads);
  assert.equal(
    historicalSessionReads,
    previousHistoricalSessionReads,
    "Canvas refresh must not fetch old plan sessions",
  );
  await settle();
  assert.deepEqual(await view(), dragged, "Status refresh preserves pan and zoom");
  assert.deepEqual(await rectangles(), stableCards, "Status refresh preserves node geometry");
  await page.setViewportSize({ width: 1366, height: 768 });
  await settle();
  assert.deepEqual(await view(), dragged, "Resize preserves the user's camera view");
  await page.getByRole("button", { name: "Fit graph to view", exact: true }).click();
  await settle();
  await assertNoOverlap();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await settle();
  await assertNoOverlap();
  const card = await page.locator('[data-node-id="work:design"]').boundingBox();
  const beforeNodeGesture = await view();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 12, card.y + card.height / 2 + 8);
  assert.deepEqual(
    await view(),
    beforeNodeGesture,
    "A pointer gesture on a card never pans the camera",
  );
  await page.mouse.up();
  await page.getByRole("region", { name: "Work item configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  // A larger saved graph remains navigable without revealing nested workflow internals.
  graph.workItems.push(
    ...Array.from({ length: 12 }, (_, index) => ({
      key: `additional-${index}`,
      title: `Additional work item ${index}`,
      description: "A larger saved graph",
      dependsOn: ["build"],
      workflows: [],
    })),
  );
  await page.reload();
  await page.getByRole("button", { name: /private-4 Created/ }).click();
  await page.getByRole("button", { name: "View approved plan", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".workgraph-node").length === 17 &&
      [...document.querySelectorAll(".workgraph-node")].every(
        (node) => getComputedStyle(node.parentElement).visibility === "visible",
      ),
  );
  await page.getByRole("button", { name: "Fit graph to view", exact: true }).click();
  await settle();
  await assertNoOverlap();
  assert.equal(
    await page
      .locator(
        '[data-node-id^="workflow:"], [data-node-id^="step:"], [data-node-id^="gate:"], [data-node-id^="agent:"]',
      )
      .count(),
    0,
    "Main canvas contains work items only",
  );
  await page.locator('[data-node-id="work:design"]').click();
  await page.getByRole("region", { name: "Work item configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.getByText("Accessible node list", { exact: true }).click();
  const accessibleNode = page.getByRole("button", { name: /Work design · work/ });
  await accessibleNode.focus();
  await accessibleNode.press("Enter");
  await page.getByRole("region", { name: "Work item configuration", exact: true }).waitFor();
  assert.equal(
    mutations.length,
    0,
    "Layout, navigation, refresh and selection must not mutate or execute plans",
  );
  console.log(
    "Measured graph geometry, branching dependencies, two-axis pan, pinch/toolbar zoom, fit/reset, resize, stable status refresh and accessible selection passed at 1366×768 and 1920×1080.",
  );
} finally {
  await browser.close();
}
