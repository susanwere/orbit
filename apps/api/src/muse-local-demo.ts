/**
 * Standalone local adapter check. Does not claim/modify production Orbit jobs.
 * Run from repository root: npm run muse:demo --workspace=/absolute/path
 */
import { resolve } from "node:path";
import { SimulatedEngineeringExecutor } from "./modules/execution/simulated-engineering-executor.js";
import {
  LocalMuseProcessRunner,
  MuseCodeCliExecutor,
} from "./modules/execution/muse-code-executor.js";

async function main() {
  const mode = process.env.ORBIT_DEMO_MODE ?? "mock";
  if (mode !== "mock" && mode !== "real") throw new Error("ORBIT_DEMO_MODE must be mock or real.");
  const workspaceArg = process.argv.find((a) => a.startsWith("--workspace="));
  const workspace = workspaceArg?.slice("--workspace=".length);
  if (!workspace || !workspace.startsWith("/") || resolve(workspace) !== workspace)
    throw new Error("Pass --workspace=/absolute/path/to/disposable-checkout");
  const mission =
    "Inspect this isolated example repository and explain the minimal React component improvement. Do not push or merge.";
  if (mode === "real") {
    if (process.env.ORBIT_DEMO_REAL_CONFIRMED !== "yes")
      throw new Error(
        "Real Muse needs ORBIT_DEMO_REAL_CONFIRMED=yes and an isolated disposable checkout.",
      );
    if (!process.env.META_API_KEY)
      throw new Error("META_API_KEY must be configured outside the repository.");
  }
  const executor =
    mode === "mock"
      ? new SimulatedEngineeringExecutor()
      : new MuseCodeCliExecutor(new LocalMuseProcessRunner());
  const result = await executor.execute({
    mission,
    workspace,
    modelSteps: 10,
    timeoutMs: 180000,
  });
  const payload = {
    demoMode: mode === "mock" ? "SIMULATED" : "REAL_CLI_TURN_UNVERIFIED",
    provider: result.provider,
    exitCode: result.exitCode,
    events:
      mode === "mock" ? result.events : [{ type: "events_redacted", count: result.events.length }],
    note: "No GitHub PR, tests, or CI evidence is verified by this local adapter check.",
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  if (result.exitCode !== 0) process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + "\n" : "Local demo failed.\n");
  process.exitCode = 1;
});
