export function assertOpenJobsProject(
  project: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> },
) {
  const all = { ...project.dependencies, ...project.devDependencies };
  if (!all.react || !all.vite || !project.scripts?.build || !project.scripts?.dev)
    throw new Error("Muse output must be a React/Vite app with build and dev scripts.");
}
