import type { ContextSnapshot, ProjectContext } from "@orbit/domain";
import { serializeCanonicalJson } from "../context/canonical-context.js";

export type ExecutionImpact = "ALLOW_CONTINUE" | "REVIEW_REQUIRED";
export interface ImpactDecision {
  result: ExecutionImpact;
  changedPaths: readonly string[];
  affectedPaths: readonly string[];
}
const equal = (a: unknown, b: unknown) => serializeCanonicalJson(a) === serializeCanonicalJson(b);
const matches = (mission: string, text: string) => {
  const missionTokens = mission
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  return missionTokens.some((token) => text.toLowerCase().includes(token));
};
const pointer = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");

export function diffProjectContext(previous: ProjectContext, next: ProjectContext): string[] {
  const paths: string[] = [];
  if (!equal(previous.currentIntent, next.currentIntent)) paths.push("/currentIntent");
  const oldConstraints = new Map(previous.constraints.map((c) => [c.id, c]));
  const newConstraints = new Map(next.constraints.map((c) => [c.id, c]));
  for (const id of new Set([...oldConstraints.keys(), ...newConstraints.keys()])) {
    if (!equal(oldConstraints.get(id) ?? null, newConstraints.get(id) ?? null)) {
      paths.push(`/constraints/${pointer(id)}`);
    }
  }
  const keys = new Set([...Object.keys(previous.attributes), ...Object.keys(next.attributes)]);
  for (const key of keys) {
    if (!equal(previous.attributes[key] ?? null, next.attributes[key] ?? null)) {
      paths.push(`/attributes/${pointer(key)}`);
    }
  }
  return paths.sort();
}

/** Existing context snapshots remain immutable; this only returns a gate decision. */
export function evaluateExecutionImpact(input: {
  previous: ProjectContext;
  current: ProjectContext;
  snapshot: ContextSnapshot;
  mission: string;
  allowedPaths: readonly string[];
}): ImpactDecision {
  const { previous, current, snapshot, mission, allowedPaths } = input;
  const changedPaths = diffProjectContext(previous, current);
  const affectedPaths = changedPaths.filter((path) => {
    if (path === "/currentIntent") return true;
    if (path.startsWith("/attributes/")) {
      return snapshot.includedPaths.includes(path);
    }
    if (!path.startsWith("/constraints/")) return false;
    const id = path.slice("/constraints/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    const constraint =
      current.constraints.find((c) => c.id === id) ?? previous.constraints.find((c) => c.id === id);
    if (!constraint) return false;
    return (
      snapshot.includedConstraintIds.includes(id) ||
      matches(mission, `${constraint.key} ${constraint.statement}`) ||
      allowedPaths.some((p) => constraint.key.includes(p.replace(/\*+/g, "")))
    );
  });
  return {
    result: affectedPaths.length ? "REVIEW_REQUIRED" : "ALLOW_CONTINUE",
    changedPaths,
    affectedPaths,
  };
}
