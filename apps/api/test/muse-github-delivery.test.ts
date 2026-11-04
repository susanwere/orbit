import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRepairPreservesDependencies,
  MuseGithubDeliveryService,
} from "../src/modules/execution/muse-github-delivery.js";

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

async function deliverFixture(
  options: {
    repair?: boolean;
    staleRepairHead?: boolean;
    reportedPaths?: string[];
    headMismatch?: boolean;
    checkoutOrigin?: string;
  } = {},
) {
  process.env.ORBIT_MUSE_ISOLATED_WORKER = "true";
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "orbit-delivery-test-")));
  await mkdir(join(workspace, "src"));
  await writeFile(
    join(workspace, "src/App.tsx"),
    "export default function App() { return <h1>Hello!</h1>; }",
  );
  const baseSha = "a".repeat(40),
    headSha = "b".repeat(40);
  const commands: string[][] = [];
  const bindings: unknown[][] = [];
  let committed = false,
    staged = false;
  let githubRequests = 0;
  const service = new MuseGithubDeliveryService(
    {
      query: async (sql: string, parameters: unknown[]) => {
        if (sql.startsWith("UPDATE")) {
          bindings.push(parameters);
          return { rows: [{ id: job.id }] };
        }
        expect(sql).toContain("plan.revision=step.plan_revision");
        expect(sql).toContain("step.agent_session_id=session.id");
        expect(sql).toContain("job.delivery_state='RUNNING'");
        return {
          rows: [
            {
              ...job,
              changed_paths: options.reportedPaths ?? ["src/App.tsx"],
              ...(options.repair
                ? {
                    repair_source_job_id: "prior-job",
                    repair_pull_number: 42,
                    repair_head_sha: baseSha,
                    repair_repository: "owner/repo",
                  }
                : {}),
            },
          ],
        };
      },
    } as never,
    "test-token",
    async (args) => {
      commands.push(args);
      if (args[0] === "remote")
        return options.checkoutOrigin ?? "https://github.com/owner/repo.git";
      if (args[0] === "rev-parse") return committed ? headSha : baseSha;
      if (args[0] === "ls-files") return args.includes("--deleted") ? "" : "src/App.tsx\0";
      if (args[0] === "branch") return "orbit/muse-prior-job";
      if (args[0] === "diff") return staged ? "src/App.tsx\0" : "";
      if (args[0] === "add") staged = true;
      if (args.includes("commit")) committed = true;
      return "";
    },
    async (url, request) => {
      githubRequests++;
      if (options.repair) {
        expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/42");
        expect(request?.method).not.toBe("POST");
        return new Response(
          JSON.stringify({
            number: 42,
            state: "open",
            draft: true,
            merged_at: null,
            head: {
              sha:
                committed && (!options.staleRepairHead || githubRequests > 2) ? headSha : baseSha,
              ref: "orbit/muse-prior-job",
              repo: { full_name: "owner/repo" },
            },
            base: { repo: { full_name: "owner/repo" } },
          }),
        );
      }
      expect(url).toBe("https://api.github.com/repos/owner/repo/pulls");
      expect(request?.method).toBe("POST");
      expect(JSON.parse(String(request?.body))).toMatchObject({
        head: "orbit/muse-job1",
        base: "main",
      });
      return new Response(
        JSON.stringify({
          number: 42,
          draft: true,
          head: { sha: options.headMismatch ? "c".repeat(40) : headSha },
        }),
      );
    },
  );
  return {
    commands,
    bindings,
    workspace,
    baseSha,
    headSha,
    githubRequests: () => githubRequests,
    run: () =>
      service.deliver({
        jobId: job.id,
        projectId: job.project_id,
        workspace,
        baseBranch: "main",
        expectedBaseSha: baseSha,
      }),
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

describe("generated change delivery with stub GitHub", () => {
  it("commits and pushes validated files and records the independently returned PR head", async () => {
    const fixture = await deliverFixture();
    try {
      await expect(fixture.run()).resolves.toEqual({
        jobId: "job1",
        repository: "owner/repo",
        pullNumber: 42,
        headSha: fixture.headSha,
      });
      expect(fixture.commands).toContainEqual([
        "push",
        "origin",
        "HEAD:refs/heads/orbit/muse-job1",
      ]);
      expect(fixture.bindings).toEqual([
        ["job1", "project", "owner/repo", 42, fixture.headSha, "org", "DRAFT"],
      ]);
      expect(fixture.githubRequests()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
  it("updates the original PR branch for a pinned CI repair without creating another PR", async () => {
    const fixture = await deliverFixture({ repair: true });
    try {
      await expect(fixture.run()).resolves.toMatchObject({
        pullNumber: 42,
        headSha: fixture.headSha,
      });
      expect(fixture.commands).toContainEqual([
        "push",
        "origin",
        "HEAD:refs/heads/orbit/muse-prior-job",
      ]);
      expect(fixture.commands.some((args) => args.includes("-b"))).toBe(false);
      expect(fixture.githubRequests()).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });
  it("refuses files that differ from the retained turn before any push", async () => {
    const fixture = await deliverFixture({ reportedPaths: ["src/Other.tsx"] });
    try {
      await expect(fixture.run()).rejects.toMatchObject({ code: "invalid_state" });
      expect(fixture.commands.some((args) => args[0] === "push")).toBe(false);
      expect(fixture.githubRequests()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
  it("does not record a PR whose returned head differs from the delivered commit", async () => {
    const fixture = await deliverFixture({ headMismatch: true });
    try {
      await expect(fixture.run()).rejects.toMatchObject({ code: "invalid_state" });
      expect(fixture.bindings).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

it("rechecks a temporarily stale repaired PR head without pushing twice", async () => {
  const fixture = await deliverFixture({ repair: true, staleRepairHead: true });
  try {
    await expect(fixture.run()).resolves.toMatchObject({ headSha: fixture.headSha });
    expect(fixture.githubRequests()).toBe(3);
    expect(fixture.commands.filter((command) => command[0] === "push")).toHaveLength(1);
    expect(fixture.bindings).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

describe("CI repairs preserve declared dependencies", () => {
  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
    "rejects removal from %s",
    (category) => {
      expect(() =>
        assertRepairPreservesDependencies(
          JSON.stringify({ [category]: { vitest: "^4.0.0" } }),
          "{}",
        ),
      ).toThrow("CI repair removed a declared dependency");
    },
  );
  it("allows compatible version repairs and additional dependencies", () => {
    expect(() =>
      assertRepairPreservesDependencies(
        JSON.stringify({ devDependencies: { vitest: "^4.0.0" } }),
        JSON.stringify({ devDependencies: { vitest: "^4.0.1", typescript: "^5.0.0" } }),
      ),
    ).not.toThrow();
  });
});
