import { describe, expect, it, vi } from "vitest";
import { summarize } from "./project-knowledge-routes.js";
import type { StructuredJsonClient } from "../decisions/meta-model-client.js";

describe("project knowledge summary timeouts", () => {
  it.each([
    ["document", 120_000],
    ["repository", 120_000],
    ["project", 180_000],
  ] as const)("uses a stage-specific timeout for %s", async (kind, timeoutMs) => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const complete = vi.fn().mockRejectedValue(timeout);
    const model: StructuredJsonClient = { complete };

    await expect(summarize(model, { kind })).rejects.toThrow(
      `Muse timed out after ${timeoutMs / 1_000} seconds while summarizing ${kind} context.`,
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs, model: "muse-spark-1.3" }),
    );
  });

  it("does not relabel unrelated model errors as timeouts", async () => {
    const error = new Error("Model returned invalid JSON");
    const model: StructuredJsonClient = { complete: vi.fn().mockRejectedValue(error) };
    await expect(summarize(model, { kind: "repository" })).rejects.toBe(error);
  });
});
