/** Trusted local operator command. Runs delivery only for a separately authorized request. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, lstat, readFile, writeFile, unlink, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PgDatabase } from "@orbit/db";
import {
  parseLocalWorkerPolicy,
  type LocalWorkerPolicy,
} from "./modules/execution/local-worker-policy.js";
import {
  permittedRepositoryPath,
  validRepositoryPattern,
} from "./modules/execution/repository-path-policy.js";

const runCommand = promisify(execFile);
const repository = "susanwere/private-test";
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const jobId = process.argv.find((argument) => argument.startsWith("--job="))?.slice(6);
const mode = process.argv[2];
const gitEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function main() {
  if (
    !["prepare", "check", "execute", "recover", "deliver"].includes(mode ?? "") ||
    !jobId ||
    !/^musejob_[A-Za-z0-9-]{20,80}$/.test(jobId) ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Use npm run muse:local -- prepare|check|execute|recover|deliver --job=musejob_<uuid> with DATABASE_URL configured.",
    );
  const jobDirectory = join(repositoryRoot, ".orbit-local", jobId);
  const checkout = join(jobDirectory, "checkout");
  const policyFilePath = join(jobDirectory, "policy.json");
  const composeOverridePath = join(jobDirectory, "compose.json");
  const database = new PgDatabase(process.env.DATABASE_URL);
  try {
    const records = await database.query<
      {
        project_id: string;
        repair_source_job_id: string | null;
        repair_head_sha: string | null;
        repair_pull_number: number | null;
        allowed_repositories: string[];
        allowed_paths: string[];
        network_policy: string;
        network_allowlist: string[];
      } & Record<string, unknown>
    >(
      `SELECT job.project_id,job.repair_source_job_id,source.github_head_sha AS repair_head_sha,source.github_pull_number AS repair_pull_number,contract.allowed_repositories,contract.allowed_paths,contract.network_policy,contract.network_allowlist
       FROM muse_execution_jobs job
       JOIN agent_sessions session ON session.id=job.agent_session_id AND session.project_id=job.project_id AND session.organization_id=job.organization_id
       JOIN execution_contracts contract ON contract.id=session.execution_contract_id AND contract.project_id=session.project_id AND contract.organization_id=session.organization_id
       LEFT JOIN muse_execution_jobs source ON source.id=job.repair_source_job_id AND source.project_id=job.project_id AND source.organization_id=job.organization_id AND source.workflow_step_id=job.workflow_step_id AND source.status='FAILED' AND source.github_ci_state='FAILED'
       JOIN project_repositories repository ON repository.project_id=job.project_id AND repository.organization_id=job.organization_id AND repository.full_name=$2
       WHERE job.id=$1 AND job.status=ANY($3::text[])`,
      [
        jobId,
        repository,
        mode === "deliver"
          ? ["TURN_FINISHED"]
          : mode === "recover" || mode === "check"
            ? ["TURN_FINISHED", "QUEUED"]
            : ["QUEUED"],
      ],
    );
    const job = records.rows[0];
    if (
      !job ||
      JSON.stringify(job.allowed_repositories) !== JSON.stringify([repository]) ||
      job.network_policy !== "none" ||
      job.network_allowlist.length ||
      !job.allowed_paths.length ||
      !job.allowed_paths.every(validRepositoryPattern)
    )
      throw new Error(
        "Job must be queued with this project's registered private-test repository and an offline path-scoped contract.",
      );
    if (
      job.repair_source_job_id &&
      (!job.repair_head_sha || !/^[a-f0-9]{40}$/.test(job.repair_head_sha))
    )
      throw new Error("Repair source is no longer valid.");
    if (mode === "prepare") {
      await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      // Never reuse, reset or overwrite another checkout.
      if ((await readdir(jobDirectory)).length)
        throw new Error(
          "Job directory already exists. Use check or inspect it; preparation never overwrites files.",
        );
      const token = process.env.ORBIT_WORKER_GITHUB_TOKEN;
      if (!token)
        throw new Error(
          "Preparation requires the restricted GitHub credential privately configured.",
        );
      let cloneBranch = "main";
      if (job.repair_source_job_id) {
        const source = await database.query<
          { id: string; repair_source_job_id: string | null } & Record<string, unknown>
        >(
          "WITH RECURSIVE lineage AS (SELECT id,repair_source_job_id,0 AS depth FROM muse_execution_jobs WHERE id=$1 AND project_id=$2 UNION ALL SELECT parent.id,parent.repair_source_job_id,lineage.depth+1 FROM muse_execution_jobs parent JOIN lineage ON parent.id=lineage.repair_source_job_id WHERE parent.project_id=$2 AND lineage.depth<20) SELECT id,repair_source_job_id FROM lineage WHERE repair_source_job_id IS NULL",
          [job.repair_source_job_id, job.project_id],
        );
        if (source.rows.length !== 1) throw new Error("Repair lineage cannot be resolved safely.");
        cloneBranch = `orbit/muse-${source.rows[0]!.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
        if (!Number.isSafeInteger(job.repair_pull_number) || !job.repair_pull_number)
          throw new Error("Repair has no source PR.");
        const response = await fetch(
          `https://api.github.com/repos/${repository}/pulls/${job.repair_pull_number}`,
          {
            redirect: "error",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(15000),
          },
        );
        const pull = (await response.json()) as {
          state?: string;
          merged_at?: string | null;
          head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
          base?: { repo?: { full_name?: string } };
        };
        if (
          !response.ok ||
          pull.state !== "open" ||
          pull.merged_at ||
          pull.head?.sha !== job.repair_head_sha ||
          pull.head.ref !== cloneBranch ||
          pull.head.repo?.full_name !== repository ||
          pull.base?.repo?.full_name !== repository
        )
          throw new Error(
            "The failed PR moved, closed or merged; reconcile it before a repair. No model was invoked.",
          );
      }
      await runCommand(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--no-recurse-submodules",
          "--single-branch",
          "--branch",
          cloneBranch,
          `https://github.com/${repository}.git`,
          checkout,
        ],
        {
          env: {
            ...gitEnvironment,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0:
              "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64"),
          },
          timeout: 120000,
        },
      );
      const files: string[] = [];
      async function inspect(relative: string) {
        for (const entry of await readdir(join(checkout, relative), { withFileTypes: true })) {
          if (!relative && entry.name === ".git") continue;
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (
            entry.isSymbolicLink() ||
            [
              ".git",
              ".muse",
              ".agents",
              ".codex",
              ".claude",
              ".ssh",
              ".aws",
              ".npmrc",
              ".gitmodules",
            ].includes(entry.name) ||
            /^\.env(?:\.|$)/.test(entry.name) ||
            /\.(pem|key|p12|pfx)$/.test(entry.name)
          )
            throw new Error(
              "Checkout contains a link, local agent configuration, submodule or credential file; refusing execution.",
            );
          if (entry.isDirectory()) await inspect(path);
          else if (entry.isFile() && (await lstat(join(checkout, path))).nlink === 1)
            files.push(path);
          else throw new Error("Only regular repository files are supported.");
        }
      }
      await inspect("");
      const writablePaths: { path: string; directory: boolean }[] = [];
      const placeholders: string[] = [];
      for (const pattern of job.allowed_paths) {
        if (pattern.endsWith("/**")) {
          const path = pattern.slice(0, -3);
          await mkdir(join(checkout, path), { recursive: true });
          writablePaths.push({ path, directory: true });
        } else if (!pattern.includes("*")) {
          if (!files.includes(pattern)) {
            // An exact bind-mounted file must exist. Remove unused empty placeholders afterward.
            await mkdir(resolve(checkout, pattern, ".."), { recursive: true });
            await writeFile(join(checkout, pattern), "", { flag: "wx" });
            placeholders.push(pattern);
          }
          writablePaths.push({ path: pattern, directory: false });
        } else {
          for (const path of files.filter((file) => permittedRepositoryPath(file, [pattern])))
            writablePaths.push({ path, directory: false });
        }
      }
      const baseSha = (
        await runCommand("git", ["-C", checkout, "rev-parse", "HEAD"], { env: gitEnvironment })
      ).stdout.trim();
      if (job.repair_head_sha && baseSha !== job.repair_head_sha)
        throw new Error(
          "The failed PR branch moved. Refresh its CI and review before a repair; no model was invoked.",
        );
      const policy = parseLocalWorkerPolicy({
        jobId,
        projectId: job.project_id,
        repository,
        baseSha,
        allowedPaths: job.allowed_paths,
        writablePaths,
      });
      const mounts = policy.writablePaths.filter(
        (mount) =>
          !policy.writablePaths.some(
            (parent) => parent.directory && mount.path.startsWith(parent.path + "/"),
          ),
      );
      await writeFile(policyFilePath, JSON.stringify(policy, null, 2), { mode: 0o600 });
      await writeFile(join(jobDirectory, "placeholders.json"), JSON.stringify(placeholders), {
        mode: 0o600,
      });
      await writeFile(
        composeOverridePath,
        JSON.stringify(
          {
            services: {
              "muse-worker": {
                volumes: [
                  {
                    type: "bind",
                    source: policyFilePath,
                    target: "/run/orbit-policy.json",
                    read_only: true,
                    bind: { create_host_path: false },
                  },
                  ...mounts.map((mount) => ({
                    type: "bind",
                    source: join(checkout, mount.path),
                    target: `/workspace/${mount.path}`,
                    read_only: false,
                    bind: { create_host_path: false },
                  })),
                ],
              },
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      process.stdout.write(
        `Prepared ${repository} at ${baseSha}. Checkout: ${checkout}\nNo job claimed or model invoked. Run check next.\n`,
      );
      return;
    }
    const policy: LocalWorkerPolicy = parseLocalWorkerPolicy(
      JSON.parse(await readFile(policyFilePath, "utf8")),
    );
    if (
      policy.jobId !== jobId ||
      policy.projectId !== job.project_id ||
      JSON.stringify(policy.allowedPaths) !== JSON.stringify(job.allowed_paths)
    )
      throw new Error("Prepared policy no longer matches the queued job contract.");
    if ((await realpath(checkout)) !== checkout) throw new Error("Checkout must not be a symlink.");

    if (mode === "deliver") {
      if (!process.env.ORBIT_WORKER_GITHUB_TOKEN || process.env.META_API_KEY)
        throw new Error(
          "Delivery requires only the restricted GitHub credential, never a Meta key.",
        );
      const requested = await database.query(
        "SELECT id FROM muse_execution_jobs WHERE id=$1 AND project_id=$2 AND delivery_state='RUNNING'",
        [jobId, job.project_id],
      );
      if (!requested.rows.length)
        throw new Error("An explicitly claimed delivery request is required.");
      const delivered = await runCommand(
        "docker",
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "infra/muse-worker/compose.delivery.yml",
          "--profile",
          "muse-delivery",
          "run",
          "--rm",
          "--no-deps",
          "muse-delivery",
          "node",
          "--import",
          "tsx",
          "src/muse-queue-worker.ts",
          "deliver",
        ],
        {
          cwd: repositoryRoot,
          timeout: 180000,
          maxBuffer: 100000,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ORBIT_DISPOSABLE_CHECKOUT: checkout,
            ORBIT_WORKER_POLICY_FILE: policyFilePath,
            ORBIT_WORKER_JOB_ID: jobId,
            ORBIT_WORKER_GITHUB_TOKEN: process.env.ORBIT_WORKER_GITHUB_TOKEN,
          },
        },
      );
      process.stdout.write(delivered.stdout);
      return;
    }
    const placeholders: string[] = JSON.parse(
      await readFile(join(jobDirectory, "placeholders.json"), "utf8"),
    );
    const workingTree = (
      await runCommand(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          checkout,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "-z",
        ],
        { env: gitEnvironment },
      )
    ).stdout;
    for (const entry of workingTree.split("\0").filter(Boolean)) {
      const path = entry.slice(3);
      if (
        !entry.startsWith("?? ") ||
        !placeholders.includes(path) ||
        (await lstat(join(checkout, path))).size !== 0
      )
        throw new Error(
          "Disposable checkout must be clean before execution. Review existing changes; do not replay the job.",
        );
    }
    let activeOverridePath = composeOverridePath;
    if (mode === "recover") {
      const recoveryPolicyPath = join(jobDirectory, "recovery-policy.json");
      await writeFile(recoveryPolicyPath, JSON.stringify({ ...policy, readOnly: true }), {
        mode: 0o600,
      });
      const original: {
        services: {
          "muse-worker": {
            volumes: {
              type: string;
              source: string;
              target: string;
              read_only: boolean;
              bind: { create_host_path: boolean };
            }[];
          };
        };
      } = JSON.parse(await readFile(composeOverridePath, "utf8"));
      for (const mount of original.services["muse-worker"].volumes) {
        mount.read_only = true;
        if (mount.target === "/run/orbit-policy.json") mount.source = recoveryPolicyPath;
      }
      activeOverridePath = join(jobDirectory, "recovery-compose.json");
      await writeFile(activeOverridePath, JSON.stringify(original), { mode: 0o600 });
    }
    const composeArguments = [
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/muse-worker/compose.local.yml",
      "-f",
      activeOverridePath,
      "--profile",
      "muse-smoke",
      "run",
      "--rm",
      "--no-deps",
      "muse-worker",
    ];
    // Only names explicitly used by Compose reach the execution container.
    const shellAllowed = process.env.ORBIT_MUSE_ALLOW_SHELL === "true";
    const environment = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ORBIT_DISPOSABLE_CHECKOUT: checkout,
      ORBIT_WORKER_JOB_ID: jobId,
      META_API_KEY: mode === "execute" || mode === "recover" ? process.env.META_API_KEY : "",
      ...(shellAllowed ? { ORBIT_MUSE_ALLOW_SHELL: "true" } : {}),
    };
    if ((mode === "execute" || mode === "recover") && !environment.META_API_KEY)
      throw new Error("Execution requires META_API_KEY configured privately.");
    const command = ["node", "--import", "tsx", "src/muse-queue-worker.ts"];
    // Always probe the same mounts first, with no model key and no queue claim.
    const checked = await runCommand("docker", [...composeArguments, ...command, "check"], {
      cwd: repositoryRoot,
      env: { ...environment, META_API_KEY: "" },
      timeout: 60000,
    });
    process.stdout.write(checked.stdout);
    if (mode === "check") return;
    try {
      const executed = await runCommand(
        "docker",
        [...composeArguments, ...command, mode === "recover" ? "recover" : "execute"],
        {
          cwd: repositoryRoot,
          env: environment,
          timeout: 900000,
        },
      );
      process.stdout.write(executed.stdout);
    } finally {
      for (const path of placeholders) {
        const info = await lstat(join(checkout, path));
        if (info.isFile() && info.size === 0) await unlink(join(checkout, path));
      }
    }
    process.stdout.write(
      "Execution ended. Review generated changes; delivery and CI verification are separate. No push requested.\n",
    );
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  // Child-process errors can include credential-bearing environment or private output.
  if (error instanceof Error && !("cmd" in error)) process.stderr.write(error.message + "\n");
  process.stderr.write(
    "Local worker command failed. Check prerequisites, checkout policy, Docker image and queued job state. No automatic delivery was started.\n",
  );
  process.exitCode = 1;
});
