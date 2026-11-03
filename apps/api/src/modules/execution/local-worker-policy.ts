import { open, readFile, writeFile, unlink, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { permittedRepositoryPath, validRepositoryPattern } from "./repository-path-policy.js";
import type { MuseJobSelection } from "./muse-execution-worker.js";

export interface LocalWorkerPolicy extends MuseJobSelection {
  readonly baseSha: string;
  readonly readOnly?: boolean;
  readonly preparedFiles?: readonly string[];
  readonly writablePaths: readonly { path: string; directory: boolean }[];
}

export function parseLocalWorkerPolicy(input: unknown): LocalWorkerPolicy {
  if (!input || typeof input !== "object") throw new Error("Missing local worker policy.");
  const policy = input as Record<string, unknown>;
  if (
    typeof policy.jobId !== "string" ||
    !/^musejob_[A-Za-z0-9-]{20,80}$/.test(policy.jobId) ||
    typeof policy.projectId !== "string" ||
    !policy.projectId ||
    policy.repository !== "susanwere/private-test" ||
    typeof policy.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(policy.baseSha) ||
    !Array.isArray(policy.allowedPaths) ||
    !policy.allowedPaths.length ||
    !policy.allowedPaths.every(
      (pattern: unknown) => typeof pattern === "string" && validRepositoryPattern(pattern),
    ) ||
    !Array.isArray(policy.writablePaths) ||
    !policy.writablePaths.length
  )
    throw new Error("Invalid local worker policy or repository scope.");
  const patterns: string[] = policy.allowedPaths;
  const writablePaths = policy.writablePaths.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("directory" in entry) ||
      typeof entry.directory !== "boolean"
    )
      throw new Error("Invalid writable mount.");
    const path = entry.path;
    if (
      !validRepositoryPattern(path) ||
      path.includes("*") ||
      (entry.directory
        ? !patterns.includes(`${path}/**`)
        : !permittedRepositoryPath(path, patterns))
    )
      throw new Error("Writable mount exceeds the Execution Contract.");
    return { path, directory: entry.directory };
  });
  const preparedFiles = policy.preparedFiles;
  if (
    preparedFiles !== undefined &&
    (!Array.isArray(preparedFiles) ||
      preparedFiles.length > 250 ||
      !preparedFiles.every(
        (path: unknown) => typeof path === "string" && permittedRepositoryPath(path, patterns),
      ))
  )
    throw new Error("Prepared files exceed the Execution Contract.");
  return {
    ...(preparedFiles === undefined ? {} : { preparedFiles: preparedFiles as string[] }),
    ...(policy.readOnly === true ? { readOnly: true } : {}),
    jobId: policy.jobId,
    projectId: policy.projectId,
    repository: policy.repository,
    baseSha: policy.baseSha,
    allowedPaths: patterns,
    writablePaths,
  };
}

/** Probe the actual mounts without running a model turn or claiming a queue job. */
export async function verifyLocalWorkerSandbox(workspace: string, policy: LocalWorkerPolicy) {
  if (
    process.platform !== "linux" ||
    workspace !== "/workspace" ||
    (await realpath(workspace)) !== workspace
  )
    throw new Error("Local worker requires the Linux Docker workspace.");
  for (const key of ["ORBIT_WORKER_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) {
    if (process.env[key])
      throw new Error("Execution container contains a forbidden credential or agent socket.");
  }
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^CapEff:\s+0+$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status))
    throw new Error("Worker requires dropped capabilities and no-new-privileges.");
  const expectReadOnly = async (path: string) => {
    let handle;
    try {
      handle = await open(path, "r+");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EROFS") return;
      throw new Error("Cannot verify a required read-only mount.");
    }
    await handle.close();
    throw new Error("A protected path is writable; refusing execution.");
  };
  await expectReadOnly(join(workspace, ".git/config"));
  await expectReadOnly("/orbit/package.json");
  const forbidden = join(workspace, `.orbit-forbidden-${process.pid}`);
  try {
    await writeFile(forbidden, "probe", { flag: "wx" });
    await unlink(forbidden);
    throw new Error("Workspace root is writable; refusing execution.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EROFS"))
      throw error;
  }
  for (const mount of policy.writablePaths) {
    const absolute = resolve(workspace, mount.path);
    if ((await realpath(absolute)) !== absolute) throw new Error("Symlink in writable mount.");
    const info = await lstat(absolute);
    if (policy.readOnly) {
      if (!mount.directory) await expectReadOnly(absolute);
      else {
        const probe = join(absolute, `.orbit-readonly-probe-${process.pid}`);
        try {
          await writeFile(probe, "probe", { flag: "wx" });
          await unlink(probe);
          throw new Error("Recovery directory is writable.");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "EROFS"))
            throw error;
        }
      }
      continue;
    }
    if (mount.directory) {
      if (!info.isDirectory()) throw new Error("Expected a writable directory.");
      const probe = join(absolute, `.orbit-probe-${process.pid}`);
      await writeFile(probe, "probe", { flag: "wx" });
      await unlink(probe);
    } else {
      if (!info.isFile() || info.nlink !== 1) throw new Error("Expected a regular writable file.");
      const handle = await open(absolute, "r+");
      await handle.close();
    }
  }
}

/** Delivery can write Git metadata, but never executes repository scripts or Muse. */
export async function verifyLocalDeliverySandbox(workspace: string) {
  if (
    process.platform !== "linux" ||
    workspace !== "/workspace" ||
    (await realpath(workspace)) !== workspace ||
    process.env.META_API_KEY ||
    process.env.SSH_AUTH_SOCK
  )
    throw new Error(
      "Delivery requires a Linux disposable checkout without model credentials or an SSH agent.",
    );
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^CapEff:\s+0+$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status))
    throw new Error("Delivery requires dropped capabilities and no-new-privileges.");
  const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .map((line) => line.split(" "));
  if (
    !mounts.some((fields) => fields[4] === "/" && fields[5]?.split(",").includes("ro")) ||
    !mounts.some((fields) => fields[4] === workspace && fields[5]?.split(",").includes("rw"))
  )
    throw new Error("Delivery needs a read-only container and writable disposable checkout.");
  const gitConfig = await open(join(workspace, ".git/config"), "r+");
  await gitConfig.close();
}
