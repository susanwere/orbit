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
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
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

  await page.route(`${apiOrigin}/projects/project-1/intent`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    assert.equal(route.request().headers().authorization, "Bearer ci-orbit-access-token");
    if (method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({ intent: null }),
      });
      return;
    }
    assert.equal(
      route.request().postDataJSON().statement,
      "Build a responsive Hacker News jobs viewer.",
    );
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        intent: {
          id: "original-intent-1",
          project_id: "project-1",
          statement: "Build a responsive Hacker News jobs viewer.",
        },
      }),
    });
  });

  const proposal = {
    summary: "Build a responsive Hacker News jobs viewer",
    workItems: [
      {
        key: "HN-1",
        title: "Job list",
        description: "Render a responsive jobs list with accessible navigation",
        dependsOn: [],
        workflows: [
          {
            name: "Design",
            steps: [{ title: "Review job list", executor: "human", requiresApproval: true }],
          },
          {
            name: "Engineering",
            steps: [{ title: "Implement list", executor: "agent", requiresApproval: false }],
          },
        ],
      },
    ],
    guardrails: ["Accessible keyboard navigation"],
    decisionsToReview: ["Choose pagination"],
    assumptions: ["Existing React project"],
  };
  let approved = false;
  let revision = 1;
  await page.route(`${apiOrigin}/projects/project-1/plan/approve`, async (route) => {
    assert.equal(route.request().headers().authorization, "Bearer ci-orbit-access-token");
    assert.equal(route.request().postDataJSON().expectedRevision, revision);
    approved = true;
    revision++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        plan: {
          id: "proposed-plan-1",
          project_id: "project-1",
          status: "APPROVED",
          revision,
          content: proposal,
        },
      }),
    });
  });
  await page.route(`${apiOrigin}/projects/project-1/plan`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    assert.equal(route.request().headers().authorization, "Bearer ci-orbit-access-token");
    if (method === "PATCH") {
      const body = route.request().postDataJSON();
      assert.equal(body.expectedRevision, revision);
      assert.equal(body.content.workItems[0].title, "Responsive job list");
      proposal.workItems[0].title = body.content.workItems[0].title;
      revision++;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        plan:
          method === "GET"
            ? null
            : {
                id: "proposed-plan-1",
                project_id: "project-1",
                status: approved ? "APPROVED" : "READY_FOR_REVIEW",
                revision,
                content: proposal,
              },
      }),
    });
  });

  await page.route(`${apiOrigin}/projects/project-1/repositories`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({ repositories: [] }),
    });
  });

  await page.goto(frontendOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Sign in to Orbit" }).waitFor();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  await page.getByRole("button", { name: "View projects" }).click();
  await page.getByRole("heading", { name: "Start with intent." }).waitFor();

  await page.getByLabel("Project name").fill("HN Jobs Viewer");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
  await page.getByLabel("Your original intent").fill("Build a responsive Hacker News jobs viewer.");
  await page.getByRole("button", { name: "Save intent & propose plan" }).click();
  await page.getByText("Proposed plan ready").waitFor();
  await page.getByRole("button", { name: "Review proposed plan" }).click();
  await page.getByRole("heading", { name: "Review the proposed plan." }).waitFor();
  await page.getByLabel("Work item title").fill("Responsive job list");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByText("Plan approved by a human.").waitFor();

  await page.screenshot({
    path: "docs/images/orbit-authenticated-project-creation.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to Orbit" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "View projects" }).count(), 0);

  console.log(
    "Mocked browser sign-in, protected project and Intent planning, and sign-out passed.",
  );
} finally {
  await browser.close();
}
