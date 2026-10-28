import { describe, expect, it } from "vitest";
import type { AgentDefinition, ContextVersion, Decision } from "@orbit/domain";
import { resolveContextSnapshot } from "../src/modules/context/resolve-agent-context.js";

const at = "2026-10-28T10:00:00Z";
const agent: AgentDefinition = {
  id: "agent_1", organizationId: "org_1", name: "Engineer", purpose: "Implement tasks",
  provider: "meta", model: "muse", capabilities: ["repo.read"],
  approvedTools: [], maxContextClassification: "INTERNAL",
  allowedContextScopes: ["project", "/attributes/releaseChannel"],
  allowedRepositories: ["susanwere/orbit"], allowedPaths: ["apps/**"],
  approvalRequiredActions: [], forbiddenActions: [], networkPolicy: "none",
  networkAllowlist: [], status: "approved", version: 1,
  createdByPrincipalId: "admin", createdAt: at,
};
const version: ContextVersion = {
  id: "v4", organizationId: "org_1", projectId: "project_1",
  versionNumber: 4, contentHash: "a".repeat(64), createdAt: at,
  content: {
    projectId: "project_1", originalIntentId: "intent_1", currentIntent: "Build jobs viewer",
    constraints: [
      { id: "c1", key: "jobs.loadMore", statement: "Load More for jobs",
        sourceDecisionId: "d1", createdAt: at },
      { id: "c2", key: "billing", statement: "Billing invoice change",
        sourceDecisionId: "d2", createdAt: at },
    ],
    attributes: { releaseChannel: "preview", secret: "do-not-include" },
  },
};
const decisions: Decision[] = [
  { id: "d1", organizationId: "org_1", projectId: "project_1",
    sourceDecisionProposalId: "p1", sourceArtifactId: "art1",
    title: "Load More", rationale: "Fast jobs loading", alternatives: [],
    scope: ["jobs list"], status: "ACTIVE", approvedByPrincipalId: "admin", createdAt: at },
  { id: "d2", organizationId: "org_1", projectId: "project_1",
    sourceDecisionProposalId: "p2", sourceArtifactId: "art2",
    title: "Billing", rationale: "Invoice", alternatives: [],
    scope: ["billing"], status: "ACTIVE", approvedByPrincipalId: "admin", createdAt: at },
];
const resolve = (def = agent) => resolveContextSnapshot({
  id: "s1", version, activeDecisions: decisions, agent: def,
  mission: "Implement jobs Load More", requestedByPrincipalId: "usr_1", createdAt: at,
});

describe("agent context snapshot resolution", () => {
  it("uses authoritative version and includes task-relevant active decisions", () => {
    const snapshot = resolve();
    expect(snapshot.sourceContextVersionId).toBe("v4");
    expect(snapshot.includedDecisionIds).toEqual(["d1"]);
    expect(snapshot.includedConstraintIds).toEqual(["c1"]);
    expect(snapshot.excludedPaths).toContain("/constraints/1");
    expect(snapshot.excludedPaths).toContain("/attributes/secret");
    expect(JSON.stringify(snapshot)).not.toContain("do-not-include");
  });
  it("denies snapshots above agent clearance", () => {
    expect(() => resolve({ ...agent, maxContextClassification: "PUBLIC" })).toThrow();
  });
  it("rejects cross-organization agent definitions", () => {
    expect(() => resolve({ ...agent, organizationId: "other" })).toThrow();
  });
  it("rejects unapproved agent definitions", () => {
    expect(() => resolve({ ...agent, status: "draft" })).toThrow();
  });
});
