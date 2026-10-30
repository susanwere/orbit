import type { EngineeringExecutor, EngineeringExecutionRequest, EngineeringExecutionResult } from "./muse-code-executor.js";

/** Deterministic demo only. No files, GitHub PRs, tests or CI are actually run. */
export class SimulatedEngineeringExecutor implements EngineeringExecutor {
  async execute(request: EngineeringExecutionRequest): Promise<EngineeringExecutionResult> {
    if (!request.mission.trim()) throw new Error("A mission is required.");
    return {
      provider: "SIMULATION_ONLY",
      exitCode: 0,
      events: [
        { type: "demo_started", simulated: true, label: "SIMULATED — no agent executed" },
        { type: "demo_planning", simulated: true, label: "SIMULATED — planning work" },
        { type: "demo_finished", simulated: true, label: "SIMULATED — no code changes, tests or PR" },
      ],
      outputTruncated: false,
    };
  }
}
