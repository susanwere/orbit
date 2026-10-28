import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertCanManageAgents,
  assertSnapshotWithinEnvelope,
  evaluatePolicies,
  type AgentDefinition,
  type ContextSnapshot,
  type Policy,
  type Principal,
} from "../src/index.js";

const organizationId = "org_test";

describe("governance primitives", () => {
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

  it("rejects context outside an agent repository envelope", () => {
    const definition: AgentDefinition = {
      id: "agt_1",
      organizationId,
      name: "Engineering Agent",
      purpose: "Implement approved work",
      provider: "meta",
      model: "muse",
      capabilities: [],
      approvedTools: [],
      maxContextClassification: "CONFIDENTIAL",
      allowedContextScopes: [],
      allowedRepositories: ["susanwere/orbit"],
      allowedPaths: ["apps/**"],
      approvalRequiredActions: [],
      forbiddenActions: [],
      networkPolicy: "none",
      networkAllowlist: [],
      status: "approved",
      version: 1,
      createdByPrincipalId: "usr_admin",
      createdAt: new Date(0).toISOString(),
    };

    const snapshot: ContextSnapshot = {
      id: "ctx_1",
      organizationId,
      mission: "test",
      items: [],
      maxClassification: "INTERNAL",
      allowedRepositories: ["other/repo"],
      allowedPaths: [],
      forbiddenData: [],
      approvalRequiredActions: [],
      createdAt: new Date(0).toISOString(),
    };

    expect(() => assertSnapshotWithinEnvelope(definition, snapshot)).toThrow(
      DomainError,
    );
  });
});

describe("policy evaluation", () => {
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
        createdAt: new Date(0).toISOString(),
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
        createdAt: new Date(0).toISOString(),
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
