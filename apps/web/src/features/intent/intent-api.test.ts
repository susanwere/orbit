import { describe, expect, it, vi } from "vitest";
import { createIntentApi } from "./intent-api.js";

describe("intent API authorization and durable intent", () => {
  it("writes versioned edits and requests explicit human approval separately", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            plan: { id: "plan", revision: 2, status: "READY_FOR_REVIEW" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            plan: { id: "plan", revision: 3, status: "APPROVED" },
          }),
          { status: 200 },
        ),
      );
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    const content = { summary: "Reviewed plan" };
    expect((await api.updatePlan("project-1", 1, content)).revision).toBe(2);
    expect((await api.approvePlan("project-1", 2)).status).toBe("APPROVED");
    expect(send.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(send.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        expectedRevision: 1,
        content,
      }),
    );
    expect(send.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        expectedRevision: 2,
      }),
    );
  });

  it("reads existing intent and plan with the current authenticated principal", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ intent: { id: "intent-1", statement: "Build jobs" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: { id: "plan-1", status: "READY_FOR_REVIEW" } }), {
          status: 200,
        }),
      );
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    expect((await api.getIntent("project-1"))?.statement).toBe("Build jobs");
    expect((await api.getPlan("project-1"))?.status).toBe("READY_FOR_REVIEW");
    expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer signed",
    });
  });

  it("submits exactly the original user statement and requests planning separately", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ intent: { id: "intent", statement: "Build jobs" } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: { id: "plan", status: "READY_FOR_REVIEW" } }), {
          status: 201,
        }),
      );
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    expect((await api.submitIntent("project-1", "Build jobs")).statement).toBe("Build jobs");
    expect((await api.generatePlan("project-1")).status).toBe("READY_FOR_REVIEW");
    expect(send.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ statement: "Build jobs" }));
    expect(send.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("preserves 503 provider failures for meaningful retry and does not revoke valid 403 sessions", async () => {
    const onUnauthorized = vi.fn();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Muse planning is not configured." }), {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send, {
      onUnauthorized,
    });
    await expect(api.generatePlan("project")).rejects.toMatchObject({
      status: 503,
      message: "Muse planning is not configured.",
    });
    await expect(api.getIntent("project")).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("signs out only the authorization used for expired requests", async () => {
    const onUnauthorized = vi.fn();
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send, {
      onUnauthorized,
    });
    await expect(api.getPlan("project")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith("Bearer signed");
  });
  it("sends expected revision for edits and approval, without dispatching execution", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: { id: "p", revision: 3 } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: { id: "p", revision: 4, status: "APPROVED" } }), {
          status: 200,
        }),
      );
    const api = createIntentApi("http://localhost:4000", () => "Bearer valid", fetchImpl);
    const graph = {
      summary: "Build a jobs viewer",
      workItems: [],
      guardrails: [],
      decisionsToReview: [],
      assumptions: [],
    };
    await api.updatePlan("project-1", 2, graph);
    await api.approvePlan("project-1", 3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: 2,
      content: graph,
    });
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 3 });
  });
});

describe("existing project repository registration", () => {
  it("connects and discovers the repository using authenticated project endpoints", async () => {
    const repository = {
      id: "repo-1",
      project_id: "existing-project",
      full_name: "susanwere/private-test",
    };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repositories: [repository] })));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    expect(await api.connectRepository("existing-project", "susanwere/private-test")).toEqual(
      repository,
    );
    expect(await api.getRepositories("existing-project")).toEqual([repository]);
    expect(send.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/projects/existing-project/repositories",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer signed" },
      body: JSON.stringify({ repository: "susanwere/private-test" }),
    });
    expect(send.mock.calls[1]?.[1]?.method).toBe("GET");
  });
});

describe("authenticated human output review", () => {
  it("allows approval without sending a comment", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.reviewOutput("project", "proposal-step", "a".repeat(64));
    await api.completeHumanReview("project", "human-step");
    expect(send.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ outputHash: "a".repeat(64) }));
    expect(send.mock.calls[1]?.[1]?.body).toBe("{}");
  });

  it("sends explicit proposal designation, exact output hash and human decision separately", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.authorizeProposalReview("project", "step:one");
    await api.reviewOutput("project", "step:one", "a".repeat(64), "Use simultaneous greetings");
    await api.completeHumanReview("project", "step:two", "Approved final wording");
    expect(send.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/projects/project/execution/steps/step%3Aone/authorize-proposal-review",
    );
    expect(send.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ acknowledgeNonCodeStep: true }));
    expect(send.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ outputHash: "a".repeat(64), note: "Use simultaneous greetings" }),
    );
    expect(send.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ note: "Approved final wording" }));
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls)
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer signed" });
  });
});

describe("queued session replacement", () => {
  it("retires the exact unstarted job and authorizes retry without starting another session", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.retireUnstartedJob("project", "step", "job-1");
    await api.authorizeExecutionRetry("project", "step");
    expect(send.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/projects/project/execution/steps/step/retire-unstarted-job",
    );
    expect(send.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ jobId: "job-1", acknowledgeReplacement: true }),
    );
    expect(send.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ acknowledgeFailedAttempt: true }));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("browser local execution", () => {
  it("explicitly requests local execution through the existing authenticated dispatch endpoint", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 202 }));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.dispatchMuse("project", "session");
    expect(send.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/projects/project/agent-sessions/session/dispatch-muse",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ executeLocally: true }),
      headers: { Authorization: "Bearer signed" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("explicit GitHub delivery request", () => {
  it("sends exact reviewed job and push consent through the authenticated API", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.requestDelivery("project", "step:one", "musejob-test", "a".repeat(64));
    expect(send.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/projects/project/execution/steps/step%3Aone/request-delivery",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer signed" },
      body: JSON.stringify({
        jobId: "musejob-test",
        outputHash: "a".repeat(64),
        acknowledgePush: true,
      }),
    });
  });
});

describe("CI inspection and fresh repair authorization", () => {
  it("shares exact failure identity and carries the source job into a fresh session", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ session: { id: "new-repair-session" } })),
      );
    const api = createIntentApi("http://localhost:4000", () => "Bearer signed", send);
    await api.inspectGithubCi("project", "step:one", "failed-job");
    await api.prepareCiRepair("project", "step:one", "failed-job");
    expect(
      await api.createAgentSession("project", "agent", "work", "Repair CI", "failed-job"),
    ).toBe("new-repair-session");
    expect(send.mock.calls[0]?.[0]).toContain("/step%3Aone/inspect-github-ci");
    expect(send.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ jobId: "failed-job", acknowledgeRepair: true }),
    );
    expect(send.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        agentDefinitionId: "agent",
        workItemId: "work",
        mission: "Repair CI",
        repairSourceJobId: "failed-job",
      }),
    );
    for (const call of send.mock.calls)
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer signed" });
  });
});
