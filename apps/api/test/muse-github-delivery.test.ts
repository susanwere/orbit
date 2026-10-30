import { afterEach, describe, expect, it } from "vitest";
import { MuseGithubDeliveryService } from "../src/modules/execution/muse-github-delivery.js";

afterEach(() => {
  delete process.env.ORBIT_MUSE_ISOLATED_WORKER;
});

const job = {
  id: "job1",
  organization_id: "org",
  project_id: "project",
  agent_session_id: "session",
  workflow_step_id: "step",
  status: "TURN_FINISHED",
  allowed_repositories: ["owner/repo"],
  allowed_paths: ["src/**"],
};

describe("trusted Muse GitHub delivery", () => {
  it("refuses delivery on an API host before contacting GitHub", async () => {
    let queries = 0;
    const service = new MuseGithubDeliveryService(
      {
        query: async () => {
          queries++;
          return { rows: [job] };
        },
      } as never,
      "test-token",
    );
    await expect(
      service.deliver({
        jobId: "job1",
        projectId: "project",
        workspace: "/tmp/checkout",
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(queries).toBe(0);
  });

  it("rejects an untrusted checkout origin before writing code", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const commands: string[][] = [];
    const service = new MuseGithubDeliveryService(
      { query: async () => ({ rows: [job] }) } as never,
      "test-token",
      async (args) => {
        commands.push(args);
        return "https://github.com/attacker/repo.git\n";
      },
    );
    await expect(
      service.deliver({
        jobId: "job1",
        projectId: "project",
        workspace: "/tmp/checkout",
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(commands).toEqual([["remote", "get-url", "origin"]]);
  });

  it("rejects a job that is not independently eligible for delivery", async () => {
    process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
    const service = new MuseGithubDeliveryService(
      {
        query: async (sql: string) => {
          expect(sql).toContain("job.status='TURN_FINISHED'");
          expect(sql).toContain("gate.status='OPEN'");
          expect(sql).toContain("job.github_repository IS NULL");
          return { rows: [] };
        },
      } as never,
      "test-token",
    );
    await expect(
      service.deliver({
        jobId: "job1",
        projectId: "project",
        workspace: "/tmp/checkout",
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
