import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";

describe("authenticated Muse dispatch queue", () => {
  it("queues exactly one backend-authorized job without invoking a provider", async () => {
    const calls: unknown[] = [];
    const app = await buildApp({
      agentSessions: {
        auth: {
          verify: (header: string | undefined) => {
            if (header !== "Bearer valid")
              throw new DomainError("unauthenticated", "Missing token");
            return { id: "human" };
          },
        } as never,
        service: {} as never,
        museJobs: {
          enqueue: async (input: unknown) => {
            calls.push(input);
            return { id: "job", status: "QUEUED" };
          },
        } as never,
      },
    });
    const route = "/projects/project/agent-sessions/session/dispatch-muse";
    const denied = await app.inject({ method: "POST", url: route });
    expect(denied.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    const accepted = await app.inject({
      method: "POST",
      url: route,
      headers: { authorization: "Bearer valid" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().job.status).toBe("QUEUED");
    expect(calls).toEqual([
      { projectId: "project", sessionId: "session", principalId: "human", executeLocally: false },
    ]);
    const invalid = await app.inject({
      method: "POST",
      url: route,
      headers: { authorization: "Bearer valid" },
      payload: { executeLocally: "true" },
    });
    expect(invalid.statusCode).toBe(400);
    const local = await app.inject({
      method: "POST",
      url: route,
      headers: { authorization: "Bearer valid" },
      payload: { executeLocally: true },
    });
    expect(local.statusCode).toBe(202);
    expect(calls[1]).toEqual({
      projectId: "project",
      sessionId: "session",
      principalId: "human",
      executeLocally: true,
    });
    await app.close();
  });
});

describe("authenticated execution activity reads", () => {
  it("authenticates before returning activity and delegates exact project/session scoping", async () => {
    const calls: unknown[] = [];
    const app = await buildApp({
      agentSessions: {
        auth: {
          verify: (header: string | undefined) => {
            if (header !== "Bearer valid")
              throw new DomainError("unauthenticated", "Missing token");
            return { id: "human" };
          },
        } as never,
        service: {} as never,
        museJobs: {
          getStatus: async (input: unknown) => {
            calls.push(input);
            return {
              id: "job",
              activity: [{ id: "1", message: "Muse is using an execution tool." }],
            };
          },
        } as never,
      },
    });
    const url = "/projects/project/agent-sessions/session/muse-job";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.activity).toHaveLength(1);
    expect(calls).toEqual([{ projectId: "project", sessionId: "session", principalId: "human" }]);
    await app.close();
  });
});
