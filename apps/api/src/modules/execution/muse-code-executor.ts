import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface EngineeringExecutionRequest {
  readonly mission: string;
  readonly workspace: string;
  readonly modelSteps: number;
  readonly timeoutMs: number;
}
export interface EngineeringExecutionResult {
  readonly provider: string;
  readonly exitCode: number | null;
  readonly events: readonly unknown[];
  readonly outputTruncated: boolean;
}
export interface EngineeringExecutor {
  execute(request: EngineeringExecutionRequest): Promise<EngineeringExecutionResult>;
}

export interface MuseProcessRunner {
  run(
    args: readonly string[],
    options: {
      cwd: string;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<{ exitCode: number | null; stdout: string }>;
}

/** Explicitly for a separate, pre-provisioned, restricted worker container. */
export class MuseCodeCliExecutor implements EngineeringExecutor {
  constructor(private readonly runner: MuseProcessRunner) {}
  async execute(request: EngineeringExecutionRequest): Promise<EngineeringExecutionResult> {
    if (!request.mission.trim() || request.mission.length > 12000)
      throw new Error("Bounded execution mission required.");
    if (!Number.isInteger(request.modelSteps) || request.modelSteps < 1 || request.modelSteps > 60)
      throw new Error("Invalid model step budget.");
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1000 ||
      request.timeoutMs > 900000
    )
      throw new Error("Invalid execution timeout.");
    if (!request.workspace.startsWith("/") || resolve(request.workspace) !== request.workspace)
      throw new Error("An absolute, canonical workspace is required.");

    const temporary = await mkdtemp(join(tmpdir(), "orbit-muse-"));
    try {
      const prompt = join(temporary, "mission.txt");
      await writeFile(prompt, request.mission, { mode: 0o600 });
      const run = await this.runner.run(
        [
          "exec",
          "--disable-approval",
          "--json",
          "--prompt-file",
          prompt,
          "--max-model-steps",
          String(request.modelSteps),
          "--workspace",
          request.workspace,
        ],
        { cwd: request.workspace, timeoutMs: request.timeoutMs, maxOutputBytes: 2_000_000 },
      );
      const events: unknown[] = [];
      for (const line of run.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as unknown);
        } catch {
          // The CLI can emit non-JSON diagnostics. They are not trusted execution evidence.
        }
      }
      return {
        provider: "meta-muse-code",
        exitCode: run.exitCode,
        events,
        outputTruncated: run.stdout.length >= 2_000_000,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/** Only usable from an isolated host with an OS sandbox and scoped workspace. */
export class LocalMuseProcessRunner implements MuseProcessRunner {
  async run(
    args: readonly string[],
    options: {
      cwd: string;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ) {
    return new Promise<{ exitCode: number | null; stdout: string }>((accept, reject) => {
      const child = spawn("muse", [...args], {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          META_API_KEY: process.env.META_API_KEY,
        },
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      let stdout = "";
      let size = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Muse Code timed out.")), options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxOutputBytes)
          return fail(new Error("Muse Code output limit exceeded."));
        stdout += chunk.toString("utf8");
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        accept({ exitCode: code, stdout });
      });
    });
  }
}
