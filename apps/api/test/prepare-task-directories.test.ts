import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareTaskFiles,
  excludeUnusedPreparedFiles,
} from "../src/modules/execution/prepare-task-directories.js";

describe("approved task directory preparation", () => {
  it("creates nested directories for approved source paths as editable placeholders", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "orbit-task-paths-")));
    try {
      await prepareTaskFiles(workspace, "Add src/components/JobCard.tsx and src/lib/date.ts", [
        "src/**",
      ]);
      expect(await readdir(join(workspace, "src/components"))).toEqual(["JobCard.tsx"]);
      expect(await readdir(join(workspace, "src/lib"))).toEqual(["date.ts"]);
      await prepareTaskFiles(workspace, "Add src/components/JobList.tsx", ["src/**"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it("excludes unused placeholders and retains actual edits", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "orbit-task-files-")));
    try {
      const placeholders = await prepareTaskFiles(workspace, "src/New.tsx src/Unused.tsx", [
        "src/**",
      ]);
      await writeFile(join(workspace, "src/New.tsx"), "export const ready = true;");
      expect(
        await excludeUnusedPreparedFiles(
          workspace,
          ["src/New.tsx", "src/Unused.tsx"],
          placeholders,
        ),
      ).toEqual(["src/New.tsx"]);
      expect(await prepareTaskFiles(workspace, "src/New.tsx", ["src/**"])).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it("ignores traversal, protected paths and paths outside recursive grants", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "orbit-task-paths-")));
    try {
      await prepareTaskFiles(
        workspace,
        "../escape.ts src/../../escape.ts .git/config.json other/new.ts src/.muse/config.json src/components/New.tsx",
        ["src/App.tsx"],
      );
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it("rejects symlink parents before creating directories outside the checkout", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "orbit-task-paths-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "orbit-task-outside-")));
    try {
      await mkdir(join(workspace, "src"));
      await symlink(outside, join(workspace, "src/components"));
      await expect(
        prepareTaskFiles(workspace, "src/components/nested/New.tsx", ["src/**"]),
      ).rejects.toThrow("symbolic links");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
