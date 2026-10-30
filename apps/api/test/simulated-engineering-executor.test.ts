import { describe, expect, it } from "vitest";
import { SimulatedEngineeringExecutor } from "../src/modules/execution/simulated-engineering-executor.js";

describe("local demo executor", () => {
  it("labels every event as simulation and never asserts GitHub evidence", async () => {
    const result = await new SimulatedEngineeringExecutor().execute({
      mission: "Build a React component",
      workspace: "/tmp/disposable",
      modelSteps: 10,
      timeoutMs: 10000,
    });
    expect(result.provider).toBe("SIMULATION_ONLY");
    expect(result.events).toHaveLength(3);
    expect(result.events.every((event) => (event as { simulated?: boolean }).simulated)).toBe(true);
    expect(JSON.stringify(result.events)).not.toMatch(/https:\/\/github.com\/[^\s]+\/pull\/\d+/);
  });
  it("rejects empty missions", async () => {
    await expect(
      new SimulatedEngineeringExecutor().execute({
        mission: " ",
        workspace: "/tmp/disposable",
        modelSteps: 10,
        timeoutMs: 10000,
      }),
    ).rejects.toThrow("mission");
  });
});
