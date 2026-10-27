import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Orbit API demo flow", () => {
  it("creates an initiative, proposes a plan, and approves it into work items", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/initiatives",
      payload: {
        title: "Interview Capture & Debrief (CareerGlyph)",
        intent: "Build interview capture with explicit consent, microphone and system audio, recovery when devices change, transcription, and a structured interview debrief.",
      },
    });
    expect(created.statusCode).toBe(201);
    const initiative = created.json();

    const planned = await app.inject({ method: "POST", url: `/initiatives/${initiative.id}/plan` });
    expect(planned.statusCode).toBe(200);
    const plan = planned.json();
    expect(plan.planner).toMatchObject({ provider: "meta", model: "muse-spark", mode: "stub" });
    expect(plan.workItems.length).toBeGreaterThanOrEqual(3);
    expect(plan.detectedDecisionIds).toContain("dec_consent");
    expect(plan.workItems[0].workflows.length).toBeGreaterThanOrEqual(3);

    const approved = await app.inject({ method: "POST", url: `/initiatives/${initiative.id}/approve-plan` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().workItemIds.length).toBe(plan.workItems.length);

    const fetched = await app.inject({ method: "GET", url: `/initiatives/${initiative.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().workItems[0].key).toMatch(/^CG-/);
    expect(fetched.json().workItems[0].workflows.length).toBeGreaterThanOrEqual(3);
    await app.close();
  });

  it("rejects an initiative without intent", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/initiatives", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("agent execution and human gate", () => {
  async function setupApprovedPlan() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/initiatives",
      payload: {
        title: "Interview Capture & Debrief (CareerGlyph)",
        intent: "Build interview capture with explicit consent, microphone and system audio, recovery when devices change, transcription, and a structured interview debrief.",
      },
    });
    const initiative = created.json();
    await app.inject({ method: "POST", url: `/initiatives/${initiative.id}/plan` });
    await app.inject({ method: "POST", url: `/initiatives/${initiative.id}/approve-plan` });
    const fetched = await app.inject({ method: "GET", url: `/initiatives/${initiative.id}` });
    const recorder = fetched.json().workItems[0];
    const impl = recorder.workflows.find((w: { type: string }) => w.type === "implementation");
    const step = impl.steps.find((s: { kind: string }) => s.kind === "ai");
    return { app, stepId: step.id as string };
  }

  it("starts a scoped session, triggers API-04 gate, and resumes on approval", async () => {
    const { app, stepId } = await setupApprovedPlan();
    const started = await app.inject({ method: "POST", url: `/workflow-steps/${stepId}/execute` });
    expect(started.statusCode).toBe(201);
    const record = started.json();
    expect(record.session.state).toBe("waiting");
    expect(record.snapshot.decisionIds).toContain("dec_consent");
    expect(record.contract.allowedPaths).toContain("src/recorder/**");
    expect(record.gate.state).toBe("open");

    const resolved = await app.inject({
      method: "POST",
      url: `/gates/${record.gate.id}/resolve`,
      payload: { decision: "approved" },
    });
    expect(resolved.statusCode).toBe(200);
    const done = resolved.json();
    expect(done.session.state).toBe("completed");
    expect(done.evidence.some((e: { category: string; result: string }) => e.category === "test" && e.result === "passed")).toBe(true);
    await app.close();
  });

  it("blocks the workflow when the gate is rejected", async () => {
    const { app, stepId } = await setupApprovedPlan();
    const started = await app.inject({ method: "POST", url: `/workflow-steps/${stepId}/execute` });
    const { gate } = started.json();
    const resolved = await app.inject({
      method: "POST",
      url: `/gates/${gate.id}/resolve`,
      payload: { decision: "rejected" },
    });
    expect(resolved.json().session.state).toBe("failed");
    await app.close();
  });

  it("denies agent-definition creation for non-admin members", async () => {
    const app = await buildApp();
    const denied = await app.inject({
      method: "POST",
      url: "/agent-definitions",
      headers: { "x-principal-id": "usr_alex" },
      payload: { name: "Rogue agent" },
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/agent-definitions",
      payload: { name: "QA Reviewer — Muse Spark", model: "muse-spark" },
    });
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });
});

describe("empty JSON body tolerance", () => {
  it("accepts POST /plan with a JSON content-type but no body (browser fetch behavior)", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/initiatives",
      payload: { title: "t", intent: "Build interview capture with explicit consent" },
    });
    const planned = await app.inject({
      method: "POST",
      url: `/initiatives/${created.json().id}/plan`,
      headers: { "content-type": "application/json" },
    });
    expect(planned.statusCode).toBe(200);
    await app.close();
  });
});
