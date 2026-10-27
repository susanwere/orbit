import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertCanManageAgents,
  evaluatePolicies,
  transitionWorkflow,
  type Policy,
  type Principal,
} from "../src/index.js";

const admin: Principal = {
  id: "u_admin",
  organizationId: "org_1",
  type: "human",
  displayName: "Susan (Admin)",
  role: "admin",
};

const member: Principal = {
  id: "u_member",
  organizationId: "org_1",
  type: "human",
  displayName: "Alex (Member)",
  role: "member",
};

function policy(partial: Partial<Policy>): Policy {
  return {
    id: "pol_1",
    organizationId: "org_1",
    code: "API-04",
    name: "API contract changes require human approval",
    category: "architecture",
    description: "API contract changes require approval.",
    scopeType: "organization",
    triggerAction: "api_contract.change",
    result: "APPROVAL_REQUIRED",
    mandatory: true,
    version: 1,
    active: true,
    ...partial,
  };
}

describe("policy evaluation", () => {
  it("allows actions no policy governs", () => {
    const out = evaluatePolicies({ action: "file.write", resourceRef: "step_1", policies: [] });
    expect(out.result).toBe("ALLOW");
  });

  it("requires approval when an approval policy matches", () => {
    const out = evaluatePolicies({
      action: "api_contract.change",
      resourceRef: "step_1",
      policies: [policy({})],
    });
    expect(out.result).toBe("APPROVAL_REQUIRED");
    expect(out.policy?.code).toBe("API-04");
  });

  it("most restrictive result wins on conflict", () => {
    const out = evaluatePolicies({
      action: "api_contract.change",
      resourceRef: "step_1",
      policies: [policy({}), policy({ id: "pol_2", code: "SEC-01", result: "DENY" })],
    });
    expect(out.result).toBe("DENY");
  });
});

describe("agent governance", () => {
  it("only human admins can manage agent definitions", () => {
    expect(() => assertCanManageAgents(admin)).not.toThrow();
    expect(() => assertCanManageAgents(member)).toThrow(DomainError);
  });
});

describe("workflow state machine", () => {
  it("allows running -> paused -> running", () => {
    expect(transitionWorkflow("running", "paused")).toBe("paused");
    expect(transitionWorkflow("paused", "running")).toBe("running");
  });

  it("rejects completion directly from proposed", () => {
    expect(() => transitionWorkflow("proposed", "completed")).toThrow(DomainError);
  });
});
