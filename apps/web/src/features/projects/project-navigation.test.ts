import { describe, expect, it } from "vitest";
import { projectNameFromPath, projectPath } from "./project-navigation.js";

describe("name-based project navigation", () => {
  it.each(["Orbit", "HN Jobs Viewer", "new", "Café / API? #1", "项目"])(
    "round trips %s without exposing an ID",
    (name) => {
      const pathname = projectPath({ name });
      expect(projectNameFromPath(pathname)).toBe(name);
      expect(pathname).toBe(`/projects/${encodeURIComponent(name)}`);
    },
  );
  it.each(["/", "/projects", "/new-project", "/projects/%ZZ", "/projects/a/b", "/projects/%20"])(
    "does not open a project for %s",
    (pathname) => {
      expect(projectNameFromPath(pathname)).toBeNull();
    },
  );
});
