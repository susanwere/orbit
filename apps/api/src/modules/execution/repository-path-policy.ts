/** Contract paths support relative files, basename globs and recursive directory grants. */
export function validRepositoryPattern(pattern: string): boolean {
  return (
    pattern.length > 0 &&
    !pattern.startsWith("/") &&
    !pattern.includes("\\") &&
    !pattern.includes("\0") &&
    !pattern
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.startsWith(".")) &&
    /^[A-Za-z0-9_./*-]+$/.test(pattern) &&
    (!pattern.includes("**") || (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*"))) &&
    !pattern
      .split("/")
      .slice(0, -1)
      .some((part) => part.includes("*"))
  );
}

export function permittedRepositoryPath(file: string, patterns: readonly string[]): boolean {
  if (!validRepositoryPattern(file) || file.includes("*")) return false;
  return patterns.some((pattern) => {
    if (!validRepositoryPattern(pattern)) return false;
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3) + "/");
    const expression = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${expression}$`).test(file);
  });
}
