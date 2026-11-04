import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { permittedRepositoryPath } from "./repository-path-policy.js";

/** Prepare explicit approved task files inside recursive write grants. */
export async function prepareTaskFiles(
  workspace: string,
  approvedPrompt: string,
  allowedPaths: readonly string[],
): Promise<string[]> {
  const preparedFiles: string[] = [];
  if ((await realpath(workspace)) !== resolve(workspace))
    throw new Error("Task preparation requires a canonical checkout.");
  const filePaths = new Set(
    approvedPrompt.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) ?? [],
  );
  if (filePaths.size > 250) throw new Error("Too many explicit task file paths.");
  for (const filePath of filePaths) {
    if (!permittedRepositoryPath(filePath, allowedPaths)) continue;
    if (
      !allowedPaths.some(
        (pattern) => pattern.endsWith("/**") && filePath.startsWith(pattern.slice(0, -3) + "/"),
      )
    )
      continue;
    let currentDirectory = workspace;
    for (const part of dirname(filePath).split("/")) {
      currentDirectory = join(currentDirectory, part);
      try {
        await mkdir(currentDirectory);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
          throw error;
      }
      const directory = await lstat(currentDirectory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (await realpath(currentDirectory)) !== currentDirectory
      )
        throw new Error("Task directories must remain inside the checkout without symbolic links.");
    }
    const absoluteFile = join(workspace, filePath);
    try {
      await writeFile(absoluteFile, "", { flag: "wx" });
      preparedFiles.push(filePath);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
      const existingFile = await lstat(absoluteFile);
      if (!existingFile.isFile() || existingFile.isSymbolicLink() || existingFile.nlink !== 1)
        throw new Error("Prepared task files must be regular checkout files.");
    }
  }
  return preparedFiles;
}

/** Empty preparation files are not model changes and must never trigger delivery. */
export async function excludeUnusedPreparedFiles(
  workspace: string,
  changedPaths: readonly string[],
  preparedFiles: readonly string[],
): Promise<string[]> {
  const retainedPaths: string[] = [];
  for (const path of changedPaths) {
    if (preparedFiles.includes(path)) {
      const file = await lstat(join(workspace, path));
      if (file.isFile() && !file.isSymbolicLink() && file.size === 0) continue;
    }
    retainedPaths.push(path);
  }
  return retainedPaths;
}
