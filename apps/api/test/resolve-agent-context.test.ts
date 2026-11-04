import { describe, expect, it } from "vitest";
import type { AgentDefinition, ContextVersion, Decision } from "@orbit/domain";
import { resolveContextSnapshot } from "../src/modules/context/resolve-agent-context.js";

const at = "2026-10-28T10:00:00Z";
const agent: AgentDefinition = {
  id: "agent_1",
  organizationId: "org_1",
  name: "Engineer",
  purpose: "Implement tasks",
  provider: "meta",
  model: "muse",
  capabilities: ["repo.read"],
  approvedTools: [],
  maxContextClassification: "INTERNAL",
  allowedContextScopes: ["project", "/attributes/releaseChannel"],
  allowedRepositories: ["susanwere/orbit"],
  allowedPaths: ["apps/**"],
  approvalRequiredActions: [],
  forbiddenActions: [],
  networkPolicy: "none",
  networkAllowlist: [],
  status: "approved",
  version: 1,
  createdByPrincipalId: "admin",
  createdAt: at,
};
const version: ContextVersion = {
  id: "v4",
  organizationId: "org_1",
  projectId: "project_1",
  versionNumber: 4,
  contentHash: "a".repeat(64),
  createdAt: at,
  content: {
    projectId: "project_1",
    originalIntentId: "intent_1",
    currentIntent: "Build jobs viewer",
    constraints: [
      {
        id: "c1",
        key: "jobs.loadMore",
        statement: "Load More for jobs",
        sourceDecisionId: "d1",
        createdAt: at,
      },
      {
        id: "c2",
        key: "billing",
        statement: "Billing invoice change",
        sourceDecisionId: "d2",
        createdAt: at,
      },
    ],
    attributes: { releaseChannel: "preview", secret: "do-not-include" },
  },
};
const decisions: Decision[] = [
  {
    id: "d1",
    organizationId: "org_1",
    projectId: "project_1",
    sourceDecisionProposalId: "p1",
    sourceArtifactId: "art1",
    title: "Load More",
    rationale: "Fast jobs loading",
    alternatives: [],
    scope: ["jobs list"],
    status: "ACTIVE",
    approvedByPrincipalId: "admin",
    createdAt: at,
  },
  {
    id: "d2",
    organizationId: "org_1",
    projectId: "project_1",
    sourceDecisionProposalId: "p2",
    sourceArtifactId: "art2",
    title: "Billing",
    rationale: "Invoice",
    alternatives: [],
    scope: ["billing"],
    status: "ACTIVE",
    approvedByPrincipalId: "admin",
    createdAt: at,
  },
];
const resolve = (def = agent) =>
  resolveContextSnapshot({
    id: "s1",
    version,
    activeDecisions: decisions,
    agent: def,
    mission: "Implement jobs Load More",
    requestedByPrincipalId: "usr_1",
    createdAt: at,
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
  it("excludes internal content for a public agent and classifies the empty snapshot correctly", () => {
    const snapshot = resolve({ ...agent, maxContextClassification: "PUBLIC" });
    expect(snapshot.items).toEqual([]);
    expect(snapshot.includedPaths).toEqual([]);
    expect(snapshot.maxClassification).toBe("PUBLIC");
    expect(snapshot.excludedPaths).toContain("/currentIntent");
    expect(JSON.stringify(snapshot)).not.toContain("do-not-include");
    expect(resolve().maxClassification).toBe("INTERNAL");
  });
  it("rejects cross-organization agent definitions", () => {
    expect(() => resolve({ ...agent, organizationId: "other" })).toThrow();
  });
  it("rejects unapproved agent definitions", () => {
    expect(() => resolve({ ...agent, status: "draft" })).toThrow();
  });
});

const knowledgePath = "/attributes/approvedProjectKnowledge";
describe("approved structured knowledge", () => {
  const knowledge = {
    snapshotId: "knowledge_2",
    revision: 2,
    content: { summary: { overview: "A jobs viewer", architecture: "React frontend" } },
  };
  const knowledgeVersion: ContextVersion = {
    ...version,
    content: {
      ...version.content,
      attributes: { approvedProjectKnowledge: knowledge, arbitrary: { secret: "excluded" } },
    },
  };
  const resolveKnowledge = (definition: AgentDefinition) =>
    resolveContextSnapshot({
      id: "knowledge_snapshot",
      version: knowledgeVersion,
      activeDecisions: [],
      agent: definition,
      mission: "Implement jobs",
      requestedByPrincipalId: "admin",
      createdAt: at,
    });
  it("preserves structured content and provenance only with explicit scope and clearance", () => {
    const snapshot = resolveKnowledge({
      ...agent,
      allowedContextScopes: [knowledgePath, "/attributes/arbitrary"],
    });
    expect(snapshot.includedPaths).toEqual([knowledgePath]);
    expect(JSON.parse(snapshot.items[0]!.excerpt)).toEqual(knowledge);
    expect(snapshot.items[0]!.sourceRef).toBe("knowledge:knowledge_2:revision:2");
    expect(JSON.stringify(snapshot)).not.toContain('"secret"');
    expect(snapshot.sourceContextVersionId).toBe(version.id);
  });
  it("does not broaden project scopes or public classification", () => {
    expect(resolveKnowledge(agent).includedPaths).not.toContain(knowledgePath);
    expect(
      resolveKnowledge({
        ...agent,
        allowedContextScopes: [knowledgePath],
        maxContextClassification: "PUBLIC",
      }).items,
    ).toEqual([]);
  });
  it("rejects oversized approved context instead of silently dropping it", () => {
    const oversized: ContextVersion = {
      ...knowledgeVersion,
      content: {
        ...knowledgeVersion.content,
        attributes: {
          approvedProjectKnowledge: { ...knowledge, content: { overview: "a".repeat(48000) } },
        },
      },
    };
    expect(() =>
      resolveContextSnapshot({
        id: "large",
        version: oversized,
        activeDecisions: [],
        agent: { ...agent, allowedContextScopes: [knowledgePath] },
        mission: "Implement",
        requestedByPrincipalId: "admin",
        createdAt: at,
      }),
    ).toThrow("budget");
  });
});
