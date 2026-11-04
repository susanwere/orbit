import { describe, expect, it } from "vitest";
import {
  diffProjectContext,
  evaluateExecutionImpact,
} from "../src/modules/execution/evaluate-execution-impact.js";
import type { ContextSnapshot, ProjectContext } from "@orbit/domain";

const at = "2026-10-28T10:00:00Z";
const previous: ProjectContext = {
  projectId: "p",
  originalIntentId: "i",
  currentIntent: "Build jobs",
  constraints: [],
  attributes: { mode: "dev" },
};
const snapshot: ContextSnapshot = {
  id: "s",
  organizationId: "o",
  projectId: "p",
  sourceContextVersionId: "v3",
  mission: "Implement Load More for jobs",
  items: [],
  includedDecisionIds: [],
  includedConstraintIds: [],
  includedPaths: ["/currentIntent"],
  excludedPaths: ["/attributes/mode"],
  authorizationBasis: {
    requestedByPrincipalId: "u",
    agentDefinitionId: "agent",
    agentDefinitionVersion: 1,
    capabilities: [],
    policyEvaluationIds: [],
  },
  maxClassification: "INTERNAL",
  allowedRepositories: [],
  allowedPaths: [],
  forbiddenData: [],
  approvalRequiredActions: [],
  createdAt: at,
};
const changed = (key: string, statement: string): ProjectContext => ({
  ...previous,
  constraints: [
    {
      id: "c1",
      key,
      statement,
      sourceDecisionId: "d1",
      createdAt: at,
    },
  ],
});

describe("running-session context impact", () => {
  it("gates materially relevant new constraints", () => {
    const impact = evaluateExecutionImpact({
      previous,
      current: changed("jobs.loadMore", "Use Load More for jobs"),
      snapshot,
      mission: snapshot.mission,
      allowedPaths: ["apps/jobs/**"],
    });
    expect(impact.result).toBe("REVIEW_REQUIRED");
    expect(impact.affectedPaths).toEqual(["/constraints/c1"]);
  });
  it("allows unrelated changes without modifying snapshots", () => {
    const impact = evaluateExecutionImpact({
      previous,
      current: changed("billing.invoices", "Generate invoices"),
      snapshot,
      mission: snapshot.mission,
      allowedPaths: ["apps/jobs/**"],
    });
    expect(impact.result).toBe("ALLOW_CONTINUE");
    expect(snapshot.sourceContextVersionId).toBe("v3");
  });
  it("gates changed project-wide intent", () => {
    expect(
      evaluateExecutionImpact({
        previous,
        current: { ...previous, currentIntent: "Change product direction" },
        snapshot,
        mission: snapshot.mission,
        allowedPaths: [],
      }).result,
    ).toBe("REVIEW_REQUIRED");
  });
  it("detects only changed attribute paths", () => {
    expect(diffProjectContext(previous, { ...previous, attributes: { mode: "prod" } })).toEqual([
      "/attributes/mode",
    ]);
  });
});

it("requires review for knowledge consumed by a snapshot, without granting new scopes", () => {
  const current: ProjectContext = {
    ...previous,
    attributes: {
      ...previous.attributes,
      approvedProjectKnowledge: {
        snapshotId: "knowledge2",
        revision: 2,
        content: { overview: "Updated" },
      },
    },
  };
  const evaluate = (includedPaths: readonly string[]) =>
    evaluateExecutionImpact({
      previous,
      current,
      snapshot: { ...snapshot, includedPaths },
      mission: snapshot.mission,
      allowedPaths: [],
    });
  expect(evaluate(["/attributes/approvedProjectKnowledge"]).result).toBe("REVIEW_REQUIRED");
  expect(evaluate([]).result).toBe("ALLOW_CONTINUE");
  expect(snapshot.sourceContextVersionId).toBe("v3");
});
