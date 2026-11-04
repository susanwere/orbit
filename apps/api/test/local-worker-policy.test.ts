import { describe, expect, it } from "vitest";
import { parseLocalWorkerPolicy } from "../src/modules/execution/local-worker-policy.js";
import { permittedRepositoryPath } from "../src/modules/execution/repository-path-policy.js";

const policy = {
  jobId: "musejob_4a560794-a548-4f63-b11e-398e22414306",
  projectId: "project",
  repository: "susanwere/private-test",
  baseSha: "a".repeat(40),
  allowedPaths: ["src/**", "package.json", "tsconfig*.json"],
  writablePaths: [
    { path: "src", directory: true },
    { path: "package.json", directory: false },
    { path: "tsconfig.app.json", directory: false },
  ],
};

describe("local Docker worker contract", () => {
  it("accepts only exact files and complete directory grants within the contract", () => {
    expect(parseLocalWorkerPolicy(policy)).toEqual(policy);
    expect(() =>
      parseLocalWorkerPolicy({
        ...policy,
        writablePaths: [{ path: "src", directory: true }],
        allowedPaths: ["src/index.ts"],
      }),
    ).toThrow();
    expect(() =>
      parseLocalWorkerPolicy({
        ...policy,
        writablePaths: [{ path: "README.md", directory: false }],
      }),
    ).toThrow();
  });
  it("rejects other repositories, traversal, hidden configuration and broad writable mounts", () => {
    expect(() => parseLocalWorkerPolicy({ ...policy, repository: "susanwere/orbit" })).toThrow();
    for (const path of ["../outside", "/", ".git", "src/../outside", "src/.muse", "src/*"]) {
      expect(() =>
        parseLocalWorkerPolicy({ ...policy, writablePaths: [{ path, directory: true }] }),
      ).toThrow();
    }
  });
  it("bounds prepared files to the contract", () => {
    expect(
      parseLocalWorkerPolicy({ ...policy, preparedFiles: ["src/New.tsx"] }).preparedFiles,
    ).toEqual(["src/New.tsx"]);
    for (const preparedFiles of [["../outside"], ["src/.env"], ["other/File.ts"], ["src/**"]])
      expect(() => parseLocalWorkerPolicy({ ...policy, preparedFiles })).toThrow("Prepared files");
  });
  it("uses the same path semantics for mounting and delivery, including config globs", () => {
    expect(permittedRepositoryPath("src/nested/App.tsx", policy.allowedPaths)).toBe(true);
    expect(permittedRepositoryPath("tsconfig.app.json", policy.allowedPaths)).toBe(true);
    expect(permittedRepositoryPath("tsconfig.app.json.bak", policy.allowedPaths)).toBe(false);
    expect(permittedRepositoryPath("src-other/App.tsx", policy.allowedPaths)).toBe(false);
    expect(permittedRepositoryPath("src/../.env", policy.allowedPaths)).toBe(false);
    expect(permittedRepositoryPath("src/.env", policy.allowedPaths)).toBe(false);
  });
});
