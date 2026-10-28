import {
  DomainError,
  assertCanStartSession,
  assertSnapshotWithinEnvelope,
  exceedsClassification,
  type AgentDefinition,
  type ContextSnapshot,
  type ContextSnapshotItem,
  type ContextVersion,
  type Decision,
} from "@orbit/domain";

export interface ResolveSnapshotInput {
  id: string;
  version: ContextVersion;
  activeDecisions: readonly Decision[];
  agent: AgentDefinition;
  mission: string;
  requestedByPrincipalId: string;
  createdAt: string;
}
const classification = "INTERNAL" as const;
const matches = (mission: string, values: readonly string[]) => {
  const tokens = mission.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  return values.some((v) => tokens.some((token) => v.toLowerCase().includes(token)));
};
const inScope = (path: string, scopes: readonly string[]) =>
  scopes.includes(path) ||
  scopes.some((scope) => scope.endsWith("/**") && path.startsWith(scope.slice(0, -2)));

/** Deterministically filters immutable authoritative context, never a model proposal. */
export function resolveContextSnapshot(input: ResolveSnapshotInput): ContextSnapshot {
  const { version, agent, mission } = input;
  assertCanStartSession(agent, version.organizationId);
  if (version.content.projectId !== version.projectId || !mission.trim()) {
    throw new DomainError("validation", "Invalid context or mission.");
  }
  const items: ContextSnapshotItem[] = [];
  const includedPaths: string[] = [];
  const excludedPaths: string[] = [];
  const includedConstraintIds: string[] = [];
  const includedDecisionIds = new Set<string>();
  const authorized = !exceedsClassification(classification, agent.maxContextClassification);
  const add = (path: string, item: ContextSnapshotItem, relevant: boolean) => {
    if (authorized && inScope(path, agent.allowedContextScopes) && relevant) {
      items.push(item);
      includedPaths.push(path);
    } else {
      excludedPaths.push(path);
    }
  };

  add("/currentIntent", {
    contextItemId: `intent:${version.content.originalIntentId}`,
    title: "Current project intent",
    classification,
    excerpt: version.content.currentIntent,
  }, true);

  const active = new Map(input.activeDecisions.filter((decision) =>
    decision.status === "ACTIVE" &&
    decision.organizationId === version.organizationId &&
    decision.projectId === version.projectId
  ).map((decision) => [decision.id, decision]));

  version.content.constraints.forEach((constraint, index) => {
    const decision = active.get(constraint.sourceDecisionId);
    const path = `/constraints/${index}`;
    const relevant = !!decision && matches(mission, [...decision.scope, constraint.statement]);
    add(path, {
      contextItemId: constraint.id,
      title: constraint.key,
      classification,
      excerpt: constraint.statement,
      sourceRef: decision ? `decision:${decision.id}` : undefined,
    }, relevant);
    if (relevant && authorized && inScope(path, agent.allowedContextScopes) && decision) {
      includedConstraintIds.push(constraint.id);
      includedDecisionIds.add(decision.id);
    }
  });

  // Attributes are denied by default unless an agent explicitly lists the path.
  for (const key of Object.keys(version.content.attributes).sort()) {
    const path = `/attributes/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const item = version.content.attributes[key];
    const safePrimitive = typeof item === "string" || typeof item === "number" || typeof item === "boolean";
    const explicit = agent.allowedContextScopes.includes(path);
    add(path, {
      contextItemId: `attribute:${key}`,
      title: key,
      classification,
      excerpt: safePrimitive ? String(item) : "[structured attribute omitted]",
    }, explicit && safePrimitive && matches(mission, [key]));
  }

  const snapshot: ContextSnapshot = {
    id: input.id,
    organizationId: version.organizationId,
    projectId: version.projectId,
    sourceContextVersionId: version.id,
    mission,
    items,
    includedDecisionIds: [...includedDecisionIds].sort(),
    includedConstraintIds,
    includedPaths,
    excludedPaths,
    authorizationBasis: {
      requestedByPrincipalId: input.requestedByPrincipalId,
      agentDefinitionId: agent.id,
      agentDefinitionVersion: agent.version,
      capabilities: agent.capabilities,
      policyEvaluationIds: [],
    },
    maxClassification: classification,
    allowedRepositories: agent.allowedRepositories,
    allowedPaths: agent.allowedPaths,
    forbiddenData: [],
    approvalRequiredActions: agent.approvalRequiredActions,
    createdAt: input.createdAt,
  };
  assertSnapshotWithinEnvelope(agent, snapshot);
  return snapshot;
}
