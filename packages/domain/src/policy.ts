import type { Policy, PolicyEvaluation, PolicyResult } from "./types.js";

export interface PolicyEvaluationInput {
  action: string;
  resourceRef: string;
  /** Policies already resolved to the effective set for this scope. */
  policies: Policy[];
}

export interface PolicyEvaluationOutcome {
  result: PolicyResult;
  policy?: Policy;
  evaluations: Omit<PolicyEvaluation, "id" | "organizationId" | "evaluatedAt">[];
  reason: string;
}

const RESTRICTIVENESS: Record<PolicyResult, number> = {
  ALLOW: 0,
  APPROVAL_REQUIRED: 1,
  DENY: 2,
};

/**
 * Deterministic policy evaluation. AI may explain a result; it never decides
 * one. When policies conflict, the most restrictive result wins.
 */
export function evaluatePolicies(input: PolicyEvaluationInput): PolicyEvaluationOutcome {
  const matching = input.policies.filter((p) => p.active && p.triggerAction === input.action);

  const evaluations = matching.map((policy) => ({
    policyId: policy.id,
    policyVersion: policy.version,
    action: input.action,
    resourceRef: input.resourceRef,
    result: policy.result as PolicyResult,
    reason: `${policy.code}: ${policy.name}`,
  }));

  if (matching.length === 0) {
    return { result: "ALLOW", evaluations, reason: "No policy governs this action." };
  }

  const winning = matching.reduce((a, b) =>
    RESTRICTIVENESS[b.result] > RESTRICTIVENESS[a.result] ? b : a,
  );

  return {
    result: winning.result,
    policy: winning,
    evaluations,
    reason:
      winning.result === "DENY"
        ? `Denied by ${winning.code} (${winning.name}).`
        : `Approval required by ${winning.code} (${winning.name}).`,
  };
}
