import type { CreatedProject } from "./project-api.js";

/** Project names are unique within the authenticated organization. */
export function projectPath(project: Pick<CreatedProject, "name">): string {
  return `/projects/${encodeURIComponent(project.name)}`;
}

export function projectNameFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const projectName = decodeURIComponent(match[1]);
    return projectName.trim() && projectName.length <= 120 ? projectName : null;
  } catch {
    return null;
  }
}
