/**
 * Local hackathon smoke test: Muse builds an Open Jobs React/Vite app in a
 * throwaway workspace, then we build and preview it on loopback only.
 * This is NOT Orbit production deployment, sandboxing, or GitHub CI evidence.
 */
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MuseCodeCliExecutor, LocalMuseProcessRunner } from "./modules/execution/muse-code-executor.js";
import { assertOpenJobsProject } from "./modules/execution/muse-open-jobs-contract.js";

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}`;

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((accept, reject) => {
    // Running npm scripts from generated code is potentially unsafe.
    // Only use a disposable checkout containing no secrets.
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  if (process.env.ORBIT_DEMO_REAL_CONFIRMED !== "yes")
    throw new Error("Set ORBIT_DEMO_REAL_CONFIRMED=yes to run real Muse against disposable code.");
  if (!process.env.META_API_KEY)
    throw new Error("Configure META_API_KEY privately, never commit it.");
  const argument = process.argv.find((arg) => arg.startsWith("--workspace="));
  const workspace = argument?.slice("--workspace=".length);
  if (!workspace || !workspace.startsWith("/") || resolve(workspace) !== workspace)
    throw new Error("Pass --workspace=/absolute/path/to/empty/disposable/workspace");
  if ((await readdir(workspace)).length)
    throw new Error("Use an EMPTY disposable workspace; refusing to modify existing files.");
  const executor = new MuseCodeCliExecutor(new LocalMuseProcessRunner());
  const result = await executor.execute({
    workspace,
    modelSteps: 40,
    timeoutMs: 600000,
    mission: [
      "Create a complete React + TypeScript + Vite app called Open Jobs in this empty workspace.",
      "Build a clean, responsive jobs dashboard with a searchable list of sample jobs, filters,",
      "and accessible job detail cards. Use hard-coded DEMO sample data only.",
      "Add package.json with npm scripts 'dev' and 'build'. Do not access external APIs,",
      "use credentials, push to GitHub or deploy to any external service.",
      "Ensure npm run build succeeds."
    ].join(" "),
  });
  if (result.exitCode !== 0 || result.outputTruncated)
    throw new Error("Muse did not finish cleanly; local preview not started.");
  const projectFile = join(workspace, "package.json");
  await access(projectFile);
  const project = JSON.parse(await readFile(projectFile, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assertOpenJobsProject(project);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], workspace);
  await run("npm", ["run", "build"], workspace);
  process.stdout.write(`LOCAL PREVIEW ONLY: ${URL}\nNot deployed; no GitHub PR or CI is claimed.\n`);
  const server = spawn("npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { cwd: workspace, stdio: "inherit", shell: false },
  );
  server.on("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
  server.on("exit", (code) => { if (code && code !== 0) process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + "\n" : "Demo failed.\n");
  process.exitCode = 1;
});
