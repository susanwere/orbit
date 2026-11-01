import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";

function fixture(authorized = true) {
  let materialized = 0;
  let queried = 0;
  const app = buildApp({
    workflowSteps: {
      auth: {
        verify: (header: string | undefined) => {
          if (!header) throw new DomainError("unauthenticated", "Missing token");
          return { id: "human" };
        },
      } as never,
      authorization: {
        authorize: async () => {
          if (!authorized) throw new Error("Forbidden");
          return { projectId: "project", organizationId: "org", role: "member" };
        },
      } as never,
      db: {
        query: async (sql: string, params: unknown[]) => {
          expect(sql).toContain("AS blocker_reason");
          expect(sql).toContain("prerequisite_incomplete");
          expect(sql).toContain("human_approval_required");
          expect(sql).toContain("human_gate_open");
          expect(sql).toContain("agent_session_required");
          queried++;
          expect(params).toEqual(["project", "org"]);
          return { rows: [{ id: "step", state: "BLOCKED" }] };
        },
      } as never,
      binding: { bind: async () => ({ id: "step", agent_session_id: "session" }) } as never,
      execution: {
        approve: async () => ({ id: "step", approved_by_principal_id: "human" }),
        retireUnstartedJob: async () => ({ stepId: "step", state: "FAILED" }),
        authorizeRetry: async () => ({ id: "step", state: "BLOCKED", agent_session_id: null }),
      } as never,
      materializer: {
        materialize: async (projectId: string, principalId: string) => {
          materialized++;
          expect(projectId).toBe("project");
          expect(principalId).toBe("human");
          return { planId: "plan", stepCount: 3 };
        },
      } as never,
    },
  });
  return {
    app,
    get queried() {
      return queried;
    },
    get materialized() {
      return materialized;
    },
  };
}

describe("workflow step routes", () => {
  it("authenticates every new review action before reading or changing a step", async () => {
    const testFixture = fixture();
    const app = await testFixture.app;
    for (const action of [
      "authorize-proposal-review",
      "review-output",
      "complete-human-review",
      "request-delivery",
      "verify-github-ci",
      "inspect-github-ci",
      "prepare-ci-repair",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/projects/project/execution/steps/step/${action}`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(testFixture.queried).toBe(0);
    await app.close();
  });
  it("reports missing independent CI credentials without completing the step", async () => {
    const testFixture = fixture();
    const app = await testFixture.app;
    const response = await app.inject({
      method: "POST",
      url: "/projects/project/execution/steps/step/verify-github-ci",
      headers: { authorization: "Bearer token" },
      payload: { repository: "susanwere/private-test", runId: 123, pullNumber: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("ORBIT_GITHUB_EVIDENCE_TOKEN");
    expect(testFixture.queried).toBe(0);
    await app.close();
  });
  it("requires explicit push consent before recording delivery", async () => {
    const testFixture = fixture();
    const app = await testFixture.app;
    for (const payload of [
      {},
      { jobId: "job", outputHash: "hash" },
      { jobId: 42, outputHash: "hash", acknowledgePush: true },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/projects/project/execution/steps/step/request-delivery",
            headers: { authorization: "Bearer token" },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(testFixture.queried).toBe(0);
    await app.close();
  });
  it("requires explicit acknowledgment and an exact job ID for queued-session retirement", async () => {
    const testFixture = fixture();
    const app = await testFixture.app;
    const url = "/projects/project/execution/steps/step/retire-unstarted-job";
    const headers = { authorization: "Bearer token" };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { jobId: "musejob_4a560794-a548-4f63-b11e-398e22414306" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { jobId: "bad", acknowledgeReplacement: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: {
            jobId: "musejob_4a560794-a548-4f63-b11e-398e22414306",
            acknowledgeReplacement: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("binds a scoped session through authenticated route", async () => {
    const f = fixture();
    const app = await f.app;
    const response = await app.inject({
      method: "POST",
      url: "/projects/project/execution/steps/step/bind-session",
      headers: { authorization: "Bearer token" },
      payload: { sessionId: "session" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().step.agent_session_id).toBe("session");
    await app.close();
  });

  it("rejects missing session identifier", async () => {
    const f = fixture();
    const app = await f.app;
    const response = await app.inject({
      method: "POST",
      url: "/projects/project/execution/steps/step/bind-session",
      headers: { authorization: "Bearer token" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation");
    await app.close();
  });

  it("records authenticated explicit step approval", async () => {
    const f = fixture();
    const app = await f.app;
    const response = await app.inject({
      method: "POST",
      url: "/projects/project/execution/steps/step/approve",
      headers: { authorization: "Bearer token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().step.approved_by_principal_id).toBe("human");
    await app.close();
  });
  it("requires explicit human acknowledgment before resetting a failed step", async () => {
    const f = fixture();
    const app = await f.app;
    const url = "/projects/project/execution/steps/step/authorize-retry";
    const missing = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer token" },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const authorized = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer token" },
      payload: { acknowledgeFailedAttempt: true },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().step.state).toBe("BLOCKED");
    await app.close();
  });

  it("prepares approved plan records only through authenticated service", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "POST",
      url: "/projects/project/execution/prepare",
      headers: { authorization: "Bearer token" },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ planId: "plan", stepCount: 3 });
    expect(f.materialized).toBe(1);
    await app.close();
  });

  it("returns server-derived step states without allowing state mutation", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "GET",
      url: "/projects/project/execution/steps",
      headers: { authorization: "Bearer token" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ steps: [{ id: "step", state: "BLOCKED" }] });
    expect(f.queried).toBe(1);
    await app.close();
  });

  it("does not prepare or read without authentication", async () => {
    const f = fixture();
    const app = await f.app;
    const result = await app.inject({
      method: "POST",
      url: "/projects/project/execution/prepare",
    });
    expect(result.statusCode).toBe(401);
    expect(f.materialized).toBe(0);
    await app.close();
  });
});
