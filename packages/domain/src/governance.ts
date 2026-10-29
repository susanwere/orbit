import { DomainError } from "./errors.js";
import { exceedsClassification, type AgentDefinition, type Principal } from "./types.js";
import type { ContextSnapshot } from "./execution-context.js";

/** Non-overridable agent safety rules, enforced outside any model reasoning. */
export const NON_OVERRIDABLE_AGENT_RULES = [
  "Agents cannot create other agents.",
  "Agents cannot modify or expand their own permissions.",
  "Agents cannot approve their own work or exceptions.",
  "Agents cannot cross organization boundaries.",
  "Agents cannot reveal protected product context.",
  "Agents cannot access long-lived raw credentials.",
  "Agents cannot bypass mandatory human gates.",
] as const;

export function assertCanManageAgents(actor: Principal): void {
  if (actor.type !== "human" || actor.role !== "admin") {
    throw new DomainError(
      "forbidden",
      "Only organization administrators can create or modify agent definitions.",
    );
  }
}

export function assertCanStartSession(definition: AgentDefinition, organizationId: string): void {
  if (definition.organizationId !== organizationId) {
    throw new DomainError("forbidden", "Agent definition belongs to another organization.");
  }
  if (definition.status !== "approved") {
    throw new DomainError(
      "invalid_state",
      `Agent definition is ${definition.status}; only approved definitions can start sessions.`,
    );
  }
}

export function assertSnapshotWithinEnvelope(
  definition: AgentDefinition,
  snapshot: ContextSnapshot,
): void {
  if (snapshot.organizationId !== definition.organizationId) {
    throw new DomainError("scope_exceeded", "Context snapshot belongs to another organization.");
  }

  if (snapshot.authorizationBasis.agentDefinitionId !== definition.id) {
    throw new DomainError(
      "scope_exceeded",
      "Context snapshot was authorized for another agent definition.",
    );
  }

  if (exceedsClassification(snapshot.maxClassification, definition.maxContextClassification)) {
    throw new DomainError(
      "classification_exceeded",
      `Context snapshot reaches ${snapshot.maxClassification}, above agent clearance ${definition.maxContextClassification}.`,
    );
  }

  for (const repo of snapshot.allowedRepositories) {
    if (!definition.allowedRepositories.includes(repo)) {
      throw new DomainError(
        "scope_exceeded",
        `Repository ${repo} is outside the agent definition scope.`,
      );
    }
  }

  for (const path of snapshot.allowedPaths) {
    if (!definition.allowedPaths.includes(path)) {
      throw new DomainError(
        "scope_exceeded",
        `Path ${path} is outside the agent definition scope.`,
      );
    }
  }
}

/** Only humans resolve human gates. Agents can never approve their own work. */
export function assertGateResolverIsHuman(resolver: Principal): void {
  if (resolver.type !== "human") {
    throw new DomainError("forbidden", "Only a human can resolve a human gate.");
  }
}
