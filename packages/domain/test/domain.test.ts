import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertCanManageAgents,
  assertSnapshotWithinEnvelope,
  evaluatePolicies,
  transitionAgentSession,
  transitionContextChangeProposal,
  transitionDecision,
  transitionDecisionProposal,
  type AgentDefinition,
  type ContextConstraint,
  type ContextSnapshot,
  type Decision,
  type Intent,
  type Policy,
  type Principal,
  type ProjectContext,
} from "../src/index.js";

const organizationId = "org_test";
const projectId = "project_test";
const now = new Date(0).toISOString();

function engineeringAgent(): AgentDefinition {
  return {
    id: "agt_engineering",
    organizationId,
    name: "Engineering Agent",
    purpose: "Implement approved work",
    provider: "meta",
    model: "muse",
    capabilities: ["repo.read", "repo.write"],
    approvedTools: ["repo"],
    maxContextClassification: "CONFIDENTIAL",
    allowedContextScopes: ["project"],
    allowedRepositories: ["susanwere/orbit"],
    allowedPaths: ["apps/**", "packages/**"],
    approvalRequiredActions: [],
    forbiddenActions: ["gate.resolve.self"],
    networkPolicy: "none",
    networkAllowlist: [],
    status: "approved",
    version: 1,
    createdByPrincipalId: "usr_admin",
    createdAt: now,
  };
}

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id: "ctx_1",
    organizationId,
    projectId,
    sourceContextVersionId: "context_v3",
    mission: "Implement a work item",
    items: [],
    includedDecisionIds: [],
    includedConstraintIds: [],
    includedPaths: ["constraints.pagination"],
    excludedPaths: ["secrets.production"],
    authorizationBasis: {
      requestedByPrincipalId: "usr_admin",
      agentDefinitionId: "agt_engineering",
      agentDefinitionVersion: 1,
      capabilities: ["repo.read", "repo.write"],
      policyEvaluationIds: [],
    },
    maxClassification: "INTERNAL",
    allowedRepositories: ["susanwere/orbit"],
    allowedPaths: ["apps/**"],
    forbiddenData: ["production secrets"],
    approvalRequiredActions: [],
    createdAt: now,
    ...overrides,
  };
}

describe("decision and context lifecycle", () => {
  it("requires proposals to become reviewable before approval", () => {
    expect(transitionDecisionProposal("DETECTED", "READY_FOR_REVIEW")).toBe(
      "READY_FOR_REVIEW",
    );
    expect(() => transitionDecisionProposal("DETECTED", "APPROVED")).toThrow(
      DomainError,
    );
  });

  it("allows authoritative decisions only to become superseded", () => {
    expect(transitionDecision("ACTIVE", "SUPERSEDED")).toBe("SUPERSEDED");
    expect(() => transitionDecision("SUPERSEDED", "ACTIVE")).toThrow(DomainError);
  });

  it("requires context proposals to pass through APPLYING before APPLIED", () => {
    expect(
      transitionContextChangeProposal("READY_FOR_REVIEW", "APPLYING"),
    ).toBe("APPLYING");
    expect(() =>
      transitionContextChangeProposal("READY_FOR_REVIEW", "APPLIED"),
    ).toThrow(DomainError);
  });

  it("keeps original intent separate from derived current intent", () => {
    const intent: Intent = {
      id: "intent_1",
      organizationId,
      projectId,
      statement: "Build the original product",
      createdByPrincipalId: "usr_admin",
      createdAt: now,
    };
    const context: ProjectContext = {
      projectId,
      originalIntentId: intent.id,
      currentIntent: "Build the product with an approved pagination constraint",
      constraints: [],
      attributes: {},
    };

    expect(intent.statement).toBe("Build the original product");
    expect(context.currentIntent).not.toBe(intent.statement);
    expect(context.originalIntentId).toBe(intent.id);
  });

  it("keeps decisions and derived constraints as distinct domain concepts", () => {
    const decision: Decision = {
      id: "decision_1",
      organizationId,
      projectId,
      sourceDecisionProposalId: "proposal_1",
      sourceArtifactId: "artifact_1",
      title: "Use explicit Load More",
      rationale: "Keep loading user controlled",
      alternatives: ["Infinite scroll"],
      scope: ["jobs list"],
      status: "ACTIVE",
      approvedByPrincipalId: "usr_admin",
      createdAt: now,
    };
    const constraint: ContextConstraint = {
      id: "constraint_1",
      key: "pagination.mode",
      statement: "Use explicit Load More",
      sourceDecisionId: decision.id,
      createdAt: now,
    };

    expect(constraint.sourceDecisionId).toBe(decision.id);
    expect(constraint.id).not.toBe(decision.id);
  });
});

describe("context snapshots and agent sessions", () => {
  it("captures version, included/excluded paths and authorization basis", () => {
    const value = snapshot();

    expect(value.sourceContextVersionId).toBe("context_v3");
    expect(value.includedPaths).toContain("constraints.pagination");
    expect(value.excludedPaths).toContain("secrets.production");
    expect(value.authorizationBasis.agentDefinitionId).toBe("agt_engineering");
  });

  it("rejects snapshots outside an agent envelope", () => {
    expect(() =>
      assertSnapshotWithinEnvelope(
        engineeringAgent(),
        snapshot({ allowedRepositories: ["other/repo"] }),
      ),
    ).toThrow(DomainError);
  });

  it("rejects snapshots authorized for a different agent", () => {
    expect(() =>
      assertSnapshotWithinEnvelope(
        engineeringAgent(),
        snapshot({
          authorizationBasis: {
            ...snapshot().authorizationBasis,
            agentDefinitionId: "agt_other",
          },
        }),
      ),
    ).toThrow(DomainError);
  });

  it("enforces the agent session lifecycle", () => {
    expect(transitionAgentSession("CREATED", "AUTHORIZED")).toBe("AUTHORIZED");
    expect(transitionAgentSession("AUTHORIZED", "RUNNING")).toBe("RUNNING");
    expect(() => transitionAgentSession("CREATED", "COMPLETED")).toThrow(
      DomainError,
    );
  });
});

describe("existing governance primitives", () => {
  it("allows only human admins to manage agent definitions", () => {
    const admin: Principal = {
      id: "usr_admin",
      organizationId,
      type: "human",
      displayName: "Admin",
      role: "admin",
    };

    expect(() => assertCanManageAgents(admin)).not.toThrow();

    const member: Principal = { ...admin, id: "usr_member", role: "member" };
    expect(() => assertCanManageAgents(member)).toThrow(DomainError);
  });

  it("uses the most restrictive matching policy", () => {
    const policies: Policy[] = [
      {
        id: "p1",
        organizationId,
        code: "APPROVE-1",
        name: "Approval",
        category: "architecture",
        description: "",
        scopeType: "organization",
        triggerAction: "dependency.add",
        result: "APPROVAL_REQUIRED",
        mandatory: true,
        version: 1,
        active: true,
        createdAt: now,
      },
      {
        id: "p2",
        organizationId,
        code: "DENY-1",
        name: "Deny",
        category: "security",
        description: "",
        scopeType: "organization",
        triggerAction: "dependency.add",
        result: "DENY",
        mandatory: true,
        version: 1,
        active: true,
        createdAt: now,
      },
    ];

    expect(
      evaluatePolicies({
        action: "dependency.add",
        resourceRef: "work_item:test",
        policies,
      }).result,
    ).toBe("DENY");
  });
});
