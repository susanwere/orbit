import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";
import { compareKnowledgeVersions } from "./compare-knowledge.js";

const make = (version: number, features: string[]): ProjectKnowledgeSnapshot => ({
  id: String(version),
  revision: version,
  created_at: "2026-11-01T00:00:00Z",
  content: {
    summary: { summary: "Project", architecture: "React", features, constraints: [], unknowns: [] },
    documents: [],
    repositories: [],
  },
});

describe("context version comparison", () => {
  it("detects additions and removals relative to approved knowledge", () => {
    const changes = compareKnowledgeVersions(make(2, ["Search", "Auth"]), make(1, ["Search", "Legacy"]));
    expect(changes.addedFeatures).toEqual(["Auth"]);
    expect(changes.removedFeatures).toEqual(["Legacy"]);
    expect(changes.architectureChanged).toBe(false);
  });

  it("shows all features for initial knowledge", () => {
    expect(compareKnowledgeVersions(make(1, ["Search"])).addedFeatures).toEqual(["Search"]);
  });
});
