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
    expect(calls).toEqual([{ projectId: "project", sessionId: "session", principalId: "human" }]);
    await app.close();
  });
});
