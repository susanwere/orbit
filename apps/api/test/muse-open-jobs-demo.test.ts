import { describe, expect, it } from "vitest";
import { assertOpenJobsProject } from "../src/modules/execution/muse-open-jobs-contract.js";

describe("local Open Jobs demo project contract", () => {
  it("accepts a React/Vite project with an explicit build script", () => {
    expect(() =>
      assertOpenJobsProject({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^6.0.0" },
        scripts: { build: "vite build", dev: "vite" },
      }),
    ).not.toThrow();
  });

  it("rejects a missing frontend toolchain or build script", () => {
    expect(() => assertOpenJobsProject({ scripts: { build: "echo hello" } })).toThrow();
    expect(() =>
      assertOpenJobsProject({
        dependencies: { react: "^19.0.0", vite: "^6.0.0" },
      }),
    ).toThrow();
  });
});
