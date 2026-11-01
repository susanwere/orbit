import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@orbit/domain";
import { buildApp } from "../src/app.js";

async function taskApp() {
  const calls: unknown[] = [];
  const app = await buildApp({
    tasks: {
      auth: {
        verify: (header: string | undefined) => {
          if (header !== "******") throw new DomainError("unauthenticated", "Missing token");
          return { id: "human-1" };
        },
      } as never,
      tasks: {
        initialize: async () => [{ id: "task-1", title: "Build list" }],
        update: async (input: unknown) => {
          calls.push(["update", input]);
          return { id: "task-1", revision: 2 };
        },
        add: async (input: unknown) => {
          calls.push(["add", input]);
          return { existingTaskId: "task-1", task: null };
        },
      } as never,
      execution: {
        execute: async (input: unknown) => {
          calls.push(["execute", input]);
          return { taskId: "task-1", state: "ACTIVE" };
        },
      } as never,
    },
  });
  return { app, calls };
}

describe("prompt-first task routes", () => {
  it("requires authentication and forwards execute as the single authorization", async () => {
    const { app, calls } = await taskApp();
    const denied = await app.inject({ method: "GET", url: "/projects/project-1/tasks" });
    expect(denied.statusCode).toBe(401);

    const listed = await app.inject({
      method: "GET",
      url: "/projects/project-1/tasks",
      headers: { authorization: "******" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks).toHaveLength(1);

    const executed = await app.inject({
      method: "POST",
      url: "/projects/project-1/tasks/task-1/execute",
      headers: { authorization: "******" },
      payload: { agentDefinitionId: "muse_code_project-1" },
    });
    expect(executed.statusCode).toBe(202);
    expect(calls).toContainEqual([
      "execute",
      {
        projectId: "project-1",
        taskId: "task-1",
        principalId: "human-1",
        agentDefinitionId: "muse_code_project-1",
      },
    ]);
    await app.close();
  });

  it("rejects execute without an agent and edits with a stale payload shape", async () => {
    const { app, calls } = await taskApp();
    const missingAgent = await app.inject({
      method: "POST",
      url: "/projects/project-1/tasks/task-1/execute",
      headers: { authorization: "******" },
      payload: {},
    });
    expect(missingAgent.statusCode).toBe(400);
    const badEdit = await app.inject({
      method: "PATCH",
      url: "/projects/project-1/tasks/task-1",
      headers: { authorization: "******" },
      payload: { revision: "1", title: "x", prompt: "y" },
    });
    expect(badEdit.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("returns the existing task when Muse Spark deduplicates a new request", async () => {
    const { app } = await taskApp();
    const drafted = await app.inject({
      method: "POST",
      url: "/projects/project-1/tasks",
      headers: { authorization: "******" },
      payload: { request: "Build the list again" },
    });
    expect(drafted.statusCode).toBe(200);
    expect(drafted.json()).toEqual({ existingTaskId: "task-1", task: null });
    await app.close();
  });

  it("validates the task drafter contract used for dedupe", async () => {
    const { MuseSparkTaskDrafter } = await import("../src/modules/tasks/task-drafter.js");
    const drafter = new MuseSparkTaskDrafter({
      complete: vi.fn(async () => ({
        title: "Duplicate",
        prompt: "Already covered",
        existingTaskId: "task-existing",
        dependencyKeys: [],
      })),
    });
    const draft = await drafter.draft({
      request: "do it again",
      originalIntent: "Build",
      projectContext: {},
      tasks: [{ id: "task-existing", task_key: "a", title: "A", prompt: "A", state: "DRAFT" }],
    });
    expect(draft.existingTaskId).toBe("task-existing");
  });
});
