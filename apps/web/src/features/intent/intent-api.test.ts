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
